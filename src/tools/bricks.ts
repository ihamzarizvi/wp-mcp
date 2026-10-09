import { z } from "zod";
import * as bricks from "../bricks.js";
import type { WpClient } from "../wp-client.js";
import { BRIDGE, defineTool, jsonRecord, type Ctx } from "./helpers.js";

const postId = z.number().int().describe("Page, post or Bricks template id");
const area = z
  .enum(["content", "header", "footer"])
  .optional()
  .describe("Which element tree. Default: header/footer for header/footer templates, otherwise content");
const elementId = z.string().regex(/^[a-z0-9]+$/i).describe("Bricks element id from bricks_get");

const elementSpec: z.ZodType<bricks.ElementSpec> = z.lazy(() =>
  z.object({
    name: z.string().describe("Bricks element type, e.g. section, container, block, div, heading, text-basic, text, button, image, icon, list, video, code"),
    settings: jsonRecord.optional(),
    label: z.string().optional().describe("Name shown in the builder's structure panel"),
    children: z.array(elementSpec).optional(),
  }),
);

interface Page {
  id: number;
  title: string;
  area: string;
  link: string;
  global_classes: Record<string, string>;
  elements: bricks.BricksElement[];
  [key: string]: unknown;
}

async function load(wp: WpClient, id: number, areaName?: string): Promise<Page> {
  const page = (await wp.get<Page>(`${BRIDGE}/bricks/${id}`, { area: areaName })).data;
  page.elements = bricks.normalise(page.elements ?? []);
  return page;
}

/** Validates locally first, so a broken tree never reaches the site. */
async function save(wp: WpClient, page: Page, elements: bricks.BricksElement[]) {
  bricks.validate(elements);
  return (await wp.post<Record<string, unknown>>(`${BRIDGE}/bricks/${page.id}`, { area: page.area, elements })).data;
}

