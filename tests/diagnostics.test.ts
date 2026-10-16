import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Page } from "playwright";
import { Diagnostics } from "../src/diagnostics.js";
import { config } from "../src/config.js";

test("closing a page removes its bounded diagnostics state", () => {
  const diagnostics = new Diagnostics() as any;
  const page = fakePage();

  diagnostics.attach(page, "p_0001");
  diagnostics.dialogByPage.set("p_0001", {
    at: new Date().toISOString(),
    type: "confirm",
    message: "test",
    default_value: "",
  });

  assert.equal(diagnostics.consoleByPage.has("p_0001"), true);
  assert.equal(diagnostics.networkByPage.has("p_0001"), true);
  assert.equal(diagnostics.dialogByPage.has("p_0001"), true);

  page.emit("close");

  assert.equal(diagnostics.consoleByPage.has("p_0001"), false);
  assert.equal(diagnostics.networkByPage.has("p_0001"), false);
  assert.equal(diagnostics.dialogByPage.has("p_0001"), false);
});

test("network log captures unknown request URLs and remains bounded and clearable", () => {
  const diagnostics = new Diagnostics();
  const page = fakePage();
  diagnostics.attach(page, "p_0001");

  for (let i = 0; i < 45; i++) {
    const request = { method: () => "GET", url: () => `https://example.test/api/${i}`, resourceType: () => "fetch" };
    page.emit("request", request);
  }
  const request = { method: () => "POST", url: () => "https://example.test/search", resourceType: () => "xhr" };
  page.emit("response", { request: () => request, url: request.url, status: () => 200 });

  const events = diagnostics.networkLog("p_0001", "read") as { events: Array<{ kind: string; url: string; status?: number }> };
  assert.equal(events.events.length, 46);
  assert.equal(events.events[0].url, "https://example.test/api/0");
  assert.equal(events.events.at(-1)?.kind, "response");
  assert.equal(events.events.at(-1)?.url, "https://example.test/search");
  assert.equal(events.events.at(-1)?.status, 200);
  assert.deepEqual(diagnostics.networkLog("p_0001", "clear"), { cleared: true, resource_type: "all" });
  assert.deepEqual(diagnostics.networkLog("p_0001", "read"), { events: [], dropped: 0 });
});

test("network discovery groups request and response, filters APIs and reports overflow", () => {
  const diagnostics = new Diagnostics();
  const page = fakePage();
  diagnostics.attach(page, "p_0002");
  diagnostics.networkLog("p_0002", "clear", { resource_type: "api" });
  page.emit("request", { url: () => "https://test/img", method: () => "GET", resourceType: () => "image" });
  for (let i = 0; i < config.networkHistoryLimit + 2; i++) {
    const request = { url: () => `https://test/api/${i}`, method: () => "POST", resourceType: () => "fetch" };
    page.emit("request", request);
    page.emit("response", { request: () => request, url: request.url, status: () => 201 });
  }
  const result = diagnostics.networkLog("p_0002", "read", { resource_type: "fetch", url_contains: "/api/", method: "post" }) as {
    events: Array<{ kind: string; status: number; resource_type: string }>; dropped: number
  };
  assert.equal(result.events.length, config.networkHistoryLimit);
  assert.equal(result.dropped, 2);
  assert.equal(result.events[0].kind, "response");
  assert.equal(result.events[0].status, 201);
  assert.equal(result.events[0].resource_type, "fetch");
});

test("websocket frames are opt-in, bounded and stop capturing", () => {
  const diagnostics = new Diagnostics();
  const page = fakePage();
  diagnostics.attach(page, "p_0003");
  const socket = new EventEmitter();
  Object.assign(socket, { url: () => "wss://example.test/live" });
  page.emit("websocket", socket);
  socket.emit("framesent", { payload: "not captured" });
  diagnostics.websocketLog("p_0003", "start");
  socket.emit("framereceived", { payload: "secret" });
  const initial = diagnostics.websocketLog("p_0003", "read") as { events: Array<{ payload?: string; bytes?: number }> };
  assert.deepEqual(initial.events.map((e) => e.bytes), [6]);
  assert.equal(initial.events[0].payload, undefined);

  diagnostics.websocketLog("p_0003", "start", true);
  for (let i = 0; i < config.websocketHistoryLimit + 3; i++) socket.emit("framesent", { payload: "test" });
  const result = diagnostics.websocketLog("p_0003", "read") as { events: Array<{ payload?: string }>; dropped: number };
  assert.equal(result.events.length, config.websocketHistoryLimit);
  assert.equal(result.dropped, 3);
  assert.equal(result.events[0].payload, "test");
  diagnostics.websocketLog("p_0003", "stop");
  socket.emit("framereceived", { payload: "ignored" });
  assert.equal((diagnostics.websocketLog("p_0003", "read") as { events: unknown[] }).events.length, config.websocketHistoryLimit);
});
function fakePage() {
  return new EventEmitter() as unknown as Page & EventEmitter;
}
