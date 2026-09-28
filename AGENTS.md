# Browser Control Project Instructions

This repository is the standalone browser-control infrastructure.

The ChatGPT-facing MCP identity is `macmini-browser`; `browser-control` remains
the internal repository/runtime/service name.

P1 is intentionally a thin runtime policy layer over Playwright native APIs:

```text
Agent -> macmini-browser -> browser-control Runtime Policy -> Playwright -> Dedicated Chrome
```

- Playwright owns generic browser behavior. Do not mirror the Playwright API or Playwright MCP tool surface.
- The runtime owns exactly one persistent Google Chrome context using `~/browser-control/chrome-profile`.
- Launch Chrome through Playwright `launchPersistentContext`; do not add a CDP reconnect path or a second daemon.
- Browser startup is lazy. Do not expose start/stop tools just for symmetry.
- Keep the Playwright context in memory and reuse it across actions and MCP sessions.
- Use stable page ids / aliases; never expose tab index as durable identity.
- Multi-step work goes through `browser_batch`; do not add single-action MCP tools unless a real runtime requirement proves necessary.
- Every batch and action must be bounded. Diagnostics and console/network history must also be bounded.
- Page `evaluate` is page-context JavaScript only. Never expose Controller-process Node execution. Keep evaluated JavaScript short and guaranteed to terminate; do not use infinite loops, long polling, or never-settling promises. An outer timeout does not guarantee page-side JavaScript was cancelled.
- System clipboard means real macOS `pbcopy` / `pbpaste`; browser Clipboard API is a separate mode.
- The dedicated Chrome profile, artifacts, locks, logs, screenshots, sockets, and PIDs are runtime state and must never be committed.
- The persistent browser-control profile is intentionally stateful, not a clean test environment. Treat cookies, login state, local/session storage, IndexedDB, permissions, caches, and site preferences as potentially persistent across runs. When a test requires clean state, use an isolated temporary profile or clear only the target site's relevant state; never delete the production browser-control profile just to reset a test.
- Identify and clean browser-control Chrome processes by the dedicated `--user-data-dir=<browser-control profile>`, not by generic Chrome process counts or broad `pgrep Chrome` matching. Renderer/GPU/utility helpers are not extra browser instances, and unrelated user Chrome processes must never be killed.
- Do not treat Playwright's `--remote-debugging-pipe` as legacy CDP exposure. Legacy-CDP residue means an externally reachable/debuggable port such as `--remote-debugging-port=...`, a listening debug port, or an old daemon/wrapper reconnecting over CDP.
- `context` / `hard` reset must preserve the persistent profile; never delete the profile as a recovery shortcut. After either reset, callers must reacquire pages and aliases instead of assuming old page ids or aliases still identify the same page.
- Runtime lifecycle mutations must not race an active batch on the affected page/context. Do not reset context/hard, close the active page, or shut down the runtime while a `browser_batch` is still executing; serialize lifecycle operations with in-flight browser work.
- Runtime validation should assert observable semantics, not incidental implementation details: verify timeout plus subsequent recovery rather than exact error wording, verify the dedicated owner/browser rather than helper-process counts, and verify reset/profile/page identity behavior rather than requiring specific PID changes.
- Do not add business-system-specific behavior to the core.
- `browser-agent`, Playwright CLI fallback, compatibility shims, and alternate Chrome runtimes are explicitly out of scope.

