import type { Dialog, Page } from "playwright";
import { config } from "./config.js";

type ConsoleEvent = { at: string; type: string; text: string };
type NetworkEvent = { at: string; kind: "response" | "failed"; method: string; url: string; status?: number; error?: string };
export type DialogInfo = { at: string; type: string; message: string; default_value: string };
type DialogArm = {
  action: "accept" | "dismiss";
  promptText?: string;
  resolve: (value: DialogInfo) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

function clipped(value: string) {
  return value.length <= config.diagnosticsTextLimit ? value : `${value.slice(0, config.diagnosticsTextLimit)}…`;
}

function pushBounded<T>(items: T[], value: T) {
  items.push(value);
  if (items.length > config.diagnosticsLimit) items.splice(0, items.length - config.diagnosticsLimit);
}

export class Diagnostics {
  private readonly attached = new WeakSet<Page>();
  private readonly consoleByPage = new Map<string, ConsoleEvent[]>();
  private readonly networkByPage = new Map<string, NetworkEvent[]>();
  private readonly dialogByPage = new Map<string, DialogInfo>();
  private readonly dialogArms = new WeakMap<Page, DialogArm>();

  attach(page: Page, pageId: string) {
    if (this.attached.has(page)) return;
    this.attached.add(page);
    this.consoleByPage.set(pageId, []);
    this.networkByPage.set(pageId, []);

    page.once("close", () => this.remove(page, pageId));

    page.on("console", (message) => {
      const events = this.consoleByPage.get(pageId);
      if (events) pushBounded(events, { at: new Date().toISOString(), type: message.type(), text: clipped(message.text()) });
    });
    page.on("response", (response) => {
      const events = this.networkByPage.get(pageId);
      if (events) pushBounded(events, {
        at: new Date().toISOString(), kind: "response", method: response.request().method(),
        url: clipped(response.url()), status: response.status(),
      });
    });
    page.on("requestfailed", (request) => {
      const events = this.networkByPage.get(pageId);
      if (events) pushBounded(events, {
        at: new Date().toISOString(), kind: "failed", method: request.method(), url: clipped(request.url()),
        error: clipped(request.failure()?.errorText ?? "request failed"),
      });
    });
    page.on("dialog", async (dialog) => this.handleDialog(page, pageId, dialog));
  }

  armDialog(page: Page, action: "accept" | "dismiss", promptText: string | undefined, timeoutMs: number) {
    if (this.dialogArms.has(page)) throw new Error("A dialog waiter is already active for this page");
    return new Promise<DialogInfo>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.dialogArms.delete(page);
        reject(new Error(`Dialog did not appear within ${timeoutMs}ms`));
      }, timeoutMs);
      this.dialogArms.set(page, { action, promptText, resolve, reject, timer });
    });
  }

  clear(pageId?: string) {
    if (pageId) {
      this.consoleByPage.set(pageId, []);
      this.networkByPage.set(pageId, []);
      this.dialogByPage.delete(pageId);
      return;
    }
    for (const key of this.consoleByPage.keys()) this.consoleByPage.set(key, []);
    for (const key of this.networkByPage.keys()) this.networkByPage.set(key, []);
    this.dialogByPage.clear();
  }

  reset() {
    this.consoleByPage.clear();
    this.networkByPage.clear();
    this.dialogByPage.clear();
  }

  snapshot(pageId: string, include?: { console?: boolean; network?: boolean }) {
    return {
      dialog: this.dialogByPage.get(pageId) ?? null,
      console: include?.console ? (this.consoleByPage.get(pageId) ?? []).slice(-10) : undefined,
      network: include?.network ? (this.networkByPage.get(pageId) ?? []).slice(-10) : undefined,
    };
  }

  private async handleDialog(page: Page, pageId: string, dialog: Dialog) {
    const info: DialogInfo = {
      at: new Date().toISOString(), type: dialog.type(), message: clipped(dialog.message()), default_value: clipped(dialog.defaultValue()),
    };
    this.dialogByPage.set(pageId, info);
    const arm = this.dialogArms.get(page);
    if (!arm) {
      await dialog.dismiss().catch(() => undefined);
      return;
    }
    this.dialogArms.delete(page);
    clearTimeout(arm.timer);
    try {
      if (arm.action === "accept") await dialog.accept(arm.promptText);
      else await dialog.dismiss();
      arm.resolve(info);
    } catch (error) {
      arm.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private remove(page: Page, pageId: string) {
    this.consoleByPage.delete(pageId);
    this.networkByPage.delete(pageId);
    this.dialogByPage.delete(pageId);

    const arm = this.dialogArms.get(page);
    if (arm) {
      this.dialogArms.delete(page);
      clearTimeout(arm.timer);
      arm.reject(new Error(`Page ${pageId} closed while waiting for dialog`));
    }
  }
}
