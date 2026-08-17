# diagnose.ps1
#
# Read-only report of the Windows settings that decide whether a second PC can
# reach KeyCast. The Config UI runs this behind the "Copy diagnostics" button so
# a user who is stuck can paste a complete picture into a bug report or a comment
# instead of guessing.
#
# This script changes nothing and needs no administrator rights. It reads
# firewall settings, firewall rules that mention KeyCast, network profiles, and
# whether the KeyCast port is listening. It does not read, and cannot read, any
# key or mouse data.

[CmdletBinding()]
param(
    [int]$Port = 8765,
    [string]$ExePath = ''
)

$ErrorActionPreference = 'SilentlyContinue'

function Write-Section {
    param([string]$Title)
    Write-Output ''
    Write-Output "-- $Title"
}

Write-Output "KeyCast diagnostics (port $Port)"

Write-Section 'Listening sockets on this port'
$listeners = Get-NetTCPConnection -State Listen -LocalPort $Port
if ($listeners) {
    foreach ($listener in $listeners) {
        $owner = (Get-Process -Id $listener.OwningProcess).ProcessName
        Write-Output ("   {0}:{1}  process: {2} (pid {3})" -f $listener.LocalAddress, $listener.LocalPort, $owner, $listener.OwningProcess)
    }
    # 0.0.0.0 means every network adapter, which is what allows a second PC in.
    if (-not ($listeners | Where-Object { $_.LocalAddress -eq '0.0.0.0' -or $_.LocalAddress -eq '::' })) {
        Write-Output '   WARNING: not listening on all adapters. Only this PC can connect.'
    }
} else {
    Write-Output '   Nothing is listening on this port. KeyCast is not running, or its server failed to start.'
}

Write-Section 'Windows Firewall profiles'
foreach ($profile in Get-NetFirewallProfile) {
    Write-Output ("   {0,-8} enabled: {1,-5} default inbound: {2,-6} allow inbound rules: {3}" -f `
        $profile.Name, $profile.Enabled, $profile.DefaultInboundAction, $profile.AllowInboundRules)
    if ($profile.Enabled -and $profile.AllowInboundRules -eq $false) {
        Write-Output "   WARNING: the $($profile.Name) profile blocks ALL incoming connections. Allow rules are ignored."
    }
}

Write-Section 'Network connection profiles'
foreach ($net in Get-NetConnectionProfile) {
    Write-Output ("   {0,-28} category: {1}" -f $net.InterfaceAlias, $net.NetworkCategory)
}

Write-Section 'Firewall rules for the KeyCast port'
$portRules = Get-NetFirewallPortFilter | Where-Object { $_.LocalPort -eq $Port } | Get-NetFirewallRule
if ($portRules) {
    foreach ($rule in $portRules) {
        Write-Output ("   [{0}] {1,-6} {2,-6} {3}" -f $rule.Enabled, $rule.Direction, $rule.Action, $rule.DisplayName)
    }
} else {
    Write-Output '   No rule mentions this port. Use "Allow through firewall" in KeyCast if a second PC cannot connect.'
}

Write-Section 'Firewall rules for the KeyCast program'
if ($ExePath) {
    Write-Output "   Program: $ExePath"
    $appRules = Get-NetFirewallApplicationFilter | Where-Object { $_.Program -ieq $ExePath } | Get-NetFirewallRule
    if ($appRules) {
        foreach ($rule in $appRules) {
            Write-Output ("   [{0}] {1,-6} {2,-6} {3}" -f $rule.Enabled, $rule.Direction, $rule.Action, $rule.DisplayName)
            # A block rule here defeats every allow rule, including the port rule
            # above, because Windows applies block rules first.
            if ($rule.Enabled -eq 'True' -and $rule.Direction -eq 'Inbound' -and $rule.Action -eq 'Block') {
                Write-Output '   WARNING: this rule BLOCKS KeyCast and overrides every allow rule. Run "Allow through firewall" to disable it.'
            }
        }
    } else {
        Write-Output '   No rule mentions the KeyCast program.'
    }
} else {
    Write-Output '   Running from source, so there is no KeyCast.exe to match rules against.'
}

Write-Section 'Third-party firewalls registered with Windows'
$products = Get-CimInstance -Namespace 'root\SecurityCenter2' -ClassName FirewallProduct
if ($products) {
    foreach ($product in $products) {
        Write-Output "   $($product.displayName)"
    }
    Write-Output '   A third-party firewall enforces its own rules and ignores the Windows rules above.'
} else {
    Write-Output '   None detected.'
}
