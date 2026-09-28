import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import { chromium, type Browser } from "playwright";
import { cdpUrl, config, runtimePaths } from "./config.js";

type ChromeVersion = {
  Browser?: string;
  "Protocol-Version"?: string;
  webSocketDebuggerUrl?: string;
};

export class ChromeManager {
  private browser?: Browser;
  private spawned?: ChildProcess;
  private connecting?: Promise<Browser>;

  get connectedBrowser() {
    return this.browser?.isConnected() ? this.browser : undefined;
  }

  async status() {
    const version = await this.fetchVersion().catch(() => undefined);
    return {
      chrome_running: Boolean(version),
      playwright_connected: Boolean(this.connectedBrowser),
      cdp_url: cdpUrl(),
      profile_dir: runtimePaths().profileDir,
      browser: version?.Browser ?? null,
      protocol_version: version?.["Protocol-Version"] ?? null,
    };
  }

  async ensureConnected(timeoutMs = 8000): Promise<Browser> {
    if (this.connectedBrowser) return this.connectedBrowser;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      await this.ensureChrome(timeoutMs);
      const browser = await chromium.connectOverCDP(cdpUrl(), { timeout: timeoutMs });
      this.browser = browser;
      browser.on("disconnected", () => {
        if (this.browser === browser) this.browser = undefined;
      });
      return browser;
    })().finally(() => {
      this.connecting = undefined;
    });

    return this.connecting;
  }

  async disconnectPlaywright() {
    if (!this.browser) return;
    const browser = this.browser;
    this.browser = undefined;
    await browser.close().catch(() => undefined);
  }

  async stopChrome(timeoutMs = 5000) {
    await this.disconnectPlaywright();
    const paths = runtimePaths();
    let pid: number | undefined;
    try {
      pid = Number((await fs.readFile(paths.chromePid, "utf8")).trim());
    } catch {
      pid = undefined;
    }

    if (pid && Number.isFinite(pid)) {
      try { process.kill(pid, "SIGTERM"); } catch {}
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (!await this.fetchVersion().catch(() => undefined)) break;
        await sleep(100);
      }
      if (await this.fetchVersion().catch(() => undefined)) {
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
    }
    this.spawned = undefined;
    await fs.rm(paths.chromePid, { force: true }).catch(() => undefined);
  }

  async restartChrome() {
    await this.stopChrome();
    return this.ensureConnected();
  }

  private async ensureChrome(timeoutMs: number) {
    if (await this.fetchVersion().catch(() => undefined)) return;

    const paths = runtimePaths();
    await Promise.all([
      fs.mkdir(paths.profileDir, { recursive: true }),
      fs.mkdir(paths.artifactsDir, { recursive: true }),
      fs.mkdir(paths.runDir, { recursive: true }),
      fs.mkdir(paths.logsDir, { recursive: true }),
    ]);

    if (!fsSync.existsSync(config.chromeBin)) {
      throw new Error(`Chrome not found: ${config.chromeBin}`);
    }

    await Promise.all([
      fs.rm(`${paths.profileDir}/SingletonCookie`, { force: true }),
      fs.rm(`${paths.profileDir}/SingletonLock`, { force: true }),
      fs.rm(`${paths.profileDir}/SingletonSocket`, { force: true }),
    ]).catch(() => undefined);

    const logFd = fsSync.openSync(paths.chromeLog, "a");
    this.spawned = spawn(config.chromeBin, [
      `--remote-debugging-address=${config.chromeHost}`,
      `--remote-debugging-port=${config.chromePort}`,
      `--user-data-dir=${paths.profileDir}`,
      "--profile-directory=Default",
      "--restore-last-session",
      "--no-first-run",
      "--no-default-browser-check",
    ], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    fsSync.closeSync(logFd);
    this.spawned.unref();
    await fs.writeFile(paths.chromePid, `${this.spawned.pid ?? ""}\n`, "utf8");

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.fetchVersion().catch(() => undefined)) return;
      await sleep(100);
    }
    throw new Error(`Chrome did not expose CDP within ${timeoutMs}ms; log: ${paths.chromeLog}`);
  }

  private async fetchVersion(): Promise<ChromeVersion> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 800);
    try {
      const response = await fetch(`${cdpUrl()}/json/version`, { signal: controller.signal });
      if (!response.ok) throw new Error(`CDP HTTP ${response.status}`);
      return await response.json() as ChromeVersion;
    } finally {
      clearTimeout(timer);
    }
  }
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

