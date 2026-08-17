# fix-connection.ps1
#
# Troubleshooting helper for KeyCast 2PC setups. It makes Windows Firewall allow
# a second PC on the same local network to reach the overlay.
#
# Most users never need this. Run it only if the overlay loads on the gaming PC
# but not on the streaming PC. The script is not run automatically by the app.
#
# It does four things:
#   1. Turns off any inbound BLOCK rule pointing at the KeyCast executable.
#      Windows creates one of these when its "allow this app to communicate on
#      these networks" prompt is dismissed or cancelled. Windows applies block
#      rules before allow rules, so while such a rule exists no amount of
#      allowing the port has any effect. This is the most common reason a 2PC
#      setup keeps failing after the port rule has already been added.
#   2. Adds an inbound ALLOW rule for the KeyCast port.
#   3. Adds an inbound ALLOW rule for the KeyCast executable, so the rule keeps
#      working if the port changes later.
#   4. Reports the things this script cannot fix by itself: a network set to
#      Public, a firewall profile set to block every incoming connection, and
#      third-party security suites that ignore Windows Firewall entirely.
#
# This script does not touch any key or mouse data. It only manages firewall
# rules and reads firewall settings.
#
# It must run as Administrator to change the firewall. If it is not already
# elevated, it relaunches itself with elevation, which triggers a Windows User
# Account Control (UAC) prompt. That prompt is expected and required.

[CmdletBinding()]
param(
    # The KeyCast port. When the app launches this script it passes the port
    # currently configured; run by hand, it is read from config.json instead.
    [int]$Port = 0,

    # Full path to KeyCast.exe. The app passes this so program rules can be
    # created. Running from source there is no KeyCast.exe to name, and the
    # script falls back to the port rule alone.
    [string]$ExePath = ''
)

$ErrorActionPreference = 'Stop'

$PortRuleName = 'Key Overlay - WebSocket'
$AppRuleName = 'KeyCast'
$DefaultPort = 8765

