# WP-MCP

One MCP server that gives AI agents full admin control over **many WordPress sites on any host**. Works with Claude Code, Claude Desktop, Hermes Agent and any other MCP client over stdio or HTTP.

Developed by [Hamza Rizvi](https://hamzarizvi.com).

## How it works

```
MCP client ──stdio or HTTP──> wp-mcp server ──HTTPS + Application Password──> site A (core REST + bridge plugin)
                                                                          ──> site B (core REST only)
```

- **The server** (this repo, Node 20+) holds a registry of sites and talks to each over the WordPress REST API.
- **The bridge plugin** (`bridge-plugin/wp-mcp-bridge`) is optional per site. It adds what core REST lacks: theme install/switch, plugin and theme updates, any option, any post meta, Elementor layouts, cron, cache flushing, and (off by default) file, database and WP-CLI access.

## Tools

Every tool except `wp_list_sites` takes a `site` id.

| Area | Tools | Needs bridge |
|---|---|---|
| Sites | `wp_list_sites`, `wp_site_info`, `wp_site_health` | no |
| Any content | `wp_discover`, `wp_list`, `wp_get`, `wp_create`, `wp_update`, `wp_delete` | no |
| Media | `wp_media_upload` (file path, URL or base64) | no |
| Plugins | `wp_plugins_list`, `wp_plugin_install`, `wp_plugin_set_status`, `wp_plugin_delete` | no |
| Plugins | `wp_plugin_update` | yes |
| Themes | `wp_themes_list` | no |
| Themes | `wp_theme_install`, `wp_theme_activate`, `wp_theme_update`, `wp_theme_delete` | yes |
| Settings | `wp_settings_get`, `wp_settings_update` | no |
| Options and meta | `wp_option_get`, `wp_option_set`, `wp_postmeta_get`, `wp_postmeta_set` | yes |
| Elementor | `wp_elementor_get`, `wp_elementor_set` | yes |
| Bricks pages | `bricks_get`, `bricks_update_element`, `bricks_add_elements`, `bricks_move_element`, `bricks_remove_element`, `bricks_set`, `bricks_undo` | yes |
| Bricks templates | `bricks_templates_list`, `bricks_template_create` | yes |
| Bricks globals | `bricks_globals_get`, `bricks_global_upsert`, `bricks_global_delete` (classes, variables; colours, theme styles and more read-only) | yes |
| Maintenance | `wp_cache_flush`, `wp_cron_list`, `wp_cron_run`, `wp_activity_log` | yes |
| Files | `wp_file_list`, `wp_file_read`, `wp_file_write` | yes + enabled in its settings |
| Database | `wp_db_query` | yes + enabled in its settings |
| WP-CLI | `wp_cli` | yes + enabled in its settings |
| WooCommerce | `wc_request` | no (needs WooCommerce) |
| Anything else | `wp_rest_request` (any REST route of any plugin) | no |

The six content tools take a `resource` argument and cover posts, pages, media, categories, tags, comments, users, menus (`menus`, `menu-items`), reusable blocks, templates and every custom post type or taxonomy. A resource starting with `/` is used as a full route, e.g. `/wc/v3/products`.

### Bricks Builder

Bricks pages are edited element by element instead of being re-sent whole. `bricks_get` returns a compact outline (ids, element types, labels, text snippets, class names); the agent then reads one element in full, changes it with `bricks_update_element`, or adds, moves and removes elements. Every tree is validated before it is saved, the version before each change is kept so `bricks_undo` can restore it (one level), and CSS files are regenerated on sites that load Bricks CSS from files. Header and footer templates are handled the same way by template id.

## Setup

### 1. Install and build

```bash
npm install
npm run build
```

### 2. Prepare each WordPress site

There are two ways to log in to a site. Pick one per site.

**Connection key (recommended).** Upload `wp-mcp-bridge.zip` (a zip of `bridge-plugin/wp-mcp-bridge`) in **Plugins > Add New > Upload**, activate it, open **WP MCP** in the admin menu and click **Create connection key**. The page shows the `.env` line and the `sites.json` entry to copy. Keys work on hosts where Application Passwords are disabled or the `Authorization` header is stripped, act as the administrator who created them, are stored only as a hash, and can be revoked from the same page.

**Application Password.** Works without the plugin (core REST tools only). Create one under **Users > Profile > Application Passwords** for a dedicated administrator, and use `username` plus `appPasswordEnv` in `sites.json`.

The plugin adds a **WP MCP** screen to WP Admin with three tabs:

- **Connection**: a button that creates a connection key, the ready-made `sites.json` entry and `.env` line for this site, the existing keys with a revoke button, the Application Password alternative, what the agent may do here, and environment checks.
- **Settings**: switch MCP access off entirely, put the site in read-only mode, restrict access to listed IP addresses, enable file, database and WP-CLI access, and set log retention.
- **Activity**: every change the wp-mcp server made on this site (time, user, request, result, parameters with secrets redacted), filterable and searchable. Reads are logged too if you turn that on.

The three powerful features are off until enabled on the Settings tab. A constant in `wp-config.php` overrides the matching setting and locks it, for sites where even administrators should not be able to change it:

```php
define( 'WP_MCP_ALLOW_FILES', false );
define( 'WP_MCP_ALLOW_DB', false );
define( 'WP_MCP_ALLOW_CLI', false );
define( 'WP_MCP_CLI_PATH', '/usr/local/bin/wp' ); // optional, default "wp"
```

In site read-only mode every non-GET request is refused, which includes `wp_cli` and `wp_db_query` even for read-only commands, since both are sent as POST.

### 3. Register the sites

Copy `sites.example.json` to `sites.json` and `.env.example` to `.env`. Both are gitignored.

```json
{
  "sites": [
    { "id": "shop", "url": "https://shop.example.com", "keyEnv": "WP_SITE_SHOP_KEY" },
    { "id": "blog", "url": "https://blog.example.com", "username": "mcp-admin", "appPasswordEnv": "WP_SITE_BLOG_APP_PASSWORD", "readOnly": true }
  ]
}
```

Secrets live only in `.env` (or the client's `env` block), keyed by `keyEnv` or `appPasswordEnv`. A connection key is only accepted for `https://` sites (or localhost). Per-site options: `readOnly` blocks every write; `plainPermalinks` uses `?rest_route=` for sites without pretty permalinks.

### 4. Connect a client

**Claude Code**

```bash
claude mcp add wp-mcp -- node C:/path/to/WP-MCP/dist/index.js
```

**Claude Desktop** (`claude_desktop_config.json`) and most other stdio clients:

```json
{
  "mcpServers": {
    "wp-mcp": { "command": "node", "args": ["C:/path/to/WP-MCP/dist/index.js"] }
  }
}
```

**Hermes Agent** (`~/.hermes/config.yaml`):

```yaml
mcp_servers:
  wp-mcp:
    command: node
    args: ["C:/path/to/WP-MCP/dist/index.js"]
```

**Remote agents (HTTP)**: set `WP_MCP_TOKEN` in `.env` to a long random string, then:

```bash
npm run start:http
```

The endpoint is `http://127.0.0.1:3939/mcp` (Streamable HTTP, stateless) and requires the header `Authorization: Bearer <WP_MCP_TOKEN>`. Change `WP_MCP_HOST`/`WP_MCP_PORT` to expose it; put it behind HTTPS (a reverse proxy or tunnel) before using it over the internet, since the token grants admin on every registered site.

Any other MCP client works with one of the two forms above: the stdio command, or the HTTP URL plus bearer header.

## Safety

- `readOnly` sites reject every write tool.
- Destructive calls (deletes, file writes, SQL writes, non-read WP-CLI commands) are refused unless the call includes `confirm: true`. This is a prompt for the agent to ask you, not a security boundary.
- Every write, including blocked ones, is appended to `logs/audit.jsonl` with secrets redacted.
- The bridge requires the `manage_options` capability on every route, confines file access to `wp-content` (symlinks included), keeps file, database and WP-CLI access off until an administrator enables them, and refuses any attempt by the agent to change the plugin's own settings or activity log.
- The HTTP transport will not start without a token of at least 16 characters and binds to localhost by default.

An agent with these tools can break a site. Start with `readOnly: true`, use a staging copy for theme, file and database work, and keep backups.

## Testing

```bash
npm test
```

runs the unit tests. For the end-to-end suite, start a disposable local WordPress (WordPress Playground, no Docker or PHP needed) in one terminal:

```bash
npm run test:site
```

and once it reports that WordPress is running, in another:

```bash
npm run test:integration
```

The suite drives the built server over stdio and HTTP and exercises content, media, plugins, themes, options, post meta, Elementor data, files, SQL, cron, cache and every guard. It does not cover real WP-CLI execution, WooCommerce, saving through an active Elementor install, or how Bricks renders the result (the test site has no Bricks theme, so only storage and tree editing are checked); test those on a staging site.

## Troubleshooting

- **401 on every call**: the site has Application Passwords disabled (many security plugins do this) or the host strips the `Authorization` header. Switch that site to a connection key.
- **`wp_mcp_invalid_key`**: the key was revoked or mistyped; create a new one under WP Admin > WP MCP.
- **Non-JSON response**: a firewall or security plugin is blocking the REST API, or the site needs `"plainPermalinks": true`.
- **"needs the wp-mcp-bridge plugin"**: install and activate the bridge on that site.
- **`wp_mcp_disabled`**: enable that feature under WP Admin > WP MCP > Settings on that site.
- **`wp_mcp_access_off`, `wp_mcp_read_only`, `wp_mcp_ip_blocked`**: the site's own WP MCP settings are refusing the request.
