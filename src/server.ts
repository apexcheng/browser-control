import { randomUUID } from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { config } from "./config.js";
import { BrowserRuntime } from "./runtime.js";
import { batchActionSchema } from "./schema.js";

const runtime = new BrowserRuntime();

function toolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: { result: value },
  };
}

function createMcpServer() {
  const server = new McpServer({
    name: "macmini-browser",
    title: "Mac mini Browser",
    version: "1.0.0-p1",
  });

  server.registerTool("browser_status", {
    description: "Inspect runtime status without starting Chrome",
    inputSchema: {},
  }, async () => toolResult(await runtime.status()));

  server.registerTool("browser_reset", {
    description: "Recover browser state at soft, page, context, or hard level",
    inputSchema: {
      level: z.enum(["soft", "page", "context", "hard"]),
      page: z.string().optional(),
    },
  }, async (args) => toolResult(await runtime.reset(args.level, args.page)));

  server.registerTool("page_list", {
    description: "List stable page ids and aliases; lazily starts the dedicated Chrome",
    inputSchema: {},
  }, async () => toolResult(await runtime.pageList()));

  server.registerTool("page_create", {
    description: "Create a page and optionally assign an alias",
    inputSchema: {
      alias: z.string().optional(),
      url: z.string().url().optional(),
    },
  }, async (args) => toolResult(await runtime.pageCreate(args)));

  server.registerTool("page_close", {
    description: "Close a page by stable id or alias",
    inputSchema: { page: z.string() },
  }, async (args) => toolResult(await runtime.pageClose(args.page)));

  server.registerTool("page_alias", {
    description: "Assign a stable alias to a page",
    inputSchema: { page: z.string(), alias: z.string() },
  }, async (args) => toolResult(await runtime.pageAlias(args.page, args.alias)));

  server.registerTool("browser_batch", {
    description: "Run bounded Playwright primitives in-process in one MCP round trip",
    inputSchema: {
      page: z.string().optional(),
      actions: z.array(batchActionSchema).min(1).max(config.maxActions),
      stop_on_error: z.boolean().default(true),
      timeout_ms: z.number().int().positive().max(120_000).optional(),
      action_timeout_ms: z.number().int().positive().max(60_000).optional(),
      diagnostics: z.object({
        on_error: z.boolean().optional(),
        console: z.boolean().optional(),
        network: z.boolean().optional(),
        screenshot: z.boolean().optional(),
      }).optional(),
    },
  }, async (args) => toolResult(await runtime.batch(args)));

  server.registerTool("clipboard_read", {
    description: "Read the real macOS system clipboard or the browser Clipboard API",
    inputSchema: {
      mode: z.enum(["system", "browser"]).default("system"),
      page: z.string().optional(),
      grant_permission: z.boolean().default(false),
    },
  }, async (args) => toolResult(await runtime.clipboardRead(args.mode, args.page, args.grant_permission)));

  server.registerTool("clipboard_write", {
    description: "Write the real macOS system clipboard or the browser Clipboard API",
    inputSchema: {
      mode: z.enum(["system", "browser"]).default("system"),
      page: z.string().optional(),
      text: z.string(),
      grant_permission: z.boolean().default(false),
    },
  }, async (args) => toolResult(await runtime.clipboardWrite(args.mode, args.text, args.page, args.grant_permission)));

  return server;
}

const app = express();
app.use(express.json({ limit: "2mb" }));
app.get("/healthz", async (_req, res) => res.json(await runtime.status()));

const sessions = new Map<string, StreamableHTTPServerTransport>();
app.all("/mcp", async (req, res) => {
  const sessionId = req.header("mcp-session-id");
  let transport = sessionId ? sessions.get(sessionId) : undefined;

  if (!transport && req.method === "POST" && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => { sessions.set(id, transport!); },
    });
    transport.onclose = () => {
      if (transport?.sessionId) sessions.delete(transport.sessionId);
    };
    await createMcpServer().connect(transport);
  }

  if (!transport) {
    res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "No valid MCP session" }, id: null });
    return;
  }
  await transport.handleRequest(req, res, req.body);
});

const httpServer = app.listen(config.port, config.host, () => {
  console.log(`browser-control P1 listening on http://${config.host}:${config.port}/mcp`);
});

async function shutdown() {
  httpServer.close();
  for (const transport of sessions.values()) await transport.close().catch(() => undefined);
  await runtime.shutdown();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
