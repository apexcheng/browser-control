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
  -> dedicated Google Chrome persistent context
```

Runtime defaults:

- MCP: `http://127.0.0.1:8766/mcp`
- Chrome profile: `~/browser-control/chrome-profile`
- Runtime state: `~/browser-control/runtime`
- Artifacts: `~/browser-control/artifacts`

There is no browser-agent fallback, Playwright CLI path, CDP reconnect loop, internal daemon, or arbitrary Node execution.

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

