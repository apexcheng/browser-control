import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function defaultChromeActivePortFile() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library/Application Support/Google/Chrome/DevToolsActivePort");
  }
  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Google/Chrome/User Data/DevToolsActivePort") : undefined;
  }
  return path.join(os.homedir(), ".config/google-chrome/DevToolsActivePort");
}

// Chrome 144+ can expose an approval-gated WebSocket for an existing normal
// profile. Its HTTP /json/version endpoint intentionally returns 404.
export async function resolveCdpEndpoint(endpoint: string, activePortFile = defaultChromeActivePortFile()) {
  const url = new URL(endpoint);
  if (!activePortFile || url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) return endpoint;

  try {
    const [port, wsPath] = (await readFile(activePortFile, "utf8")).trim().split(/\r?\n/);
    if (port !== url.port || !wsPath?.startsWith("/devtools/browser/") || /[\s?#]/.test(wsPath)) return endpoint;
    return `ws://${url.host}${wsPath}`;
  } catch {
    // Explicit debugging-port Chrome instances still use the HTTP endpoint.
    return endpoint;
  }
}
