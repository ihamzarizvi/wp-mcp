import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Site, SiteRegistry } from "../config.js";
import { audit, guard, type Kind } from "../safety.js";
import { WpClient, WpError } from "../wp-client.js";

export interface Ctx {
  server: McpServer;
  sites: SiteRegistry;
}

export interface ToolDef<S extends z.ZodRawShape> {
  name: string;
  description: string;
  schema: S;
  kind: Kind;
  /** Overrides `kind` per call, for tools whose effect depends on arguments. */
  classify?: (args: z.infer<z.ZodObject<S>>) => Kind;
  /** Tool needs the wp-mcp-bridge plugin on the target site. */
  bridge?: boolean;
  run: (wp: WpClient, args: z.infer<z.ZodObject<S>>, site: Site) => Promise<unknown>;
}

const MAX_OUTPUT_CHARS = 100_000;

export function toText(result: unknown): string {
  const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n… truncated (${text.length} chars total). Narrow the request with fields, per_page or a filter.`;
}

function describeError(err: unknown, site: string, bridge: boolean): string {
  if (err instanceof WpError) {
    if (bridge && err.code === "rest_no_route") {
      return `This tool needs the wp-mcp-bridge plugin, which is not active on site "${site}". Install bridge-plugin/wp-mcp-bridge from this project on that site and activate it.`;
    }
    const hint =
      err.status === 401
        ? " Check the username and Application Password for this site, and that the host passes the Authorization header."
        : "";
    return `WordPress error [${err.code}, HTTP ${err.status}]: ${err.message}${hint}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export function defineTool<S extends z.ZodRawShape>(ctx: Ctx, def: ToolDef<S>): void {
  const mayDestroy = def.kind === "destructive" || def.classify !== undefined;
  const inputSchema = {
    site: z.string().describe("Site id from wp_list_sites"),
    ...def.schema,
    ...(mayDestroy
      ? { confirm: z.boolean().optional().describe("Must be true to run a destructive operation; ask the user first") }
      : {}),
  };

  ctx.server.registerTool(
    def.name,
    {
      description: def.bridge ? `${def.description} Requires the wp-mcp-bridge plugin on the site.` : def.description,
      inputSchema,
      annotations: {
        readOnlyHint: def.kind === "read" && !def.classify,
        destructiveHint: mayDestroy,
        openWorldHint: true,
      },
    },
    (async (raw: Record<string, unknown>) => {
      const { site: siteId, confirm, ...rest } = raw;
      const args = rest as z.infer<z.ZodObject<S>>;
      let kind: Kind = def.kind;
      try {
        const site = ctx.sites.get(String(siteId));
        kind = def.classify ? def.classify(args) : def.kind;
        guard(site, def.name, kind, confirm);
        const result = await def.run(new WpClient(site), args, site);
        if (kind !== "read") audit({ site: site.id, tool: def.name, kind, args, ok: true });
        return { content: [{ type: "text" as const, text: toText(result) }] };
      } catch (err) {
        const message = describeError(err, String(siteId), def.bridge === true);
        if (kind !== "read") audit({ site: String(siteId), tool: def.name, kind, args, ok: false, error: message });
        return { content: [{ type: "text" as const, text: message }], isError: true };
      }
    }) as never,
  );
}

export const BRIDGE = "/wp-mcp/v1";

export function methodKind(method: string): Kind {
  if (method === "GET") return "read";
  return method === "DELETE" ? "destructive" : "write";
}

export const jsonRecord = z.record(z.string(), z.unknown());
