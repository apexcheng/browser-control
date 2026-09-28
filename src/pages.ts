import type { Browser, BrowserContext, Page } from "playwright";
import { PageDiagnostics } from "./diagnostics.js";

export type ManagedPage = {
  id: string;
  alias?: string;
  page: Page;
  context: BrowserContext;
  contextId: string;
  diagnostics: PageDiagnostics;
  createdAt: number;
  lastUsedAt: number;
};

export class PageRegistry {
  private pages = new Map<string, ManagedPage>();
  private aliases = new Map<string, string>();
  private contexts = new Map<BrowserContext, string>();
  private pageSeq = 0;
  private contextSeq = 0;
  private activePageId?: string;

  async sync(browser: Browser) {
    const contexts = browser.contexts();
    for (const context of contexts) this.registerContext(context);
    for (const context of contexts) {
      for (const page of context.pages()) this.registerPage(page, context);
    }
    if (!this.activePageId) {
      const first = [...this.pages.values()].find((item) => !item.page.isClosed());
      if (first) this.activePageId = first.id;
    }
  }

  async create(browser: Browser, options?: { alias?: string; url?: string; isolated?: boolean }) {
    let context: BrowserContext;
    if (options?.isolated) {
      context = await browser.newContext();
      this.registerContext(context);
    } else {
      context = browser.contexts()[0] ?? await browser.newContext();
      this.registerContext(context);
    }
    const page = await context.newPage();
    const managed = this.registerPage(page, context);
    if (options?.alias) this.setAlias(managed.id, options.alias);
    this.activePageId = managed.id;
    if (options?.url) await page.goto(options.url, { waitUntil: "domcontentloaded" });
    return managed;
  }

  registerPage(page: Page, context: BrowserContext) {
    const existing = [...this.pages.values()].find((item) => item.page === page);
    if (existing) return existing;

    const id = `p_${String(++this.pageSeq).padStart(4, "0")}`;
    const managed: ManagedPage = {
      id,
      page,
      context,
      contextId: this.registerContext(context),
      diagnostics: new PageDiagnostics(page),
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    };
    this.pages.set(id, managed);
    page.on("close", () => {
      for (const [alias, pageId] of this.aliases) {
        if (pageId === id) this.aliases.delete(alias);
      }
      if (this.activePageId === id) this.activePageId = undefined;
      this.pages.delete(id);
    });
    return managed;
  }

  list() {
    return [...this.pages.values()].filter((item) => !item.page.isClosed());
  }

  resolve(ref?: string) {
    let id = ref;
    if (ref && this.aliases.has(ref)) id = this.aliases.get(ref);
    if (!id) id = this.activePageId;
    const managed = id ? this.pages.get(id) : undefined;
    if (!managed || managed.page.isClosed()) throw new Error(`Page not found: ${ref ?? "active"}`);
    managed.lastUsedAt = Date.now();
    this.activePageId = managed.id;
    return managed;
  }

  async use(ref: string) {
    const managed = this.resolve(ref);
    await managed.page.bringToFront();
    return managed;
  }

  setAlias(ref: string, alias: string) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(alias)) throw new Error(`Invalid page alias: ${alias}`);
    const managed = this.resolve(ref);
    const existingId = this.aliases.get(alias);
    if (existingId && existingId !== managed.id) throw new Error(`Alias already in use: ${alias}`);
    if (managed.alias) this.aliases.delete(managed.alias);
    managed.alias = alias;
    this.aliases.set(alias, managed.id);
    return managed;
  }

  async close(ref: string) {
    const managed = this.resolve(ref);
    await managed.page.close({ runBeforeUnload: false });
    return managed.id;
  }

  async resetPage(browser: Browser, ref: string, url?: string) {
    const old = this.resolve(ref);
    const alias = old.alias;
    const context = old.context;
    await old.page.close({ runBeforeUnload: false }).catch(() => undefined);
    const page = await context.newPage();
    const managed = this.registerPage(page, context);
    if (alias) this.setAlias(managed.id, alias);
    this.activePageId = managed.id;
    if (url) await page.goto(url, { waitUntil: "domcontentloaded" });
    await this.sync(browser);
    return managed;
  }

  async resetManagedContext(browser: Browser, ref: string, url?: string) {
    const old = this.resolve(ref);
    if (old.context === browser.contexts()[0]) {
      throw new Error("Default persistent context cannot be reset independently; use page or hard reset");
    }
    const alias = old.alias;
    await old.context.close();
    const context = await browser.newContext();
    this.registerContext(context);
    const page = await context.newPage();
    const managed = this.registerPage(page, context);
    if (alias) this.setAlias(managed.id, alias);
    this.activePageId = managed.id;
    if (url) await page.goto(url, { waitUntil: "domcontentloaded" });
    return managed;
  }

  clear() {
    this.pages.clear();
    this.aliases.clear();
    this.contexts.clear();
    this.activePageId = undefined;
  }

  private registerContext(context: BrowserContext) {
    const existing = this.contexts.get(context);
    if (existing) return existing;
    const id = `c_${String(++this.contextSeq).padStart(4, "0")}`;
    this.contexts.set(context, id);
    context.on("page", (page) => this.registerPage(page, context));
    context.on("close", () => this.contexts.delete(context));
    return id;
  }
}

