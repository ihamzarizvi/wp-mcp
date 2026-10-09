import { z } from "zod";
import type { Kind } from "../safety.js";
import { BRIDGE, defineTool, jsonRecord, methodKind, type Ctx } from "./helpers.js";

/** Split a command line into arguments, honouring single and double quotes. */
export function splitArgs(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: string | null = null;
  let started = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < command.length) current += command[++i];
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) args.push(current);
      current = "";
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (quote) throw new Error("Unterminated quote in command");
  if (started) args.push(current);
  return args;
}

const CLI_READ_VERBS = new Set([
  "list", "get", "status", "version", "info", "search", "check-update", "verify-checksums",
  "is-installed", "is-active", "exists", "path", "size", "tables", "columns", "check", "prefix", "pluck", "has",
]);

// The word after these is an argument, not a subcommand, so it proves nothing.
const CLI_ALWAYS_CONFIRM = new Set(["eval", "eval-file", "search-replace", "shell", "import", "export", "server", "scaffold"]);
const CLI_SUBGROUPS = new Set(["meta", "term", "cap", "auto-updates", "application-password", "session"]);

/** `wp plugin list` and `wp user meta get` are reads; everything else needs confirmation. */
export function classifyCli(command: string): Kind {
  const words = splitArgs(command).filter((a) => !a.startsWith("-"));
  if (words[0] === "wp") words.shift();
  // Bare flags such as --info or --version.
  if (words.length === 0) return "read";
  if (CLI_ALWAYS_CONFIRM.has(words[0])) return "destructive";
  if (words.length === 1) return CLI_READ_VERBS.has(words[0]) ? "read" : "destructive";
  if (CLI_READ_VERBS.has(words[1])) return "read";
  if (CLI_SUBGROUPS.has(words[1]) && CLI_READ_VERBS.has(words[2])) return "read";
  return "destructive";
}

