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
import { inspectVisualComponentsInPage, inspectVisualLayoutInPage, visualPageExpression, VISUAL_STYLE_PROPS } from "../src/visual.js";

test("visual_inspect delegates to the page and target screenshot clips without relocating the pointer", async () => {
  const runtime = new BrowserRuntime() as any;
  const calls: unknown[] = [];
  const visualState = {
    rect: { x: 20, y: 30, width: 50, height: 20 }, viewport: { width: 500, height: 300 },
    hover: true, focus: false, focusWithin: false,
    styles: { background: "red", shadow: "none", outlineStyle: "none", outlineWidth: "0px", outlineOffset: "0px" },
  };
  const viewportImage = new PNG({ width: 500, height: 300 });
  viewportImage.data.fill(255);
  const page = {
    evaluate: async (callback: unknown, args: unknown) => {
      calls.push(["evaluate", typeof callback, args]);
      return { elements: [], matches: 0 };
    },
    locator: (selector: string) => ({
      evaluate: async () => { calls.push(["locator.evaluate", selector]); return visualState; },
      screenshot: async () => { throw new Error("locator.screenshot changes hover and must not be called"); },
    }),
    screenshot: async (options: object) => {
      calls.push(["page.screenshot", options]);
      return PNG.sync.write(viewportImage);
    },
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
    const shot = batchActionSchema.parse({ op: "screenshot", target: ".toolbar", name: "test-component", padding_px: 8 });
    const captured = await runtime.runAction("p_001", page, shot, 2000);
    assert.equal((calls[2] as unknown[])[0], "page.screenshot");
    assert.equal(((calls[2] as unknown[])[1] as { clip?: object }).clip, undefined);
    assert.deepEqual(captured.clip, { x: 12, y: 22, width: 66, height: 36 });
    assert.equal(captured.padding_px, 8);
    assert.equal(captured.padding_clipped, false);
    const crop = PNG.sync.read(await readFile(captured.path));
    assert.equal(crop.width, 66);
    assert.equal(crop.height, 36);
  } finally {
    (config as any).artifactDir = original;
    await rm(dir, { recursive: true, force: true });
  }
});

test("target screenshot fails if element is offscreen or visual state changes", async () => {
  const runtime = new BrowserRuntime() as any;
  let current = { rect: { x: 5, y: 5, width: 30, height: 20 },
    viewport: { width: 100, height: 100 }, hover: true, focus: false,
    styles: { background: "red", shadow: "none", outlineStyle: "none", outlineWidth: "0px", outlineOffset: "0px" } };
  const dir = await mkdtemp(path.join(os.tmpdir(), "visual-screenshot-test-"));
  const { config } = await import("../src/config.js");
  const original = config.artifactDir;
  (config as any).artifactDir = dir;
  const page = {
    locator: () => ({ evaluate: async () => current }),
    screenshot: async () => {
      current = { ...current, hover: false };
      return Buffer.alloc(0);
    },
  } as unknown as Page;
  try {
    await assert.rejects(() => runtime.runAction("p_001", page,
      batchActionSchema.parse({ op: "screenshot", target: "#button", name: "changed" }), 1000),
    /state changed/);
    await assert.rejects(() => readFile(path.join(dir, "changed.png")));
    current = { ...current, rect: { x: -1, y: 5, width: 30, height: 20 } };
    await assert.rejects(() => runtime.runAction("p_001", page,
      batchActionSchema.parse({ op: "screenshot", target: "#button" }), 1000),
    /entire element/);
  } finally {
    (config as any).artifactDir = original;
    await rm(dir, { recursive: true, force: true });
  }
});

