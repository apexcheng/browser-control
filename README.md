# browser-control

Persistent browser-control infrastructure for Web DOM automation and E2E work.

P0 architecture:

```text
Agent
  -> browser-control MCP (Streamable HTTP)
  -> in-process BrowserController
  -> one long-lived Playwright CDP connection
  -> dedicated Google Chrome
```

Runtime defaults:

- MCP: `http://127.0.0.1:8766/mcp`
- CDP: `http://127.0.0.1:19313`
- Chrome profile: `~/browser-control/chrome-profile`
- Artifacts: `~/browser-control/artifacts`

The normal action path never shells out to a browser CLI and never reconnects to CDP per action.

## Development

```bash
npm install
npm run typecheck
npm test
npm run benchmark
```

`browser_batch` is the preferred interface for multi-step cases. `eval` executes only in the page context; P0 intentionally does not expose arbitrary Node/Playwright code execution inside the Controller process.

## macOS service

The production MCP server is kept alive by `launchd/com.openai.browser-control.plist`. The service starts the MCP process only; Dedicated Chrome is started lazily by `browser_start` or the first browser operation.

