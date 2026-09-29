import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function readSystemClipboard() {
  if (process.platform === "win32") {
    const script = [
      "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
      "Get-Clipboard -Raw",
    ].join("; ");
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      maxBuffer: 2_000_000,
    });
    return stdout;
  }
  const { stdout } = await execFileAsync("/usr/bin/pbpaste", [], { encoding: "utf8", maxBuffer: 2_000_000 });
  return stdout;
}

export async function writeSystemClipboard(text: string) {
  if (process.platform === "win32") {
    await writeWindowsClipboard(text);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn("/usr/bin/pbcopy", [], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(stderr || `pbcopy exited ${code}`)));
    child.stdin.end(text);
  });
}

async function writeWindowsClipboard(text: string) {
  const script = [
    "[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)",
    "$value = [Console]::In.ReadToEnd()",
    "Set-Clipboard -Value $value",
  ].join("; ");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(stderr || `powershell exited ${code}`)));
    child.stdin.end(text, "utf8");
  });
}
