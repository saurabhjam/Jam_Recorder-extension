<#
.SYNOPSIS
    Installs the BestQ Monitoring Agent for the current user.

.DESCRIPTION
    Does exactly what the Inno Setup installer does, without needing Inno Setup
    or a Windows build machine: copies the agent, writes the native messaging
    host manifest with the real install path, and registers that manifest with
    every Chromium browser.

    Everything is per-user — %LOCALAPPDATA% and HKCU — so no administrator
    rights are required. That is deliberate beyond convenience: the agent must
    run inside the user's interactive desktop session to see the foreground
    window at all, so a machine-wide service would be useless for this.

.PARAMETER ExtensionId
    The extension permitted to open the port. Chrome refuses any origin not
    listed, which is what stops another extension from driving this agent.
    Never widen this to a wildcard.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File install.ps1
#>
[CmdletBinding()]
param(
    [string] $ExtensionId = 'heogonedpcjllemcclnbedlgnnijhloi',
    [string] $SourceDir   = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'
$HostName  = 'com.bestq.monitoring'
$InstallDir = Join-Path $env:LOCALAPPDATA 'BestQ\MonitoringAgent'
$AgentPath  = Join-Path $InstallDir 'bestq-monitoring-agent.exe'
$ManifestPath = Join-Path $InstallDir "$HostName.json"

# --- pick the binary for this machine ------------------------------------
# Windows on ARM would run the x64 build under emulation. It works, but this
# process samples the foreground window every two seconds, so the native build
# is worth selecting when it is present.
$isArm = $env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64'
# Written as a statement rather than `$x = if (...) {...} else {...}`: the
# expression form is fine in PowerShell 7 but brittle across lines in Windows
# PowerShell 5.1, which is what most machines still run by default.
if ($isArm) {
    $wanted = 'bestq-monitoring-agent-windows-arm64.exe'
} else {
    $wanted = 'bestq-monitoring-agent-windows-amd64.exe'
}

$source = Join-Path $SourceDir $wanted
if (-not (Test-Path $source)) {
    # Fall back to the x64 build on an ARM machine rather than failing: emulated
    # is better than absent.
    $fallback = Join-Path $SourceDir 'bestq-monitoring-agent-windows-amd64.exe'
    if ($isArm -and (Test-Path $fallback)) {
        Write-Warning "No arm64 build found; installing the x64 build (runs emulated)."
        $source = $fallback
    } else {
        throw "Agent binary not found: $source`nPut install.ps1 in the same folder as the agent .exe files."
    }
}

Write-Host "Installing BestQ Monitoring Agent..." -ForegroundColor Cyan
Write-Host "  source : $(Split-Path $source -Leaf)"
Write-Host "  target : $InstallDir"

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null

# A file that arrived over the internet carries a Zone.Identifier stream, and
# Windows refuses to launch it. Chrome would then report the native host as
# failing to start, with nothing explaining why.
try { Unblock-File -Path $source -ErrorAction SilentlyContinue } catch { }

# Stop a running agent first: copying over a locked executable fails.
Get-Process -Name 'bestq-monitoring-agent' -ErrorAction SilentlyContinue |
    Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 300

Copy-Item -Path $source -Destination $AgentPath -Force
try { Unblock-File -Path $AgentPath -ErrorAction SilentlyContinue } catch { }

# --- host manifest --------------------------------------------------------
# Written here rather than shipped, so `path` is the real install directory. A
# manifest with a baked-in path breaks the moment the location differs.
$manifest = [ordered]@{
    name            = $HostName
    description     = 'BestQ Desktop Monitoring Agent'
    path            = $AgentPath
    type            = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
}
# ASCII, no BOM: Chrome's manifest parser rejects a byte-order mark, and
# Set-Content's default encoding on Windows PowerShell 5.1 writes one.
$json = $manifest | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($ManifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))

# --- register with every Chromium browser ---------------------------------
# Chrome only launches a host it has a registry entry for; the extension cannot
# write this itself, which is the whole reason an installer exists.
$browsers = @{
    'Chrome'   = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts'
    'Chromium' = 'HKCU:\Software\Chromium\NativeMessagingHosts'
    'Brave'    = 'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts'
    'Edge'     = 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts'
}
foreach ($name in $browsers.Keys | Sort-Object) {
    $key = Join-Path $browsers[$name] $HostName
    New-Item -Path $key -Force | Out-Null
    Set-ItemProperty -Path $key -Name '(Default)' -Value $ManifestPath
    Write-Host "  registered: $name"
}

# --- verify ---------------------------------------------------------------
# Prove the agent actually launches on this machine, rather than reporting
# success because files were copied.
Write-Host ""
try {
    $probe = & $AgentPath --probe 2>&1 | Out-String
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Agent runs correctly." -ForegroundColor Green
        if ($probe.Trim()) { Write-Host $probe.Trim() }
    } else {
        Write-Warning "Agent exited with code $LASTEXITCODE`n$probe"
    }
} catch {
    Write-Warning "Could not run the agent: $_"
}

Write-Host ""
Write-Host "Installed. Fully quit and reopen your browser." -ForegroundColor Green
Write-Host "Monitoring will then show 'Activity agent: Connected'."
