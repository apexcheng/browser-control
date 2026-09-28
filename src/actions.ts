import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Locator, Page } from "playwright";
import { config } from "./config.js";
import { runtimePaths } from "./config.js";
import fs from "node:fs/promises";
import path from "node:path";
import type { BatchAction, LocatorSpec, Target } from "./schema.js";
import type { ManagedPage } from "./pages.js";

const execFileAsync = promisify(execFile);

export type ActionResult = {
  ok: true;
  value?: unknown;
  duration_ms: number;
};

export class ActionExecutor {
  async run(managed: ManagedPage, action: BatchAction, timeoutCapMs?: number): Promise<ActionResult> {
    const started = performance.now();
    const page = managed.page;
    const timeout = Math.max(1, Math.min(
      action.op === "navigate" ? config.navigationTimeoutMs : config.actionTimeoutMs,
      "timeout_ms" in action && action.timeout_ms ? action.timeout_ms : Number.POSITIVE_INFINITY,
      timeoutCapMs ?? Number.POSITIVE_INFINITY,
    ));

    const value = await this.withTimeout(this.execute(page, managed, action, timeout), timeout, action.op);
    return { ok: true, value, duration_ms: roundMs(performance.now() - started) };
  }

  private async execute(page: Page, managed: ManagedPage, action: BatchAction, timeout: number): Promise<unknown> {
    switch (action.op) {
      case "navigate":
        await page.goto(action.url, { waitUntil: action.wait_until ?? "domcontentloaded", timeout });
        return { url: page.url(), title: await page.title() };
      case "reload":
        await page.reload({ waitUntil: action.wait_until ?? "domcontentloaded", timeout });
        return { url: page.url(), title: await page.title() };
      case "click":
        await this.locator(page, action.target).click({ button: action.button, force: action.force, noWaitAfter: action.no_wait_after, timeout }); return null;
      case "dblclick":
        await this.locator(page, action.target).dblclick({ button: action.button, force: action.force, noWaitAfter: action.no_wait_after, timeout }); return null;
      case "fill":
        await this.locator(page, action.target).fill(action.value, { timeout }); return null;
      case "focus":
        await this.locator(page, action.target).focus({ timeout }); return null;
      case "press": {
        if (action.target) await this.locator(page, action.target).press(action.key, { timeout });
        else await page.keyboard.press(action.key);
        return null;
      }
      case "hover":
        await this.locator(page, action.target).hover({ timeout }); return null;
      case "wait":
        await page.waitForTimeout(action.ms); return null;
      case "wait_for":
        await this.locator(page, action.target).waitFor({ state: action.state ?? "visible", timeout }); return null;
      case "scroll_into_view":
        await this.locator(page, action.target).scrollIntoViewIfNeeded({ timeout }); return null;
      case "scroll":
        await page.mouse.wheel(action.dx, action.dy); return null;
      case "mouse_move":
        await page.mouse.move(action.x, action.y, { steps: action.steps }); return null;
      case "mouse_down":
        await page.mouse.down({ button: action.button }); return null;
      case "mouse_up":
        await page.mouse.up({ button: action.button }); return null;
      case "drag":
        await this.drag(page, action.from, action.to, action.steps ?? 8, timeout); return null;
      case "text":
        return await this.locator(page, action.target).innerText({ timeout });
      case "html":
        return action.target
          ? await this.locator(page, action.target).innerHTML({ timeout })
          : await page.content();
      case "attr":
        return await this.locator(page, action.target).getAttribute(action.name, { timeout });
      case "count":
        return await this.locator(page, action.target).count();
      case "bounding_box":
        return await this.locator(page, action.target).boundingBox({ timeout });
      case "screenshot": {
        const file = path.join(runtimePaths().artifactsDir, `screenshot-${Date.now()}.png`);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await page.screenshot({ path: file, fullPage: action.full_page ?? false, timeout });
        return { path: file };
      }
      case "eval":
        return await page.evaluate(({ expression, arg }) => {
          const fn = (0, eval)(`(${expression})`);
          return fn(arg);
        }, { expression: action.expression, arg: action.arg });
      case "wait_response": {
        const method = action.method?.toUpperCase();
        const responsePromise = page.waitForResponse((response) => {
          return response.url().includes(action.url_contains) && (!method || response.request().method().toUpperCase() === method);
        }, { timeout });
        await this.execute(page, managed, action.trigger as BatchAction, timeout);
        const response = await responsePromise;
        let body: unknown = null;
        if (action.body === "json") body = await response.json();
        else if (action.body === "text") body = await response.text();
        return {
          url: response.url(),
          status: response.status(),
          method: response.request().method(),
          body,
        };
      }
      case "local_storage_get":
        return await page.evaluate((key) => localStorage.getItem(key), action.key);
      case "local_storage_set":
        await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: action.key, value: action.value }); return null;
      case "local_storage_remove":
        await page.evaluate((key) => localStorage.removeItem(key), action.key); return null;
      case "local_storage_clear":
        await page.evaluate(() => localStorage.clear()); return null;
      case "clipboard_read":
        if (action.mode === "browser") {
          if (action.grant_permission ?? true) await this.grantBrowserClipboard(page);
          return await page.evaluate(() => navigator.clipboard.readText());
        }
        return await this.systemClipboardRead(timeout);
      case "clipboard_write":
        if (action.mode === "browser") {
          if (action.grant_permission ?? true) await this.grantBrowserClipboard(page);
          await page.evaluate((text) => navigator.clipboard.writeText(text), action.text);
        } else await this.systemClipboardWrite(action.text, timeout);
        return null;
      case "dialog_accept": {
        const dialog = managed.diagnostics.currentDialog();
        if (!dialog) throw new Error("No visible dialog");
        await dialog.accept(action.prompt_text);
        managed.diagnostics.clearDialog(dialog);
        return null;
      }
      case "dialog_dismiss": {
        const dialog = managed.diagnostics.currentDialog();
        if (!dialog) throw new Error("No visible dialog");
        await dialog.dismiss();
        managed.diagnostics.clearDialog(dialog);
        return null;
      }
    }
  }

  private locator(page: Page, spec: LocatorSpec): Locator {
    if (typeof spec === "string") return page.locator(spec);
    if ("selector" in spec) return page.locator(spec.selector);
    if ("text" in spec) return page.getByText(spec.text, { exact: spec.exact });
    if ("role" in spec) return page.getByRole(spec.role as never, { name: spec.name, exact: spec.exact });
    if ("label" in spec) return page.getByLabel(spec.label, { exact: spec.exact });
    return page.getByTestId(spec.testId);
  }

  private async point(page: Page, target: Target, timeout: number) {
    if (typeof target === "object" && target !== null && "x" in target && "y" in target) return target;
    const box = await this.locator(page, target).boundingBox({ timeout });
    if (!box) throw new Error("Target has no bounding box");
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  private async drag(page: Page, from: Target, to: Target, steps: number, timeout: number) {
    const start = await this.point(page, from, timeout);
    const end = await this.point(page, to, timeout);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps });
    await page.mouse.up();
  }

  private async systemClipboardRead(timeout: number) {
    const { stdout } = await execFileAsync("/usr/bin/pbpaste", [], { timeout, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" });
    return stdout;
  }

  private async systemClipboardWrite(text: string, timeout: number) {
    await new Promise<void>((resolve, reject) => {
      const child = execFile("/usr/bin/pbcopy", [], { timeout }, (error) => error ? reject(error) : resolve());
      child.stdin?.end(text);
    });
  }

  private async grantBrowserClipboard(page: Page) {
    let origin: string | undefined;
    try {
      const url = new URL(page.url());
      if (url.protocol === "http:" || url.protocol === "https:") origin = url.origin;
    } catch {}
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], origin ? { origin } : undefined);
  }

  private async withTimeout<T>(promise: Promise<T>, timeout: number, op: string) {
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${op} timed out after ${timeout}ms`)), timeout);
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function roundMs(value: number) {
  return Math.round(value * 10) / 10;
}

