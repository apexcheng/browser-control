import type { Page } from "playwright";

const ALIAS = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export class PageRegistry {
  private nextId = 1;
  private readonly pageToId = new WeakMap<Page, string>();
  private readonly pages = new Map<string, Page>();
  private readonly aliases = new Map<string, string>();

  register(page: Page): string {
    const existing = this.pageToId.get(page);
    if (existing) return existing;
    const id = `p_${String(this.nextId++).padStart(4, "0")}`;
    this.pageToId.set(page, id);
    this.pages.set(id, page);
    page.once("close", () => this.remove(id));
    return id;
  }

  reconcile(openPages: Page[]) {
    const open = new Set(openPages);
    for (const page of openPages) this.register(page);
    for (const [id, page] of this.pages) if (!open.has(page) || page.isClosed()) this.remove(id);
  }

  reset() {
    this.pages.clear();
    this.aliases.clear();
  }

  resolve(ref?: string): { id: string; page: Page } {
    if (ref) {
      const id = this.pages.has(ref) ? ref : this.aliases.get(ref);
      if (!id) throw new Error(`Unknown page: ${ref}`);
      const page = this.pages.get(id);
      if (!page || page.isClosed()) throw new Error(`Page is closed: ${ref}`);
      return { id, page };
    }
    const live = [...this.pages.entries()].filter(([, page]) => !page.isClosed());
    if (live.length !== 1) throw new Error(`page is required when ${live.length} pages are open`);
    return { id: live[0][0], page: live[0][1] };
  }

  alias(pageRef: string, alias: string) {
    if (!ALIAS.test(alias) || alias.startsWith("p_")) throw new Error(`Invalid page alias: ${alias}`);
    const { id } = this.resolve(pageRef);
    const existing = this.aliases.get(alias);
    if (existing && existing !== id) throw new Error(`Alias already in use: ${alias}`);
    this.aliases.set(alias, id);
    return { page: id, alias };
  }

  aliasesFor(id: string) {
    return [...this.aliases.entries()].filter(([, target]) => target === id).map(([alias]) => alias).sort();
  }

  idFor(page: Page) {
    return this.pageToId.get(page);
  }

  async list() {
    const result = [];
    for (const [id, page] of this.pages) {
      if (page.isClosed()) continue;
      let title = "";
      try { title = await page.title(); } catch { /* navigating */ }
      result.push({ id, aliases: this.aliasesFor(id), url: page.url(), title });
    }
    return result;
  }

  private remove(id: string) {
    this.pages.delete(id);
    for (const [alias, target] of this.aliases) if (target === id) this.aliases.delete(alias);
  }
}
