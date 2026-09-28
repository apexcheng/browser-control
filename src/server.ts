import { randomUUID } from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { BrowserController } from "./controller.js";
import { config } from "./config.js";
import { batchActionSchema, locatorSpecSchema, pointSchema, targetSchema } from "./schema.js";

const controller = new BrowserController();

function asToolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: { result: value },
  };
}

function createMcpServer() {
  const server = new McpServer({ name: "browser-control", version: "0.1.0" });

  server.registerTool("browser_status", { description: "Get browser-control and dedicated Chrome status", inputSchema: {} }, async () => asToolResult(await controller.status()));
  server.registerTool("browser_start", { description: "Start/reuse dedicated Chrome and connect Playwright once", inputSchema: {} }, async () => asToolResult(await controller.start()));
  server.registerTool("browser_stop", { description: "Stop the dedicated browser-control Chrome", inputSchema: {} }, async () => asToolResult(await controller.stop()));
  server.registerTool("browser_reset", {
    description: "Reset browser state at soft, page, context, or hard level",
    inputSchema: {
      level: z.enum(["soft", "page", "context", "hard"]),
      page: z.string().optional(),
      url: z.string().optional(),
    },
  }, async (args) => asToolResult(await controller.reset(args.level, args.page, args.url)));

  server.registerTool("page_list", { description: "List stable page ids and aliases", inputSchema: {} }, async () => asToolResult(await controller.pageList()));
  server.registerTool("page_create", {
    description: "Create a page and optionally assign an alias",
    inputSchema: { alias: z.string().optional(), url: z.string().optional(), isolated: z.boolean().optional() },
  }, async (args) => asToolResult(await controller.pageCreate(args)));
  server.registerTool("page_use", { description: "Use a page by stable id or alias", inputSchema: { page: z.string() } }, async (args) => asToolResult(await controller.pageUse(args.page)));
  server.registerTool("page_alias", { description: "Assign a stable alias to a page", inputSchema: { page: z.string(), alias: z.string() } }, async (args) => asToolResult(await controller.pageAlias(args.page, args.alias)));
  server.registerTool("page_close", { description: "Close a page by stable id or alias", inputSchema: { page: z.string() } }, async (args) => asToolResult(await controller.pageClose(args.page)));

  const single = <T extends Record<string, z.ZodTypeAny>>(name: string, description: string, shape: T, toAction: (args: z.infer<z.ZodObject<T>>) => unknown) => {
    (server.registerTool as any)(name, { description, inputSchema: { page: z.string().optional(), ...shape } }, async (args: any) => asToolResult(await controller.single(args.page, toAction(args) as any)));
  };

  single("navigate", "Navigate current/selected page", { url: z.string(), wait_until: z.enum(["commit", "domcontentloaded", "load", "networkidle"]).optional(), timeout_ms: z.number().int().positive().optional() }, (a) => ({ op: "navigate", url: a.url, wait_until: a.wait_until, timeout_ms: a.timeout_ms }));
  single("reload", "Reload current/selected page", { wait_until: z.enum(["commit", "domcontentloaded", "load", "networkidle"]).optional(), timeout_ms: z.number().int().positive().optional() }, (a) => ({ op: "reload", wait_until: a.wait_until, timeout_ms: a.timeout_ms }));
  single("click", "Click a DOM target", { target: locatorSpecSchema, force: z.boolean().optional(), no_wait_after: z.boolean().optional(), timeout_ms: z.number().int().positive().optional() }, (a) => ({ op: "click", target: a.target, force: a.force, no_wait_after: a.no_wait_after, timeout_ms: a.timeout_ms }));
  single("dblclick", "Double-click a DOM target", { target: locatorSpecSchema, force: z.boolean().optional(), no_wait_after: z.boolean().optional(), timeout_ms: z.number().int().positive().optional() }, (a) => ({ op: "dblclick", target: a.target, force: a.force, no_wait_after: a.no_wait_after, timeout_ms: a.timeout_ms }));
  single("fill", "Fill an editable DOM target", { target: locatorSpecSchema, value: z.string(), timeout_ms: z.number().int().positive().optional() }, (a) => ({ op: "fill", target: a.target, value: a.value, timeout_ms: a.timeout_ms }));
  single("focus", "Focus a DOM target", { target: locatorSpecSchema, timeout_ms: z.number().int().positive().optional() }, (a) => ({ op: "focus", target: a.target, timeout_ms: a.timeout_ms }));
  single("press", "Press a real Playwright keyboard key/shortcut", { key: z.string(), target: locatorSpecSchema.optional(), timeout_ms: z.number().int().positive().optional() }, (a) => ({ op: "press", key: a.key, target: a.target, timeout_ms: a.timeout_ms }));
  single("hover", "Hover a DOM target", { target: locatorSpecSchema, timeout_ms: z.number().int().positive().optional() }, (a) => ({ op: "hover", target: a.target, timeout_ms: a.timeout_ms }));
  single("drag", "Pointer drag between locators or coordinates", { from: targetSchema, to: targetSchema, steps: z.number().int().positive().max(100).optional(), timeout_ms: z.number().int().positive().optional() }, (a) => ({ op: "drag", from: a.from, to: a.to, steps: a.steps, timeout_ms: a.timeout_ms }));
  single("text", "Read element innerText", { target: locatorSpecSchema, timeout_ms: z.number().int().positive().optional() }, (a) => ({ op: "text", target: a.target, timeout_ms: a.timeout_ms }));
  single("html", "Read page or element HTML", { target: locatorSpecSchema.optional(), timeout_ms: z.number().int().positive().optional() }, (a) => ({ op: "html", target: a.target, timeout_ms: a.timeout_ms }));
  single("attr", "Read an element attribute", { target: locatorSpecSchema, name: z.string(), timeout_ms: z.number().int().positive().optional() }, (a) => ({ op: "attr", target: a.target, name: a.name, timeout_ms: a.timeout_ms }));
  single("count", "Count matching elements", { target: locatorSpecSchema, timeout_ms: z.number().int().positive().optional() }, (a) => ({ op: "count", target: a.target, timeout_ms: a.timeout_ms }));
  single("eval", "Evaluate a function expression in the page context", { expression: z.string(), arg: z.any().optional(), timeout_ms: z.number().int().positive().optional() }, (a) => ({ op: "eval", expression: a.expression, arg: a.arg, timeout_ms: a.timeout_ms }));
  single("wait", "Wait a bounded number of milliseconds", { ms: z.number().int().nonnegative().max(30000) }, (a) => ({ op: "wait", ms: a.ms }));
  single("screenshot", "Capture a screenshot to the browser-control artifact directory", { full_page: z.boolean().optional() }, (a) => ({ op: "screenshot", full_page: a.full_page }));

  server.registerTool("clipboard_read", {
    description: "Read browser Clipboard API or macOS system clipboard",
    inputSchema: { page: z.string().optional(), mode: z.enum(["browser", "system"]).default("system"), grant_permission: z.boolean().optional() },
  }, async (args) => asToolResult(await controller.single(args.page, { op: "clipboard_read", mode: args.mode, grant_permission: args.grant_permission })));
  server.registerTool("clipboard_write", {
    description: "Write browser Clipboard API or macOS system clipboard",
    inputSchema: { page: z.string().optional(), mode: z.enum(["browser", "system"]).default("system"), text: z.string(), grant_permission: z.boolean().optional() },
  }, async (args) => asToolResult(await controller.single(args.page, { op: "clipboard_write", mode: args.mode, text: args.text, grant_permission: args.grant_permission })));

  server.registerTool("local_storage", {
    description: "Get/set/remove/clear localStorage on a page",
    inputSchema: {
      page: z.string().optional(),
      action: z.enum(["get", "set", "remove", "clear"]),
      key: z.string().optional(),
      value: z.string().optional(),
    },
  }, async (args) => {
    if (args.action !== "clear" && args.key === undefined) throw new Error("key is required");
    if (args.action === "set" && args.value === undefined) throw new Error("value is required");
    const action = args.action === "get" ? { op: "local_storage_get", key: args.key! }
      : args.action === "set" ? { op: "local_storage_set", key: args.key!, value: args.value! }
      : args.action === "remove" ? { op: "local_storage_remove", key: args.key! }
      : { op: "local_storage_clear" };
    return asToolResult(await controller.single(args.page, action as any));
  });

  server.registerTool("dialog_accept", { description: "Accept the current JS dialog", inputSchema: { page: z.string().optional(), prompt_text: z.string().optional() } }, async (args) => asToolResult(await controller.single(args.page, { op: "dialog_accept", prompt_text: args.prompt_text })));
  server.registerTool("dialog_dismiss", { description: "Dismiss the current JS dialog", inputSchema: { page: z.string().optional() } }, async (args) => asToolResult(await controller.single(args.page, { op: "dialog_dismiss" })));

  server.registerTool("browser_batch", {
    description: "Execute many browser actions in-process in one MCP call with per-step results and diagnostics",
    inputSchema: {
      page: z.string().optional(),
      actions: z.array(batchActionSchema).min(1).max(500),
      stop_on_error: z.boolean().default(true),
      timeout_ms: z.number().int().positive().max(120000).optional(),
      action_timeout_ms: z.number().int().positive().max(60000).optional(),
      diagnostics: z.object({ on_error: z.boolean().optional(), screenshot: z.boolean().optional(), dom: z.boolean().optional() }).optional(),
    },
  }, async (args) => asToolResult(await controller.batch(args)));

  return server;
}

const app = express();
app.use(express.json({ limit: "2mb" }));
app.get("/healthz", async (_req, res) => res.json({ ok: true, ...(await controller.status()) }));

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
    const server = createMcpServer();
    await server.connect(transport);
  }

  if (!transport) {
    res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "No valid MCP session" }, id: null });
    return;
  }
  await transport.handleRequest(req, res, req.body);
});

const httpServer = app.listen(config.port, config.host, () => {
  console.log(`browser-control listening on http://${config.host}:${config.port}/mcp`);
});

async function shutdown() {
  httpServer.close();
  for (const transport of sessions.values()) await transport.close().catch(() => undefined);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

