// End-to-end check against a local WordPress Playground site.
// Start the site first (see README, "Testing"), then: node tests/integration/run.mjs
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const work = resolve(root, ".playground");
const siteUrl = process.env.WP_TEST_URL ?? "http://127.0.0.1:9400";
const password = readFileSync(resolve(work, "out/app-password.txt"), "utf8").trim();
const logDir = resolve(work, "logs");
rmSync(logDir, { recursive: true, force: true });
mkdirSync(logDir, { recursive: true });

const sitesPath = resolve(work, "sites.json");
const base = { url: siteUrl, username: "admin", appPasswordEnv: "WP_TEST_APP_PASSWORD" };
writeFileSync(
  sitesPath,
  JSON.stringify({
    sites: [
      { id: "test", ...base },
      { id: "plain", ...base, plainPermalinks: true },
      { id: "ro", ...base, readOnly: true },
      { id: "key", url: siteUrl, keyEnv: "WP_TEST_KEY" },
      { id: "badkey", url: siteUrl, keyEnv: "WP_TEST_BAD_KEY" },
    ],
  }),
);

const env = { ...process.env, WP_MCP_SITES: sitesPath, WP_TEST_APP_PASSWORD: password, WP_TEST_KEY: readFileSync(resolve(work, "out/key.txt"), "utf8").trim(), WP_TEST_BAD_KEY: "wpmcp_abcdefgh_" + "x".repeat(40), WP_MCP_LOG_DIR: logDir };
const entry = resolve(root, "dist/index.js");

let passed = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) passed++;
  else failures.push(`${name} ${detail}`);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ${detail}`}`);
}

const client = new Client({ name: "wp-mcp-integration", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env, stderr: "inherit" }));

async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { ok: !res.isError, text, data };
}
const t = (args) => ({ site: "test", ...args });

// --- discovery
const tools = (await client.listTools()).tools;
check("tools are registered", tools.length >= 35, `got ${tools.length}`);
console.log(`      ${tools.length} tools: ${tools.map((x) => x.name).join(", ")}`);

let r = await call("wp_list_sites");
check("wp_list_sites", r.ok && r.data.length === 5 && !r.text.includes(password));

r = await call("wp_site_info", t());
check("wp_site_info sees the bridge", r.ok && r.data.bridge?.bridge_version === "0.4.0" && r.data.authenticated_as?.username === "admin", r.text.slice(0, 300));

r = await call("wp_site_info", { site: "plain" });
check("plain-permalink routing works", r.ok && Array.isArray(r.data.namespaces), r.text.slice(0, 200));

r = await call("wp_site_health", t({ tests: ["authorization-header"] }));
check("wp_site_health", r.ok && r.data[0]?.test === "authorization-header", r.text.slice(0, 300));

r = await call("wp_discover", t());
check("wp_discover", r.ok && r.data.post_types.some((p) => p.resource === "pages"), r.text.slice(0, 200));

// --- content
r = await call("wp_create", t({ resource: "posts", data: { title: "MCP test post", content: "<p>Hello</p>", status: "draft" } }));
const postId = r.data?.id;
check("wp_create post", r.ok && Number.isInteger(postId), r.text.slice(0, 300));

r = await call("wp_update", t({ resource: "posts", id: postId, data: { title: "MCP test post (edited)" } }));
check("wp_update post", r.ok && r.data.title?.raw === "MCP test post (edited)", r.text.slice(0, 300));

r = await call("wp_get", t({ resource: "posts", id: postId, fields: ["id", "status", "content"] }));
check("wp_get returns raw content", r.ok && r.data.content?.raw === "<p>Hello</p>" && r.data.status === "draft", r.text.slice(0, 300));

r = await call("wp_list", t({ resource: "posts", status: "draft", search: "MCP test" }));
check("wp_list finds the draft", r.ok && r.data.total >= 1 && r.data.items.some((p) => p.id === postId), r.text.slice(0, 300));

