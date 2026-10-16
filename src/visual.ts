/**
 * Adapted from PicassoWeb 0.10.1, MIT:
 * https://github.com/blackridder22/PicassoWeb/tree/main/src/tools
 * Only DOM extraction is reused; browser lifecycle and screenshot diff are not.
 * These callbacks are self-contained for Playwright page.evaluate.
 */
export const VISUAL_STYLE_PROPS = [
  "display", "position", "z-index", "box-sizing", "overflow", "opacity",
  "width", "height", "margin", "padding", "gap", "align-items", "justify-content",
  "flex-direction", "color", "background-color", "background-image", "border",
  "border-radius", "box-shadow", "outline", "font-family", "font-size", "font-weight",
  "font-style", "line-height", "letter-spacing", "text-align", "transform",
  "transition", "cursor", "fill", "stroke",
] as const;

// Playwright accepts an expression string; tsx otherwise serializes functions
// referencing its private __name helper, unavailable in the page world.
export function visualPageExpression(callback: Function, input: unknown): string {
  return `(() => { const __name = (fn) => fn; return (${callback.toString()})(${JSON.stringify(input)}); })()`;
}

export function inspectVisualComponentsInPage(input: {
  selector: string;
  maxMatches: number;
  properties: readonly string[];
  includeText: boolean;
}) {
  // Based on PicassoWeb inspect-component/extractor.ts (page-only extraction).
  const matches = Array.from(document.querySelectorAll<HTMLElement>(input.selector));
  const stylesOf = (element: Element, pseudo?: "::before" | "::after") => {
    const style = getComputedStyle(element, pseudo);
    return Object.fromEntries(input.properties.map((name) => [name, style.getPropertyValue(name).trim()]));
  };
  function rectOf(element: Element) {
    const r = element.getBoundingClientRect();
    return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), width: +r.width.toFixed(2), height: +r.height.toFixed(2) };
  }
  const safeStyle = (name: string, value: string) => /url\s*\(/i.test(value) ? "[resource url omitted]" : value;
  return {
    kind: "components",
    url: location.origin + location.pathname,
    selector: input.selector,
    matches: matches.length,
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    elements: matches.slice(0, input.maxMatches).map((element) => ({
      tag: element.tagName.toLowerCase(),
      id: element.id,
      classes: [...element.classList].slice(0, 6),
      role: element.getAttribute("role"),
      ...(input.includeText ? { text: (element.innerText || element.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 120) } : {}),
      bounds: rectOf(element),
      styles: Object.fromEntries(Object.entries(stylesOf(element)).map(([key, value]) => [key, safeStyle(key, value)])),
      pseudo: Object.fromEntries((["::before", "::after"] as const).map((pseudo) => {
        const style = getComputedStyle(element, pseudo);
        return [pseudo, style.content && style.content !== "none"
          ? Object.fromEntries(Object.entries(stylesOf(element, pseudo)).map(([key, value]) => [key, safeStyle(key, value)]))
          : null];
      })),
      children: [...element.children].slice(0, 15).map((child) => child.tagName.toLowerCase() + (child.classList.length ? "." + child.classList[0] : "")),
    })),
  };
}

export function inspectVisualLayoutInPage(input: { selector: string; maxDepth: number; maxNodes: number; includeText: boolean }) {
  // Based on PicassoWeb extract-layout/extractor.ts; capped breadth-first traversal.
  const root = document.querySelector(input.selector);
  if (!root) return { kind: "layout", url: location.origin + location.pathname, selector: input.selector, root: null, nodes: 0, truncated: false };
  const props = ["display", "position", "flex-direction", "justify-content", "align-items",
    "gap", "grid-template-columns", "grid-template-rows", "padding", "margin", "overflow", "z-index"];
  type Node = { tag: string; id?: string; classes?: string[]; bounds: { x: number; y: number; width: number; height: number };
    styles: Record<string, string>; text?: string; scroll?: { x: number; y: number }; children?: Node[] };
  const queue: Array<{ element: Element; depth: number; parent?: Node }> = [{ element: root, depth: 0 }];
  let result: Node | null = null;
  let count = 0;
  let index = 0;
  let truncated = false;
  while (index < queue.length && count < input.maxNodes) {
    const { element, depth, parent } = queue[index++]!;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const node: Node = {
      tag: element.tagName.toLowerCase(),
      ...(element.id ? { id: element.id } : {}),
      ...(element.classList.length ? { classes: [...element.classList].slice(0, 4) } : {}),
      bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      styles: Object.fromEntries(props.map((name) => [name, style.getPropertyValue(name)]).filter(([, value]) => value && value !== "normal" && value !== "auto")),
      ...((element as HTMLElement).scrollHeight > (element as HTMLElement).clientHeight + 1
        ? { scroll: { x: (element as HTMLElement).scrollLeft, y: (element as HTMLElement).scrollTop } } : {}),
    };
    const text = [...element.childNodes].filter((child) => child.nodeType === Node.TEXT_NODE)
      .map((child) => child.textContent?.trim() ?? "").join(" ").replace(/\s+/g, " ").slice(0, 100);
    if (input.includeText && text) node.text = text;
    if (parent) (parent.children ??= []).push(node);
    else result = node;
    count++;
    if (depth < input.maxDepth) {
      for (const child of element.children) {
        if (queue.length >= input.maxNodes) { truncated = true; break; }
        const childStyle = getComputedStyle(child);
        if (childStyle.display !== "none" && childStyle.visibility !== "hidden" && child.getClientRects().length) {
          queue.push({ element: child, depth: depth + 1, parent: node });
        }
      }
    } else if (element.children.length) {
      truncated = true;
    }
  }
  return { kind: "layout", url: location.origin + location.pathname, selector: input.selector, root: result, nodes: count, truncated: truncated || index < queue.length };
}
