import os from "node:os";
import path from "node:path";

const rootDir = process.env.BROWSER_CONTROL_HOME ?? path.join(os.homedir(), "browser-control");

export const config = {
  host: process.env.BROWSER_CONTROL_HOST ?? "127.0.0.1",
  port: Number(process.env.BROWSER_CONTROL_PORT ?? 8766),
  rootDir,
  profileDir: process.env.BROWSER_CONTROL_PROFILE ?? path.join(rootDir, "chrome-profile"),
  runtimeDir: process.env.BROWSER_CONTROL_RUNTIME_DIR ?? path.join(rootDir, "runtime"),
  artifactDir: process.env.BROWSER_CONTROL_ARTIFACT_DIR ?? path.join(rootDir, "artifacts"),
  channel: process.env.BROWSER_CONTROL_CHANNEL ?? "chrome",
  headless: process.env.BROWSER_CONTROL_HEADLESS === "1",
  actionTimeoutMs: Number(process.env.BROWSER_CONTROL_ACTION_TIMEOUT_MS ?? 5000),
  navigationTimeoutMs: Number(process.env.BROWSER_CONTROL_NAVIGATION_TIMEOUT_MS ?? 30000),
  batchTimeoutMs: Number(process.env.BROWSER_CONTROL_BATCH_TIMEOUT_MS ?? 60000),
  maxActions: 100,
  diagnosticsLimit: 40,
  diagnosticsTextLimit: 2000,
  resultTextLimit: 100_000,
  responseBodyLimit: 1_000_000,
  artifactLimit: 50,
};
