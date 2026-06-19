# fix-connection.ps1
#
# Troubleshooting helper for KeyCast 2PC setups. It adds a single Windows
# Firewall inbound rule that allows traffic on the KeyCast WebSocket port so a
# second PC on the same local network can reach the overlay.
#
# Most users never need this. Local network traffic usually is not blocked.
# Run this only if the overlay loads on the gaming PC but not on the streaming
# PC. The script is not run automatically by the app.
#
# This script does not touch any key or mouse data. It only manages a firewall
# rule.
#
# It must run as Administrator to change the firewall. If it is not already
# elevated, it relaunches itself with elevation, which triggers a Windows User
# Account Control (UAC) prompt. That prompt is expected and required.

$ErrorActionPreference = 'Stop'

$RuleName = 'Key Overlay - WebSocket'
$DefaultPort = 8765

# Determine whether the current session is elevated (running as Administrator).
function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Self-elevate by relaunching this script with the RunAs verb. This raises the
# UAC prompt. After the user approves it, an elevated copy of the script runs
# and this original copy exits.
if (-not (Test-IsAdministrator)) {
    Write-Host 'Administrator rights are required to change the firewall.'
    Write-Host 'A Windows UAC prompt will appear. Approve it to continue.'
    try {
        Start-Process -FilePath 'powershell.exe' `
            -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"") `
            -Verb RunAs
    } catch {
        Write-Host 'Elevation was cancelled or failed. No changes were made.'
        Write-Host 'You can also run this script manually as Administrator: right-click it and choose Run as administrator.'
    }
    exit
}

# Read the configured port from config.json if it can be found. Fall back to the
# default port if the file is missing or unreadable. This read is best effort
# and never blocks the firewall change.
function Get-ConfiguredPort {
    $candidatePaths = @(
        (Join-Path (Split-Path -Parent $PSScriptRoot) 'config.json'),
        (Join-Path $env:APPDATA 'KeyCast\config.json')
    )
    foreach ($pathCandidate in $candidatePaths) {
        if (Test-Path $pathCandidate) {
            try {
                $json = Get-Content -Path $pathCandidate -Raw | ConvertFrom-Json
                if ($json.server -and $json.server.port) {
                    return [int]$json.server.port
                }
            } catch {
                # Unreadable or malformed config. Fall through to the default.
            }
        }
    }
    return $DefaultPort
}

$Port = Get-ConfiguredPort

Write-Host "Configuring firewall rule for KeyCast on TCP port $Port."

# Idempotent: only create the rule if it does not already exist. Running the
# script repeatedly does not create duplicates.
$existing = Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue

try {
    if ($existing) {
        # Make sure the existing rule points at the current port, in case the
        # user changed the port after the rule was first created.
        $existing | Set-NetFirewallRule -Enabled True | Out-Null
        $existing | Get-NetFirewallPortFilter | Set-NetFirewallPortFilter -LocalPort $Port -Protocol TCP | Out-Null
        Write-Host "Success. The firewall rule already existed and now allows TCP port $Port."
    } else {
        New-NetFirewallRule `
            -DisplayName $RuleName `
            -Direction Inbound `
            -Action Allow `
            -Protocol TCP `
            -LocalPort $Port `
            -Profile Any | Out-Null
        Write-Host "Success. A firewall rule named '$RuleName' was created for TCP port $Port."
    }
    Write-Host 'A second PC on the same local network should now be able to reach the overlay.'
} catch {
    Write-Host 'Failure. The firewall rule could not be created.'
    Write-Host "Reason: $($_.Exception.Message)"
    Write-Host 'Try running this script manually as Administrator: right-click it and choose Run as administrator.'
}

Write-Host ''
Write-Host 'Press Enter to close this window.'
[void](Read-Host)
