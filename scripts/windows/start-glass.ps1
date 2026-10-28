# Starts Glass with `npm start` and writes its output to a log, so it can run
# without a terminal (the desktop shortcut runs this in a hidden window).
# Log: %LOCALAPPDATA%\glass-logs\glass.log; the run before it is glass.prev.log.

$ErrorActionPreference = 'Stop'

$repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$logDir = Join-Path $env:LOCALAPPDATA 'glass-logs'
$log = Join-Path $logDir 'glass.log'

New-Item -ItemType Directory -Force $logDir | Out-Null
if (Test-Path $log) {
    Move-Item -Force $log (Join-Path $logDir 'glass.prev.log')
}

Set-Location $repo
# cmd does the redirection so the log stays UTF-8 under Windows PowerShell 5.1 too.
& cmd.exe /d /c "npm start > `"$log`" 2>&1"
