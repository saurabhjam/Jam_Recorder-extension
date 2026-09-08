<#
.SYNOPSIS
    Removes the BestQ Monitoring Agent for the current user.

.DESCRIPTION
    Unregisters the native messaging host from every Chromium browser and
    deletes the agent. Per-user only, so no administrator rights are needed.
    Removing the registry entries is the part that matters: leaving them behind
    would point browsers at a manifest that no longer exists.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$HostName   = 'com.bestq.monitoring'
$InstallDir = Join-Path $env:LOCALAPPDATA 'BestQ\MonitoringAgent'

Get-Process -Name 'bestq-monitoring-agent' -ErrorAction SilentlyContinue |
    Stop-Process -Force -ErrorAction SilentlyContinue

$roots = @(
    'HKCU:\Software\Google\Chrome\NativeMessagingHosts',
    'HKCU:\Software\Chromium\NativeMessagingHosts',
    'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts',
    'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts'
)
foreach ($root in $roots) {
    $key = Join-Path $root $HostName
    if (Test-Path $key) {
        Remove-Item -Path $key -Force -Recurse
        Write-Host "  unregistered: $root"
    }
}

if (Test-Path $InstallDir) {
    Remove-Item -Path $InstallDir -Recurse -Force
    Write-Host "  removed: $InstallDir"
}

Write-Host "BestQ Monitoring Agent removed. Restart your browser." -ForegroundColor Green
