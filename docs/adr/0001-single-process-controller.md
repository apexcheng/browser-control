# ADR 0001: Single-process MCP and BrowserController

Status: accepted

browser-control keeps MCP transport, page registry, diagnostics, and the Playwright connection in one long-running Node process. P0 does not add an internal socket/daemon layer.

The previous browser-agent path paid repeated shell, Node CLI, socket and tool completion costs even though its Playwright daemon was already persistent. Keeping the Controller in the MCP process removes those layers from normal browser actions.

