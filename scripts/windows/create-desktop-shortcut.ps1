# Creates (or replaces) a "Glass" shortcut on the desktop that runs
# start-glass.ps1 in a hidden window, detached from any terminal.
# Paths come from this checkout, so run it again after cloning on a new machine:
#   npm run shortcut:win

$ErrorActionPreference = 'Stop'

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$launcher = Join-Path $PSScriptRoot 'start-glass.ps1'
$desktop = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desktop 'Glass.lnk'

# PowerShell 7 when installed, Windows PowerShell otherwise.
$pwsh = Get-Command pwsh.exe -ErrorAction SilentlyContinue
$shell = if ($pwsh) { $pwsh.Source } else { (Get-Command powershell.exe).Source }

$wsh = New-Object -ComObject WScript.Shell
$lnk = $wsh.CreateShortcut($lnkPath)
$lnk.TargetPath = $shell
$lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`""
$lnk.WorkingDirectory = $repo
$lnk.IconLocation = Join-Path $repo 'src\ui\assets\logo.ico'
$lnk.WindowStyle = 7  # minimized, so the console barely flashes before hiding
$lnk.Description = 'Glass (npm start; log in %LOCALAPPDATA%\glass-logs)'
$lnk.Save()

Write-Host "Shortcut: $lnkPath"
Write-Host "Log: $(Join-Path $env:LOCALAPPDATA 'glass-logs\glass.log')"
