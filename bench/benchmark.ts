import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const endpoint = process.env.BROWSER_CONTROL_MCP_URL ?? "http://127.0.0.1:8766/mcp";
const fixturePort = Number(process.env.BROWSER_CONTROL_FIXTURE_PORT ?? 18767);
const fixtureUrl = `http://127.0.0.1:${fixturePort}/`;

const fixture = `<!doctype html>
<html><head><meta charset="utf-8"><title>browser-control benchmark</title></head>
<body>
  <button id="inc" onclick="document.querySelector('#count').textContent=String(Number(document.querySelector('#count').textContent)+1)">increment</button>
  <span id="count">0</span>
  <input id="input" value="alpha beta" />
  <button id="dialog" onclick="setTimeout(() => confirm('benchmark-confirm'), 0)">dialog</button>
  <div id="drag-a" style="position:absolute;left:20px;top:160px;width:30px;height:30px;background:#ccc"></div>
  <div id="drag-b" style="position:absolute;left:240px;top:160px;width:30px;height:30px;background:#ddd"></div>
  <div style="height:2200px"></div>
  <div id="bottom">bottom</div>
  <script>
    window.addEventListener('beforeunload', e => { if (window.blockUnload) { e.preventDefault(); e.returnValue = ''; } });
  </script>
</body></html>`;

const fixtureServer = createServer((req, res) => {
  if (req.url === "/favicon.ico") { res.writeHead(204).end(); return; }
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(fixture);
});

await new Promise<void>((resolve) => fixtureServer.listen(fixturePort, "127.0.0.1", resolve));

const client = new Client({ name: "browser-control-benchmark", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));

type Metric = { name: string; samples_ms: number[]; p50_ms: number; p95_ms: number; total_ms: number };
const metrics: Metric[] = [];

async function call(name: string, args: Record<string, unknown> = {}) {
  const result: any = await client.callTool({ name, arguments: args });
  const structured = result.structuredContent as { result?: unknown } | undefined;
  if (structured && "result" in structured) return structured.result;
  const text = result.content.find((item: any) => item.type === "text");
  return text && text.type === "text" ? JSON.parse(text.text) : result;
}

async function timed<T>(fn: () => Promise<T>) {
  const started = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - started };
}

