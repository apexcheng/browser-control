# browser-control

Thin persistent browser runtime policy for local Agent automation.

ChatGPT-facing MCP name: `macmini-browser`. The repository, runtime service,
profile, and launchd label remain `browser-control` internally.

```text
Agent
  -> macmini-browser MCP (browser-control runtime, Streamable HTTP)
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

