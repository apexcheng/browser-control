import os from "node:os";
import path from "node:path";

export const config = {
  host: process.env.BROWSER_CONTROL_HOST ?? "127.0.0.1",
  port: Number(process.env.BROWSER_CONTROL_PORT ?? 8766),
  chromeHost: "127.0.0.1",
  chromePort: Number(process.env.BROWSER_CONTROL_CDP_PORT ?? 19313),
  chromeBin:
    process.env.BROWSER_CONTROL_CHROME_BIN ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  runtimeDir:
    process.env.BROWSER_CONTROL_HOME ?? path.join(os.homedir(), "browser-control"),
  actionTimeoutMs: Number(process.env.BROWSER_CONTROL_ACTION_TIMEOUT_MS ?? 5000),
  navigationTimeoutMs: Number(process.env.BROWSER_CONTROL_NAVIGATION_TIMEOUT_MS ?? 15000),
  batchTimeoutMs: Number(process.env.BROWSER_CONTROL_BATCH_TIMEOUT_MS ?? 30000),
};

export function runtimePaths() {
  return {
    profileDir: path.join(config.runtimeDir, "chrome-profile"),
    artifactsDir: path.join(config.runtimeDir, "artifacts"),
    runDir: path.join(config.runtimeDir, "run"),
    logsDir: path.join(config.runtimeDir, "logs"),
    chromeLog: path.join(config.runtimeDir, "logs", "chrome.log"),
    chromePid: path.join(config.runtimeDir, "run", "chrome.pid"),
  };
}

export function cdpUrl() {
  return `http://${config.chromeHost}:${config.chromePort}`;
}

