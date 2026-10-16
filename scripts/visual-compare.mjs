#!/usr/bin/env node
// Offline only. PNGs must come from browser-control's screenshot action.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.flatMap((v, i) => v.startsWith("--") ? [[v.slice(2), args[i + 1]]] : []));
if (!flags.reference || !flags.target) {
  console.error("Usage: node scripts/visual-compare.mjs --reference a.png --target b.png [--output diff.png] [--reference-json a.json --target-json b.json]");
  process.exit(2);
}
const [reference, target] = await Promise.all(
  [flags.reference, flags.target].map(async (file) => PNG.sync.read(await readFile(file))),
);
const width = Math.max(reference.width, target.width);
const height = Math.max(reference.height, target.height);
const pad = (source) => {
  const padded = new PNG({ width, height, fill: true });
  // White background gives a visible mismatch when component dimensions differ.
  padded.data.fill(255);
  for (let y = 0; y < source.height; y++) {
    source.data.copy(padded.data, y * width * 4, y * source.width * 4, (y + 1) * source.width * 4);
  }
  return padded;
};
const diff = new PNG({ width, height });
const a = pad(reference);
const b = pad(target);
const mismatch = pixelmatch(a.data, b.data, diff.data, width, height, {
  threshold: 0.1, includeAA: false, diffMask: true,
});
const output = flags.output || path.join(path.dirname(flags.target), "visual-diff.png");
await writeFile(output, PNG.sync.write(diff));
const regions = [];
const cellSize = 60;
for (let y = 0; y < height; y += cellSize) {
  for (let x = 0; x < width; x += cellSize) {
    const w = Math.min(cellSize, width - x);
    const h = Math.min(cellSize, height - y);
    let count = 0;
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        const p = ((y + row) * width + x + col) * 4;
        if (diff.data[p] === 255 && diff.data[p + 1] === 0 && diff.data[p + 2] === 0 && diff.data[p + 3] === 255) count++;
      }
    }
    if (count) regions.push({ x, y, width: w, height: h, mismatchPercent: +(count / (w * h) * 100).toFixed(2) });
  }
}
regions.sort((x, y) => y.mismatchPercent - x.mismatchPercent);
const report = {
  reference: { width: reference.width, height: reference.height },
  target: { width: target.width, height: target.height },
  compared: { width, height, pixels: width * height },
  mismatchedPixels: mismatch,
  mismatchPercent: +(mismatch / (width * height) * 100).toFixed(2),
  dimensionsDiffer: reference.width !== target.width || reference.height !== target.height,
  ...(reference.width !== target.width || reference.height !== target.height
    ? { warnings: ["PNG dimensions differ; white-padding can hide size-only changes. Review reference/target dimensions separately."] } : {}),
  diffImage: output,
  worstRegions: regions.slice(0, 12),
};
if (flags["reference-json"] && flags["target-json"]) {
  const [refData, targetData] = await Promise.all(
    [flags["reference-json"], flags["target-json"]].map(async (file) => JSON.parse(await readFile(file, "utf8"))),
  );
  const detectKind = (data) => data.kind || (Array.isArray(data.elements) ? "components" : undefined);
  const kind = detectKind(refData);
  if (!["layout", "components"].includes(kind) || detectKind(targetData) !== kind) {
    throw new Error("JSON comparison requires two compatible visual_inspect results (both components or both layout)");
  }
  const differences = (left, right) => Object.fromEntries(
    [...new Set([...Object.keys(left || {}), ...Object.keys(right || {})])]
      .filter((key) => JSON.stringify(left?.[key]) !== JSON.stringify(right?.[key]))
      .map((key) => [key, [left?.[key] ?? null, right?.[key] ?? null]]),
  );
  report.comparisonKind = kind;
  if (kind === "components") {
    const before = refData.elements || [];
    const after = targetData.elements || [];
    report.componentMatching = "array-index (selectors must refer to corresponding components)";
    report.matchingWarnings = [];
    report.componentDifferences = Array.from({ length: Math.max(before.length, after.length) }, (_, i) => {
      const a = before[i], b = after[i];
      if (!a || !b) {
        report.matchingWarnings.push(`Component at index ${i} is missing on one side; remaining positional matches may not correspond.`);
        return { index: i, type: a ? "missing-target" : "added-target" };
      }
      const identity = differences(
        { tag: a.tag, id: a.id, role: a.role, classes: a.classes },
        { tag: b.tag, id: b.id, role: b.role, classes: b.classes },
      );
      if ((a.tag && b.tag && a.tag !== b.tag) || (a.id && b.id && a.id !== b.id)) {
        report.matchingWarnings.push(`Index ${i} has different tag/id; verify these are corresponding components before interpreting style deltas.`);
      }
      const bounds = differences(a.bounds, b.bounds);
      const styles = differences(a.styles, b.styles);
      const pseudo = differences(a.pseudo, b.pseudo);
      const fonts = JSON.stringify(a.platformFonts || []) !== JSON.stringify(b.platformFonts || [])
        ? [a.platformFonts || [], b.platformFonts || []] : undefined;
      if (!Object.keys(identity).length && !Object.keys(bounds).length && !Object.keys(styles).length && !Object.keys(pseudo).length && !fonts) return null;
      return { index: i, referenceText: a.text, targetText: b.text, identity, bounds, styles, pseudo, ...(fonts ? { fonts } : {}) };
    }).filter(Boolean);
  } else {
    report.layoutMatching = "child-index path (nodes must correspond within their parents)";
    report.matchingWarnings = [];
    report.layoutDifferences = [];
    const walk = (a, b, path = "root") => {
      if (!a || !b) {
        if (a !== b) report.layoutDifferences.push({ path, type: a ? "missing-target" : "added-target" });
        return;
      }
      const bounds = differences(a.bounds, b.bounds);
      const styles = differences(a.styles, b.styles);
      const scroll = differences(a.scroll, b.scroll);
      const identity = differences({ tag: a.tag, id: a.id }, { tag: b.tag, id: b.id });
      if ((a.tag && b.tag && a.tag !== b.tag) || (a.id && b.id && a.id !== b.id)) {
        report.matchingWarnings.push(`Layout ${path} has different tag/id; child-index correspondence may be invalid.`);
      }
      const text = a.text !== b.text ? [a.text ?? null, b.text ?? null] : undefined;
      if (Object.keys(bounds).length || Object.keys(styles).length || Object.keys(scroll).length
        || Object.keys(identity).length || text) {
        report.layoutDifferences.push({
          path, bounds, styles, scroll, identity, ...(text ? { text } : {}),
        });
      }
      const count = Math.max(a.children?.length || 0, b.children?.length || 0);
      for (let i = 0; i < count; i++) walk(a.children?.[i], b.children?.[i], `${path}.${i}`);
    };
    walk(refData.root, targetData.root);
    if (refData.truncated || targetData.truncated) {
      (report.warnings ??= []).push("Layout extraction was truncated; differences outside the extracted nodes are unknown.");
    }
  }
}
console.log(JSON.stringify(report, null, 2));