r = await call("wp_create", t({ resource: "categories", data: { name: "MCP Cat" } }));
const catId = r.data?.id;
check("wp_create category", r.ok && Number.isInteger(catId), r.text.slice(0, 200));

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
r = await call("wp_media_upload", t({ base64: png, filename: "mcp-pixel.png", alt_text: "one pixel", post: postId }));
const mediaId = r.data?.id;
check("wp_media_upload", r.ok && r.data.mime_type === "image/png" && r.data.alt_text === "one pixel", r.text.slice(0, 300));

// --- bridge: meta, elementor, options
r = await call("wp_postmeta_set", t({ id: postId, key: "_mcp_test", value: { a: 1, b: ["x", 'q"uote'] } }));
check("wp_postmeta_set", r.ok && r.data.value?.b?.[1] === 'q"uote', r.text.slice(0, 300));
r = await call("wp_postmeta_get", t({ id: postId, key: "_mcp_test" }));
check("wp_postmeta_get", r.ok && r.data.value?.a === 1, r.text.slice(0, 300));
r = await call("wp_postmeta_set", t({ id: postId, key: "_mcp_test", delete: true }));
check("postmeta delete needs confirm", !r.ok && /confirm/.test(r.text));

const tree = [{ id: "abc1234", elType: "container", settings: { content_width: "full" }, elements: [{ id: "def5678", elType: "widget", widgetType: "heading", settings: { title: 'He said "hi" \\ ok' }, elements: [] }] }];
r = await call("wp_elementor_set", t({ id: postId, elements: tree }));
check("wp_elementor_set", r.ok && r.data.saved === true, r.text.slice(0, 300));
r = await call("wp_elementor_get", t({ id: postId }));
check("wp_elementor_get round-trips the tree", r.ok && JSON.stringify(r.data.elements) === JSON.stringify(tree) && r.data.built_with === "elementor", r.text.slice(0, 400));

r = await call("wp_option_set", t({ name: "mcp_test_option", value: { k: "v", n: [1, 2] } }));
check("wp_option_set", r.ok && r.data.value?.k === "v", r.text.slice(0, 200));
r = await call("wp_option_get", t({ names: ["mcp_test_option", "blogname", "mcp_missing"] }));
check("wp_option_get", r.ok && r.data.mcp_test_option.value.n[1] === 2 && r.data.mcp_missing.exists === false && r.data.blogname.exists, r.text.slice(0, 300));
r = await call("wp_option_set", t({ name: "mcp_test_option", delete: true, confirm: true }));
check("wp_option_set delete", r.ok && r.data.deleted === true, r.text.slice(0, 200));

r = await call("wp_settings_get", t());
const oldTagline = r.data?.description;
check("wp_settings_get", r.ok && typeof r.data.title === "string");
r = await call("wp_settings_update", t({ data: { description: "MCP tagline" } }));
check("wp_settings_update", r.ok && r.data.description === "MCP tagline", r.text.slice(0, 200));
await call("wp_settings_update", t({ data: { description: oldTagline ?? "" } }));

// --- plugins & themes
r = await call("wp_plugins_list", t());
check("wp_plugins_list", r.ok && r.data.some((p) => p.plugin === "wp-mcp-bridge/wp-mcp-bridge"), r.text.slice(0, 300));
r = await call("wp_plugin_install", t({ slug: "hello-dolly", activate: true }));
const dolly = r.data?.plugin;
check("wp_plugin_install + activate", r.ok && r.data.status === "active", r.text.slice(0, 300));
if (dolly) {
  r = await call("wp_plugin_update", t({ plugin: dolly }));
  check("wp_plugin_update (already current)", r.ok && r.data.updated === false, r.text.slice(0, 300));
  r = await call("wp_plugin_set_status", t({ plugin: dolly, status: "inactive" }));
  check("wp_plugin_set_status", r.ok && r.data.status === "inactive", r.text.slice(0, 200));
  r = await call("wp_plugin_delete", t({ plugin: dolly, confirm: true }));
  check("wp_plugin_delete", r.ok && r.data.deleted === true, r.text.slice(0, 200));
}

