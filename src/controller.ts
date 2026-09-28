import fs from "node:fs/promises";
import path from "node:path";
import type { Browser } from "playwright";
import { ActionExecutor } from "./actions.js";
import { ChromeManager } from "./chrome.js";
import { config, runtimePaths } from "./config.js";
import { PageRegistry, type ManagedPage } from "./pages.js";
import type { BatchAction } from "./schema.js";

export class BrowserController {
  readonly chrome = new ChromeManager();
  readonly pages = new PageRegistry();
  readonly actions = new ActionExecutor();

  async start() {
    const browser = await this.chrome.ensureConnected();
    await this.pages.sync(browser);
    return this.status();
  }

  async status() {
    const chrome = await this.chrome.status();
    let pageCount = 0;
    if (this.chrome.connectedBrowser) {
      await this.pages.sync(this.chrome.connectedBrowser);
      pageCount = this.pages.list().length;
    }
    return { ...chrome, pages: pageCount };
  }

  async stop() {
    await this.chrome.stopChrome();
    this.pages.clear();
    return { ok: true };
  }

  async reset(level: "soft" | "page" | "context" | "hard", pageRef?: string, url?: string) {
    const browser = await this.browser();
    if (level === "soft") {
      const managed = this.pages.resolve(pageRef);
      const dialog = managed.diagnostics.currentDialog();
      if (dialog) {
        await dialog.dismiss().catch(() => undefined);
        managed.diagnostics.clearDialog(dialog);
      }
      if (url) await managed.page.goto(url, { waitUntil: "domcontentloaded", timeout: config.navigationTimeoutMs });
      return this.pageInfo(managed);
    }
    if (level === "page") return this.pageInfo(await this.pages.resetPage(browser, pageRef ?? this.pages.resolve().id, url));
    if (level === "context") return this.pageInfo(await this.pages.resetManagedContext(browser, pageRef ?? this.pages.resolve().id, url));
    await this.chrome.restartChrome();
    this.pages.clear();
    const fresh = await this.browser();
    await this.pages.sync(fresh);
    return this.status();
  }

  async pageList() {
    await this.ensurePages();
    return Promise.all(this.pages.list().map((page) => this.pageInfo(page)));
  }

  async pageCreate(options?: { alias?: string; url?: string; isolated?: boolean }) {
    return this.pageInfo(await this.pages.create(await this.browser(), options));
  }

  async pageUse(ref: string) {
    return this.pageInfo(await this.pages.use(ref));
  }

  async pageAlias(ref: string, alias: string) {
    return this.pageInfo(this.pages.setAlias(ref, alias));
  }

  async pageClose(ref: string) {
    return { closed: await this.pages.close(ref) };
  }

  async batch(input: {
    page?: string;
    actions: BatchAction[];
    stop_on_error?: boolean;
    timeout_ms?: number;
    action_timeout_ms?: number;
    diagnostics?: { on_error?: boolean; screenshot?: boolean; dom?: boolean };
  }) {
    const managed = await this.managedPage(input.page);
    const started = performance.now();
    const totalTimeout = input.timeout_ms ?? config.batchTimeoutMs;
    const deadline = Date.now() + totalTimeout;
    const results: unknown[] = [];
    let failedStep: number | null = null;

    for (let index = 0; index < input.actions.length; index++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        failedStep = index;
        results.push({ index, ok: false, error: `batch timed out after ${totalTimeout}ms` });
        break;
      }
      try {
        const actionCap = Math.min(remaining, input.action_timeout_ms ?? Number.POSITIVE_INFINITY);
        const result = await this.actions.run(managed, input.actions[index], actionCap);
        results.push({ index, ...result });
      } catch (error) {
        failedStep = index;
        results.push({ index, ok: false, error: errorMessage(error) });
        if (input.stop_on_error ?? true) break;
      }
    }

    const ok = failedStep === null;
    let diagnostics: unknown;
    if (!ok && (input.diagnostics?.on_error ?? true)) {
      diagnostics = await this.failureDiagnostics(managed, input.actions[failedStep!], input.diagnostics);
    }

    return {
      ok,
      duration_ms: roundMs(performance.now() - started),
      failed_step: failedStep,
      results,
      page: await this.pageInfo(managed),
      diagnostics,
    };
  }

  async single(page: string | undefined, action: BatchAction) {
    const result = await this.batch({ page, actions: [action] });
    if (!result.ok) throw new Error((result.results[0] as { error?: string }).error ?? "browser action failed");
    return result.results[0];
  }

  private async browser(): Promise<Browser> {
    const browser = await this.chrome.ensureConnected();
    await this.pages.sync(browser);
    return browser;
  }

  private async ensurePages() {
    const browser = await this.browser();
    if (this.pages.list().length === 0) await this.pages.create(browser, { alias: "app" });
  }

  private async managedPage(ref?: string) {
    await this.ensurePages();
    return this.pages.resolve(ref);
  }

  private async pageInfo(managed: ManagedPage) {
    return {
      id: managed.id,
      alias: managed.alias ?? null,
      context_id: managed.contextId,
      url: managed.page.url(),
      title: await managed.page.title().catch(() => ""),
      closed: managed.page.isClosed(),
      created_at: managed.createdAt,
      last_used_at: managed.lastUsedAt,
    };
  }

  private async failureDiagnostics(managed: ManagedPage, action: BatchAction, options?: { screenshot?: boolean; dom?: boolean }) {
    const extra: Record<string, unknown> = { operation: action.op };
    if ("target" in action) extra.locator = action.target;

    if (options?.dom) {
      extra.dom = await settleWithin(managed.page.evaluate(() => {
        const el = document.activeElement;
        const source = el instanceof HTMLElement ? el.outerHTML : document.body?.innerHTML ?? "";
        return source.slice(0, 4000);
      }), 500, null);
    }

    if (options?.screenshot && !managed.page.isClosed()) {
      const file = path.join(runtimePaths().artifactsDir, `error-${Date.now()}.png`);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await settleWithin(managed.page.screenshot({ path: file }), 1000, undefined);
      extra.screenshot = file;
    }

    return managed.diagnostics.snapshot(extra);
  }
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.catch(() => fallback),
      new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function roundMs(value: number) {
  return Math.round(value * 10) / 10;
}

