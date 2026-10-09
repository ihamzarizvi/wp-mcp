import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

// MCP clients launch the server from arbitrary working directories, so every
// default path is resolved from the project root rather than process.cwd().
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

dotenv.config({ path: resolve(PROJECT_ROOT, ".env"), quiet: true });

const siteSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/i, "id may only contain letters, digits, - and _"),
  label: z.string().optional(),
  url: z.string().url(),
  username: z.string().min(1),
  appPasswordEnv: z.string().min(1),
  readOnly: z.boolean().default(false),
  plainPermalinks: z.boolean().default(false),
});

const fileSchema = z.object({ sites: z.array(siteSchema).min(1) });

export interface Site {
  id: string;
  label?: string;
  url: string;
  username: string;
  appPassword: string;
  readOnly: boolean;
  plainPermalinks: boolean;
}

export class SiteRegistry {
  private readonly byId = new Map<string, Site>();

  constructor(sites: Site[]) {
    for (const site of sites) {
      if (this.byId.has(site.id)) throw new Error(`Duplicate site id "${site.id}" in sites config`);
      this.byId.set(site.id, site);
    }
  }

  get(id: string): Site {
    const site = this.byId.get(id);
    if (!site) {
      throw new Error(`Unknown site "${id}". Known sites: ${[...this.byId.keys()].join(", ")}`);
    }
    return site;
  }

  list(): Site[] {
    return [...this.byId.values()];
  }
}

export function parseSites(raw: unknown, env: NodeJS.ProcessEnv = process.env): SiteRegistry {
  const parsed = fileSchema.parse(raw);
  const sites = parsed.sites.map((s) => {
    const appPassword = env[s.appPasswordEnv];
    if (!appPassword) {
      throw new Error(`Site "${s.id}": environment variable ${s.appPasswordEnv} is not set`);
    }
    return {
      id: s.id,
      label: s.label,
      url: s.url.replace(/\/+$/, ""),
      username: s.username,
      appPassword,
      readOnly: s.readOnly,
      plainPermalinks: s.plainPermalinks,
    };
  });
  return new SiteRegistry(sites);
}

export function loadSites(): SiteRegistry {
  const path = process.env.WP_MCP_SITES
    ? resolve(process.env.WP_MCP_SITES)
    : resolve(PROJECT_ROOT, "sites.json");
  if (!existsSync(path)) {
    throw new Error(`Sites config not found at ${path}. Copy sites.example.json to sites.json and edit it.`);
  }
  return parseSites(JSON.parse(readFileSync(path, "utf8")));
}
