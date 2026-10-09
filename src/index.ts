#!/usr/bin/env node
import { loadSites } from "./config.js";
import { startHttp } from "./transports/http.js";
import { startStdio } from "./transports/stdio.js";

async function main(): Promise<void> {
  const sites = loadSites();
  const http = process.argv.includes("--http") || process.env.WP_MCP_TRANSPORT === "http";
  await (http ? startHttp(sites) : startStdio(sites));
}

main().catch((err) => {
  console.error(`wp-mcp: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
