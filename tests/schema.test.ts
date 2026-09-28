import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import type { Page } from "playwright";
import { PageRegistry } from "../src/pages.js";
import { batchActionSchema, locatorSpecSchema } from "../src/schema.js";

test("P1 locator surface maps only to native Playwright locator primitives", () => {
  for (const target of [
    "#save",
    { by: "role", role: "button", name: "Save", exact: true },
    { by: "text", text: "Save" },
    { by: "label", text: "Email" },
    { by: "testId", value: "submit" },
  ]) assert.equal(locatorSpecSchema.safeParse(target).success, true);
});

test("P1 batch actions include bounded trigger primitives and no sleep action", () => {
  const valid = [
    { op: "goto", url: "http://127.0.0.1:1234/" },
    { op: "click", target: "#save" },
    { op: "wait_for", target: "#ready", state: "visible" },
    { op: "clipboard", action: "read", mode: "system" },
    { op: "dialog", action: "accept", trigger: { op: "click", target: "#confirm" } },
    { op: "wait_response", url_contains: "/api/", body: "json", trigger: { op: "click", target: "#load" } },
  ];
  for (const action of valid) assert.equal(batchActionSchema.safeParse(action).success, true);
  assert.equal(batchActionSchema.safeParse({ op: "wait", ms: 1000 }).success, false);
});

test("stable page ids and aliases do not depend on page order", () => {
  const registry = new PageRegistry();
  const first = fakePage("https://one.example/");
  const second = fakePage("https://two.example/");
  const firstId = registry.register(first.page);
  const secondId = registry.register(second.page);
  registry.alias(firstId, "app");
  registry.reconcile([second.page, first.page]);

  assert.equal(registry.resolve("app").id, firstId);
  assert.equal(registry.resolve(secondId).page, second.page);

  first.close();
  assert.throws(() => registry.resolve("app"), /Unknown page/);
});

function fakePage(url: string) {
  const events = new EventEmitter();
  let closed = false;
  const page = Object.assign(events, {
    isClosed: () => closed,
    url: () => url,
    title: async () => url,
  }) as unknown as Page;
  return {
    page,
    close: () => { closed = true; events.emit("close"); },
  };
}
