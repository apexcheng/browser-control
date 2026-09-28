import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function readSystemClipboard() {
  const { stdout } = await execFileAsync("/usr/bin/pbpaste", [], { encoding: "utf8", maxBuffer: 2_000_000 });
  return stdout;
}

export async function writeSystemClipboard(text: string) {
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