export function registerBricksTools(ctx: Ctx): void {
  defineTool(ctx, {
    name: "bricks_get",
    description:
      "Read a Bricks Builder page, post or template. By default returns a compact outline (id, element type, label, text snippet, classes, nesting) without settings, because full pages are large. Pass element_id to get one element with its full settings (add subtree: true for everything nested in it), or full: true for every element.",
    schema: {
      id: postId,
      area,
      element_id: elementId.optional(),
      subtree: z.boolean().optional().describe("With element_id: also return all nested elements in full"),
      full: z.boolean().optional().describe("Return every element with full settings as Bricks stores them"),
    },
    kind: "read",
    bridge: true,
    run: async (wp, a) => {
      const { elements, global_classes, ...meta } = await load(wp, a.id, a.area);
      const info = { ...meta, element_count: elements.length };
      if (a.element_id) {
        const nested = bricks.subtree(elements, a.element_id);
        return { ...info, global_classes, elements: a.subtree ? nested : [nested[0]], outline: bricks.outline(elements, global_classes, a.element_id) };
      }
      if (a.full) return { ...info, global_classes, elements };
      return { ...info, outline: bricks.outline(elements, global_classes) };
    },
  });

  defineTool(ctx, {
    name: "bricks_update_element",
    description:
      'Change one element on a Bricks page. `settings` is merged into the existing settings (only the keys you send change), e.g. heading/text-basic/button: { text }, heading: { tag: "h2" }, button: { link: { type: "external", url } }, image: { image: { id, url, size } }, any element: { _cssClasses, _cssGlobalClasses: [classId], _cssCustom }. Read the element with bricks_get first to see its current settings. The previous version of the page is kept for bricks_undo.',
    schema: {
      id: postId,
      area,
      element_id: elementId,
      settings: jsonRecord.optional().describe("Settings to merge in"),
      remove_settings: z.array(z.string()).optional().describe("Setting keys to delete"),
      replace_settings: z.boolean().optional().describe("Replace all settings with `settings` instead of merging"),
      label: z.string().optional().describe("New structure-panel label; empty string clears it"),
    },
    kind: "write",
    bridge: true,
    run: async (wp, a) => {
      const page = await load(wp, a.id, a.area);
      const element = bricks.updateElement(page.elements, a.element_id, {
        settings: a.settings,
        removeSettings: a.remove_settings,
        replaceSettings: a.replace_settings,
        label: a.label,
      });
      return { ...(await save(wp, page, page.elements)), element };
    },
  });

  defineTool(ctx, {
    name: "bricks_add_elements",
    description:
      "Add new elements to a Bricks page, nested as given; ids are generated. Without parent_id they are added at the top level (normally sections). `position` is the index among the parent's children (0 = first); omitted = last. Typical structure: section > container > heading / text-basic / button. Returns the new ids.",
    schema: {
      id: postId,
      area,
      elements: z.array(elementSpec).min(1),
      parent_id: elementId.optional().describe("Existing element to add into; omit for top level"),
      position: z.number().int().min(0).optional(),
    },
    kind: "write",
    bridge: true,
    run: async (wp, a) => {
      const page = await load(wp, a.id, a.area);
      const result = bricks.addElements(page.elements, a.elements, a.parent_id, a.position);
      const saved = await save(wp, page, result.elements);
      return { ...saved, added_ids: result.addedIds, added: result.topIds.flatMap((id) => bricks.outline(result.elements, page.global_classes, id)) };
    },
  });

  defineTool(ctx, {
    name: "bricks_move_element",
    description: "Move an element (with everything inside it) to another parent or position on the same Bricks page. Omit parent_id to move it to the top level.",
    schema: {
      id: postId,
      area,
      element_id: elementId,
      parent_id: elementId.optional(),
      position: z.number().int().min(0).optional().describe("Index among the new parent's children; omitted = last"),
    },
    kind: "write",
    bridge: true,
    run: async (wp, a) => {
      const page = await load(wp, a.id, a.area);
      return save(wp, page, bricks.moveElement(page.elements, a.element_id, a.parent_id, a.position));
    },
  });

  defineTool(ctx, {
    name: "bricks_remove_element",
    description: "Remove an element and everything nested inside it from a Bricks page. The previous version of the page is kept for bricks_undo.",
    schema: { id: postId, area, element_id: elementId },
    kind: "destructive",
    bridge: true,
    run: async (wp, a) => {
      const page = await load(wp, a.id, a.area);
      const result = bricks.removeElement(page.elements, a.element_id);
      return { ...(await save(wp, page, result.elements)), removed_ids: result.removedIds };
    },
  });

  defineTool(ctx, {
    name: "bricks_set",
    description:
      "Replace the whole element tree of a Bricks page or template with a flat Bricks element array (each: id, name, parent (0 for top level), children [ids], settings, optional label), for example to copy a layout from another page (bricks_get with full: true). For edits to an existing page prefer bricks_update_element / bricks_add_elements. The previous version is kept for bricks_undo.",
    schema: { id: postId, area, elements: z.array(jsonRecord) },
    kind: "destructive",
    bridge: true,
    run: async (wp, a) => {
      const page = await load(wp, a.id, a.area);
      return save(wp, page, bricks.normalise(a.elements));
    },
  });

  defineTool(ctx, {
    name: "bricks_undo",
    description: "Restore the version of a Bricks page that existed before the last change made through these tools. Calling it again redoes that change. One level only.",
    schema: { id: postId, area },
    kind: "write",
    bridge: true,
    run: async (wp, a) => (await wp.post(`${BRIDGE}/bricks/${a.id}/undo`, { area: a.area })).data,
  });

  defineTool(ctx, {
    name: "bricks_templates_list",
    description: "List Bricks templates (header, footer, section, content, archive, popup, etc.) with type, status, element count and display conditions. Read or edit a template's elements with the other bricks_ tools using its id.",
    schema: { type: z.string().optional().describe("Only this template type, e.g. header, footer, section, content, archive, popup") },
    kind: "read",
    bridge: true,
    run: async (wp, a) => (await wp.get(`${BRIDGE}/bricks/templates`, a)).data,
  });

  defineTool(ctx, {
    name: "bricks_template_create",
    description: "Create an empty Bricks template (draft unless status is publish). Fill it afterwards with bricks_add_elements or bricks_set. A published header or footer template with conditions replaces the site's header or footer where the conditions match.",
    schema: {
      title: z.string().min(1),
      type: z.string().regex(/^[a-z0-9_-]+$/).describe("header, footer, content, section, archive, search, error, popup, or a WooCommerce type such as wc_product"),
      status: z.enum(["draft", "publish"]).optional(),
      conditions: z.array(jsonRecord).optional().describe('Bricks template conditions, e.g. [{ "main": "any" }] for the entire website'),
    },
    kind: "write",
    bridge: true,
    run: async (wp, a) => (await wp.post(`${BRIDGE}/bricks/templates`, a)).data,
  });

  defineTool(ctx, {
    name: "bricks_globals_get",
    description:
      "Read Bricks global data: classes, class_categories, variables, variable_categories, colors (palettes), theme_styles, components, pseudo_classes, breakpoints. Returns a compact list by default (class names without their styles); use search to narrow, id for one item in full, or full: true for full items. At most 500 items per call.",
    schema: {
      what: z.enum(["classes", "class_categories", "variables", "variable_categories", "colors", "theme_styles", "components", "pseudo_classes", "breakpoints"]),
      search: z.string().optional().describe("Match against id, name, label or category"),
      id: z.string().optional(),
      full: z.boolean().optional(),
    },
    kind: "read",
    bridge: true,
    run: async (wp, a) => (await wp.get(`${BRIDGE}/bricks/globals`, a)).data,
  });

  defineTool(ctx, {
    name: "bricks_global_upsert",
    description:
      'Create or update one Bricks global class or CSS variable. Matches an existing item by id, or by name when no id is given; fields you omit keep their value. Class: { name, settings: { _typography, _background, _padding, _cssCustom, ... }, category? }. Variable: { name, value, category? } (name without the leading "--"). Changing a class or variable affects every element that uses it across the site.',
    schema: {
      what: z.enum(["classes", "variables"]),
      item: jsonRecord,
    },
    kind: "write",
    bridge: true,
    run: async (wp, a) => (await wp.post(`${BRIDGE}/bricks/globals/item`, a)).data,
  });

  defineTool(ctx, {
    name: "bricks_global_delete",
    description: "Delete one Bricks global class or CSS variable by id. Elements that use it lose that styling.",
    schema: { what: z.enum(["classes", "variables"]), id: z.string().min(1) },
    kind: "destructive",
    bridge: true,
    run: async (wp, a) => (await wp.delete(`${BRIDGE}/bricks/globals/item`, a)).data,
  });
}