r = await call("wp_themes_list", t());
const original = r.data?.find?.((x) => x.status === "active")?.stylesheet;
check("wp_themes_list", r.ok && !!original, r.text.slice(0, 300));
r = await call("wp_theme_install", t({ slug: "twentytwenty" }));
check("wp_theme_install", r.ok && r.data.stylesheet === "twentytwenty", r.text.slice(0, 300));
r = await call("wp_theme_activate", t({ stylesheet: "twentytwenty" }));
check("wp_theme_activate", r.ok && r.data.active_theme === "twentytwenty", r.text.slice(0, 200));
r = await call("wp_theme_delete", t({ stylesheet: "twentytwenty", confirm: true }));
check("active theme cannot be deleted", !r.ok && /wp_mcp_theme_in_use/.test(r.text), r.text.slice(0, 200));
await call("wp_theme_activate", t({ stylesheet: original }));
r = await call("wp_theme_update", t({ stylesheet: "twentytwenty" }));
check("wp_theme_update (already current)", r.ok && r.data.updated === false, r.text.slice(0, 300));
r = await call("wp_theme_delete", t({ stylesheet: "twentytwenty", confirm: true }));
check("wp_theme_delete", r.ok && r.data.deleted === true, r.text.slice(0, 200));

// --- files, db, cron, cache, cli
const note = `note-${Date.now()}.txt`;
r = await call("wp_file_write", t({ path: `mcp-test/${note}`, content: "héllo", confirm: true }));
check("wp_file_write", r.ok && r.data.created === true, r.text.slice(0, 200));
r = await call("wp_file_read", t({ path: `mcp-test/${note}` }));
check("wp_file_read", r.ok && r.data.content === "héllo" && r.data.encoding === "utf8", r.text.slice(0, 200));
r = await call("wp_file_list", t({ path: "mcp-test" }));
check("wp_file_list", r.ok && r.data.entries.some((e) => e.name === note), r.text.slice(0, 200));
r = await call("wp_file_read", t({ path: "../wp-config.php" }));
check("path traversal is refused", !r.ok && /wp_mcp_bad_path/.test(r.text), r.text.slice(0, 200));
r = await call("wp_file_write", t({ path: `mcp-test/${note}`, content: "x" }));
check("file write needs confirm", !r.ok && /confirm/.test(r.text));

r = await call("wp_db_query", t({ sql: `SELECT ID, post_title FROM {prefix}posts WHERE ID = ${postId}` }));
check("wp_db_query select", r.ok && r.data.rows?.[0]?.post_title === "MCP test post (edited)", r.text.slice(0, 300));
r = await call("wp_db_query", t({ sql: `UPDATE {prefix}posts SET post_excerpt = 'x' WHERE ID = ${postId}` }));
check("db write needs confirm", !r.ok && /confirm/.test(r.text));
r = await call("wp_db_query", t({ sql: `UPDATE {prefix}posts SET post_excerpt = 'via sql' WHERE ID = ${postId}`, confirm: true }));
check("wp_db_query write", r.ok && r.data.affected_rows === 1, r.text.slice(0, 200));

r = await call("wp_cron_list", t());
const hook = r.data?.[0]?.hook;
check("wp_cron_list", r.ok && !!hook, r.text.slice(0, 200));
r = await call("wp_cron_run", t({ hook }));
check("wp_cron_run", r.ok && r.data.runs >= 1, r.text.slice(0, 200));
r = await call("wp_cache_flush", t());
check("wp_cache_flush", r.ok && r.data.flushed.includes("object cache"), r.text.slice(0, 200));

