# browser-control

Thin persistent browser runtime policy for local Agent automation.

ChatGPT-facing MCP name: `macmini-browser` on macOS and `windows-browser` on
Windows. The repository, runtime service, and profile remain `browser-control`
internally.

```text
Agent
  -> platform browser MCP (browser-control runtime, Streamable HTTP)
  -> thin Runtime Policy Layer
  -> Playwright native API
  -> dedicated Google Chrome persistent context (default)
```

Runtime defaults:

- MCP: `http://127.0.0.1:8766/mcp`
- Chrome profile: `~/browser-control/chrome-profile`
- Runtime state: `~/browser-control/runtime`
- Artifacts: `~/browser-control/artifacts`

There is no browser-agent fallback, Playwright CLI path, automatic CDP reconnect loop, internal daemon, or arbitrary Node execution.

## Optional existing-Chrome CDP mode

The default `BROWSER_CONTROL_MODE=persistent` retains the dedicated profile and
`launchPersistentContext` behavior. To **opt in** to an already-running local
Chrome with remote debugging enabled, set these in the browser-control **service
environment** and restart the controller at a safe task boundary:

```bash
BROWSER_CONTROL_MODE=cdp
BROWSER_CONTROL_CDP_URL=http://127.0.0.1:9222
```

CDP mode uses Playwright `connectOverCDP()` and the same MCP tools, Skill,
page registry, diagnostics and `browser_batch`; no Chrome DevTools MCP is needed.
It does not launch Chrome or access the dedicated profile. If the connection fails,
the error is reported directly (no fallback). `browser_status.browser_mode` shows
the selected startup mode.

For **Chrome 144+ already running with the normal profile**, open
`chrome://inspect/#remote-debugging` and enable remote debugging. When the
controller connects, approve the connection in Chrome. The controller reads
Chrome's local `DevToolsActivePort` file to find the approval-gated WebSocket;
the HTTP `/json/version` endpoint returning 404 is expected in this mode.
Explicit `ws://` endpoints and Chrome instances started with an ordinary CDP
HTTP debugging port continue to work unchanged. No Chrome restart is required.

**Safety boundary:** CDP mode never closes/restarts Chrome, removes Chrome profile
locks, or recycles the browser on idle. `browser_reset` levels `context` and `hard`
are unavailable in CDP mode; `soft` and `page` remain available. Closing a page
via the explicit `page_close` tool still closes that tab. Stopping the controller
does not stop the attached Chrome. Keep the Chrome debug port bound to loopback.

## MCP tools

`browser_status`, `browser_reset`, `page_list`, `page_create`, `page_close`, `page_alias`, `browser_batch`, `clipboard_read`, `clipboard_write`.

Browser startup is lazy. `browser_batch` is the normal interaction path.

## Idle browser recycling

By default, the dedicated browser closes after 30 minutes without browser operations
or page navigation/close events, but only when there are no pages or every page is
an empty `about:blank`. Any other URL, or DOM content injected into a blank page,
keeps the context open. Business pages are never closed merely because tools have
not been called recently.

The controller stays alive and the profile is retained. The next browser operation
starts Chrome automatically. Existing tools and Agent steps do not change; blank
page ids and aliases must be reacquired after recycling, as after a context reset.

Set `BROWSER_CONTROL_IDLE_TIMEOUT_MS` in the service environment to change the delay
(default `1800000`); set it to `0` to disable recycling. Negative, invalid, or values exceeding the Node timer limit
(`2147483647` milliseconds) also disable it. Restart the controller to apply configuration/code changes only
at a safe task boundary, since a service restart closes existing pages.

For isolated real-Chrome acceptance (temporary profile, no production pages):

```bash
npm run test:idle-browser
```

## Development

```bash
npm install
npm run typecheck
npm test
npm run benchmark
```

See `docs/architecture.md` for reset semantics, batch actions, lifecycle ownership, and diagnostics bounds.

## macOS service

The production MCP server is kept alive by `launchd/com.openai.browser-control.plist`. The service starts the MCP process only; Dedicated Chrome is started lazily by the first browser operation.

## Windows service

Build first and then register the per-user logon task:

```powershell
npm install
npm run build
powershell -NoProfile -ExecutionPolicy Bypass -File .\windows\install-service.ps1
```

The task runs `windows/run-browser-control.ps1`, listens on local
`127.0.0.1:8767` by default (leaving the existing Windows MCP on `8766`), uses
`%USERPROFILE%\browser-control` for runtime state, and starts Dedicated Chrome
lazily in the interactive user session.

