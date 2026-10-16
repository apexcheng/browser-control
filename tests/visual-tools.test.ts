import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import type { Page } from "playwright";
import { BrowserRuntime } from "../src/runtime.js";
import { batchActionSchema } from "../src/schema.js";
import { inspectVisualComponentsInPage, inspectVisualLayoutInPage, visualPageExpression } from "../src/visual.js";

test("visual_inspect delegates only to the existing page and screenshot targets a locator", async () => {
  const runtime = new BrowserRuntime() as any;
  const calls: unknown[] = [];
  const page = {
    evaluate: async (callback: unknown, args: unknown) => {
      calls.push(["evaluate", typeof callback, args]);
      return { elements: [], matches: 0 };
    },
    locator: (selector: string) => ({
      screenshot: async (options: object) => { calls.push(["locator", selector, options]); },
    }),
  } as unknown as Page;
  const dir = await mkdtemp(path.join(os.tmpdir(), "visual-tools-test-"));
  const { config } = await import("../src/config.js");
  const original = config.artifactDir;
  (config as any).artifactDir = dir;
  try {
    const visual = batchActionSchema.parse({ op: "visual_inspect", selector: ".toolbar", name: "sample-style" });
    const output = await runtime.runAction("p_001", page, visual, 2000);
    assert.equal((calls[0] as unknown[])[0], "evaluate");
    assert.equal((calls[0] as unknown[])[1], "string");
    assert.equal(output.artifact, path.join(dir, "sample-style.json"));
    assert.equal(JSON.parse(await readFile(output.artifact, "utf8")).matches, 0);
    const shot = batchActionSchema.parse({ op: "screenshot", target: ".toolbar", name: "test-component" });
    await runtime.runAction("p_001", page, shot, 2000);
    assert.equal((calls[1] as unknown[])[0], "locator");
    assert.equal((calls[1] as unknown[])[1], ".toolbar");
  } finally {
    (config as any).artifactDir = original;
    await rm(dir, { recursive: true, force: true });
  }
});

test("Pixelmatch consumes PNG files and reports component mismatches", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "visual-compare-test-"));
  try {
    const first = new PNG({ width: 4, height: 4 });
    const second = new PNG({ width: 4, height: 4 });
    first.data.fill(255);
    second.data.fill(255);
    second.data.set([0, 0, 0, 255], 0);
    const ref = path.join(dir, "a.png");
    const target = path.join(dir, "b.png");
    const diff = path.join(dir, "diff.png");
    await Promise.all([
      writeFile(ref, PNG.sync.write(first)),
      writeFile(target, PNG.sync.write(second)),
    ]);
    const script = path.resolve("scripts/visual-compare.mjs");
    const result = JSON.parse(execFileSync(process.execPath, [
      script, "--reference", ref, "--target", target, "--output", diff,
    ], { encoding: "utf8" }));
    assert.equal(result.mismatchedPixels, 1);
    assert.equal(result.dimensionsDiffer, false);
    assert.equal(PNG.sync.read(await readFile(diff)).width, 4);
    assert.equal(result.worstRegions.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tsx-serialized visual callbacks execute in a page-like context without leaking URLs or text", () => {
  const component = {
    tagName: "BUTTON", id: "save", classList: ["toolbar-button"],
    children: [], innerText: "Customer private data", attributes: [],
    getAttribute: () => "", getBoundingClientRect: () => ({ x: 1, y: 2, width: 30, height: 20 }),
  };
  const context = {
    document: { querySelectorAll: () => [component] },
    location: { origin: "https://example.test", pathname: "/sheet", href: "https://example.test/sheet?access_token=SECRET" },
    innerWidth: 100, innerHeight: 200, devicePixelRatio: 2,
    getComputedStyle: () => ({
      content: "none",
      getPropertyValue: (name: string) => name === "background-image" ? "url(https://host.test/p.png?token=SECRET)" : "13px",
    }),
  };
  const input = { selector: "button", maxMatches: 1, properties: ["font-size", "background-image"], includeText: false };
  const data = runInNewContext(visualPageExpression(inspectVisualComponentsInPage, input), context);
  assert.equal(data.matches, 1);
  assert.equal(data.elements[0].styles["background-image"], "[resource url omitted]");
  assert.equal(data.elements[0].text, undefined);
  assert.equal(JSON.stringify(data).includes("SECRET"), false);
  assert.equal(data.url, "https://example.test/sheet");
});