r = await call("wp_cli", t({ command: "plugin list" }));
check("wp_cli is gated off by default", !r.ok && /WP_MCP_ALLOW_CLI/.test(r.text), r.text.slice(0, 200));
r = await call("wp_cli", t({ command: "plugin delete akismet" }));
check("wp_cli write needs confirm", !r.ok && /confirm/.test(r.text));

// --- escape hatches and guards
r = await call("wp_rest_request", t({ method: "GET", route: "/wp/v2/statuses" }));
check("wp_rest_request", r.ok && !!r.data.publish, r.text.slice(0, 200));
r = await call("wc_request", t({ method: "GET", path: "products" }));
check("wc_request reports missing WooCommerce cleanly", !r.ok && /rest_no_route/.test(r.text), r.text.slice(0, 200));
r = await call("wp_list", { site: "nope", resource: "posts" });
check("unknown site is rejected", !r.ok && /Unknown site/.test(r.text));
r = await call("wp_create", { site: "ro", resource: "posts", data: { title: "x" } });
check("read-only site blocks writes", !r.ok && /read-only/.test(r.text));
r = await call("wp_list", { site: "ro", resource: "posts", status: "any" });
check("read-only site allows reads", r.ok);

// --- Bricks (the test site has no Bricks theme, so this covers storage and tree editing, not rendering)
r = await call("wp_create", t({ resource: "pages", data: { title: "Bricks test page", status: "draft" } }));
const bricksPage = r.data?.id;
r = await call("bricks_add_elements", t({ id: bricksPage, elements: [{ name: "section", label: "Hero", children: [{ name: "container", children: [{ name: "heading", settings: { text: "Hello \"quoted\" \ world", tag: "h1" } }, { name: "text-basic", settings: { text: "Body" } }] }] }] }));
check("bricks_add_elements builds a nested section", r.ok && r.data.elements === 4 && r.data.added_ids?.length === 4 && r.data.added?.[0]?.children?.[0]?.children?.length === 2, r.text.slice(0, 400));
const headingId = r.data?.added?.[0]?.children?.[0]?.children?.[0]?.id;
const containerId = r.data?.added?.[0]?.children?.[0]?.id;
r = await call("bricks_get", t({ id: bricksPage }));
check("bricks_get returns a compact outline", r.ok && r.data.built_with === "bricks" && r.data.element_count === 4 && r.data.outline[0].label === "Hero" && !r.text.includes("\"settings\""), r.text.slice(0, 400));
r = await call("bricks_update_element", t({ id: bricksPage, element_id: headingId, settings: { text: "Changed" }, label: "Title" }));
check("bricks_update_element merges settings", r.ok && r.data.element?.settings?.text === "Changed" && r.data.element.settings.tag === "h1" && r.data.element.label === "Title", r.text.slice(0, 400));
r = await call("bricks_get", t({ id: bricksPage, element_id: headingId }));
check("bricks_get returns one element in full", r.ok && r.data.elements.length === 1 && r.data.elements[0].settings.text === "Changed" && r.data.undo_available, r.text.slice(0, 400));
r = await call("bricks_undo", t({ id: bricksPage }));
r = await call("bricks_get", t({ id: bricksPage, element_id: headingId }));
check("bricks_undo restores the previous version exactly", r.ok && r.data.elements[0].settings.text === "Hello \"quoted\" \ world", r.text.slice(0, 400));
r = await call("bricks_add_elements", t({ id: bricksPage, elements: [{ name: "section", label: "CTA", children: [{ name: "button", settings: { text: "Call" } }] }], position: 0 }));
const ctaId = r.data?.added?.[0]?.id;
r = await call("bricks_move_element", t({ id: bricksPage, element_id: headingId, parent_id: ctaId, position: 0 }));
r = await call("bricks_get", t({ id: bricksPage }));
check("bricks_move_element and root position", r.ok && r.data.outline[0].id === ctaId && r.data.outline[0].children[0].id === headingId && r.data.outline[1].children[0].children.length === 1, r.text.slice(0, 500));
r = await call("bricks_remove_element", t({ id: bricksPage, element_id: containerId }));
check("bricks remove needs confirm", !r.ok && /confirm/.test(r.text));
r = await call("bricks_remove_element", t({ id: bricksPage, element_id: containerId, confirm: true }));
check("bricks_remove_element removes the subtree", r.ok && r.data.removed_ids.length === 2 && r.data.elements === 4, r.text.slice(0, 300));
r = await call("bricks_update_element", t({ id: bricksPage, element_id: "zzzzzz", settings: {} }));
check("unknown Bricks element id is reported", !r.ok && /No element/.test(r.text), r.text.slice(0, 200));
r = await call("bricks_set", t({ id: bricksPage, confirm: true, elements: [{ id: "aaaaaa", name: "section", parent: 0, children: ["bbbbbb"] }] }));
check("bricks_set rejects a broken tree", !r.ok && /bbbbbb|does not exist|different parent/.test(r.text), r.text.slice(0, 200));
r = await call("bricks_get", t({ id: bricksPage, full: true }));
const copied = r.data.elements;
r = await call("bricks_set", t({ id: bricksPage, confirm: true, elements: copied }));
check("bricks_set round-trips a full tree", r.ok && r.data.elements === copied.length, r.text.slice(0, 200));
r = await call("bricks_templates_list", t());
check("bricks_templates_list", r.ok && Array.isArray(r.data), r.text.slice(0, 200));
r = await call("bricks_template_create", t({ title: "X", type: "header" }));
check("template create explains when Bricks is not active", !r.ok && /wp_mcp_bricks_inactive/.test(r.text), r.text.slice(0, 200));
r = await call("bricks_global_upsert", t({ what: "classes", item: { name: "mcp-btn", settings: { _cssCustom: ".mcp-btn{color:red}" } } }));
const classId = r.data?.item?.id;
check("bricks_global_upsert creates a class", r.ok && r.data.created === true && /^[a-z0-9]{6}$/.test(classId), r.text.slice(0, 300));
r = await call("bricks_global_upsert", t({ what: "classes", item: { name: "mcp-btn", category: "buttons" } }));
check("bricks_global_upsert updates by name and keeps settings", r.ok && r.data.created === false && r.data.item.id === classId && r.data.item.settings._cssCustom && r.data.item.category === "buttons", r.text.slice(0, 300));
r = await call("bricks_globals_get", t({ what: "classes", search: "mcp" }));
check("bricks_globals_get lists compactly", r.ok && r.data.total === 1 && r.data.items[0].name === "mcp-btn" && r.data.items[0].sets[0] === "_cssCustom" && !r.text.includes("color:red"), r.text.slice(0, 300));
r = await call("bricks_update_element", t({ id: bricksPage, element_id: ctaId, settings: { _cssGlobalClasses: [classId] } }));
r = await call("bricks_get", t({ id: bricksPage }));
check("outline shows global class names", r.ok && r.data.outline[0].classes?.[0] === "mcp-btn", r.text.slice(0, 300));
r = await call("bricks_global_delete", t({ what: "classes", id: classId, confirm: true }));
check("bricks_global_delete", r.ok && r.data.deleted === true, r.text.slice(0, 200));
await call("wp_delete", t({ resource: "pages", id: bricksPage, force: true, confirm: true }));

