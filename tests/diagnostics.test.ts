import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Page } from "playwright";
import { Diagnostics } from "../src/diagnostics.js";

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

function fakePage() {
  return new EventEmitter() as unknown as Page & EventEmitter;
}
