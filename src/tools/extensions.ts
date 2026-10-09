import { z } from "zod";
import { BRIDGE, defineTool, type Ctx } from "./helpers.js";

const pluginFile = z
  .string()
  .regex(/^[\w.-]+(\/[\w.-]+)?$/)
  .describe('Plugin identifier from wp_plugins_list, e.g. "akismet/akismet"');

const stylesheet = z.string().regex(/^[\w.-]+$/).describe('Theme directory name from wp_themes_list, e.g. "twentytwentyfive"');

export function registerExtensionTools(ctx: Ctx): void {
  defineTool(ctx, {
    name: "wp_plugins_list",
    description: "List installed plugins with status and version.",
    schema: {
      status: z.enum(["active", "inactive"]).optional(),
      search: z.string().optional(),
    },
    kind: "read",
    run: async (wp, a) =>
      (
        await wp.get("/wp/v2/plugins", {
          status: a.status,
          search: a.search,
          _fields: "plugin,name,status,version,requires_wp,requires_php,network_only",
        })
      ).data,
  });

  defineTool(ctx, {
    name: "wp_plugin_install",
    description: "Install a plugin from the WordPress.org directory by slug, optionally activating it.",
    schema: {
      slug: z.string().regex(/^[a-z0-9-]+$/).describe('WordPress.org slug, e.g. "wordpress-seo"'),
      activate: z.boolean().optional(),
    },
    kind: "write",
    run: async (wp, a) =>
      (await wp.request("POST", "/wp/v2/plugins", { body: { slug: a.slug, status: a.activate ? "active" : "inactive" }, timeoutMs: 180_000 })).data,
  });

  defineTool(ctx, {
    name: "wp_plugin_set_status",
    description: "Activate or deactivate an installed plugin.",
    schema: { plugin: pluginFile, status: z.enum(["active", "inactive"]) },
    kind: "write",
    run: async (wp, a) => (await wp.post(`/wp/v2/plugins/${a.plugin}`, { status: a.status })).data,
  });

  defineTool(ctx, {
    name: "wp_plugin_delete",
    description: "Delete an installed plugin and its files. The plugin must be inactive first.",
    schema: { plugin: pluginFile },
    kind: "destructive",
    run: async (wp, a) => (await wp.delete(`/wp/v2/plugins/${a.plugin}`)).data,
  });

  defineTool(ctx, {
    name: "wp_plugin_update",
    description: "Update an installed plugin to its latest available version.",
    schema: { plugin: pluginFile },
    kind: "write",
    bridge: true,
    run: async (wp, a) => (await wp.request("POST", `${BRIDGE}/plugins/update`, { body: { plugin: a.plugin }, timeoutMs: 180_000 })).data,
  });

  defineTool(ctx, {
    name: "wp_themes_list",
    description: "List installed themes and which one is active.",
    schema: {},
    kind: "read",
    run: async (wp) =>
      (await wp.get<any[]>("/wp/v2/themes")).data.map((t) => ({
        stylesheet: t.stylesheet,
        template: t.template,
        name: t.name?.rendered ?? t.name,
        version: t.version,
        status: t.status,
      })),
  });

  defineTool(ctx, {
    name: "wp_theme_install",
    description: "Install a theme from the WordPress.org directory by slug, or from a zip URL, optionally activating it.",
    schema: {
      slug: z.string().regex(/^[a-z0-9-]+$/).optional(),
      zip_url: z.string().url().optional(),
      activate: z.boolean().optional(),
    },
    kind: "write",
    bridge: true,
    run: async (wp, a) => {
      if (!a.slug === !a.zip_url) throw new Error("Provide exactly one of slug or zip_url.");
      return (await wp.request("POST", `${BRIDGE}/themes/install`, { body: a, timeoutMs: 180_000 })).data;
    },
  });

  defineTool(ctx, {
    name: "wp_theme_activate",
    description: "Switch the site to an installed theme. This changes the look of the live site immediately.",
    schema: { stylesheet },
    kind: "write",
    bridge: true,
    run: async (wp, a) => (await wp.post(`${BRIDGE}/themes/activate`, a)).data,
  });

  defineTool(ctx, {
    name: "wp_theme_update",
    description: "Update an installed theme to its latest available version.",
    schema: { stylesheet },
    kind: "write",
    bridge: true,
    run: async (wp, a) => (await wp.request("POST", `${BRIDGE}/themes/update`, { body: a, timeoutMs: 180_000 })).data,
  });

  defineTool(ctx, {
    name: "wp_theme_delete",
    description: "Delete an installed theme and its files. The active theme cannot be deleted.",
    schema: { stylesheet },
    kind: "destructive",
    bridge: true,
    run: async (wp, a) => (await wp.delete(`${BRIDGE}/themes/${a.stylesheet}`)).data,
  });
}