// --- connection key login
r = await call("wp_site_info", { site: "key" });
check("connection key logs in as its owner", r.ok && r.data.authenticated_as?.username === "admin", r.text.slice(0, 300));
r = await call("wp_option_set", { site: "key", name: "mcp_key_test", value: "1" });
check("connection key can write", r.ok && r.data.value === "1", r.text.slice(0, 200));
await call("wp_option_set", { site: "key", name: "mcp_key_test", delete: true, confirm: true });
r = await call("wp_site_info", { site: "badkey" });
check("a wrong connection key is rejected clearly", !r.ok && /wp_mcp_invalid_key/.test(r.text), r.text.slice(0, 200));
r = await call("wp_option_set", t({ name: "wp_mcp_bridge_keys", value: {} }));
check("agent cannot touch the stored keys", !r.ok && /wp_mcp_protected/.test(r.text), r.text.slice(0, 200));

// --- site-side protections and activity log
r = await call("wp_option_set", t({ name: "wp_mcp_bridge_settings", value: { allow_cli: true } }));
check("agent cannot change the bridge settings", !r.ok && /wp_mcp_protected/.test(r.text), r.text.slice(0, 200));
r = await call("wp_db_query", t({ sql: "DELETE FROM {prefix}wp_mcp_log", confirm: true }));
check("agent cannot wipe the activity log with SQL", !r.ok && /wp_mcp_protected/.test(r.text), r.text.slice(0, 200));
r = await call("wp_activity_log", t({ kind: "writes", per_page: 200 }));
check("wp_activity_log records changes", r.ok && r.data.total > 10 && r.data.entries.some((e) => e.method === "POST" && e.route === "/wp/v2/posts" && Number(e.status) === 201), r.text.slice(0, 400));
check("activity log has no reads by default and no secrets", r.ok && r.data.entries.every((e) => e.method !== "GET") && !r.text.includes(password));
r = await call("wp_activity_log", t({ kind: "errors" }));
check("wp_activity_log filters errors", r.ok && r.data.total >= 1 && r.data.entries.every((e) => Number(e.status) >= 400), r.text.slice(0, 300));

