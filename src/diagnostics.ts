import type { Dialog, Page, Request } from "playwright";
import { config } from "./config.js";

type ConsoleEvent = { at: string; type: string; text: string };
type NetworkFilter = "all" | "api" | "xhr" | "fetch";
type NetworkEvent = { at: string; kind: "request" | "response" | "failed"; method: string; url: string; resource_type: string; status?: number; error?: string };
type SocketEvent = { at: string; kind: "open" | "sent" | "received" | "closed" | "error"; url: string; bytes?: number; payload?: string; error?: string };
type SocketLog = { active: boolean; includePayload: boolean; events: SocketEvent[]; dropped: number };
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
  private readonly requestEvents = new WeakMap<Request, NetworkEvent>();
  private readonly networkDropped = new Map<string, number>();
  private readonly networkFilter = new Map<string, NetworkFilter>();
  private readonly socketByPage = new Map<string, SocketLog>();
  private readonly dialogByPage = new Map<string, DialogInfo>();
  private readonly dialogArms = new WeakMap<Page, DialogArm>();

  attach(page: Page, pageId: string) {
    if (this.attached.has(page)) return;
    this.attached.add(page);
    this.consoleByPage.set(pageId, []);
    this.networkByPage.set(pageId, []);
    this.networkDropped.set(pageId, 0);
    this.networkFilter.set(pageId, "all");
    this.socketByPage.set(pageId, { active: false, includePayload: false, events: [], dropped: 0 });

    page.once("close", () => this.remove(page, pageId));

    page.on("console", (message) => {
      const events = this.consoleByPage.get(pageId);
      if (events) pushBounded(events, { at: new Date().toISOString(), type: message.type(), text: clipped(message.text()) });
    });
    page.on("request", (request) => {
      const event: NetworkEvent = {
        at: new Date().toISOString(), kind: "request", method: request.method(), url: clipped(request.url()),
        resource_type: request.resourceType(),
      };
      this.requestEvents.set(request, event);
      this.recordNetwork(pageId, event);
    });
    page.on("response", (response) => {
      const event = this.requestEvents.get(response.request());
      if (event) { event.kind = "response"; event.status = response.status(); }
      else this.recordNetwork(pageId, {
        at: new Date().toISOString(), kind: "response", method: response.request().method(),
        url: clipped(response.url()), resource_type: response.request().resourceType(), status: response.status(),
      });
    });
    page.on("requestfailed", (request) => {
      const event = this.requestEvents.get(request);
      if (event) { event.kind = "failed"; event.error = clipped(request.failure()?.errorText ?? "request failed"); }
      else this.recordNetwork(pageId, {
        at: new Date().toISOString(), kind: "failed", method: request.method(), url: clipped(request.url()),
        resource_type: request.resourceType(), error: clipped(request.failure()?.errorText ?? "request failed"),
      });
    });
    page.on("websocket", (socket) => {
      const url = clipped(socket.url());
      this.recordSocket(pageId, { at: new Date().toISOString(), kind: "open", url });
      socket.on("framesent", ({ payload }) => this.recordFrame(pageId, "sent", url, payload));
      socket.on("framereceived", ({ payload }) => this.recordFrame(pageId, "received", url, payload));
      socket.on("close", () => this.recordSocket(pageId, { at: new Date().toISOString(), kind: "closed", url }));
      socket.on("socketerror", (error) => this.recordSocket(pageId, {
        at: new Date().toISOString(), kind: "error", url, error: clipped(String(error)),
      }));
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
      this.networkDropped.set(pageId, 0);
      this.networkFilter.set(pageId, "all");
      this.socketByPage.set(pageId, { active: false, includePayload: false, events: [], dropped: 0 });
      this.dialogByPage.delete(pageId);
      return;
    }
    for (const key of this.consoleByPage.keys()) this.consoleByPage.set(key, []);
    for (const key of this.networkByPage.keys()) this.networkByPage.set(key, []);
    for (const key of this.networkDropped.keys()) this.networkDropped.set(key, 0);
    for (const key of this.networkFilter.keys()) this.networkFilter.set(key, "all");
    for (const key of this.socketByPage.keys()) this.socketByPage.set(key, { active: false, includePayload: false, events: [], dropped: 0 });
    this.dialogByPage.clear();
  }

  networkLog(pageId: string, action: "read" | "clear", filter: { resource_type?: NetworkFilter; url_contains?: string; method?: string } = {}) {
    if (action === "clear") {
      this.networkByPage.set(pageId, []);
      this.networkDropped.set(pageId, 0);
      this.networkFilter.set(pageId, filter.resource_type ?? "all");
      return { cleared: true, resource_type: filter.resource_type ?? "all" };
    }
    const events = (this.networkByPage.get(pageId) ?? []).filter((event) => (
      matchType(event.resource_type, filter.resource_type ?? "all")
      && (!filter.url_contains || event.url.includes(filter.url_contains))
      && (!filter.method || event.method.toUpperCase() === filter.method.toUpperCase())
    ));
    return { events: events.map((event) => ({ ...event })), dropped: this.networkDropped.get(pageId) ?? 0 };
  }

  websocketLog(pageId: string, action: "start" | "read" | "stop", includePayload = false) {
    const log = this.socketByPage.get(pageId);
    if (!log) throw new Error(`Unknown page: ${pageId}`);
    if (action === "start") Object.assign(log, { active: true, includePayload, events: [], dropped: 0 });
    if (action === "stop") log.active = false;
    return { active: log.active, dropped: log.dropped, ...(action === "read" ? { events: [...log.events] } : {}) };
  }

  reset() {
    this.consoleByPage.clear();
    this.networkByPage.clear();
    this.networkDropped.clear();
    this.networkFilter.clear();
    this.socketByPage.clear();
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
    this.networkDropped.delete(pageId);
    this.networkFilter.delete(pageId);
    this.socketByPage.delete(pageId);
    this.dialogByPage.delete(pageId);

    const arm = this.dialogArms.get(page);
    if (arm) {
      this.dialogArms.delete(page);
      clearTimeout(arm.timer);
      arm.reject(new Error(`Page ${pageId} closed while waiting for dialog`));
    }
  }

  private recordNetwork(pageId: string, event: NetworkEvent) {
    if (!matchType(event.resource_type, this.networkFilter.get(pageId) ?? "all")) return;
    const events = this.networkByPage.get(pageId);
    if (!events) return;
    events.push(event);
    if (events.length > config.networkHistoryLimit) {
      events.shift();
      this.networkDropped.set(pageId, (this.networkDropped.get(pageId) ?? 0) + 1);
    }
  }

  private recordSocket(pageId: string, event: SocketEvent) {
    const log = this.socketByPage.get(pageId);
    if (!log?.active) return;
    log.events.push(event);
    if (log.events.length > config.websocketHistoryLimit) {
      log.events.shift();
      log.dropped += 1;
    }
  }

  private recordFrame(pageId: string, kind: "sent" | "received", url: string, payload: string | Buffer) {
    const log = this.socketByPage.get(pageId);
    if (!log?.active) return;
    this.recordSocket(pageId, {
      at: new Date().toISOString(), kind, url, bytes: Buffer.byteLength(payload),
      ...(log.includePayload && typeof payload === "string"
        ? { payload: payload.slice(0, config.websocketPayloadLimit) } : {}),
    });
  }
}

function matchType(type: string, filter: NetworkFilter) {
  return filter === "all" || type === filter || (filter === "api" && (type === "xhr" || type === "fetch"));
}
