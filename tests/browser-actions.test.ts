import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Page } from "playwright";
import { config } from "../src/config.js";
import { BrowserRuntime } from "../src/runtime.js";

test("frame selector delegates locator operations to Playwright frameLocator", async () => {
  const runtime = new BrowserRuntime() as any;
  const calls: unknown[] = [];
  const page = {
    frameLocator: (selector: string) => {
      calls.push(["frame", selector]);
      return {
        getByRole: (role: string, options: object) => {
          calls.push(["role", role, options]);
          return { fill: async (value: string) => calls.push(["fill", value]) };
        },
      };
    },
  } as unknown as Page;
  await runtime.runAction("p_0001", page, {
    op: "fill", frame: "iframe#settings", target: { by: "role", role: "textbox", name: "Search" },
    text: "hello",
  }, 1000);
  assert.deepEqual(calls, [
    ["frame", "iframe#settings"],
    ["role", "textbox", { name: "Search", exact: undefined }],
    ["fill", "hello"],
  ]);
});

test("response detail includes opted-in bounded request text but not authentication headers", async () => {
  const runtime = new BrowserRuntime() as any;
  const request = {
    method: () => "POST",
    resourceType: () => "fetch",
    headers: () => ({ "content-type": "application/json", authorization: "Bearer secret" }),
    postDataBuffer: () => Buffer.from('{"query":"item"}'),
  };
  const response = {
    url: () => "https://example.test/api/items",
    status: () => 200,
    request: () => request,
    body: async () => Buffer.from('{"ok":true}'),
  };
  const result = await runtime.responseValue(response, "json", "text");
  assert.deepEqual(result, {
    url: "https://example.test/api/items", method: "POST", status: 200,
    request: { resource_type: "fetch", content_type: "application/json", body: '{"query":"item"}' },
    body: { ok: true },
  });
  const defaultResult = await runtime.responseValue(response, "none");
  assert.equal(defaultResult.request, undefined);
  assert.equal(defaultResult.body, undefined);
  request.postDataBuffer = () => Buffer.alloc(config.requestPayloadLimit + 1);
  const large = await runtime.responseValue(response, "none", "text");
  assert.deepEqual(large.request.body, {
    omitted: true, bytes: config.requestPayloadLimit + 1, limit: config.requestPayloadLimit,
  });
});

test("download waiter starts before click and saves only under the artifacts folder", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "browser-download-test-"));
  const previous = config.artifactDir;
  (config as any).artifactDir = dir;
  try {
    const runtime = new BrowserRuntime() as any;
    const page = new EventEmitter() as Page & EventEmitter;
    let listening = false;
    (page as any).waitForEvent = (event: string) => new Promise((resolve) => {
      listening = true;
      page.once(event, resolve);
    });
    (page as any).locator = () => ({
      click: async () => {
        assert.equal(listening, true);
        page.emit("download", {
          suggestedFilename: () => "../../orders.csv",
          saveAs: async (file: string) => writeFile(file, "id,price\n1,2\n"),
        });
      },
    });
    const result = await runtime.runAction("p_0001", page, {
      op: "download", trigger: { op: "click", target: "#export" },
    }, 2000);
    assert.equal(path.dirname(result.path), dir);
    assert.equal(result.suggested_filename, "../../orders.csv");
    assert.equal(await readFile(result.path, "utf8"), "id,price\n1,2\n");
  } finally {
    (config as any).artifactDir = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
