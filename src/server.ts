import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SiteRegistry } from "./config.js";
import { registerBricksTools } from "./tools/bricks.js";
import { registerExtensionTools } from "./tools/extensions.js";
import type { Ctx } from "./tools/helpers.js";
import { registerMediaTools } from "./tools/media.js";
import { registerResourceTools } from "./tools/resources.js";
import { registerSettingsTools } from "./tools/settings.js";
import { registerSiteTools } from "./tools/sites.js";
import { registerSystemTools } from "./tools/system.js";

export function buildServer(sites: SiteRegistry): McpServer {
  const server = new McpServer(
    { name: "wp-mcp", version: "0.1.0" },
    {
      instructions:
        "Manages multiple WordPress sites. Call wp_list_sites first; every other tool takes a `site` id. " +
        "Content, taxonomy, users, comments, media and menus all go through wp_list/get/create/update/delete with a `resource` argument. " +
        "Bricks Builder pages are edited with the bricks_ tools: bricks_get shows the element outline, then change single elements rather than replacing the page. " +
        "Destructive tools refuse to run without confirm: true; get the user's approval before setting it.",
    },
  );
  const ctx: Ctx = { server, sites };
  registerSiteTools(ctx);
  registerResourceTools(ctx);
  registerMediaTools(ctx);
  registerExtensionTools(ctx);
  registerSettingsTools(ctx);
  registerSystemTools(ctx);
  registerBricksTools(ctx);
  return server;
}