export function classifySql(sql: string): Kind {
  const stripped = sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*(--|#).*$/gm, " ").trim();
  // A second statement after a semicolon could hide a write behind a SELECT.
  if (/;\s*\S/.test(stripped)) return "destructive";
  return /^(select|show|describe|desc|explain)\b/i.test(stripped) ? "read" : "destructive";
}

const relPath = z.string().describe('Path relative to wp-content, e.g. "themes/my-theme/functions.php"');
const httpMethod = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export function registerSystemTools(ctx: Ctx): void {
  defineTool(ctx, {
    name: "wp_cli",
    description:
      'Run a WP-CLI command on the site, e.g. "plugin list --format=json", "search-replace old new --dry-run", "cache flush". Read-only commands run directly; anything else needs confirm: true. Needs WP-CLI on the server and WP-CLI access enabled on the site under WP Admin > WP MCP > Settings.',
    schema: { command: z.string().min(1).describe('Command without the leading "wp"') },
    kind: "destructive",
    classify: (a) => classifyCli(a.command),
    bridge: true,
    run: async (wp, a) => {
      const args = splitArgs(a.command);
      if (args[0] === "wp") args.shift();
      return (await wp.request("POST", `${BRIDGE}/cli`, { body: { args }, timeoutMs: 180_000 })).data;
    },
  });

  defineTool(ctx, {
    name: "wp_file_list",
    description: "List a directory inside wp-content (themes, plugins, uploads, mu-plugins). File access must be enabled on the site under WP Admin > WP MCP > Settings.",
    schema: { path: relPath.optional() },
    kind: "read",
    bridge: true,
    run: async (wp, a) => (await wp.get(`${BRIDGE}/files`, { path: a.path ?? "", list: 1 })).data,
  });

  defineTool(ctx, {
    name: "wp_file_read",
    description: "Read a file inside wp-content. Text is returned as-is; binary files as base64. File access must be enabled on the site under WP Admin > WP MCP > Settings.",
    schema: { path: relPath },
    kind: "read",
    bridge: true,
    run: async (wp, a) => (await wp.get(`${BRIDGE}/files`, { path: a.path })).data,
  });

  defineTool(ctx, {
    name: "wp_file_write",
    description:
      "Create or overwrite a file inside wp-content. A syntax error in an active theme or plugin PHP file can take the site down, so read the file first and keep the change minimal. File access must be enabled on the site under WP Admin > WP MCP > Settings.",
    schema: {
      path: relPath,
      content: z.string(),
      encoding: z.enum(["utf8", "base64"]).optional(),
    },
    kind: "destructive",
    bridge: true,
    run: async (wp, a) => (await wp.post(`${BRIDGE}/files`, a)).data,
  });

  defineTool(ctx, {
    name: "wp_db_query",
    description:
      "Run one SQL statement against the WordPress database. Use {prefix} for the table prefix, e.g. SELECT * FROM {prefix}posts LIMIT 5. SELECT/SHOW/DESCRIBE/EXPLAIN run directly; any write needs confirm: true. Database access must be enabled on the site under WP Admin > WP MCP > Settings.",
    schema: { sql: z.string().min(1) },
    kind: "destructive",
    classify: (a) => classifySql(a.sql),
    bridge: true,
    run: async (wp, a) => (await wp.post(`${BRIDGE}/db/query`, { sql: a.sql })).data,
  });

  defineTool(ctx, {
    name: "wp_cache_flush",
    description: "Flush the object cache, expired transients, and the page caches of common cache plugins (WP Rocket, LiteSpeed, W3 Total Cache, WP Super Cache, Elementor CSS).",
    schema: {},
    kind: "write",
    bridge: true,
    run: async (wp) => (await wp.post(`${BRIDGE}/cache/flush`)).data,
  });

  defineTool(ctx, {
    name: "wp_cron_list",
    description: "List scheduled WP-Cron events with their next run time and recurrence.",
    schema: {},
    kind: "read",
    bridge: true,
    run: async (wp) => (await wp.get(`${BRIDGE}/cron`)).data,
  });

  defineTool(ctx, {
    name: "wp_cron_run",
    description: "Run a scheduled WP-Cron hook immediately.",
    schema: { hook: z.string().min(1) },
    kind: "write",
    bridge: true,
    run: async (wp, a) => (await wp.request("POST", `${BRIDGE}/cron/run`, { body: a, timeoutMs: 180_000 })).data,
  });

  defineTool(ctx, {
    name: "wp_activity_log",
    description:
      "Read the site's own history of requests made through this server (time, user, method, route, status, parameters), as recorded by the bridge plugin. Changes are always recorded; reads only if the site admin enabled that.",
    schema: {
      kind: z.enum(["all", "writes", "errors"]).optional(),
      search: z.string().optional().describe("Match against route or parameters"),
      page: z.number().int().min(1).optional(),
      per_page: z.number().int().min(1).max(200).optional().describe("Default 50"),
    },
    kind: "read",
    bridge: true,
    run: async (wp, a) => (await wp.get(`${BRIDGE}/log`, a)).data,
  });

  defineTool(ctx, {
    name: "wc_request",
    description:
      'Call the WooCommerce REST API (/wc/v3). `path` examples: "products", "products/12", "products/12/variations", "orders", "orders/34/notes", "customers", "coupons", "reports/sales", "products/categories", "shipping/zones", "system_status". GET lists accept per_page, page, search, status and other WooCommerce filters in `query`. DELETE needs confirm: true.',
    schema: {
      method: httpMethod,
      path: z.string().regex(/^[\w\-\/]+$/),
      query: jsonRecord.optional(),
      body: jsonRecord.optional(),
    },
    kind: "write",
    classify: (a) => methodKind(a.method),
    run: async (wp, a) => {
      const res = await wp.request(a.method, `/wc/v3/${a.path.replace(/^\/+/, "")}`, { query: a.query, body: a.body });
      return res.total === undefined ? res.data : { total: res.total, total_pages: res.totalPages, items: res.data };
    },
  });

  defineTool(ctx, {
    name: "wp_rest_request",
    description:
      'Call any REST route on the site, for anything the other tools do not cover (plugin APIs such as /yoast/v1, /rankmath/v1, /acf/v3, /contact-form-7/v1, block and template endpoints, etc.). `route` is the path after /wp-json, e.g. "/wp/v2/block-types". wp_site_info lists the available namespaces. DELETE needs confirm: true.',
    schema: {
      method: httpMethod,
      route: z.string().regex(/^\/[\w\-\/.%()+:=]*$/),
      query: jsonRecord.optional(),
      body: jsonRecord.optional(),
    },
    kind: "write",
    classify: (a) => methodKind(a.method),
    run: async (wp, a) => {
      const res = await wp.request(a.method, a.route, { query: a.query, body: a.body });
      return res.total === undefined ? res.data : { total: res.total, total_pages: res.totalPages, items: res.data };
    },
  });
}
