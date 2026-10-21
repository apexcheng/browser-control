import assert from "node:assert/strict";
import test from "node:test";
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
