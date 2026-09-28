# Browser Control Project Instructions

This repository is the standalone browser-control infrastructure.

- Keep it independent from business repositories.
- Prefer the shortest implementation that preserves persistent Playwright state.
- Do not add shell wrappers to the normal browser action path.
- BrowserController must keep its Playwright connection in memory and reuse it.
- Use stable page ids / aliases; never expose tab index as the durable identity.
- Multi-step browser cases should use the batch executor.
- Every operation must have bounded timeouts and useful diagnostics.
- The dedicated Chrome profile is runtime state and must never be committed.
- Do not introduce AI-table-specific behavior into the core.

