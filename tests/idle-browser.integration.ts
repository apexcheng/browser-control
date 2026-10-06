// Explicit real-Chrome acceptance, isolated from the production profile/service.
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = await mkdtemp(path.join(os.tmpdir(), "browser-control-idle-"));
process.env.BROWSER_CONTROL_HOME = root;
process.env.BROWSER_CONTROL_PROFILE = path.join(root, "chrome-profile");
process.env.BROWSER_CONTROL_RUNTIME_DIR = path.join(root, "runtime");
process.env.BROWSER_CONTROL_ARTIFACT_DIR = path.join(root, "artifacts");
process.env.BROWSER_CONTROL_HEADLESS = "1";
const { BrowserRuntime } = await import("../src/runtime.js");
const runtime = new BrowserRuntime(200);
let disabledRuntime: InstanceType<typeof BrowserRuntime> | undefined;
const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end('<!doctype html><title>Isolated idle test</title><textarea id="draft"></textarea>');
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
const url = `http://127.0.0.1:${address.port}/`;

async function waitForStopped() {
  const deadline = Date.now() + 5_000;
  while ((await runtime.status()).running) {
    assert.ok(Date.now() < deadline, "idle Chrome did not close within 5 seconds");
    await delay(50);
  }
}

async function evaluate(page: string, expression: string) {
  const result = await runtime.batch({ page, actions: [{ op: "evaluate", expression }] });
  assert.equal(result.ok, true);
  return (result.results as Array<{ value: unknown }>)[0].value;
}

try {
  const first = await runtime.pageCreate({ alias: "app", url });
  await evaluate("app", `(() => {
    localStorage.setItem("idle-test", "retained");
    document.cookie = "idle_test=retained; max-age=3600; path=/";
    document.querySelector("#draft").value = "unfinished form";
    return true;
  })()`);
  await delay(600);
  assert.equal((await runtime.status()).running, true);
  assert.equal(await evaluate("app", 'document.querySelector("#draft").value'), "unfinished form");
  console.log("PASS: business page and unfinished form survive idle time");

  const blank = await runtime.pageCreate({ alias: "blank" });
  await runtime.pageClose(first.id);
  // The default startup page and this explicit page are both empty about:blank.
  await waitForStopped();
  assert.ok((await stat(process.env.BROWSER_CONTROL_PROFILE)).isDirectory());
  console.log("PASS: empty browser is recycled without deleting its profile");

  const second = await runtime.pageCreate({ alias: "app", url });
  assert.notEqual(second.id, first.id);
  assert.ok(!(await runtime.pageList()).some((page) => page.id === blank.id));
  assert.deepEqual(await evaluate("app", '({ stored: localStorage.getItem("idle-test"), cookie: document.cookie })'), {
    stored: "retained", cookie: "idle_test=retained",
  });
  console.log("PASS: next browser call restarts Chrome and retains persistent site data");

  const content = await runtime.pageCreate({ alias: "content" });
  await evaluate(content.id, 'document.body.innerHTML = \'<textarea>unsaved</textarea>\'');
  await runtime.pageClose(second.id);
  await delay(600);
  assert.equal((await runtime.status()).running, true);
  assert.equal(await evaluate(content.id, 'document.querySelector("textarea").value'), "unsaved");
  console.log("PASS: about:blank with injected content is preserved");

  for (const page of await runtime.pageList()) await runtime.pageClose(page.id);
  await waitForStopped();
  console.log("PASS: browser with no pages is also recycled");
  await runtime.shutdown();

  disabledRuntime = new BrowserRuntime(0);
  await disabledRuntime.pageCreate({});
  await delay(600);
  assert.equal((await disabledRuntime.status()).running, true);
  console.log("PASS: setting timeout to zero disables recycling");
} finally {
  if (disabledRuntime) await disabledRuntime.shutdown();
  await runtime.shutdown();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(root, { recursive: true, force: true });
}
