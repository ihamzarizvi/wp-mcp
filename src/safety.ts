import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { PROJECT_ROOT, type Site } from "./config.js";

export type Kind = "read" | "write" | "destructive";

export class GuardError extends Error {}

export function guard(site: Pick<Site, "id" | "readOnly">, tool: string, kind: Kind, confirm: unknown): void {
  if (kind === "read") return;
  if (site.readOnly) {
    throw new GuardError(`Site "${site.id}" is read-only in sites.json; ${tool} was blocked.`);
  }
  if (kind === "destructive" && confirm !== true) {
    throw new GuardError(
      `${tool} is destructive on site "${site.id}". Confirm with the user, then call again with confirm: true.`,
    );
  }
}

const SECRET_KEY = /pass|secret|token|auth|api[_-]?key/i;
const MAX_LOGGED_STRING = 500;

export function redact(value: unknown, key = ""): unknown {
  if (SECRET_KEY.test(key)) return "[redacted]";
  if (typeof value === "string") {
    return value.length > MAX_LOGGED_STRING ? `${value.slice(0, MAX_LOGGED_STRING)}… (${value.length} chars)` : value;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  }
  return value;
}

export function audit(entry: { site: string; tool: string; kind: Kind; args: unknown; ok: boolean; error?: string }): void {
  try {
    const dir = process.env.WP_MCP_LOG_DIR ? resolve(process.env.WP_MCP_LOG_DIR) : resolve(PROJECT_ROOT, "logs");
    mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ time: new Date().toISOString(), ...entry, args: redact(entry.args) });
    appendFileSync(resolve(dir, "audit.jsonl"), line + "\n");
  } catch (err) {
    // An unwritable log must not break the tool call; stderr is safe in stdio mode.
    console.error("wp-mcp: could not write audit log:", err);
  }
}
