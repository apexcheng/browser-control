# Browser Control Project Instructions

This repository is the standalone browser-control infrastructure.

The ChatGPT-facing MCP identity is `macmini-browser` on macOS and
`windows-browser` on Windows; `browser-control` remains the internal
repository/runtime/service name.

P1 is intentionally a thin runtime policy layer over Playwright native APIs:

```text
Agent -> platform browser MCP -> browser-control Runtime Policy -> Playwright -> Dedicated Chrome
```

- Playwright owns generic browser behavior. Do not mirror the Playwright API or Playwright MCP tool surface.
- By default, the runtime owns one persistent Google Chrome context using `~/browser-control/chrome-profile`.
- Default to Playwright `launchPersistentContext`. Only explicit `BROWSER_CONTROL_MODE=cdp` may attach to an existing Chrome via `connectOverCDP`; do not add automatic CDP reconnect, fallback, or a second daemon.
- In CDP mode, never close or kill Chrome, clean its profile, or run context/hard resets; no idle recycling of the attached browser.
- Browser startup is lazy. Do not expose start/stop tools just for symmetry.
- Keep the Playwright context in memory and reuse it across actions and MCP sessions.
- Use stable page ids / aliases; never expose tab index as durable identity.
- Multi-step work goes through `browser_batch`; do not add single-action MCP tools unless a real runtime requirement proves necessary.
- Every batch and action must be bounded. Diagnostics and console/network history must also be bounded.
- Page `evaluate` is page-context JavaScript only. Never expose Controller-process Node execution. Keep evaluated JavaScript short and guaranteed to terminate; do not use infinite loops, long polling, or never-settling promises. An outer timeout does not guarantee page-side JavaScript was cancelled.
- System clipboard means the real platform clipboard (`pbcopy` / `pbpaste` on macOS, PowerShell clipboard APIs on Windows); browser Clipboard API is a separate mode.
- The dedicated Chrome profile, artifacts, locks, logs, screenshots, sockets, and PIDs are runtime state and must never be committed.
- The persistent browser-control profile is intentionally stateful, not a clean test environment. Treat cookies, login state, local/session storage, IndexedDB, permissions, caches, and site preferences as potentially persistent across runs. When a test requires clean state, use an isolated temporary profile or clear only the target site's relevant state; never delete the production browser-control profile just to reset a test.
- Identify and clean browser-control Chrome processes by the dedicated `--user-data-dir=<browser-control profile>`, not by generic Chrome process counts or broad process-name matching. Renderer/GPU/utility helpers are not extra browser instances, and unrelated user Chrome processes must never be killed.
- Do not treat Playwright's `--remote-debugging-pipe` as legacy CDP exposure. Legacy-CDP residue means an externally reachable/debuggable port such as `--remote-debugging-port=...`, a listening debug port, or an old daemon/wrapper reconnecting over CDP.
- `context` / `hard` reset must preserve the persistent profile; never delete the profile as a recovery shortcut. After either reset, callers must reacquire pages and aliases instead of assuming old page ids or aliases still identify the same page.
- Runtime lifecycle mutations must not race an active batch on the affected page/context. Do not reset context/hard, close the active page, or shut down the runtime while a `browser_batch` is still executing; serialize lifecycle operations with in-flight browser work.
- Runtime validation should assert observable semantics, not incidental implementation details: verify timeout plus subsequent recovery rather than exact error wording, verify the dedicated owner/browser rather than helper-process counts, and verify reset/profile/page identity behavior rather than requiring specific PID changes.
- Do not add business-system-specific behavior to the core.
- For cross-SaaS UI visual comparisons, read `skills/saas-ui-visual-analysis/SKILL.md`; use `visual_inspect` and element `screenshot` through the existing `browser_batch`, then run the offline Pixelmatch CLI. Do not start PicassoWeb's browser or MCP.
- When delegating browser checks to a DevSpace/Codex subagent, test the **subagent's own** connection to the existing MCP before claiming browser validation; parent-agent access does not imply subagent network access. `connect EPERM 127.0.0.1` may be a Codex sandbox restriction, not a broken browser-control service.
- On this setup, `devspace agents run` does not expose a sandbox flag. Direct `codex exec -m gpt-6-astra -s danger-full-access` was independently verified to reach the local MCP, but full access is **not** a default: use it only when explicitly authorized, for that invocation only, and constrain read-only reviews in the brief. Require the subagent itself to call `browser_batch`/`visual_inspect`; a parent-run screenshot followed by a subagent's commentary is not an independent live-browser test.
- `browser-agent`, Playwright CLI fallback, compatibility shims, and alternate Chrome runtimes are explicitly out of scope.

