$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $env:USERPROFILE 'browser-control'
$logDir = Join-Path $runtimeRoot 'logs'
$entry = Join-Path $repoRoot 'dist\src\server.js'
$node = (Get-Command node.exe -ErrorAction Stop).Source

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$env:BROWSER_CONTROL_HOME = $runtimeRoot
$env:BROWSER_CONTROL_PORT = '8767'
$env:BROWSER_CONTROL_MCP_NAME = 'windows-browser'
$env:BROWSER_CONTROL_MCP_TITLE = 'Windows Browser'

& $node $entry 1>> (Join-Path $logDir 'browser-control.log') 2>> (Join-Path $logDir 'browser-control-error.log')
exit $LASTEXITCODE