// --- cleanup through the tools under test
r = await call("wp_delete", t({ resource: "posts", id: postId, force: true }));
check("delete needs confirm", !r.ok && /confirm/.test(r.text));
r = await call("wp_delete", t({ resource: "media", id: mediaId, force: true, confirm: true }));
check("wp_delete media", r.ok && r.data.deleted === true, r.text.slice(0, 200));
r = await call("wp_delete", t({ resource: "categories", id: catId, force: true, confirm: true }));
check("wp_delete category", r.ok && r.data.deleted === true, r.text.slice(0, 200));
r = await call("wp_delete", t({ resource: "posts", id: postId, force: true, confirm: true }));
check("wp_delete post", r.ok && r.data.deleted === true, r.text.slice(0, 200));
await client.close();

// --- audit log
const auditPath = resolve(logDir, "audit.jsonl");
const lines = existsSync(auditPath) ? readFileSync(auditPath, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
check("audit log records writes only", lines.length > 10 && lines.every((l) => l.kind !== "read") && lines.some((l) => l.tool === "wp_create" && l.ok));
check("audit log records blocked calls", lines.some((l) => l.site === "ro" && l.ok === false));

// --- HTTP transport
const token = "integration-test-token-0123456789";
const port = 3941;
const http = spawn(process.execPath, [entry, "--http"], { env: { ...env, WP_MCP_TOKEN: token, WP_MCP_PORT: String(port) }, stdio: ["ignore", "ignore", "pipe"] });
await new Promise((ok, fail) => {
  http.stderr.on("data", (d) => String(d).includes("HTTP server on") && ok());
  http.on("exit", (code) => fail(new Error(`http server exited with ${code}`)));
  setTimeout(() => fail(new Error("http server did not start")), 15000);
});
try {
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  const anon = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  check("HTTP rejects a missing token", anon.status === 401);
  const wrong = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer nope" }, body: "{}" });
  check("HTTP rejects a wrong token", wrong.status === 401);

  const remote = new Client({ name: "wp-mcp-integration-http", version: "0" });
  await remote.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const list = await remote.listTools();
  const res = await remote.callTool({ name: "wp_list", arguments: { site: "test", resource: "pages" } });
  check("HTTP transport serves tools", list.tools.length === tools.length && !res.isError, res.content?.[0]?.text?.slice(0, 200));
  await remote.close();
} finally {
  http.kill();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => ` - ${f}`).join("\n"));
  process.exit(1);
}
