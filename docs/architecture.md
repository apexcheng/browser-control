# Architecture — P1

## Boundary

```text
Agent
  -> browser-control MCP
  -> BrowserRuntime / PageRegistry / bounded diagnostics
  -> Playwright native API
  -> Google Chrome persistent context
```

browser-control owns runtime policy only. Playwright owns navigation, locators, mouse/keyboard input, dialogs, screenshots, network events, and page-context evaluation.

The Node MCP process is the only controller process. There is no internal daemon and no CLI/browser-agent fallback.

## Dedicated Chrome

The runtime lazily creates exactly one Playwright persistent context using Google Chrome (`channel: chrome`) and `~/browser-control/chrome-profile`. The context remains in memory and is reused for all actions until a reset or process shutdown.

An owner lock under `~/browser-control/runtime` prevents two browser-control processes from owning the same profile. Chrome itself also rejects concurrent use of one user-data directory.

No CDP endpoint is part of P1. The runtime does not connect or reconnect per action.

## Stable pages

Each Playwright Page receives a process-stable id such as `p_0001`. Aliases such as `app`, `reference`, or `admin` map to ids. Tab order is never an identity. Closing a page removes aliases that point to it.

## MCP surface

P1 exposes exactly nine tools:

1. `browser_status`
2. `browser_reset`
3. `page_list`
4. `page_create`
5. `page_close`
6. `page_alias`
7. `browser_batch`
8. `clipboard_read`
9. `clipboard_write`

There are no single-action click/fill/evaluate tools and no start/stop/page-use tools.

## Batch DSL

`browser_batch` accepts 1–100 actions and executes them in the same long-running process/context. P1 actions are:

- `goto`
- `click`
- `dblclick`
- `fill`
- `press`
- `hover`
- `drag`
- `wait_for`
- `text`
- `attr`
- `count`
- `evaluate`
- `screenshot`
- `dialog`
- `wait_response`
- `clipboard`

There is no unconditional sleep action. `dialog` and `wait_response` take a bounded trigger action so the waiter is installed before the triggering operation.

Targets are a thin mapping to Playwright native locators: selector strings plus `getByRole`, `getByText`, `getByLabel`, and `getByTestId`. browser-control does not maintain element refs or a snapshot engine.

Each batch has a total timeout and each step has an effective timeout capped by the remaining batch budget. `stop_on_error` defaults to true. Results contain per-step duration/value/error and `failed_step` when applicable.

`evaluate` executes only in the page JavaScript context. It never runs JavaScript in the Node controller process.

## Reset semantics

- `soft`: reconcile PageRegistry with current context pages and clear bounded transient diagnostics. No navigation or browser restart.
- `page`: reload one target page while preserving its page id and aliases.
- `context`: gracefully close and relaunch the persistent context with the same profile. Page ids are rebuilt.
- `hard`: bound the graceful close attempt, force-stop any remaining Chrome processes using the browser-control profile, remove stale runtime ownership plus Chrome `Singleton*` profile locks, and relaunch with the same profile.

Concurrent `browser_batch` calls may run on different pages, but a second batch targeting the same stable page id is rejected while the first is active. This prevents multi-client action interleaving without introducing a scheduler or queue.

The profile is never deleted by reset, so persistent login state remains a profile concern.

## Diagnostics

For each page, browser-control keeps only the latest 40 console events and 40 network events, with message/URL fields truncated. Batch failures always include operation, target summary, current URL, page id/aliases, active element/selection, and latest dialog metadata. Console/network excerpts are returned only when requested. Error screenshots are opt-in and always written below `~/browser-control/artifacts`; only the newest 50 artifacts are retained.

## Clipboard

System clipboard uses the native platform clipboard (`pbcopy` / `pbpaste` on macOS and PowerShell clipboard APIs on Windows). Browser clipboard uses `navigator.clipboard` in the selected page. Real platform shortcuts are sent by Playwright keyboard input (`Meta` on macOS, `Control` on Windows); reading/writing the system clipboard is a distinct operation.

