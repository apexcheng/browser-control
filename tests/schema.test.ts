import assert from "node:assert/strict";
import test from "node:test";
import { batchActionSchema, locatorSpecSchema } from "../src/schema.js";

test("batch schema accepts pointer, clipboard, storage and dialog actions", () => {
  for (const action of [
    { op: "drag", from: "#a", to: { x: 100, y: 120 }, steps: 8 },
    { op: "clipboard_read", mode: "system" },
    { op: "local_storage_set", key: "a", value: "b" },
    { op: "dialog_dismiss" },
  ]) {
    assert.equal(batchActionSchema.safeParse(action).success, true);
  }
});

test("locator schema supports stable selector strategies", () => {
  for (const locator of [
    "#save",
    { selector: "[data-row='1']" },
    { text: "Save", exact: true },
    { role: "button", name: "Save" },
    { label: "Email" },
    { testId: "submit" },
  ]) {
    assert.equal(locatorSpecSchema.safeParse(locator).success, true);
  }
});