test("target screenshot warns when outline/shadow exceed padding and detects transient pixels when enabled", async () => {
  const runtime = new BrowserRuntime() as any;
  const dir = await mkdtemp(path.join(os.tmpdir(), "visual-stability-test-"));
  const { config } = await import("../src/config.js");
  const original = config.artifactDir;
  (config as any).artifactDir = dir;
  const base = new PNG({ width: 100, height: 100 });
  base.data.fill(255);
  const changed = new PNG({ width: 100, height: 100 });
  base.data.copy(changed.data);
  changed.data.set([0, 0, 0, 255], (41 * 100 + 41) * 4);
  let shotCount = 0;
  const page = {
    locator: () => ({
      evaluate: async () => ({
        rect: { x: 40, y: 40, width: 20, height: 20 },
        viewport: { width: 100, height: 100 }, hover: false, focus: true,
        styles: {
          background: "white", shadow: "rgb(168, 85, 247) 0px 0px 0px 8px",
          outlineStyle: "solid", outlineWidth: "3px", outlineOffset: "3px",
        },
      }),
    }),
    screenshot: async () => PNG.sync.write((++shotCount % 2) === 1 ? base : changed),
  } as unknown as Page;
  try {
    const insufficient = await runtime.runAction("p_001", page,
      batchActionSchema.parse({ op: "screenshot", target: "#focus", name: "tight", padding_px: 0, stability_check: true }), 2000);
    assert.equal(insufficient.padding_clipped, false);
    assert.equal(insufficient.recommended_padding_px, 8);
    assert.equal(insufficient.effects_may_be_clipped, true);
    assert.equal(insufficient.stability.stable, false);
    assert.equal(insufficient.stability.mismatched_pixels, 1);
    assert.equal(insufficient.warnings.length, 2);
    const roomy = await runtime.runAction("p_001", page,
      batchActionSchema.parse({ op: "screenshot", target: "#focus", name: "roomy", padding_px: 12 }), 2000);
    assert.equal(roomy.effects_may_be_clipped, false);
    assert.equal(roomy.stability, undefined);
    assert.equal(roomy.warnings, undefined);
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

test("component inspection includes align-self and outline-offset", () => {
  assert.ok(VISUAL_STYLE_PROPS.includes("align-self"));
  assert.ok(VISUAL_STYLE_PROPS.includes("outline-offset"));
});

test("layout extraction limits DOM scanning and marks depth truncation", () => {
  let styleReads = 0;
  const leaf = {
    tagName: "DIV", id: "", classList: [], childNodes: [], children: [],
    getBoundingClientRect: () => ({ x: 0.25, y: 1.5, width: 1.75, height: 2.25 }),
    getClientRects: () => [1], scrollHeight: 0, clientHeight: 0, scrollTop: 0, scrollLeft: 0,
  };
  const root = { ...leaf, children: Array.from({ length: 10_000 }, () => leaf) };
  const context = {
    document: { querySelector: () => root },
    location: { origin: "https://example.test", pathname: "/sheet" },
    Node: { TEXT_NODE: 3 },
    getComputedStyle: () => {
      styleReads++;
      return { display: "block", visibility: "visible",
        getPropertyValue: (name: string) => name === "align-items" ? "normal" : name === "overflow" ? "auto" : "block" };
    },
  };
  const single = runInNewContext(visualPageExpression(inspectVisualLayoutInPage,
    { selector: "main", maxDepth: 2, maxNodes: 1, includeText: false }), context);
  assert.equal(single.nodes, 1);
  assert.equal(single.truncated, true);
  assert.equal(styleReads, 1);
  assert.equal(single.root.bounds.x, 0.25);
  assert.equal(single.root.bounds.height, 2.25);
  assert.equal(single.root.styles["align-items"], "normal");
  assert.equal(single.root.styles.overflow, "auto");
  const shallow = runInNewContext(visualPageExpression(inspectVisualLayoutInPage,
    { selector: "main", maxDepth: 0, maxNodes: 10, includeText: false }), context);
  assert.equal(shallow.truncated, true);
});

test("layout JSON comparison detects Grid columns, gaps, scroll, bounds and missing nodes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "visual-layout-compare-test-"));
  try {
    const image = new PNG({ width: 3, height: 3 });
    image.data.fill(255);
    const png = path.join(dir, "same.png");
    const before = path.join(dir, "before.json"), after = path.join(dir, "after.json");
    await writeFile(png, PNG.sync.write(image));
    await writeFile(before, JSON.stringify({ kind: "layout", root: {
      tag: "div", id: "grid", bounds: { x: 0.5, width: 400 },
      styles: { gap: "12px", "grid-template-columns": "160px 228px" },
      scroll: { y: 0 }, children: [{ tag: "div", bounds: { x: 172 }, styles: {} }],
    } }));
    await writeFile(after, JSON.stringify({ kind: "layout", root: {
      tag: "div", id: "grid", bounds: { x: 0.5, width: 400 },
      styles: { gap: "15px", "grid-template-columns": "163px 222px" },
      scroll: { y: 40 }, children: [],
    } }));
    const args = [path.resolve("scripts/visual-compare.mjs"),
      "--reference", png, "--target", png, "--reference-json", before, "--target-json", after,
      "--output", path.join(dir, "diff.png")];
    const report = JSON.parse(execFileSync(process.execPath, args, { encoding: "utf8" }));
    assert.equal(report.comparisonKind, "layout");
    assert.equal(report.mismatchedPixels, 0);
    assert.deepEqual(report.layoutDifferences[0].styles.gap, ["12px", "15px"]);
    assert.deepEqual(report.layoutDifferences[0].scroll.y, [0, 40]);
    assert.equal(report.layoutDifferences[1].type, "missing-target");
    assert.deepEqual(report.matchingWarnings, []);
    await writeFile(after, JSON.stringify({ kind: "components", elements: [] }));
    assert.throws(() => execFileSync(process.execPath, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
      /Command failed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

test("component comparisons expose identity differences and warn about positional mismatch", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "visual-identity-test-"));
  try {
    const png = new PNG({ width: 2, height: 2 });
    png.data.fill(255);
    const image = path.join(dir, "same.png");
    const before = path.join(dir, "before.json"), after = path.join(dir, "after.json");
    await writeFile(image, PNG.sync.write(png));
    await writeFile(before, JSON.stringify({ kind: "components", elements: [
      { tag: "button", id: "first", bounds: {}, styles: {} },
      { tag: "button", id: "second", bounds: {}, styles: {} },
    ] }));
    await writeFile(after, JSON.stringify({ kind: "components", elements: [
      { tag: "button", id: "second", bounds: {}, styles: {} },
      { tag: "button", id: "first", bounds: {}, styles: {} },
    ] }));
    const report = JSON.parse(execFileSync(process.execPath, [
      path.resolve("scripts/visual-compare.mjs"),
      "--reference", image, "--target", image, "--reference-json", before, "--target-json", after,
      "--output", path.join(dir, "diff.png"),
    ], { encoding: "utf8" }));
    assert.equal(report.componentDifferences.length, 2);
    assert.deepEqual(report.componentDifferences[0].identity.id, ["first", "second"]);
    assert.equal(report.matchingWarnings.length, 2);
    assert.equal(report.mismatchedPixels, 0);
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