# Determine whether the current session is elevated (running as Administrator).
function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Self-elevate by relaunching this script with the RunAs verb. This raises the
# UAC prompt. After the user approves it, an elevated copy of the script runs
# and this original copy exits. The parameters are forwarded so the elevated
# copy configures the same port and executable.
if (-not (Test-IsAdministrator)) {
    Write-Host 'Administrator rights are required to change the firewall.'
    Write-Host 'A Windows UAC prompt will appear. Approve it to continue.'
    try {
        $forward = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
        if ($Port -gt 0) { $forward += @('-Port', $Port) }
        if ($ExePath) { $forward += @('-ExePath', "`"$ExePath`"") }
        Start-Process -FilePath 'powershell.exe' -ArgumentList $forward -Verb RunAs
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

if ($Port -le 0 -or $Port -gt 65535) {
    $Port = Get-ConfiguredPort
}

# Locate KeyCast.exe when the app did not pass its path, so a hand-run of this
# script can still clear a block rule. Only the standard per-user install
# location is checked; if it is not there, the port rule alone is used.
function Find-KeyCastExe {
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\KeyCast\KeyCast.exe'),
        (Join-Path $env:ProgramFiles 'KeyCast\KeyCast.exe')
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path $candidate)) {
            return $candidate
        }
    }
    return ''
}

if (-not $ExePath -or -not (Test-Path $ExePath)) {
    $ExePath = Find-KeyCastExe
}

Write-Host ''
Write-Host '=== KeyCast connection fix ==='
Write-Host "Port: $Port"
if ($ExePath) {
    Write-Host "Program: $ExePath"
} else {
    Write-Host 'Program: not found (running from source, or installed elsewhere). Using the port rule only.'
}
Write-Host ''

# --- Step 1: disable inbound block rules that name the KeyCast executable ---
#
# These are disabled rather than deleted, so the change is reversible: they stay
# visible in Windows Defender Firewall's advanced view and can be switched back
# on there. Only inbound rules whose action is Block and whose program is this
# exact executable are touched.
$blockedFound = 0
if ($ExePath) {
    Write-Host 'Checking for firewall rules that block KeyCast...'
    try {
        $inboundBlocks = Get-NetFirewallRule -Direction Inbound -Action Block -Enabled True -ErrorAction SilentlyContinue
        foreach ($rule in $inboundBlocks) {
            $program = ''
            try {
                $program = ($rule | Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue).Program
            } catch {
                continue
            }
            if ($program -and ($program -ieq $ExePath)) {
                $rule | Set-NetFirewallRule -Enabled False
                $blockedFound++
                Write-Host "  Disabled blocking rule: $($rule.DisplayName) [profile: $($rule.Profile)]"
            }
        }
    } catch {
        Write-Host "  Could not read the firewall rule list. Reason: $($_.Exception.Message)"
    }

    if ($blockedFound -eq 0) {
        Write-Host '  None found. Good.'
    } else {
        Write-Host "  Disabled $blockedFound blocking rule(s). These were stopping the connection."
    }
    Write-Host ''
}

# Create an inbound allow rule, or update the existing one, without creating
# duplicates on repeat runs.
function Set-AllowRule {
    param(
        [string]$Name,
        [hashtable]$Filter
    )

    $existing = Get-NetFirewallRule -DisplayName $Name -ErrorAction SilentlyContinue
    if ($existing) {
        $existing | Set-NetFirewallRule -Enabled True -Action Allow -Profile Any | Out-Null
        return $existing
    }

    $params = @{
        DisplayName = $Name
        Direction   = 'Inbound'
        Action      = 'Allow'
        Profile     = 'Any'
    }
    foreach ($key in $Filter.Keys) {
        $params[$key] = $Filter[$key]
    }
    return New-NetFirewallRule @params
}

# --- Step 2: allow the port ---
Write-Host "Allowing TCP port $Port..."
try {
    $portRule = Set-AllowRule -Name $PortRuleName -Filter @{ Protocol = 'TCP'; LocalPort = $Port }
    # Point an existing rule at the current port, in case the user changed it
    # after the rule was first created.
    $portRule | Get-NetFirewallPortFilter | Set-NetFirewallPortFilter -LocalPort $Port -Protocol TCP | Out-Null
    Write-Host "  Done. Inbound TCP $Port is allowed."
} catch {
    Write-Host "  Failed. Reason: $($_.Exception.Message)"
}

# --- Step 3: allow the program ---
if ($ExePath) {
    Write-Host 'Allowing the KeyCast program...'
    try {
        $appRule = Set-AllowRule -Name $AppRuleName -Filter @{ Program = $ExePath }
        $appRule | Get-NetFirewallApplicationFilter | Set-NetFirewallApplicationFilter -Program $ExePath | Out-Null
        Write-Host '  Done. KeyCast is allowed to accept incoming connections.'
    } catch {
        Write-Host "  Failed. Reason: $($_.Exception.Message)"
    }
}

Write-Host ''
Write-Host '=== Things this script cannot change for you ==='

# A firewall profile with DefaultInboundAction Block and AllowInboundRules False
# is the "Blocks all incoming connections, including those in the list of
# allowed apps" checkbox in Windows Security. It overrides every allow rule,
# including the ones just created.
try {
    foreach ($profile in Get-NetFirewallProfile -ErrorAction SilentlyContinue) {
        if ($profile.Enabled -and $profile.AllowInboundRules -eq $false) {
            Write-Host ''
            Write-Host "  WARNING: the $($profile.Name) firewall profile is set to block ALL incoming connections."
            Write-Host '  Allow rules are ignored while that is on. Turn it off in:'
            Write-Host "  Windows Security > Firewall & network protection > $($profile.Name) network"
            Write-Host '  > clear "Blocks all incoming connections, including those in the list of allowed apps".'
        }
    }
} catch {
    # Reading profile settings is best effort.
}

# A network set to Public is not itself a blocker now that the rules above use
# Profile Any, but it is worth pointing out because it is the usual reason a
# home network behaves unexpectedly.
try {
    $publicNets = Get-NetConnectionProfile -ErrorAction SilentlyContinue | Where-Object { $_.NetworkCategory -eq 'Public' }
    foreach ($net in $publicNets) {
        Write-Host ''
        Write-Host "  NOTE: the network on '$($net.InterfaceAlias)' is set to Public."
        Write-Host '  The rules above cover Public too, but setting your home network to Private'
        Write-Host '  in Windows Settings > Network & internet is a good idea anyway.'
    }
} catch {
    # Reading connection profiles is best effort.
}

Write-Host ''
Write-Host '  If you use a third-party security suite (Norton, ESET, Kaspersky,'
Write-Host '  Bitdefender, Avast, McAfee), it has its own firewall and ignores'
Write-Host '  everything this script did. Allow KeyCast there as well.'
Write-Host ''
Write-Host '  If you use a VPN, many clients block local network traffic by default.'
Write-Host '  Look for a "local network sharing", "allow LAN", or "killswitch" setting'
Write-Host '  and allow LAN access, or disconnect the VPN to test.'
Write-Host ''
Write-Host '=== Next step ==='
Write-Host '  On the streaming PC, open this address in a normal web browser:'
Write-Host ''
Write-Host "    http://<gaming-pc-ip>:$Port/test"
Write-Host ''
Write-Host '  The KeyCast window shows the exact address to use under "2PC / LAN".'
Write-Host '  If that page loads, the connection works and the problem is in OBS.'
Write-Host '  If it does not load, the streaming PC still cannot reach this PC.'
Write-Host ''
Write-Host 'Press Enter to close this window.'
[void](Read-Host)
