import type { Site } from "./config.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type Query = Record<string, unknown>;

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  /** Send `body` as raw bytes (media upload) instead of JSON. */
  rawBody?: Uint8Array;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface WpResponse<T = unknown> {
  status: number;
  data: T;
  total?: number;
  totalPages?: number;
}

export class WpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "WpError";
  }
}

const RETRY_STATUS = new Set([429, 502, 503, 504]);
const MAX_RETRIES = 2;

function appendQuery(params: URLSearchParams, query: Query | undefined): void {
  if (!query) return;
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) params.set(key, value.join(","));
    else if (typeof value === "object") params.set(key, JSON.stringify(value));
    else params.set(key, String(value));
  }
}

export function buildUrl(site: Pick<Site, "url" | "plainPermalinks">, route: string, query?: Query): string {
  const path = route.startsWith("/") ? route : `/${route}`;
  const params = new URLSearchParams();
  let base: string;
  if (site.plainPermalinks) {
    base = `${site.url}/`;
    params.set("rest_route", path);
  } else {
    base = `${site.url}/wp-json${path}`;
  }
  appendQuery(params, query);
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class WpClient {
  private readonly auth: string;

  constructor(readonly site: Site) {
    this.auth = "Basic " + Buffer.from(`${site.username}:${site.appPassword}`).toString("base64");
  }

  async request<T = unknown>(method: HttpMethod, route: string, opts: RequestOptions = {}): Promise<WpResponse<T>> {
    const url = buildUrl(this.site, route, opts.query);
    const headers: Record<string, string> = {
      Authorization: this.auth,
      Accept: "application/json",
      "User-Agent": "wp-mcp/0.1",
      ...opts.headers,
    };
    let body: BodyInit | undefined;
    if (opts.rawBody) {
      body = opts.rawBody as BodyInit;
    } else if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }

    // Only idempotent reads are retried; a retried write could apply twice.
    const retries = method === "GET" ? MAX_RETRIES : 0;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers,
          body,
          signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
        });
      } catch (err) {
        if (attempt < retries) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        const reason = err instanceof Error ? err.message : String(err);
        throw new WpError(`Request to ${this.site.id} failed: ${reason}`, 0, "network_error");
      }

      if (RETRY_STATUS.has(res.status) && attempt < retries) {
        await sleep(500 * 2 ** attempt);
        continue;
      }

      const text = await res.text();
      let data: unknown = text;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          // Non-JSON body: usually a firewall, maintenance or PHP fatal page.
        }
      }

      if (!res.ok) {
        const err = data as { code?: string; message?: string; data?: unknown } | string;
        if (typeof err === "object" && err !== null && err.code) {
          throw new WpError(err.message ?? err.code, res.status, err.code, err.data);
        }
        const snippet = typeof data === "string" ? data.replace(/\s+/g, " ").slice(0, 300) : "";
        throw new WpError(`HTTP ${res.status} from ${this.site.id}: ${snippet}`, res.status, "http_error");
      }
      if (typeof data === "string" && text) {
        throw new WpError(
          `${this.site.id} returned a non-JSON response; the REST API may be blocked or the URL wrong: ${text.replace(/\s+/g, " ").slice(0, 200)}`,
          res.status,
          "invalid_json",
        );
      }

      const total = res.headers.get("x-wp-total");
      const totalPages = res.headers.get("x-wp-totalpages");
      return {
        status: res.status,
        data: data as T,
        total: total ? Number(total) : undefined,
        totalPages: totalPages ? Number(totalPages) : undefined,
      };
    }
  }

  get<T = unknown>(route: string, query?: Query) {
    return this.request<T>("GET", route, { query });
  }
  post<T = unknown>(route: string, body?: unknown, query?: Query) {
    return this.request<T>("POST", route, { body, query });
  }
  delete<T = unknown>(route: string, query?: Query) {
    return this.request<T>("DELETE", route, { query });
  }
}
