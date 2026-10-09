import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { SiteRegistry } from "../config.js";
import { buildServer } from "../server.js";

export async function startStdio(sites: SiteRegistry): Promise<void> {
  await buildServer(sites).connect(new StdioServerTransport());
  // stdout carries the protocol, so diagnostics go to stderr.
  console.error(`wp-mcp: stdio server ready, ${sites.list().length} site(s)`);
}
