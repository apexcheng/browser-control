# Architecture

## Decision

browser-control uses a single long-running Node process for both the MCP server and Playwright Controller.

```text
MCP client
  -> Streamable HTTP
  -> browser-control
     -> BrowserController
     -> PageRegistry
     -> BatchExecutor
     -> Diagnostics
     -> Playwright Browser (kept in memory)
  -> CDP :19313
  -> dedicated Chrome profile
```

There is no second internal daemon in P0. Adding one would add latency and lifecycle complexity without improving isolation for the normal action path.

## Page identity

Pages receive stable ids such as `p_0001`. Optional aliases (`app`, `reference`, `admin`) map to page ids and never depend on Chrome tab order.

## Batch

`browser_batch` executes a bounded DSL directly inside the Controller. It returns per-step results, the failed step index, and diagnostics. It does not add unconditional post-action sleeps.

## Script execution

P0 does not expose arbitrary Playwright/Node code execution. Page-context `eval` is available, but Controller-process RCE is not. A future high-level runner should remain a controlled DSL or run unsafe code in a killable worker process.

## Clipboard

The Controller distinguishes browser Clipboard API operations from the macOS system clipboard. Real `Meta+C/V/X` is exercised through Playwright keyboard input and can be combined with system clipboard reads/writes in one batch.

