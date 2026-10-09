import { z } from "zod";
import { BRIDGE, defineTool, jsonRecord, type Ctx } from "./helpers.js";

export function registerSettingsTools(ctx: Ctx): void {
  defineTool(ctx, {
    name: "wp_settings_get",
    description: "Get the core site settings exposed over REST (title, tagline, URL, timezone, date format, reading and discussion settings, front page).",
    schema: {},
    kind: "read",
    run: async (wp) => (await wp.get("/wp/v2/settings")).data,
  });

  defineTool(ctx, {
    name: "wp_settings_update",
    description: "Update core site settings. `data` uses the keys returned by wp_settings_get, e.g. { title, description, timezone_string, posts_per_page, show_on_front, page_on_front }.",
    schema: { data: jsonRecord },
    kind: "write",
    run: async (wp, a) => (await wp.post("/wp/v2/settings", a.data)).data,
  });

  defineTool(ctx, {
    name: "wp_option_get",
    description: "Read any rows from the wp_options table by name, including plugin and theme settings that core REST does not expose.",
    schema: { names: z.array(z.string().min(1)).min(1).max(50) },
    kind: "read",
    bridge: true,
    run: async (wp, a) => (await wp.get(`${BRIDGE}/options`, { names: a.names })).data,
  });

  defineTool(ctx, {
    name: "wp_option_set",
    description:
      "Create, update or delete a wp_options row. Structured values (arrays/objects) are stored serialized, as WordPress does. A wrong value in a core option such as siteurl can take the site down.",
    schema: {
      name: z.string().min(1),
      value: z.unknown().optional().describe("New value; omit when deleting"),
      autoload: z.boolean().optional(),
      delete: z.boolean().optional().describe("Delete the option instead of setting it"),
    },
    kind: "write",
    classify: (a) => (a.delete ? "destructive" : "write"),
    bridge: true,
    run: async (wp, a) =>
      a.delete
        ? (await wp.delete(`${BRIDGE}/options`, { name: a.name })).data
        : (await wp.post(`${BRIDGE}/options`, { name: a.name, value: a.value, autoload: a.autoload })).data,
  });

  defineTool(ctx, {
    name: "wp_postmeta_get",
    description: "Read post meta (custom fields) for a post of any type, including meta keys not registered for REST. Omit `key` to get all meta.",
    schema: { id: z.number().int(), key: z.string().optional() },
    kind: "read",
    bridge: true,
    run: async (wp, a) => (await wp.get(`${BRIDGE}/postmeta/${a.id}`, { key: a.key })).data,
  });

  defineTool(ctx, {
    name: "wp_postmeta_set",
    description: "Set or delete a post meta value on a post of any type (SEO fields, ACF fields, page-builder data and other custom fields).",
    schema: {
      id: z.number().int(),
      key: z.string().min(1),
      value: z.unknown().optional(),
      delete: z.boolean().optional(),
    },
    kind: "write",
    classify: (a) => (a.delete ? "destructive" : "write"),
    bridge: true,
    run: async (wp, a) =>
      a.delete
        ? (await wp.delete(`${BRIDGE}/postmeta/${a.id}`, { key: a.key })).data
        : (await wp.post(`${BRIDGE}/postmeta/${a.id}`, { key: a.key, value: a.value })).data,
  });

  defineTool(ctx, {
    name: "wp_elementor_get",
    description: "Get the Elementor layout of a page or post as its element tree (sections, containers, widgets and their settings).",
    schema: { id: z.number().int() },
    kind: "read",
    bridge: true,
    run: async (wp, a) => (await wp.get(`${BRIDGE}/elementor/${a.id}`)).data,
  });

  defineTool(ctx, {
    name: "wp_elementor_set",
    description:
      "Replace the Elementor layout of a page or post with a new element tree and clear Elementor's CSS cache. Fetch the current tree with wp_elementor_get first and send back the full modified tree. Elementor keeps the previous layout as a revision when revisions are enabled.",
    schema: {
      id: z.number().int(),
      elements: z.array(jsonRecord).describe("Complete Elementor element tree"),
      page_settings: jsonRecord.optional(),
    },
    kind: "write",
    bridge: true,
    run: async (wp, a) => (await wp.post(`${BRIDGE}/elementor/${a.id}`, { elements: a.elements, page_settings: a.page_settings })).data,
  });
}
