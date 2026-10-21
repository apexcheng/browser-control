import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { chromium, type BrowserContext, type Locator, type Page, type Response } from "playwright";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { readSystemClipboard, writeSystemClipboard } from "./clipboard.js";
import { resolveCdpEndpoint } from "./cdp.js";
import { config } from "./config.js";
import { Diagnostics } from "./diagnostics.js";
import { PageRegistry } from "./pages.js";
import type { BatchAction, LocatorSpec, TriggerAction } from "./schema.js";
import { inspectVisualComponentsInPage, inspectVisualLayoutInPage, VISUAL_STYLE_PROPS, visualPageExpression } from "./visual.js";

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
  // A timed-out page.evaluate/CDP call can continue after Promise.race rejects.
  // Block all lifecycle mutations until its underlying work actually settles.
  private readonly pendingVisualActions = new Map<string, Promise<unknown>>();
  private readonly mutatingPages = new Set<string>();
  private contextMutation = false;
  private activeOperations = 0;
  private lastActivityAt = Date.now();
  private activityGeneration = 0;
  private readonly activityPages = new WeakSet<Page>();
  private idleTimer?: NodeJS.Timeout;
  private idleRecycling?: Promise<void>;
  private contextClosing?: Promise<void>;
  private releasingOwner?: Promise<void>;
  private shuttingDown = false;

  constructor(private readonly idleTimeoutMs = config.idleTimeoutMs) {}

  async status() {
    return {
      ok: true,
      running: Boolean(this.context),
      closing: Boolean(this.contextClosing),
      browser_mode: config.browserMode,
      pid: process.pid,
      profile_dir: config.profileDir,
      runtime_dir: config.runtimeDir,
      launch_count: this.launchCount,
      idle_timeout_ms: this.idleTimeoutMs,
      pages: this.context ? await this.pages.list() : [],
    };
  }

  async reset(level: "soft" | "page" | "context" | "hard", pageRef?: string) {
    return this.withBrowserActivity(() => this.resetOperation(level, pageRef));
  }

  private async resetOperation(level: "soft" | "page" | "context" | "hard", pageRef?: string) {
    if (config.browserMode === "cdp" && (level === "context" || level === "hard")) {
      throw new Error(`browser_reset(${level}) is not supported in CDP mode: the attached Chrome must not be restarted or closed`);
    }
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
    return this.withBrowserActivity(() => this.pageListOperation());
  }

  private async pageListOperation() {
    const context = await this.ensureContext();
    this.pages.reconcile(context.pages());
    return this.pages.list();
  }

  async pageCreate(input: { alias?: string; url?: string }) {
    return this.withBrowserActivity(() => this.pageCreateOperation(input));
  }

  private async pageCreateOperation({ alias, url }: { alias?: string; url?: string }) {
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
    return this.withBrowserActivity(() => this.pageCloseOperation(pageRef));
  }

  private async pageCloseOperation(pageRef: string) {
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
    return this.withBrowserActivity(() => this.pageAliasOperation(pageRef, alias));
  }

  private async pageAliasOperation(pageRef: string, alias: string) {
    return { ok: true, ...this.pages.alias(pageRef, alias) };
  }

  async clipboardRead(mode: "system" | "browser", pageRef?: string, grantPermission = false) {
    return this.withBrowserActivity(() => this.clipboardReadOperation(mode, pageRef, grantPermission));
  }

  private async clipboardReadOperation(mode: "system" | "browser", pageRef?: string, grantPermission = false) {
    if (mode === "system") return { mode, text: clipResult(await readSystemClipboard()) };
    const { page } = await this.requirePage(pageRef);
    if (grantPermission) await grantClipboard(page);
    return { mode, text: clipResult(await page.evaluate(() => navigator.clipboard.readText())) };
  }

  async clipboardWrite(mode: "system" | "browser", text: string, pageRef?: string, grantPermission = false) {
    return this.withBrowserActivity(() => this.clipboardWriteOperation(mode, text, pageRef, grantPermission));
  }

  private async clipboardWriteOperation(mode: "system" | "browser", text: string, pageRef?: string, grantPermission = false) {
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
    return this.withBrowserActivity(() => this.batchOperation(input));
  }

  private async batchOperation(input: BatchInput) {
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
        let value: unknown;
        if (action.op === "visual_inspect") {
          const controller = new AbortController();
          const pending = this.runAction(selected.id, selected.page, action, timeout, controller.signal);
          this.pendingVisualActions.set(selected.id, pending);
          void pending.finally(() => {
            if (this.pendingVisualActions.get(selected.id) === pending) this.pendingVisualActions.delete(selected.id);
          }).catch(() => undefined);
          try {
            value = await withTimeout(pending, timeout, `visual_inspect timed out after ${timeout}ms`);
          } catch (error) {
            controller.abort();
            throw error;
          }
        } else {
          value = await withTimeout(
            this.runAction(selected.id, selected.page, action, timeout),
            timeout, `${action.op} timed out after ${timeout}ms`,
          );
        }
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
        if (input.stop_on_error !== false || this.pendingVisualActions.has(selected.id)) break;
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
    if (this.idleRecycling) await this.idleRecycling.catch(() => undefined);
    if (this.activeOperations > 0) throw new Error("Cannot shutdown while a browser operation is running");
    this.beginContextMutation("shutdown");
    this.shuttingDown = true;
    this.clearIdleTimer();
    try {
      await this.stopContext();
    } finally {
      this.contextMutation = false;
    }
  }

  private async withBrowserActivity<T>(operation: () => Promise<T>): Promise<T> {
    if (this.shuttingDown) throw new Error("Browser runtime is shutting down");
    this.activeOperations += 1;
    this.noteActivity();
    try {
      // A request arriving during graceful close waits, then lazily starts Chrome.
      if (this.idleRecycling) await this.idleRecycling.catch(() => undefined);
      return await operation();
    } finally {
      this.activeOperations -= 1;
      this.noteActivity();
    }
  }

  private clearIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private noteActivity() {
    this.activityGeneration += 1;
    this.lastActivityAt = Date.now();
    this.scheduleIdleCheck();
  }

  private scheduleIdleCheck() {
    this.clearIdleTimer();
    if (config.browserMode === "cdp" || !(this.idleTimeoutMs > 0) || this.shuttingDown || !this.context
      || this.activeOperations > 0 || this.idleRecycling) return;
    const remaining = Math.max(1, this.idleTimeoutMs - (Date.now() - this.lastActivityAt));
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      const recycling = this.recycleIdleContext();
      this.idleRecycling = recycling;
      void recycling.catch((error) => {
        this.lastActivityAt = Date.now();
        console.warn("Idle browser recycling skipped:", errorText(error));
      }).finally(() => {
        this.idleRecycling = undefined;
        this.scheduleIdleCheck();
      });
    }, remaining);
    this.idleTimer.unref();
  }

  private async recycleIdleContext() {
    const context = this.context;
    const activityAt = this.lastActivityAt;
    const generation = this.activityGeneration;
    if (!context || this.activeOperations > 0 || this.launching || this.contextMutation
      || this.busyPages.size > 0 || this.mutatingPages.size > 0 || this.pendingVisualActions.size > 0
      || Date.now() - activityAt < this.idleTimeoutMs) return;

    const pages = context.pages();
    // Never infer that an arbitrary URL is idle or safe to close.
    if (pages.some((page) => page.url() !== "about:blank")) {
      this.lastActivityAt = Date.now();
      return;
    }
    const empty = await withTimeout(Promise.all(pages.map((page) => page.evaluate(() => (
      document.head.children.length === 0
      && [...document.body.childNodes].every((node) => (
        node.nodeType === Node.TEXT_NODE && !node.textContent?.trim()
      ))
    )))), 1_000, "Blank-page check timed out");
    if (empty.some((value) => !value)) {
      this.lastActivityAt = Date.now();
      return;
    }
    // Page events and new requests can arrive while the DOM checks are awaited.
    if (this.activeOperations > 0 || this.activityGeneration !== generation || this.context !== context
      || context.pages().length !== pages.length
      || pages.some((page) => page.isClosed() || page.url() !== "about:blank")) return;
    this.beginContextMutation("idle recycling");
    try {
      await this.stopContext();
      console.log("Idle dedicated browser closed; persistent profile retained");
    } finally {
      this.contextMutation = false;
    }
  }

  private assertNoContextMutation() {
    if (this.contextMutation) throw new Error("Browser context lifecycle operation is in progress");
  }

  private beginBatch(pageId: string) {
    this.assertNoContextMutation();
    if (this.pendingVisualActions.has(pageId)) throw new Error(`Page ${pageId} is finishing a previous visual inspection`);
    if (this.mutatingPages.has(pageId)) throw new Error(`Page ${pageId} is undergoing a lifecycle operation`);
    if (this.busyPages.has(pageId)) throw new Error(`Page ${pageId} is already running another browser_batch`);
    this.busyPages.add(pageId);
  }

  private beginPageMutation(pageId: string) {
    this.assertNoContextMutation();
    if (this.pendingVisualActions.has(pageId)) throw new Error(`Page ${pageId} is finishing a previous visual inspection`);
    if (this.busyPages.has(pageId)) throw new Error(`Page ${pageId} is running browser_batch`);
    if (this.mutatingPages.has(pageId)) throw new Error(`Page ${pageId} is already undergoing a lifecycle operation`);
    this.mutatingPages.add(pageId);
  }

  private beginContextMutation(operation: string) {
    if (this.contextMutation) throw new Error(`Cannot ${operation}: another browser context lifecycle operation is in progress`);
    if (this.busyPages.size > 0) throw new Error(`Cannot ${operation} while browser_batch is running`);
    if (this.pendingVisualActions.size > 0) throw new Error(`Cannot ${operation} while visual inspection is finishing`);
    if (this.mutatingPages.size > 0) throw new Error(`Cannot ${operation} while a page lifecycle operation is running`);
    this.contextMutation = true;
  }

  private async ensureContext() {
    if (this.contextClosing) {
      await withTimeout(this.contextClosing, 5_000, "Previous browser context is still closing; retry later or use hard reset");
    }
    if (this.context) return this.context;
    if (this.launching) return this.launching;
    this.launching = this.launch().finally(() => { this.launching = undefined; });
    return this.launching;
  }

  private async launch() {
    if (config.browserMode === "persistent") await mkdir(config.profileDir, { recursive: true });
    await mkdir(config.runtimeDir, { recursive: true });
    await mkdir(config.artifactDir, { recursive: true });
    await this.acquireOwner();

    try {
      let context: BrowserContext;
      if (config.browserMode === "cdp") {
        const endpoint = await resolveCdpEndpoint(config.cdpUrl);
        const browser = await chromium.connectOverCDP(endpoint, { timeout: 30_000 }).catch((error) => {
          throw new Error(`Cannot attach to Chrome via CDP. For a normal Chrome session, enable remote debugging at chrome://inspect/#remote-debugging and approve the connection prompt. ${errorText(error)}`);
        });
        const existingContext = browser.contexts()[0];
        if (!existingContext) throw new Error("CDP connection has no default Chrome context");
        context = existingContext;
        browser.once("disconnected", () => {
          if (this.context !== context) return;
          this.context = undefined;
          this.pages.reset();
          this.diagnostics.reset();
          void this.releaseOwner();
        });
      } else {
        context = await chromium.launchPersistentContext(config.profileDir, {
          channel: config.channel,
          chromiumSandbox: true,
          headless: config.headless,
          viewport: null,
          acceptDownloads: true,
          args: ["--no-first-run", "--no-default-browser-check"],
        });
      }
      context.setDefaultTimeout(config.actionTimeoutMs);
      context.setDefaultNavigationTimeout(config.navigationTimeoutMs);
      this.context = context;
      this.launchCount += 1;
      this.pages.reset();
      this.diagnostics.reset();
      for (const page of context.pages()) this.attachPage(page);
      context.on("page", (page) => this.attachPage(page));
      context.once("close", () => {
        if (this.context !== context) return;
        this.context = undefined;
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
    if (!this.activityPages.has(page)) {
      this.activityPages.add(page);
      page.on("framenavigated", () => this.noteActivity());
      page.once("close", () => this.noteActivity());
    }
    return id;
  }

  private async requirePage(ref?: string) {
    const context = await this.ensureContext();
    this.pages.reconcile(context.pages());
    if (context.pages().length === 0) this.attachPage(await context.newPage());
    return this.pages.resolve(ref);
  }

  private locator(page: Page, spec: LocatorSpec, frame?: string): Locator {
    const scope = frame ? page.frameLocator(frame) : page;
    if (typeof spec === "string") return scope.locator(spec);
    switch (spec.by) {
      case "role":
        return scope.getByRole(spec.role as any, { name: spec.name, exact: spec.exact });
      case "text":
        return scope.getByText(spec.text, { exact: spec.exact });
      case "label":
        return scope.getByLabel(spec.text, { exact: spec.exact });
      case "testId":
        return scope.getByTestId(spec.value);
    }
  }

  private async runAction(pageId: string, page: Page, action: BatchAction, timeout: number, signal?: AbortSignal): Promise<unknown> {
    switch (action.op) {
      case "goto": {
        const response = await page.goto(action.url, { waitUntil: action.wait_until, timeout });
        return { url: page.url(), status: response?.status() };
      }
      case "click":
        await this.locator(page, action.target, action.frame).click({ timeout });
        return true;
      case "dblclick":
        await this.locator(page, action.target, action.frame).dblclick({ timeout });
        return true;
      case "fill":
        await this.locator(page, action.target, action.frame).fill(action.text, { timeout });
        return true;
      case "press":
        if (action.target) await this.locator(page, action.target, action.frame).press(action.key, { timeout });
        else await page.keyboard.press(action.key);
        return true;
      case "hover":
        await this.locator(page, action.target, action.frame).hover({ timeout });
        return true;
      case "drag":
        await this.locator(page, action.from, action.frame).dragTo(this.locator(page, action.to, action.frame), { timeout });
        return true;
      case "wait_for":
        await this.locator(page, action.target, action.frame).waitFor({ state: action.state, timeout });
        return true;
      case "text":
        return clipResult(await this.locator(page, action.target, action.frame).innerText({ timeout }));
      case "attr":
        return this.locator(page, action.target, action.frame).getAttribute(action.name, { timeout });
      case "count":
        return this.locator(page, action.target, action.frame).count();
      case "evaluate":
        return page.evaluate(action.expression);
      case "screenshot":
        return this.captureScreenshot(page, action.name, action.full_page, timeout, action.target,
          action.padding_px, action.stability_check);
      case "visual_inspect": {
        const deadline = Date.now() + timeout;
        const ensureActive = () => {
          if (signal?.aborted || Date.now() >= deadline) throw new Error("Visual inspection timed out or cancelled");
        };
        const result = await this.visualInspect(page, action, ensureActive);
        ensureActive();
        if (!action.name) return result;
        const name = action.name.endsWith(".json") ? action.name : `${action.name}.json`;
        const filepath = path.join(config.artifactDir, name);
        await mkdir(config.artifactDir, { recursive: true });
        ensureActive();
        await writeFile(filepath, JSON.stringify(result, null, 2));
        await this.pruneArtifacts();
        return { ...result, artifact: filepath };
      }
      case "clipboard":
        if (action.action === "read") return this.clipboardRead(action.mode, pageId, action.grant_permission);
        return this.clipboardWrite(action.mode, action.text!, pageId, action.grant_permission);
      case "dialog":
        return this.runDialog(pageId, page, action, timeout);
      case "wait_response":
        return this.runWaitResponse(pageId, page, action, timeout);
      case "network_log":
        return this.diagnostics.networkLog(pageId, action.action, action);
      case "download":
        return this.runDownload(pageId, page, action, timeout);
      case "websocket_log":
        return this.diagnostics.websocketLog(pageId, action.action, action.include_payload);
    }
  }

  private runTrigger(pageId: string, page: Page, action: TriggerAction, timeout: number) {
    return this.runAction(pageId, page, action as BatchAction, timeout);
  }

  private async visualInspect(page: Page, action: Extract<BatchAction, { op: "visual_inspect" }>, ensureActive: () => void) {
    ensureActive();
    if (action.mode === "layout") {
      const layout = await page.evaluate(visualPageExpression(inspectVisualLayoutInPage, {
        selector: action.selector, maxDepth: action.max_depth, maxNodes: action.max_nodes,
        includeText: action.include_text,
      })) as ReturnType<typeof inspectVisualLayoutInPage>;
      ensureActive();
      return layout;
    }
    const output = await page.evaluate(visualPageExpression(inspectVisualComponentsInPage, {
      selector: action.selector, maxMatches: action.max_matches, properties: VISUAL_STYLE_PROPS,
      includeText: action.include_text,
    })) as ReturnType<typeof inspectVisualComponentsInPage>;
    ensureActive();
    if (!action.include_platform_fonts || !output.elements.length) return output;
    // Reuse the *existing* Chrome context's CDP session, not another browser.
    const cdp = await page.context().newCDPSession(page);
    const warnings: string[] = [];
    try {
      ensureActive();
      await cdp.send("DOM.enable");
      ensureActive();
      await cdp.send("CSS.enable");
      ensureActive();
      const { root } = await cdp.send("DOM.getDocument", { depth: 1 });
      ensureActive();
      const { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: action.selector });
      for (let i = 0; i < Math.min(nodeIds.length, output.elements.length); i++) {
        ensureActive();
        try {
          const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId: nodeIds[i]! });
          ensureActive();
          Object.assign(output.elements[i]!, {
            platformFonts: fonts.map((font) => ({
              family: font.familyName, custom: font.isCustomFont, glyphCount: font.glyphCount,
            })),
          });
        } catch (error) {
          warnings.push(`Font inspection ${i + 1}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      warnings.push(`CDP font inspection unavailable: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await cdp.detach().catch(() => undefined);
    }
    ensureActive();
    return { ...output, ...(warnings.length ? { warnings } : {}) };
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
    return this.responseValue(response, action.body, action.request_body);
  }

  private async runDownload(pageId: string, page: Page, action: Extract<BatchAction, { op: "download" }>, timeout: number) {
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout }),
      this.runTrigger(pageId, page, action.trigger, timeout),
    ]);
    const suggested = download.suggestedFilename().replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80) || "file";
    const filepath = path.join(config.artifactDir, `download-${randomUUID()}-${suggested}`);
    await mkdir(config.artifactDir, { recursive: true });
    await withTimeout(download.saveAs(filepath), timeout, "Download save timed out");
    await this.pruneArtifacts();
    return { path: filepath, suggested_filename: download.suggestedFilename() };
  }

  private async responseValue(response: Response, bodyMode: "none" | "text" | "json", requestBodyMode: "none" | "text" = "none") {
    const value: Record<string, unknown> = {
      url: response.url(),
      method: response.request().method(),
      status: response.status(),
    };
    if (requestBodyMode === "text") {
      const request = response.request();
      const contentType = request.headers()["content-type"] ?? null;
      const payload = request.postDataBuffer();
      value.request = {
        resource_type: request.resourceType(),
        content_type: contentType,
        body: !payload ? null : payload.length > config.requestPayloadLimit
          ? { omitted: true, bytes: payload.length, limit: config.requestPayloadLimit }
          : /^(application\/(json|[^;]+\+json|x-www-form-urlencoded|xml)|text\/)/i.test(contentType ?? "")
            ? payload.toString("utf8") : { omitted: true, reason: "non-text content type" },
      };
    }
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

  private async captureScreenshot(
    page: Page, name?: string, fullPage = false, timeout = config.actionTimeoutMs,
    target?: LocatorSpec, paddingPx = 4, stabilityCheck = false,
  ) {
    await mkdir(config.artifactDir, { recursive: true });
    const filename = name ?? `shot-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
    const filepath = path.join(config.artifactDir, filename.endsWith(".png") ? filename : `${filename}.png`);
    if (target) {
      const locator = this.locator(page, target);
      const snapshot = () => locator.evaluate((element) => {
        const r = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          rect: { x: r.x, y: r.y, width: r.width, height: r.height },
          viewport: { width: window.innerWidth, height: window.innerHeight },
          hover: element.matches(":hover"), focus: element.matches(":focus"),
          focusWithin: element.matches(":focus-within"),
          styles: {
            background: style.backgroundColor, color: style.color, border: style.border,
            outline: style.outline, shadow: style.boxShadow, opacity: style.opacity,
            outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth,
            outlineOffset: style.outlineOffset, transform: style.transform, visibility: style.visibility,
          },
        };
      }, undefined, { timeout });
      const before = await snapshot();
      // An estimate, not a proof of sufficient padding: blur/shadow effects
      // can extend beyond their CSS radius. Surface a warning rather than
      // falsely asserting that the resulting pixels are complete.
      const px = (value: string) => parseFloat(value) || 0;
      const outlinePadding = before.styles.outlineStyle === "none"
        ? 0 : Math.max(0, px(before.styles.outlineWidth) + px(before.styles.outlineOffset));
      const shadowPadding = before.styles.shadow.split(/,(?![^()]*\))/).reduce((max, shadow) => {
        if (/\binset\b/.test(shadow)) return max;
        const numbers = [...shadow.matchAll(/(-?\d+(?:\.\d+)?)px/g)].map((match) => Number(match[1]));
        if (numbers.length < 2) return max;
        const [offsetX, offsetY, blur = 0, spread = 0] = numbers;
        return Math.max(max, Math.max(Math.abs(offsetX!), Math.abs(offsetY!))
          + Math.max(0, blur) * 2 + spread);
      }, 0);
      const recommendedPadding = Math.ceil(Math.max(0, outlinePadding, shadowPadding));
      const { x, y, width, height } = before.rect;
      const viewport = before.viewport;
      if (width <= 0 || height <= 0 || x < 0 || y < 0
        || x + width > viewport.width || y + height > viewport.height) {
        throw new Error("Target screenshot requires the entire element to be visible in the viewport; scroll explicitly first to preserve hover/focus state");
      }
      // Playwright's locator.screenshot AND page.screenshot({clip}) can
      // change :hover by repositioning the pointer / viewport. Capture the
      // existing viewport, then crop its PNG in memory without writing a
      // full-page artifact or changing the browser's interaction state.
      const left = Math.max(0, x - paddingPx);
      const top = Math.max(0, y - paddingPx);
      const right = Math.min(viewport.width, x + width + paddingPx);
      const bottom = Math.min(viewport.height, y + height + paddingPx);
      const clip = { x: left, y: top, width: right - left, height: bottom - top };
      const effectsMayBeClipped = paddingPx < recommendedPadding
        || left > x - recommendedPadding || top > y - recommendedPadding
        || right < x + width + recommendedPadding || bottom < y + height + recommendedPadding;
      const captured = await page.screenshot({ timeout });
      const after = await snapshot();
      if (JSON.stringify({ ...before, rect: undefined }) !== JSON.stringify({ ...after, rect: undefined })
        || JSON.stringify(before.rect) !== JSON.stringify(after.rect)) {
        throw new Error("Target visual state changed during screenshot; screenshot discarded rather than comparing mismatched states");
      }
      const source = PNG.sync.read(captured);
      const scaleX = source.width / viewport.width;
      const scaleY = source.height / viewport.height;
      const bounds = {
        x: Math.max(0, Math.floor(left * scaleX)),
        y: Math.max(0, Math.floor(top * scaleY)),
        right: Math.min(source.width, Math.ceil(right * scaleX)),
        bottom: Math.min(source.height, Math.ceil(bottom * scaleY)),
      };
      const cropped = new PNG({ width: bounds.right - bounds.x, height: bounds.bottom - bounds.y });
      for (let row = 0; row < cropped.height; row++) {
        source.data.copy(cropped.data, row * cropped.width * 4,
          ((bounds.y + row) * source.width + bounds.x) * 4,
          ((bounds.y + row) * source.width + bounds.right) * 4);
      }
      let stability: { checked: true; mismatched_pixels: number; stable: boolean } | undefined;
      if (stabilityCheck) {
        const secondCapture = await page.screenshot({ timeout });
        const secondState = await snapshot();
        if (JSON.stringify(after) !== JSON.stringify(secondState)) {
          throw new Error("Target visual state changed during stability check; screenshot discarded");
        }
        const second = PNG.sync.read(secondCapture);
        if (second.width !== source.width || second.height !== source.height) {
          throw new Error("Viewport dimensions changed during stability check; screenshot discarded");
        }
        const secondCrop = new PNG({ width: cropped.width, height: cropped.height });
        for (let row = 0; row < secondCrop.height; row++) {
          second.data.copy(secondCrop.data, row * secondCrop.width * 4,
            ((bounds.y + row) * second.width + bounds.x) * 4,
            ((bounds.y + row) * second.width + bounds.right) * 4);
        }
        const changedPixels = pixelmatch(cropped.data, secondCrop.data, undefined, cropped.width, cropped.height,
          { threshold: 0.1, includeAA: false });
        stability = { checked: true, mismatched_pixels: changedPixels, stable: changedPixels === 0 };
      }
      await writeFile(filepath, PNG.sync.write(cropped));
      await this.pruneArtifacts();
      return {
        path: filepath, clip, padding_px: paddingPx,
        padding_clipped: left > x - paddingPx || top > y - paddingPx
          || right < x + width + paddingPx || bottom < y + height + paddingPx,
        recommended_padding_px: recommendedPadding,
        effects_may_be_clipped: effectsMayBeClipped,
        ...(stability ? { stability } : {}),
        ...((effectsMayBeClipped || (stability && !stability.stable)) ? {
          warnings: [
            ...(effectsMayBeClipped
              ? [`Outline/shadow may be cropped; estimated margin ${recommendedPadding}px (padding_px max 64). Check viewport edges or use full-page screenshot.`]
              : []),
            ...(stability && !stability.stable
              ? [`Repeated screenshots differ by ${stability.mismatched_pixels} pixels; inspect scrollbars, animations and dynamic content.`] : []),
          ],
        } : {}),
      };
    }
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
    // A CDP attachment is not the owner of the user's Chrome process or profile.
    // Drop runtime references; never close its default context or kill Chrome.
    if (config.browserMode === "cdp") {
      await this.releaseOwner();
      return;
    }
    if (context) {
      const closing = context.close().then(() => this.releaseOwner()).finally(() => {
        if (this.contextClosing === closing) this.contextClosing = undefined;
      });
      this.contextClosing = closing;
      const closed = await settlesWithin(closing, timeoutMs);
      if (!closed && !force) {
        throw new Error(`Browser context did not close within ${timeoutMs}ms; use hard reset`);
      }
    }
    if (force) await this.forceKillProfileChrome();
    await this.releaseOwner();
  }

  private async acquireOwner() {
    if (this.releasingOwner) await this.releasingOwner;
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
    if (this.releasingOwner) return this.releasingOwner;
    if (!this.ownsLock) return;
    this.releasingOwner = (async () => {
      const owner = await readOwner();
      if (!owner?.pid || owner.pid === process.pid) await unlink(ownerFile).catch(() => undefined);
      this.ownsLock = false;
    })().finally(() => { this.releasingOwner = undefined; });
    return this.releasingOwner;
  }

  private async forceKillProfileChrome() {
    const pattern = `--user-data-dir=${config.profileDir}`;
    const pids = process.platform === "win32"
      ? await windowsProcessIdsContaining(pattern)
      : await unixProcessIdsContaining(pattern);
    for (const pid of pids) {
      if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue;
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    for (const pid of pids) {
      if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid || !pidAlive(pid)) continue;
      try { process.kill(pid, process.platform === "win32" ? "SIGTERM" : "SIGKILL"); } catch {}
    }
  }

  private async clearChromeProfileLocks() {
    await Promise.all(["SingletonCookie", "SingletonLock", "SingletonSocket"].map((name) => (
      unlink(path.join(config.profileDir, name)).catch(() => undefined)
    )));
  }
}

async function unixProcessIdsContaining(pattern: string) {
  const { stdout } = await execFileAsync("/usr/bin/pgrep", ["-f", pattern], { encoding: "utf8" })
    .catch(() => ({ stdout: "" }));
  return stdout.split(/\s+/).filter(Boolean).map(Number).filter(Number.isInteger);
}

async function windowsProcessIdsContaining(pattern: string) {
  const script = [
    "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
    "$needle = $args[0]",
    "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($needle) } | ForEach-Object { $_.ProcessId }",
  ].join("; ");
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script, pattern], {
    encoding: "utf8",
    maxBuffer: 1_000_000,
  }).catch(() => ({ stdout: "" }));
  return stdout.split(/\s+/).filter(Boolean).map(Number).filter(Number.isInteger);
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
