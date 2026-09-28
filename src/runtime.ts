import { execFile } from "node:child_process";
import { mkdir, open, readFile, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { chromium, type BrowserContext, type Locator, type Page, type Response } from "playwright";
import { readSystemClipboard, writeSystemClipboard } from "./clipboard.js";
import { config } from "./config.js";
import { Diagnostics } from "./diagnostics.js";
import { PageRegistry } from "./pages.js";
import type { BatchAction, LocatorSpec, TriggerAction } from "./schema.js";

const execFileAsync = promisify(execFile);
const ownerFile = path.join(config.runtimeDir, "owner.json");
const failureDiagnosticsTimeoutMs = 2_000;
const failureDiagnosticsFocusTimeoutMs = 300;

type DiagnosticOptions = {
  on_error?: boolean;
  console?: boolean;
  network?: boolean;
  screenshot?: boolean;
};

type BatchInput = {
  page?: string;
  actions: BatchAction[];
  stop_on_error?: boolean;
  timeout_ms?: number;
  action_timeout_ms?: number;
  diagnostics?: DiagnosticOptions;
};

export class BrowserRuntime {
  private context?: BrowserContext;
  private launching?: Promise<BrowserContext>;
  private ownsLock = false;
  private launchCount = 0;
  private readonly pages = new PageRegistry();
  private readonly diagnostics = new Diagnostics();
  private readonly busyPages = new Set<string>();
  private readonly mutatingPages = new Set<string>();
  private contextMutation = false;

  async status() {
    return {
      ok: true,
      running: Boolean(this.context),
      pid: process.pid,
      profile_dir: config.profileDir,
      runtime_dir: config.runtimeDir,
      launch_count: this.launchCount,
      pages: this.context ? await this.pages.list() : [],
    };
  }

  async reset(level: "soft" | "page" | "context" | "hard", pageRef?: string) {
    if (level === "soft") {
      if (!this.context) return { ok: true, level, running: false };
      this.pages.reconcile(this.context.pages());
      this.diagnostics.clear();
      return { ok: true, level, pages: await this.pages.list() };
    }

    if (level === "page") {
      this.assertNoContextMutation();
      const { id, page } = await this.requirePage(pageRef);
      this.beginPageMutation(id);
      try {
        await page.reload({ waitUntil: "domcontentloaded", timeout: config.navigationTimeoutMs });
        return { ok: true, level, page: id, url: page.url() };
      } finally {
        this.mutatingPages.delete(id);
      }
    }

    this.beginContextMutation(`browser_reset(${level})`);
    try {
      if (level === "hard") {
        await this.stopContext({ timeoutMs: 1500, force: true });
        await this.clearChromeProfileLocks();
      } else {
        await this.stopContext({ timeoutMs: 5000 });
      }
      await this.ensureContext();
      return { ok: true, level, pages: await this.pages.list() };
    } finally {
      this.contextMutation = false;
    }
  }

  async pageList() {
    const context = await this.ensureContext();
    this.pages.reconcile(context.pages());
    return this.pages.list();
  }

  async pageCreate({ alias, url }: { alias?: string; url?: string }) {
    const context = await this.ensureContext();
    const page = await context.newPage();
    const id = this.attachPage(page);
    try {
      if (alias) this.pages.alias(id, alias);
      if (url) await page.goto(url, { waitUntil: "domcontentloaded", timeout: config.navigationTimeoutMs });
      return { id, aliases: this.pages.aliasesFor(id), url: page.url() };
    } catch (error) {
      await page.close({ runBeforeUnload: false }).catch(() => undefined);
      throw error;
    }
  }

  async pageClose(pageRef: string) {
    this.assertNoContextMutation();
    const { id, page } = await this.requirePage(pageRef);
    this.beginPageMutation(id);
    try {
      await page.close({ runBeforeUnload: false });
      return { ok: true, page: id };
    } finally {
      this.mutatingPages.delete(id);
    }
  }

  async pageAlias(pageRef: string, alias: string) {
    return { ok: true, ...this.pages.alias(pageRef, alias) };
  }

  async clipboardRead(mode: "system" | "browser", pageRef?: string, grantPermission = false) {
    if (mode === "system") return { mode, text: clipResult(await readSystemClipboard()) };
    const { page } = await this.requirePage(pageRef);
    if (grantPermission) await grantClipboard(page);
    return { mode, text: clipResult(await page.evaluate(() => navigator.clipboard.readText())) };
  }

  async clipboardWrite(mode: "system" | "browser", text: string, pageRef?: string, grantPermission = false) {
    if (mode === "system") {
      await writeSystemClipboard(text);
      return { ok: true, mode };
    }
    const { page } = await this.requirePage(pageRef);
    if (grantPermission) await grantClipboard(page);
    await page.evaluate((value) => navigator.clipboard.writeText(value), text);
    return { ok: true, mode };
  }

  async batch(input: BatchInput) {
    if (input.actions.length > config.maxActions) throw new Error(`At most ${config.maxActions} actions are allowed`);
    this.assertNoContextMutation();
    const selected = await this.requirePage(input.page);
    this.beginBatch(selected.id);
    try {
    const totalTimeout = input.timeout_ms ?? config.batchTimeoutMs;
    const defaultActionTimeout = input.action_timeout_ms ?? config.actionTimeoutMs;
    const deadline = Date.now() + totalTimeout;
    const results: Array<Record<string, unknown>> = [];
    let failedStep: number | undefined;

    for (let index = 0; index < input.actions.length; index++) {
      const action = input.actions[index];
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        failedStep = index;
        results.push({ index, op: action.op, ok: false, duration_ms: 0, error: `Batch timed out after ${totalTimeout}ms` });
        break;
      }

      const timeout = Math.min(action.timeout_ms ?? defaultActionTimeout, remaining);
      const started = performance.now();
      try {
        const value = await withTimeout(
          this.runAction(selected.id, selected.page, action, timeout),
          timeout,
          `${action.op} timed out after ${timeout}ms`,
        );
        results.push({
          index,
          op: action.op,
          ok: true,
          duration_ms: round(performance.now() - started),
          value: boundValue(value),
        });
      } catch (error) {
        failedStep ??= index;
        results.push({
          index,
          op: action.op,
          ok: false,
          duration_ms: round(performance.now() - started),
          error: errorText(error),
        });
        if (input.stop_on_error !== false) break;
      }
    }

    const ok = failedStep === undefined;
    const output: Record<string, unknown> = {
      ok,
      page: selected.id,
      results,
      ...(ok ? {} : { failed_step: failedStep }),
    };
    if (!ok && input.diagnostics?.on_error !== false) {
      try {
        output.diagnostics = await withTimeout(
          this.failureDiagnostics(
            selected.id,
            selected.page,
            input.actions[failedStep!],
            input.diagnostics ?? {},
          ),
          failureDiagnosticsTimeoutMs,
          `Failure diagnostics timed out after ${failureDiagnosticsTimeoutMs}ms`,
        );
      } catch (error) {
        output.diagnostics = { unavailable: true, error: errorText(error) };
      }
    }
    return output;
    } finally {
      this.busyPages.delete(selected.id);
    }
  }

  async shutdown() {
    this.beginContextMutation("shutdown");
    try {
      await this.stopContext();
    } finally {
      this.contextMutation = false;
    }
  }

  private assertNoContextMutation() {
    if (this.contextMutation) throw new Error("Browser context lifecycle operation is in progress");
  }

  private beginBatch(pageId: string) {
    this.assertNoContextMutation();
    if (this.mutatingPages.has(pageId)) throw new Error(`Page ${pageId} is undergoing a lifecycle operation`);
    if (this.busyPages.has(pageId)) throw new Error(`Page ${pageId} is already running another browser_batch`);
    this.busyPages.add(pageId);
  }

  private beginPageMutation(pageId: string) {
    this.assertNoContextMutation();
    if (this.busyPages.has(pageId)) throw new Error(`Page ${pageId} is running browser_batch`);
    if (this.mutatingPages.has(pageId)) throw new Error(`Page ${pageId} is already undergoing a lifecycle operation`);
    this.mutatingPages.add(pageId);
  }

  private beginContextMutation(operation: string) {
    if (this.contextMutation) throw new Error(`Cannot ${operation}: another browser context lifecycle operation is in progress`);
    if (this.busyPages.size > 0) throw new Error(`Cannot ${operation} while browser_batch is running`);
    if (this.mutatingPages.size > 0) throw new Error(`Cannot ${operation} while a page lifecycle operation is running`);
    this.contextMutation = true;
  }

  private async ensureContext() {
    if (this.context) return this.context;
    if (this.launching) return this.launching;
    this.launching = this.launch().finally(() => { this.launching = undefined; });
    return this.launching;
  }

  private async launch() {
    await mkdir(config.profileDir, { recursive: true });
    await mkdir(config.runtimeDir, { recursive: true });
    await mkdir(config.artifactDir, { recursive: true });
    await this.acquireOwner();

    try {
      const context = await chromium.launchPersistentContext(config.profileDir, {
        channel: config.channel,
        chromiumSandbox: true,
        headless: config.headless,
        viewport: null,
        acceptDownloads: true,
        args: ["--no-first-run", "--no-default-browser-check"],
      });
      context.setDefaultTimeout(config.actionTimeoutMs);
      context.setDefaultNavigationTimeout(config.navigationTimeoutMs);
      this.context = context;
      this.launchCount += 1;
      this.pages.reset();
      this.diagnostics.reset();
      for (const page of context.pages()) this.attachPage(page);
      context.on("page", (page) => this.attachPage(page));
      context.once("close", () => {
        if (this.context === context) this.context = undefined;
        this.pages.reset();
        this.diagnostics.reset();
        void this.releaseOwner();
      });
      return context;
    } catch (error) {
      await this.releaseOwner();
      throw error;
    }
  }

  private attachPage(page: Page) {
    const id = this.pages.register(page);
    this.diagnostics.attach(page, id);
    return id;
  }

  private async requirePage(ref?: string) {
    const context = await this.ensureContext();
    this.pages.reconcile(context.pages());
    if (context.pages().length === 0) this.attachPage(await context.newPage());
    return this.pages.resolve(ref);
  }

  private locator(page: Page, spec: LocatorSpec): Locator {
    if (typeof spec === "string") return page.locator(spec);
    switch (spec.by) {
      case "role":
        return page.getByRole(spec.role as any, { name: spec.name, exact: spec.exact });
      case "text":
        return page.getByText(spec.text, { exact: spec.exact });
      case "label":
        return page.getByLabel(spec.text, { exact: spec.exact });
      case "testId":
        return page.getByTestId(spec.value);
    }
  }

  private async runAction(pageId: string, page: Page, action: BatchAction, timeout: number): Promise<unknown> {
    switch (action.op) {
      case "goto": {
        const response = await page.goto(action.url, { waitUntil: action.wait_until, timeout });
        return { url: page.url(), status: response?.status() };
      }
      case "click":
        await this.locator(page, action.target).click({ timeout });
        return true;
      case "dblclick":
        await this.locator(page, action.target).dblclick({ timeout });
        return true;
      case "fill":
        await this.locator(page, action.target).fill(action.text, { timeout });
        return true;
      case "press":
        if (action.target) await this.locator(page, action.target).press(action.key, { timeout });
        else await page.keyboard.press(action.key);
        return true;
      case "hover":
        await this.locator(page, action.target).hover({ timeout });
        return true;
      case "drag":
        await this.locator(page, action.from).dragTo(this.locator(page, action.to), { timeout });
        return true;
      case "wait_for":
        await this.locator(page, action.target).waitFor({ state: action.state, timeout });
        return true;
      case "text":
        return clipResult(await this.locator(page, action.target).innerText({ timeout }));
      case "attr":
        return this.locator(page, action.target).getAttribute(action.name, { timeout });
      case "count":
        return this.locator(page, action.target).count();
      case "evaluate":
        return page.evaluate(action.expression);
      case "screenshot":
        return this.captureScreenshot(page, action.name, action.full_page, timeout);
      case "clipboard":
        if (action.action === "read") return this.clipboardRead(action.mode, pageId, action.grant_permission);
        return this.clipboardWrite(action.mode, action.text!, pageId, action.grant_permission);
      case "dialog":
        return this.runDialog(pageId, page, action, timeout);
      case "wait_response":
        return this.runWaitResponse(pageId, page, action, timeout);
    }
  }

  private runTrigger(pageId: string, page: Page, action: TriggerAction, timeout: number) {
    return this.runAction(pageId, page, action as BatchAction, timeout);
  }

  private async runDialog(
    pageId: string,
    page: Page,
    action: Extract<BatchAction, { op: "dialog" }>,
    timeout: number,
  ) {
    const dialog = this.diagnostics.armDialog(page, action.action, action.prompt_text, timeout);
    await Promise.all([dialog, this.runTrigger(pageId, page, action.trigger, timeout)]);
    return dialog;
  }

  private async runWaitResponse(
    pageId: string,
    page: Page,
    action: Extract<BatchAction, { op: "wait_response" }>,
    timeout: number,
  ) {
    const method = action.method?.toUpperCase();
    const responsePromise = page.waitForResponse((response) => {
      return response.url().includes(action.url_contains)
        && (!method || response.request().method().toUpperCase() === method);
    }, { timeout });
    const [response] = await Promise.all([
      responsePromise,
      this.runTrigger(pageId, page, action.trigger, timeout),
    ]);
    return this.responseValue(response, action.body);
  }

  private async responseValue(response: Response, bodyMode: "none" | "text" | "json") {
    const value: Record<string, unknown> = {
      url: response.url(),
      method: response.request().method(),
      status: response.status(),
    };
    if (bodyMode === "none") return value;
    const body = await response.body();
    if (body.length > config.responseBodyLimit) {
      value.body = { omitted: true, bytes: body.length, limit: config.responseBodyLimit };
      return value;
    }
    const text = body.toString("utf8");
    if (bodyMode === "text") {
      value.body = clipResult(text);
      return value;
    }
    try {
      value.body = JSON.parse(text);
      return value;
    } catch {
      throw new Error(`Response body is not valid JSON: ${response.url()}`);
    }
  }

  private async failureDiagnostics(pageId: string, page: Page, action: BatchAction, options: DiagnosticOptions) {
    const focus = await withTimeout(
      page.evaluate(() => {
        const element = document.activeElement as HTMLElement | null;
        const input = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element : null;
        return {
          active_element: element ? {
            tag: element.tagName.toLowerCase(),
            id: element.id || null,
            class: typeof element.className === "string" ? element.className.slice(0, 500) : null,
            role: element.getAttribute("role"),
            aria_label: element.getAttribute("aria-label"),
          } : null,
          selection: input ? {
            start: input.selectionStart,
            end: input.selectionEnd,
            text: input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0).slice(0, 2_000),
          } : {
            text: (window.getSelection()?.toString() ?? "").slice(0, 2_000),
          },
        };
      }),
      failureDiagnosticsFocusTimeoutMs,
      `Failure diagnostics focus timed out after ${failureDiagnosticsFocusTimeoutMs}ms`,
    ).catch(() => ({ active_element: null, selection: null }));
    const details: Record<string, unknown> = {
      operation: action.op,
      target: actionTarget(action),
      page: pageId,
      aliases: this.pages.aliasesFor(pageId),
      url: page.url(),
      ...focus,
      ...this.diagnostics.snapshot(pageId, { console: options.console, network: options.network }),
    };
    if (options.screenshot) {
      details.screenshot = await this.captureScreenshot(page, undefined, false, 5_000)
        .catch((error) => ({ error: errorText(error) }));
    }
    return details;
  }

  private async captureScreenshot(page: Page, name?: string, fullPage = false, timeout = config.actionTimeoutMs) {
    await mkdir(config.artifactDir, { recursive: true });
    const filename = name ?? `shot-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
    const filepath = path.join(config.artifactDir, filename.endsWith(".png") ? filename : `${filename}.png`);
    await page.screenshot({ path: filepath, fullPage, timeout });
    await this.pruneArtifacts();
    return { path: filepath };
  }

  private async pruneArtifacts() {
    const entries = await readdir(config.artifactDir, { withFileTypes: true }).catch(() => []);
    const files = await Promise.all(entries.filter((entry) => entry.isFile()).map(async (entry) => {
      const filepath = path.join(config.artifactDir, entry.name);
      return { filepath, mtime: (await stat(filepath)).mtimeMs };
    }));
    files.sort((a, b) => b.mtime - a.mtime);
    await Promise.all(files.slice(config.artifactLimit).map((file) => unlink(file.filepath).catch(() => undefined)));
  }

  private async stopContext({ timeoutMs = 5000, force = false }: { timeoutMs?: number; force?: boolean } = {}) {
    const context = this.context;
    this.context = undefined;
    this.pages.reset();
    this.diagnostics.reset();
    if (context) {
      const closed = await settlesWithin(context.close(), timeoutMs);
      if (!closed && !force) {
        throw new Error(`Browser context did not close within ${timeoutMs}ms; use hard reset`);
      }
    }
    if (force) await this.forceKillProfileChrome();
    await this.releaseOwner();
  }

  private async acquireOwner() {
    if (this.ownsLock) return;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(ownerFile, "wx");
        await handle.writeFile(JSON.stringify({
          pid: process.pid,
          started_at: new Date().toISOString(),
          profile_dir: config.profileDir,
        }) + "\n");
        await handle.close();
        this.ownsLock = true;
        return;
      } catch (error: any) {
        if (error?.code !== "EEXIST") throw error;
        const owner = await readOwner();
        if (owner?.pid && owner.pid !== process.pid && pidAlive(owner.pid)) {
          throw new Error(`browser-control profile is owned by live pid ${owner.pid}`);
        }
        await unlink(ownerFile).catch(() => undefined);
      }
    }
    throw new Error("Unable to acquire browser-control runtime ownership");
  }

  private async releaseOwner() {
    if (!this.ownsLock) return;
    const owner = await readOwner();
    if (!owner?.pid || owner.pid === process.pid) await unlink(ownerFile).catch(() => undefined);
    this.ownsLock = false;
  }

  private async forceKillProfileChrome() {
    const pattern = `--user-data-dir=${config.profileDir}`;
    const { stdout } = await execFileAsync("/usr/bin/pgrep", ["-f", pattern], { encoding: "utf8" })
      .catch(() => ({ stdout: "" }));
    for (const token of stdout.split(/\s+/).filter(Boolean)) {
      const pid = Number(token);
      if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue;
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    for (const token of stdout.split(/\s+/).filter(Boolean)) {
      const pid = Number(token);
      if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid || !pidAlive(pid)) continue;
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  }

  private async clearChromeProfileLocks() {
    await Promise.all(["SingletonCookie", "SingletonLock", "SingletonSocket"].map((name) => (
      unlink(path.join(config.profileDir, name)).catch(() => undefined)
    )));
  }
}

async function grantClipboard(page: Page) {
  const url = new URL(page.url());
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: url.origin });
}

async function readOwner(): Promise<{ pid?: number } | undefined> {
  try {
    return JSON.parse(await readFile(ownerFile, "utf8"));
  } catch {
    return undefined;
  }
}

function pidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!));
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number) {
  return Promise.race([
    promise.then(() => true, () => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function round(value: number) {
  return Math.round(value * 10) / 10;
}

function clipResult(value: string) {
  return value.length <= config.resultTextLimit ? value : `${value.slice(0, config.resultTextLimit)}…`;
}

function boundValue(value: unknown): unknown {
  if (typeof value === "string") return clipResult(value);
  if (Array.isArray(value)) return value.slice(0, 1000).map(boundValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 1000).map(([key, item]) => [key, boundValue(item)]));
  }
  return value;
}

function actionTarget(action: BatchAction) {
  if ("target" in action) return action.target;
  if ("from" in action) return { from: action.from, to: action.to };
  if ("url" in action) return action.url;
  if ("url_contains" in action) return action.url_contains;
  return undefined;
}
