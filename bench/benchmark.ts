import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const endpoint = process.env.BROWSER_CONTROL_MCP_URL ?? "http://127.0.0.1:8766/mcp";
const fixturePort = Number(process.env.BROWSER_CONTROL_FIXTURE_PORT ?? 0);

const fixture = `<!doctype html>
<html><head><meta charset="utf-8"><title>browser-control P1 fixture</title></head>
<body>
  <button id="inc" onclick="count.textContent=String(Number(count.textContent)+1)">increment</button>
  <span id="count">0</span>
  <input id="input" value="alpha beta" />
  <button id="dialog" onclick="confirm('p1-confirm')">dialog</button>
  <button id="api" onclick="fetch('/api/data', {method:'POST'}).then(r => r.json()).then(v => apiResult.textContent=v.ok)">api</button>
  <button id="slow" onclick="fetch('/api/slow', {method:'POST'})">slow</button>
  <span id="apiResult"></span>
  <div id="drag-a" draggable="true">A</div><div id="drag-b">B</div>
</body></html>`;

const fixtureServer = createServer((req, res) => {
  if (req.url === "/favicon.ico") return void res.writeHead(204).end();
  if (req.url === "/api/data") {
    res.setHeader("content-type", "application/json");
    return void res.end(JSON.stringify({ ok: "yes", source: "fixture" }));
  }
  if (req.url === "/api/slow") {
    res.setHeader("content-type", "application/json");
    setTimeout(() => res.end(JSON.stringify({ ok: true })), 250);
    return;
  }
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(fixture);
});

await new Promise<void>((resolve) => fixtureServer.listen(fixturePort, "127.0.0.1", resolve));
const fixtureAddress = fixtureServer.address();
if (!fixtureAddress || typeof fixtureAddress === "string") throw new Error("Unable to resolve fixture port");
const fixtureUrl = `http://127.0.0.1:${fixtureAddress.port}/`;

const client = new Client({ name: "browser-control-p1-benchmark", version: "1" });
await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
const stage = (name: string) => console.error(`[bench] ${name}`);

async function call(name: string, args: Record<string, unknown> = {}) {
  const response: any = await client.callTool({ name, arguments: args });
  const structured = response.structuredContent as { result?: unknown } | undefined;
  if (structured && "result" in structured) return structured.result as any;
  const text = response.content.find((item: any) => item.type === "text");
  return text ? JSON.parse(text.text) : response;
}

async function timed<T>(fn: () => Promise<T>) {
  const started = performance.now();
  const value = await fn();
  return { value, ms: round(performance.now() - started) };
}

const toolNames = (await client.listTools()).tools.map((tool) => tool.name).sort();
const expectedTools = [
  "browser_batch", "browser_reset", "browser_status", "clipboard_read", "clipboard_write",
  "page_alias", "page_close", "page_create", "page_list",
].sort();

const before = await call("browser_status");
stage("lazy status");
await call("page_create", { alias: "bench", url: fixtureUrl });
const afterLaunch = await call("browser_status");
stage("page created");

const separate20 = await timed(async () => {
  for (let i = 0; i < 20; i++) {
    const result = await call("browser_batch", { page: "bench", actions: [{ op: "evaluate", expression: "1" }] });
    if (!result.ok) throw new Error("single-step batch failed");
  }
});
const batch20 = await timed(() => call("browser_batch", {
  page: "bench",
  actions: Array.from({ length: 20 }, () => ({ op: "evaluate", expression: "1" })),
}));
stage("batch performance");

const stability100 = await timed(() => call("browser_batch", {
  page: "bench",
  actions: Array.from({ length: 100 }, () => ({ op: "evaluate", expression: "1" })),
  timeout_ms: 30_000,
}));

const clicks = await call("browser_batch", {
  page: "bench",
  actions: [
    ...Array.from({ length: 10 }, () => ({ op: "click", target: "#inc" })),
    { op: "text", target: "#count" },
  ],
});
stage("basic actions");

