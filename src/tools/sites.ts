import { z } from "zod";
import { WpClient } from "../wp-client.js";
import { BRIDGE, defineTool, toText, type Ctx } from "./helpers.js";

const HEALTH_TESTS = ["background-updates", "loopback-requests", "https-status", "dotorg-communication", "authorization-header"];

async function bridgeStatus(wp: WpClient): Promise<unknown> {
  try {
    return (await wp.get(`${BRIDGE}/status`)).data;
  } catch {
    return null;
  }
}

export function registerSiteTools(ctx: Ctx): void {
  // The one tool without a `site` argument, so it is registered directly.
  ctx.server.registerTool(
    "wp_list_sites",
    {
      description: "List the WordPress sites this server can manage. Call this first to get the site ids every other tool needs.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => ({
      content: [
        {
          type: "text" as const,
          text: toText(ctx.sites.list().map((s) => ({ id: s.id, label: s.label, url: s.url, readOnly: s.readOnly }))),
        },
      ],
    }),
  );

  defineTool(ctx, {
    name: "wp_site_info",
    description:
      "Site name, URLs, timezone, available REST namespaces, the authenticated user, and (when the bridge plugin is active) WordPress/PHP versions, active theme and which gated features are enabled.",
    schema: {},
    kind: "read",
    run: async (wp) => {
      const [index, me, bridge] = await Promise.all([
        wp.get("/", { _fields: "name,description,url,home,gmt_offset,timezone_string,namespaces" }),
        wp.get("/wp/v2/users/me", { context: "edit", _fields: "id,username,name,roles" }),
        bridgeStatus(wp),
      ]);
      return { ...(index.data as object), authenticated_as: me.data, bridge: bridge ?? "not installed" };
    },
  });

  defineTool(ctx, {
    name: "wp_site_health",
    description: "Run WordPress Site Health checks (background updates, loopback, HTTPS, WordPress.org connectivity, auth header).",
    schema: {
      tests: z.array(z.enum(HEALTH_TESTS as [string, ...string[]])).optional().describe("Subset of tests; default all"),
    },
    kind: "read",
    run: async (wp, args) => {
      const tests = args.tests ?? HEALTH_TESTS;
      const results = await Promise.allSettled(tests.map((t) => wp.get(`/wp-site-health/v1/tests/${t}`)));
      return results.map((r, i) => {
        if (r.status === "rejected") return { test: tests[i], status: "error", error: String(r.reason?.message ?? r.reason) };
        const d = r.value.data as { status?: string; label?: string; description?: string };
        return { test: tests[i], status: d.status, label: d.label, description: d.description?.replace(/<[^>]+>/g, "") };
      });
    },
  });
}
