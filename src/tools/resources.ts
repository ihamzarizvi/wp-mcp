import { z } from "zod";
import { defineTool, jsonRecord, type Ctx } from "./helpers.js";

// Unknown names in _fields are ignored by WordPress, so one compact list
// serves posts, terms, users, comments, media and menu items alike.
const COMPACT_FIELDS =
  "id,date,modified,slug,status,type,link,title,name,parent,author,author_name,post,count,taxonomy,username,email,roles,mime_type,source_url,menus,menu_order,url";

const resource = z
  .string()
  .regex(/^\/?[a-zA-Z0-9_\-\/]+$/)
  .describe(
    'REST collection. A bare name maps to /wp/v2/<name>: posts, pages, media, categories, tags, comments, users, menus, menu-items, blocks, templates, or any custom post type / taxonomy rest_base (see wp_discover). A value starting with "/" is used as a full route, e.g. /wc/v3/products.',
  );

export function resourceRoute(name: string, id?: number | string): string {
  const base = name.startsWith("/") ? name.replace(/\/+$/, "") : `/wp/v2/${name}`;
  return id === undefined ? base : `${base}/${id}`;
}

const id = z.union([z.number().int(), z.string().regex(/^[\w-]+$/)]).describe("Item id");

export function registerResourceTools(ctx: Ctx): void {
  defineTool(ctx, {
    name: "wp_discover",
    description: "List the post types and taxonomies registered on the site with their rest_base, for use as the `resource` argument of wp_list/get/create/update/delete.",
    schema: {},
    kind: "read",
    run: async (wp) => {
      const [types, taxonomies] = await Promise.all([
        wp.get<Record<string, any>>("/wp/v2/types", { context: "edit" }),
        wp.get<Record<string, any>>("/wp/v2/taxonomies", { context: "edit" }),
      ]);
      const pick = (o: Record<string, any>) =>
        Object.values(o).map((t) => ({ slug: t.slug, name: t.name, resource: t.rest_base, namespace: t.rest_namespace }));
      return {
        post_types: pick(types.data),
        taxonomies: pick(taxonomies.data),
        other: ["comments", "users", "plugins", "themes", "settings"],
      };
    },
  });

  defineTool(ctx, {
    name: "wp_list",
    description:
      "List items of any REST resource (posts, pages, media, categories, tags, comments, users, menus, menu-items, custom types). Returns a compact summary plus total counts; pass `fields` or use wp_get for full detail.",
    schema: {
      resource,
      search: z.string().optional(),
      status: z.string().optional().describe('Post/comment status filter, e.g. "publish", "draft", "any"'),
      page: z.number().int().min(1).optional(),
      per_page: z.number().int().min(1).max(100).optional().describe("Default 20"),
      orderby: z.string().optional(),
      order: z.enum(["asc", "desc"]).optional(),
      fields: z.array(z.string()).optional().describe("Fields to return instead of the compact default"),
      query: jsonRecord.optional().describe("Any other REST query parameters, e.g. { categories: [3], author: 1, menus: 5 }"),
    },
    kind: "read",
    run: async (wp, a) => {
      const res = await wp.get(resourceRoute(a.resource), {
        per_page: a.per_page ?? 20,
        page: a.page,
        search: a.search,
        status: a.status,
        orderby: a.orderby,
        order: a.order,
        _fields: a.fields?.join(",") ?? COMPACT_FIELDS,
        ...a.query,
      });
      return { total: res.total, total_pages: res.totalPages, page: a.page ?? 1, items: res.data };
    },
  });

  defineTool(ctx, {
    name: "wp_get",
    description: "Get one item of any REST resource. Uses the edit context by default so raw (unrendered) content and all editable fields are returned.",
    schema: {
      resource,
      id,
      context: z.enum(["view", "edit", "embed"]).optional(),
      fields: z.array(z.string()).optional(),
    },
    kind: "read",
    run: async (wp, a) =>
      (await wp.get(resourceRoute(a.resource, a.id), { context: a.context ?? "edit", _fields: a.fields?.join(",") })).data,
  });

  defineTool(ctx, {
    name: "wp_create",
    description:
      'Create an item in any REST resource. `data` holds the REST fields, e.g. posts/pages: { title, content, status, slug, excerpt, categories, tags, featured_media, parent, meta }; categories/tags: { name, slug, parent, description }; users: { username, email, password, roles }; comments: { post, content, author_name }; menus: { name }; menu-items: { title, url, menus, parent, menu_order, object, object_id, type, status: "publish" }. New posts default to draft.',
    schema: { resource, data: jsonRecord },
    kind: "write",
    run: async (wp, a) => (await wp.post(resourceRoute(a.resource), a.data)).data,
  });

  defineTool(ctx, {
    name: "wp_update",
    description: "Update fields of an existing item in any REST resource. Only the fields present in `data` change.",
    schema: { resource, id, data: jsonRecord },
    kind: "write",
    run: async (wp, a) => (await wp.post(resourceRoute(a.resource, a.id), a.data)).data,
  });

  defineTool(ctx, {
    name: "wp_delete",
    description:
      "Delete an item from any REST resource. Posts, pages and comments go to trash unless force is true; terms, users, menus, menu-items and media cannot be trashed and need force: true. Deleting a user requires `reassign` (a user id to inherit their content).",
    schema: {
      resource,
      id,
      force: z.boolean().optional().describe("Permanently delete instead of trashing"),
      reassign: z.number().int().optional().describe("Users only: id of the user who receives the deleted user's content"),
    },
    kind: "destructive",
    run: async (wp, a) => (await wp.delete(resourceRoute(a.resource, a.id), { force: a.force, reassign: a.reassign })).data,
  });
}
