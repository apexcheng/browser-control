# Browser Control Project Instructions

This repository is the standalone browser-control infrastructure.

P1 is intentionally a thin runtime policy layer over Playwright native APIs:

```text
Agent -> browser-control -> Runtime Policy -> Playwright -> Dedicated Chrome
```

- Playwright owns generic browser behavior. Do not mirror the Playwright API or Playwright MCP tool surface.
- The runtime owns exactly one persistent Google Chrome context using `~/browser-control/chrome-profile`.
- Launch Chrome through Playwright `launchPersistentContext`; do not add a CDP reconnect path or a second daemon.
- Browser startup is lazy. Do not expose start/stop tools just for symmetry.
- Keep the Playwright context in memory and reuse it across actions and MCP sessions.
- Use stable page ids / aliases; never expose tab index as durable identity.
- Multi-step work goes through `browser_batch`; do not add single-action MCP tools unless a real runtime requirement proves necessary.
- Every batch and action must be bounded. Diagnostics and console/network history must also be bounded.
- Page `evaluate` is page-context JavaScript only. Never expose Controller-process Node execution.
- System clipboard means real macOS `pbcopy` / `pbpaste`; browser Clipboard API is a separate mode.
- The dedicated Chrome profile, artifacts, locks, logs, screenshots, sockets, and PIDs are runtime state and must never be committed.
- Do not add business-system-specific behavior to the core.
- `browser-agent`, Playwright CLI fallback, compatibility shims, and alternate Chrome runtimes are explicitly out of scope.