test("layout extraction limits DOM scanning and marks depth truncation", () => {
  let styleReads = 0;
  const leaf = {
    tagName: "DIV", id: "", classList: [], childNodes: [], children: [],
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 1, height: 1 }),
    getClientRects: () => [1], scrollHeight: 0, clientHeight: 0, scrollTop: 0, scrollLeft: 0,
  };
  const root = { ...leaf, children: Array.from({ length: 10_000 }, () => leaf) };
  const context = {
    document: { querySelector: () => root },
    location: { origin: "https://example.test", pathname: "/sheet" },
    Node: { TEXT_NODE: 3 },
    getComputedStyle: () => {
      styleReads++;
      return { display: "block", visibility: "visible", getPropertyValue: () => "block" };
    },
  };
  const single = runInNewContext(visualPageExpression(inspectVisualLayoutInPage,
    { selector: "main", maxDepth: 2, maxNodes: 1, includeText: false }), context);
  assert.equal(single.nodes, 1);
  assert.equal(single.truncated, true);
  assert.equal(styleReads, 1);
  const shallow = runInNewContext(visualPageExpression(inspectVisualLayoutInPage,
    { selector: "main", maxDepth: 0, maxNodes: 10, includeText: false }), context);
  assert.equal(shallow.truncated, true);
});

test("visual inspection timeout blocks context reset until CDP cleanup and prevents JSON write", async () => {
  const runtime = new BrowserRuntime() as any;
  const dir = await mkdtemp(path.join(os.tmpdir(), "visual-timeout-test-"));
  const { config } = await import("../src/config.js");
  const original = config.artifactDir;
  (config as any).artifactDir = dir;
  let release!: () => void;
  let signalEntered!: () => void;
  const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
  const deferred = new Promise<void>((resolve) => { release = resolve; });
  let detached = false;
  const page = {
    evaluate: async () => ({ elements: [{ styles: {} }], matches: 1 }),
    context: () => ({
      newCDPSession: async () => ({
        send: async () => { signalEntered(); await deferred; return {}; },
        detach: async () => { detached = true; },
      }),
    }),
  } as unknown as Page;
  runtime.requirePage = async () => ({ id: "p_1", page });
  try {
    const batch = runtime.batch({
      page: "p_1",
      actions: [batchActionSchema.parse({
        op: "visual_inspect", selector: ".toolbar", include_platform_fonts: true, name: "should-not-exist",
      })],
      action_timeout_ms: 30, diagnostics: { on_error: false },
    });
    await entered;
    const result = await batch;
    assert.equal(result.ok, false);
    await assert.rejects(() => runtime.resetOperation("context"), /visual inspection/);
    release();
    for (let i = 0; i < 10 && !detached; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(detached, true);
    await assert.rejects(() => readFile(path.join(dir, "should-not-exist.json")));
  } finally {
    release?.();
    (config as any).artifactDir = original;
    await rm(dir, { recursive: true, force: true });
  }
});

test("component JSON reports missing entries and pseudo-element changes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "visual-json-test-"));
  try {
    const png = new PNG({ width: 2, height: 2 });
    png.data.fill(255);
    const img = path.join(dir, "shot.png");
    const source = path.join(dir, "source.json");
    const target = path.join(dir, "target.json");
    await writeFile(img, PNG.sync.write(png));
    await writeFile(source, JSON.stringify({ elements: [
      { bounds: {}, styles: {}, pseudo: { "::before": { color: "red" } } },
      { bounds: {}, styles: {} },
    ] }));
    await writeFile(target, JSON.stringify({ elements: [
      { bounds: {}, styles: {}, pseudo: { "::before": { color: "blue" } } },
    ] }));
    const result = JSON.parse(execFileSync(process.execPath, [
      path.resolve("scripts/visual-compare.mjs"), "--reference", img, "--target", img,
      "--reference-json", source, "--target-json", target, "--output", path.join(dir, "diff.png"),
    ], { encoding: "utf8" }));
    assert.equal(result.componentDifferences.length, 2);
    assert.equal(result.componentDifferences[1].type, "missing-target");
    assert.ok(result.componentDifferences[0].pseudo["::before"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Pixelmatch locates a mismatch at a region boundary", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "visual-region-test-"));
  try {
    const a = new PNG({ width: 61, height: 4 });
    const b = new PNG({ width: 61, height: 4 });
    a.data.fill(255);
    b.data.fill(255);
    b.data.set([0, 0, 0, 255], (2 * 61 + 60) * 4);
    const reference = path.join(dir, "a.png");
    const target = path.join(dir, "b.png");
    await writeFile(reference, PNG.sync.write(a));
    await writeFile(target, PNG.sync.write(b));
    const report = JSON.parse(execFileSync(process.execPath, [
      path.resolve("scripts/visual-compare.mjs"), "--reference", reference, "--target", target,
      "--output", path.join(dir, "diff.png"),
    ], { encoding: "utf8" }));
    assert.equal(report.mismatchedPixels, 1);
    assert.equal(report.worstRegions[0].x, 60);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