const responseWait = await call("browser_batch", {
  page: "bench",
  actions: [{
    op: "wait_response",
    url_contains: "/api/data",
    method: "POST",
    body: "json",
    trigger: { op: "click", target: "#api" },
  }],
});

const dialog = await call("browser_batch", {
  page: "bench",
  actions: [{
    op: "dialog",
    action: "accept",
    trigger: { op: "click", target: "#dialog" },
  }],
});
stage("response + dialog");

await call("browser_batch", {
  page: "bench",
  actions: [
    { op: "fill", target: "#input", text: "alpha beta" },
    { op: "press", target: "#input", key: "Meta+A" },
    { op: "press", target: "#input", key: "Meta+C" },
  ],
});
const metaCopy = await call("clipboard_read", { mode: "system" });
stage("meta copy");

await call("browser_batch", {
  page: "bench",
  actions: [
    { op: "press", target: "#input", key: "Meta+A" },
    { op: "press", target: "#input", key: "Meta+X" },
  ],
});
const metaCut = await call("clipboard_read", { mode: "system" });
const cutValue = await call("browser_batch", {
  page: "bench",
  actions: [{ op: "evaluate", expression: "document.querySelector('#input').value" }],
});
stage("meta cut");

await call("clipboard_write", { mode: "system", text: "pasted-value" });
const pasteValue = await call("browser_batch", {
  page: "bench",
  actions: [
    { op: "press", target: "#input", key: "Meta+A" },
    { op: "press", target: "#input", key: "Meta+V" },
    { op: "evaluate", expression: "document.querySelector('#input').value" },
  ],
});
stage("meta paste");

await call("clipboard_write", { mode: "browser", page: "bench", text: "browser-api", grant_permission: true });
const browserClipboard = await call("clipboard_read", { mode: "browser", page: "bench", grant_permission: true });
stage("browser clipboard");

const missing = await call("browser_batch", {
  page: "bench",
  actions: [{ op: "click", target: "#does-not-exist", timeout_ms: 150 }],
  diagnostics: { on_error: true, console: true, network: true, screenshot: false },
});

const batchTimeout = await call("browser_batch", {
  page: "bench",
  actions: [{ op: "wait_for", target: "#never-exists", timeout_ms: 5000 }],
  timeout_ms: 50,
});

const slowBatch = call("browser_batch", {
  page: "bench",
  actions: [{
    op: "wait_response",
    url_contains: "/api/slow",
    method: "POST",
    trigger: { op: "click", target: "#slow" },
  }],
});
await new Promise((resolve) => setTimeout(resolve, 25));
const busyResponse: any = await client.callTool({
  name: "browser_batch",
  arguments: { page: "bench", actions: [{ op: "evaluate", expression: "1" }] },
});
await slowBatch;
const busyError = busyResponse.content?.find((item: any) => item.type === "text")?.text ?? "";
stage("error diagnostics");

const screenshot = await call("browser_batch", {
  page: "bench",
  actions: [{ op: "screenshot", name: "p1-benchmark.png" }],
});
stage("screenshot");

const aliasBefore = await call("page_list");
await call("page_create", { alias: "reference", url: fixtureUrl });
const aliasAfter = await call("page_list");
const benchId = aliasAfter.find((page: any) => page.aliases.includes("bench"))?.id;
await call("page_close", { page: "reference" });
const aliasAfterClose = await call("page_list");
stage("stable aliases");

