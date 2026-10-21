import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveCdpEndpoint } from "../src/cdp.js";
import { config } from "../src/config.js";
import { BrowserRuntime } from "../src/runtime.js";

test("CDP mode rejects destructive resets and never closes the attached context on shutdown", async () => {
  const previousMode = config.browserMode;
  config.browserMode = "cdp";
  try {
    const runtime = new BrowserRuntime(0) as any;
    let closes = 0;
    runtime.context = { close: async () => { closes++; } };

    await assert.rejects(runtime.reset("context"), /not supported in CDP mode/);
    await assert.rejects(runtime.reset("hard"), /not supported in CDP mode/);
    await runtime.shutdown();

    assert.equal(closes, 0);
    assert.equal(runtime.context, undefined);
  } finally {
    config.browserMode = previousMode;
  }
});

test("CDP resolves an approval-gated Chrome 144+ WebSocket without HTTP discovery", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "browser-control-cdp-"));
  const activePortFile = path.join(dir, "DevToolsActivePort");
  try {
    await writeFile(activePortFile, "9222\n/devtools/browser/example-id\n");
    assert.equal(await resolveCdpEndpoint("http://127.0.0.1:9222", activePortFile),
      "ws://127.0.0.1:9222/devtools/browser/example-id");
    assert.equal(await resolveCdpEndpoint("http://127.0.0.1:9333", activePortFile),
      "http://127.0.0.1:9333");
    assert.equal(await resolveCdpEndpoint("ws://127.0.0.1:9222/explicit", activePortFile),
      "ws://127.0.0.1:9222/explicit");
    await writeFile(activePortFile, "9222\ninvalid-path\n");
    assert.equal(await resolveCdpEndpoint("http://127.0.0.1:9222", activePortFile),
      "http://127.0.0.1:9222");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