async function sample(name: string, count: number, fn: () => Promise<unknown>) {
  const samples: number[] = [];
  for (let i = 0; i < count; i++) {
    const { ms } = await timed(fn);
    samples.push(ms);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
  metrics.push({
    name,
    samples_ms: samples.map(round),
    p50_ms: round(percentile(0.5)),
    p95_ms: round(percentile(0.95)),
    total_ms: round(samples.reduce((a, b) => a + b, 0)),
  });
}

const connect = await timed(() => call("browser_start"));
metrics.push({ name: "browser_start_existing_chrome", samples_ms: [round(connect.ms)], p50_ms: round(connect.ms), p95_ms: round(connect.ms), total_ms: round(connect.ms) });

await call("page_create", { alias: "bench", url: fixtureUrl });

await sample("mcp_status", 10, () => call("browser_status"));
await sample("page_eval", 20, () => call("eval", { page: "bench", expression: "() => document.title.length" }));

await call("eval", { page: "bench", expression: "() => { document.querySelector('#count').textContent = '0'; }" });
await sample("click_separate_10", 10, () => call("click", { page: "bench", target: "#inc" }));

await call("eval", { page: "bench", expression: "() => { document.querySelector('#count').textContent = '0'; }" });
const batchClicks = await timed(() => call("browser_batch", {
  page: "bench",
  actions: Array.from({ length: 10 }, () => ({ op: "click", target: "#inc" })),
}));
metrics.push({ name: "click_batch_10", samples_ms: [round(batchClicks.ms)], p50_ms: round(batchClicks.ms), p95_ms: round(batchClicks.ms), total_ms: round(batchClicks.ms) });

await call("eval", { page: "bench", expression: "() => { document.querySelector('#count').textContent = '0'; }" });
const batchFastClicks = await timed(() => call("browser_batch", {
  page: "bench",
  actions: Array.from({ length: 10 }, () => ({ op: "click", target: "#inc", force: true, no_wait_after: true })),
}));
metrics.push({ name: "click_batch_10_fast", samples_ms: [round(batchFastClicks.ms)], p50_ms: round(batchFastClicks.ms), p95_ms: round(batchFastClicks.ms), total_ms: round(batchFastClicks.ms) });

await sample("dom_count_separate_100", 100, () => call("count", { page: "bench", target: "#inc" }));
const batchDom = await timed(() => call("browser_batch", {
  page: "bench",
  actions: Array.from({ length: 100 }, () => ({ op: "count", target: "#inc" })),
  timeout_ms: 30000,
}));
metrics.push({ name: "dom_count_batch_100", samples_ms: [round(batchDom.ms)], p50_ms: round(batchDom.ms), p95_ms: round(batchDom.ms), total_ms: round(batchDom.ms) });

await sample("clipboard_system_write_read", 5, async () => {
  await call("clipboard_write", { page: "bench", mode: "system", text: "browser-control-benchmark" });
  const value = await call("clipboard_read", { page: "bench", mode: "system" });
  if (!JSON.stringify(value).includes("browser-control-benchmark")) throw new Error("clipboard mismatch");
});

await call("clipboard_write", { page: "bench", mode: "browser", text: "browser-api-benchmark" });
const browserClipboard = await call("clipboard_read", { page: "bench", mode: "browser" });

await call("page_create", { alias: "bench2", url: fixtureUrl });
await sample("page_switch", 20, async () => {
  await call("page_use", { page: "bench" });
  await call("page_use", { page: "bench2" });
});

const stability = await call("browser_batch", {
  page: "bench",
  actions: Array.from({ length: 100 }, () => ({ op: "eval", expression: "() => 1" })),
  timeout_ms: 30000,
});

await call("local_storage", { page: "bench", action: "set", key: "browser-control", value: "ok" });
const localStorageValue = await call("local_storage", { page: "bench", action: "get", key: "browser-control" });

await call("browser_batch", {
  page: "bench",
  actions: [
    { op: "eval", expression: "() => { setTimeout(() => confirm('benchmark-confirm'), 0); return true; }" },
    { op: "wait", ms: 50 },
    { op: "dialog_accept" },
  ],
  timeout_ms: 5000,
});

await call("reload", { page: "bench" });
await call("browser_batch", {
  page: "bench",
  actions: [
    { op: "scroll_into_view", target: "#bottom" },
    { op: "drag", from: "#drag-a", to: "#drag-b", steps: 5 },
    { op: "focus", target: "#input" },
    { op: "press", key: "Meta+A" },
    { op: "press", key: "Meta+C" },
  ],
});
const copied = await call("clipboard_read", { page: "bench", mode: "system" });

const missing = await call("browser_batch", {
  page: "bench",
  actions: [{ op: "click", target: "#does-not-exist", timeout_ms: 150 }],
  diagnostics: { on_error: true, dom: true, screenshot: false },
});

const screenshot = await call("screenshot", { page: "bench", full_page: false });

console.log(JSON.stringify({
  generated_at: new Date().toISOString(),
  endpoint,
  fixture_url: fixtureUrl,
  metrics,
  checks: {
    stability_100_actions_ok: (stability as any)?.ok === true,
    local_storage_ok: JSON.stringify(localStorageValue).includes("ok"),
    real_meta_c_system_clipboard: copied,
    browser_clipboard_api: browserClipboard,
    missing_locator_failed_step: (missing as any)?.failed_step,
    missing_locator_has_diagnostics: Boolean((missing as any)?.diagnostics),
    screenshot,
  },
}, null, 2));

await client.close();
await new Promise<void>((resolve) => fixtureServer.close(() => resolve()));

function round(value: number) {
  return Math.round(value * 10) / 10;
}

