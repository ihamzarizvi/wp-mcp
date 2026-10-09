import { createHash, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response } from "express";
import type { SiteRegistry } from "../config.js";
import { buildServer } from "../server.js";

const digest = (s: string) => createHash("sha256").update(s).digest();

export function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  return timingSafeEqual(digest(header.slice(7).trim()), digest(token));
}

export function createHttpApp(sites: SiteRegistry, token: string) {
  const app = express();
  app.use(express.json({ limit: "50mb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  app.use("/mcp", (req, res, next) => {
    if (!tokenMatches(req.headers.authorization, token)) {
      res.status(401).set("WWW-Authenticate", "Bearer").json({ error: "unauthorized" });
      return;
    }
    next();
  });

  // Stateless: a fresh server and transport per request, so no session state
  // is shared between the different agents calling in.
  app.post("/mcp", async (req: Request, res: Response) => {
    const server = buildServer(sites);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("wp-mcp: request failed:", err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  app.all("/mcp", (_req, res) => {
    res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  });

  return app;
}

export async function startHttp(sites: SiteRegistry): Promise<void> {
  const token = process.env.WP_MCP_TOKEN;
  if (!token || token.length < 16) {
    throw new Error("WP_MCP_TOKEN must be set to a random string of at least 16 characters to use the HTTP transport.");
  }
  const host = process.env.WP_MCP_HOST ?? "127.0.0.1";
  const port = Number(process.env.WP_MCP_PORT ?? 3939);
  await new Promise<void>((resolve, reject) => {
    const listener = createHttpApp(sites, token).listen(port, host, () => resolve());
    listener.on("error", reject);
  });
  console.error(`wp-mcp: HTTP server on http://${host}:${port}/mcp, ${sites.list().length} site(s)`);
}
