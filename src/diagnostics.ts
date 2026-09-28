import type { Dialog, Page, Request } from "playwright";

type ConsoleEntry = { ts: number; type: string; text: string };
type NetworkEntry = { ts: number; method: string; url: string; error: string | null };

export class PageDiagnostics {
  private consoleEntries: ConsoleEntry[] = [];
  private networkEntries: NetworkEntry[] = [];
  private dialog?: Dialog;
  private crashed = false;
  private readonly maxEntries = 100;

  constructor(private readonly page: Page) {
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type())) {
        this.pushConsole({ ts: Date.now(), type: message.type(), text: message.text() });
      }
    });
    page.on("pageerror", (error) => {
      this.pushConsole({ ts: Date.now(), type: "pageerror", text: error.message });
    });
    page.on("requestfailed", (request) => this.pushNetwork(request));
    page.on("dialog", (dialog) => { this.dialog = dialog; });
    page.on("crash", () => { this.crashed = true; });
    page.on("close", () => { this.dialog = undefined; });
  }

  currentDialog() {
    return this.dialog;
  }

  clearDialog(dialog: Dialog) {
    if (this.dialog === dialog) this.dialog = undefined;
  }

  async snapshot(extra?: Record<string, unknown>) {
    const activeElement = await settleWithin(this.page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return null;
      return {
        tag: el.tagName,
        id: el.id || null,
        class: el.className || null,
        role: el.getAttribute("role"),
        name: el.getAttribute("name"),
        type: (el as HTMLInputElement).type || null,
        ariaLabel: el.getAttribute("aria-label"),
      };
    }), 500, null);

    const dialog = this.dialog ? {
      type: this.dialog.type(),
      message: this.dialog.message(),
    } : null;

    return {
      url: this.page.url(),
      title: await settleWithin(this.page.title(), 500, ""),
      closed: this.page.isClosed(),
      crashed: this.crashed,
      active_element: activeElement,
      dialog,
      console_errors: this.consoleEntries.slice(-20),
      network_failures: this.networkEntries.slice(-20),
      ...extra,
    };
  }

  private pushConsole(entry: ConsoleEntry) {
    this.consoleEntries.push(entry);
    if (this.consoleEntries.length > this.maxEntries) this.consoleEntries.shift();
  }

  private pushNetwork(request: Request) {
    this.networkEntries.push({
      ts: Date.now(),
      method: request.method(),
      url: request.url(),
      error: request.failure()?.errorText ?? null,
    });
    if (this.networkEntries.length > this.maxEntries) this.networkEntries.shift();
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