const softReset = await call("browser_reset", { level: "soft" });
const pageReset = await call("browser_reset", { level: "page", page: "bench" });
const profileCookieBefore = await call("browser_batch", {
  page: "bench",
  actions: [{ op: "evaluate", expression: "document.cookie.includes('browser-control-p1=persisted')" }],
});
await call("browser_batch", {
  page: "bench",
  actions: [{ op: "evaluate", expression: "document.cookie = 'browser-control-p1=persisted; Path=/; Max-Age=86400'" }],
});
const profileMarkerBefore = await call("browser_batch", {
  page: "bench",
  actions: [{ op: "evaluate", expression: "localStorage.getItem('browser-control-p1-marker')" }],
});
await call("browser_batch", {
  page: "bench",
  actions: [{ op: "evaluate", expression: "localStorage.setItem('browser-control-p1-marker', 'persisted')" }],
});
const beforeContext = await call("browser_status");
const contextReset = await call("browser_reset", { level: "context" });
const afterContext = await call("browser_status");
await call("page_create", { alias: "after-context", url: fixtureUrl });
const markerAfterContext = await call("browser_batch", {
  page: "after-context",
  actions: [{ op: "evaluate", expression: "localStorage.getItem('browser-control-p1-marker')" }],
});
const hardReset = await call("browser_reset", { level: "hard" });
const afterHard = await call("browser_status");
await call("page_create", { alias: "after-hard", url: fixtureUrl });
const markerAfterHard = await call("browser_batch", {
  page: "after-hard",
  actions: [{ op: "evaluate", expression: "localStorage.getItem('browser-control-p1-marker')" }],
});
stage("resets");

console.log(JSON.stringify({
  generated_at: new Date().toISOString(),
  endpoint,
  tools: {
    count: toolNames.length,
    exact_p1_surface: JSON.stringify(toolNames) === JSON.stringify(expectedTools),
    names: toolNames,
  },
  lifecycle: {
    lazy_before_running: before.running,
    launch_count_after_first_page: afterLaunch.launch_count,
    launch_count_before_context_reset: beforeContext.launch_count,
    launch_count_after_context_reset: afterContext.launch_count,
    launch_count_after_hard_reset: afterHard.launch_count,
    context_reset: contextReset.ok,
    hard_reset: hardReset.ok,
  },
  performance_ms: {
    twenty_single_action_batches: separate20.ms,
    one_twenty_action_batch: batch20.ms,
    one_hundred_action_batch: stability100.ms,
  },
  checks: {
    stability_100_actions_ok: stability100.value.ok === true && stability100.value.results.length === 100,
    ten_clicks_then_text: clicks.results.at(-1)?.value,
    wait_response_json: responseWait.results[0]?.value?.body,
    dialog_accept: dialog.results[0]?.value,
    meta_copy_system_clipboard: metaCopy.text,
    meta_cut_system_clipboard: metaCut.text,
    meta_cut_emptied_input: cutValue.results[0]?.value,
    meta_paste_input: pasteValue.results.at(-1)?.value,
    browser_clipboard_api: browserClipboard.text,
    failed_step: missing.failed_step,
    batch_timeout_failed_step: batchTimeout.failed_step,
    batch_timeout_error: batchTimeout.results?.[0]?.error,
    same_page_concurrent_batch_rejected: busyResponse.isError === true,
    same_page_concurrent_batch_error: busyError,
    failure_diagnostics: missing.diagnostics,
    screenshot: screenshot.results[0]?.value,
    stable_alias_id_before_reorder: benchId,
    alias_lists_before_second_page: aliasBefore,
    alias_lists_after_second_page: aliasAfter,
    alias_lists_after_close: aliasAfterClose,
    soft_reset: softReset.ok,
    page_reset: pageReset.ok,
    profile_cookie_before: profileCookieBefore.results?.[0]?.value ?? false,
    profile_marker_before: profileMarkerBefore.results?.[0]?.value ?? null,
    profile_marker_after_context_reset: markerAfterContext.results?.[0]?.value ?? null,
    profile_marker_after_hard_reset: markerAfterHard.results?.[0]?.value ?? null,
  },
}, null, 2));

await client.close();
await new Promise<void>((resolve) => fixtureServer.close(() => resolve()));

function round(value: number) {
  return Math.round(value * 10) / 10;
}
