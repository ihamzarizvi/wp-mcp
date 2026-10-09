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
| Maintenance | `wp_cache_flush`, `wp_cron_list`, `wp_cron_run` | yes |
| Files | `wp_file_list`, `wp_file_read`, `wp_file_write` | yes + `WP_MCP_ALLOW_FILES` |
| Database | `wp_db_query` | yes + `WP_MCP_ALLOW_DB` |
| WP-CLI | `wp_cli` | yes + `WP_MCP_ALLOW_CLI` |
| WooCommerce | `wc_request` | no (needs WooCommerce) |
| Anything else | `wp_rest_request` (any REST route of any plugin) | no |

The six content tools take a `resource` argument and cover posts, pages, media, categories, tags, comments, users, menus (`menus`, `menu-items`), reusable blocks, templates and every custom post type or taxonomy. A resource starting with `/` is used as a full route, e.g. `/wc/v3/products`.

## Setup

### 1. Install and build

```bash
npm install
npm run build
```

### 2. Prepare each WordPress site

1. Create a dedicated administrator user for the agent (so its actions are attributable and revocable).
2. In **Users > Profile > Application Passwords**, create a password for that user.
3. Optional: zip `bridge-plugin/wp-mcp-bridge`, upload it in **Plugins > Add New > Upload**, and activate it.
4. Optional: enable the gated features you want in `wp-config.php`:

```php
define( 'WP_MCP_ALLOW_FILES', true ); // read/write files under wp-content
define( 'WP_MCP_ALLOW_DB', true );    // run SQL
define( 'WP_MCP_ALLOW_CLI', true );   // run WP-CLI (host must allow proc_open)
define( 'WP_MCP_CLI_PATH', '/usr/local/bin/wp' ); // optional
```

### 3. Register the sites

Copy `sites.example.json` to `sites.json` and `.env.example` to `.env`. Both are gitignored.

```json
{
  "sites": [
    { "id": "shop", "url": "https://shop.example.com", "username": "mcp-admin", "appPasswordEnv": "WP_SITE_SHOP_APP_PASSWORD" },
    { "id": "blog", "url": "https://blog.example.com", "username": "mcp-admin", "appPasswordEnv": "WP_SITE_BLOG_APP_PASSWORD", "readOnly": true }
  ]
}
```

Passwords live only in `.env` (or the client's `env` block), keyed by `appPasswordEnv`. Per-site options: `readOnly` blocks every write; `plainPermalinks` uses `?rest_route=` for sites without pretty permalinks.

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
- The bridge requires the `manage_options` capability on every route, confines file access to `wp-content` (symlinks included), and keeps file, database and WP-CLI access off until enabled in `wp-config.php`.
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

The suite drives the built server over stdio and HTTP and exercises content, media, plugins, themes, options, post meta, Elementor data, files, SQL, cron, cache and every guard. It does not cover real WP-CLI execution, WooCommerce, or saving through an active Elementor install; test those on a staging site.

## Troubleshooting

- **401 on every call**: wrong username or Application Password, or the host strips the `Authorization` header (run `wp_site_health` with the `authorization-header` test).
- **Non-JSON response**: a firewall or security plugin is blocking the REST API, or the site needs `"plainPermalinks": true`.
- **"needs the wp-mcp-bridge plugin"**: install and activate the bridge on that site.
- **`wp_mcp_disabled`**: add the named constant to that site's `wp-config.php`.
