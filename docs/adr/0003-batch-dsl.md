# ADR 0003: Controlled batch DSL instead of unsafe run-code

Status: accepted

P0 uses a bounded action DSL for multi-step cases. Arbitrary Node/Playwright code is intentionally excluded because code running in the Controller process can block the event loop and defeat operation timeouts.

If unsafe scripting becomes necessary later, it must run in a separately killable worker/process with a hard timeout.

