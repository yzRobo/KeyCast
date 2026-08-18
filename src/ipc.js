// ipc.js
//
// Electron IPC handlers that connect the Config UI (renderer) to the main
// process. The renderer can read the config, save the config, ask for the OBS
// URLs, and request a fresh default profile. Saving config.json is the only
// disk write the app performs at the user's request.
//
// PRIVACY MODEL:
// None of these handlers touch key or mouse input. They move configuration and
// computed URLs only.

const os = require('os');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { ipcMain } = require('electron');
const config = require('./config');

// Adapter names that belong to a VPN, a virtual machine, or a container bridge.
// An address on one of these is almost never the one a streaming PC on the same
// house network can reach, so they are ranked last and labelled in the UI.
const VIRTUAL_ADAPTER_PATTERN = new RegExp([
  'vethernet', 'hyper-?v', 'wsl', 'virtualbox', 'vmware', 'docker', 'vmnet',
  'tailscale', 'zerotier', 'hamachi', 'radmin', 'wireguard', 'nordlynx',
  'openvpn', 'proton', 'mullvad', 'express\\s?vpn', 'surfshark', 'tap-',
  'tun', 'bluetooth', 'loopback'
].join('|'), 'i');

// Adapter names that are usually the real house network connection.
const PHYSICAL_ADAPTER_PATTERN = /ethernet|wi-?fi|wlan|local area connection/i;

// Private address ranges (RFC 1918). A 2PC setup on one home network always
// uses one of these.
function isPrivateAddress(address) {
  return /^10\./.test(address) ||
    /^192\.168\./.test(address) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(address);
}

// Score an adapter for how likely it is to be the one the streaming PC reaches.
// Lower is better. Used for ordering and for the auto-pick, never to hide an
// adapter: every detected address is still offered in the dropdown, because
// these are heuristics and a user with an unusual setup has to be able to
// override them.
function scoreAdapter(name, address) {
  let score = 0;
  if (VIRTUAL_ADAPTER_PATTERN.test(name)) {
    score += 100;
  }
  if (!isPrivateAddress(address)) {
    score += 50;
  }
  if (PHYSICAL_ADAPTER_PATTERN.test(name) && !VIRTUAL_ADAPTER_PATTERN.test(name)) {
    score -= 10;
  }
  return score;
}

// List every non-internal IPv4 address with the name of the adapter it belongs
// to. A machine often has several (Ethernet, Wi-Fi, plus VPN and virtual
// adapters like Tailscale, WSL, or VirtualBox), and the right one for a 2PC
// setup is the adapter the streaming PC can actually reach. The most likely
// candidates are listed first so the auto-pick lands on a real LAN address
// rather than whichever adapter Windows happened to enumerate first. This reads
// the local network interface list only; it makes no network connection.
function listLocalIpAddresses() {
  const interfaces = os.networkInterfaces();
  const results = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        results.push({
          name,
          address: iface.address,
          virtual: VIRTUAL_ADAPTER_PATTERN.test(name),
          score: scoreAdapter(name, iface.address)
        });
      }
    }
  }
  results.sort((a, b) => a.score - b.score);
  return results;
}

// The machine's most likely local IPv4 address, or null if only loopback is
// available. Used as the fallback when the user has not chosen an adapter.
function getLocalIpAddress() {
  const list = listLocalIpAddresses();
  return list.length > 0 ? list[0].address : null;
}

// Run the read-only Windows diagnostics script and return its output. Failures
// are reported in the text rather than thrown, because a partial report is still
// worth pasting into a bug report. The script is given a timeout because
// Get-NetFirewallRule can be slow on a machine with a large rule set.
function runDiagnosticsScript(deps, port, exePath) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve('-- Windows firewall\n   Skipped: not running on Windows.');
      return;
    }
    const scriptPath = deps.getDiagnosticsScriptPath ? deps.getDiagnosticsScriptPath() : null;
    if (!scriptPath || !fs.existsSync(scriptPath)) {
      resolve('-- Windows firewall\n   Skipped: the diagnostics script was not found.');
      return;
    }

    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Port', String(port)];
    if (exePath) {
      args.push('-ExePath', exePath);
    }

    execFile(
      'powershell.exe',
      args,
      { timeout: 30000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (stdout && stdout.trim().length > 0) {
          resolve(stdout.trim());
          return;
        }
        resolve('-- Windows firewall\n   Could not run the diagnostics script. ' + ((err && err.message) || ''));
      }
    );
  });
}

// Register all handlers. deps provides the live application state:
//   getConfig    returns the current in-memory config object
//   setConfig    replaces the in-memory config after a validated save
//   getConfigPath returns the absolute path to config.json
//   getServer    returns the server controller (for port and rebroadcast)
//   onConfigSaved callback run after a successful save (rebroadcast, restart)
function register(deps) {
  // Return the current configuration to the renderer.
  ipcMain.handle('config:get', () => {
    return deps.getConfig();
  });

  // Return a fresh default profile so the UI can seed a new profile.
  ipcMain.handle('config:getDefaultProfile', () => {
    return config.getDefaultConfig().profiles.list.default;
  });

  // Save configuration sent by the renderer. This is the user-triggered write.
  // The payload is validated and written to disk, then the in-memory copy is
  // updated and dependents are notified.
  ipcMain.handle('config:save', (event, incoming) => {
    const validated = config.save(deps.getConfigPath(), incoming);
    deps.setConfig(validated);
    deps.onConfigSaved(validated);
    return validated;
  });

  // Return the OBS Browser Source URLs for single PC and 2PC use, plus the full
  // list of detected network adapters so the UI can let the user pick the right
  // one for 2PC. The LAN URL uses the user's saved adapter when it is still
  // present; otherwise it falls back to the first detected address. Availability
  // is re-checked every call because IPs change (DHCP, adapters toggling on/off).
  ipcMain.handle('server:urls', () => {
    const cfg = deps.getConfig();
    const port = cfg.server.port;
    const addresses = listLocalIpAddresses();

    const saved = cfg.server.lanAddress;
    let selected = null;
    if (saved && addresses.some((a) => a.address === saved)) {
      selected = saved;
    } else if (addresses.length > 0) {
      selected = addresses[0].address;
    }

    const base = selected ? 'http://' + selected + ':' + port : null;

    return {
      port,
      localhost: 'http://localhost:' + port,
      lan: base || 'No local network address detected',
      // The reachability check page. Opening this on the streaming PC in an
      // ordinary browser separates a network problem from an OBS problem.
      test: base ? base + '/test' : 'No local network address detected',
      selectedAddress: selected,
      addresses: addresses.map((a) => ({
        name: a.name,
        address: a.address,
        virtual: a.virtual,
        url: 'http://' + a.address + ':' + port
      }))
    };
  });

  // Launch the firewall helper script. The script self-elevates, so launching
  // it triggers a Windows UAC prompt. This adds the same inbound rule a user
  // would get by running scripts/fix-connection.ps1 by hand, but with one click.
  // It manages a firewall rule only and never touches input data.
  ipcMain.handle('firewall:fix', () => {
    if (process.platform !== 'win32') {
      return { started: false, reason: 'The firewall helper is only available on Windows.' };
    }
    const scriptPath = deps.getFirewallScriptPath();
    if (!fs.existsSync(scriptPath)) {
      return { started: false, reason: 'The firewall helper script was not found.' };
    }
    // Pass the live port and the executable path so the script can fix the rule
    // that actually matters, including any inbound block rule Windows created
    // for KeyCast.exe. Those block rules override allow rules, so a port rule
    // alone cannot repair that case.
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath];
    const port = deps.getConfig().server.port;
    if (port) {
      args.push('-Port', String(port));
    }
    const exePath = deps.getAppExePath ? deps.getAppExePath() : null;
    if (exePath) {
      args.push('-ExePath', exePath);
    }

    try {
      // Do NOT pass detached: true here. On Windows that creates the process
      // with DETACHED_PROCESS (no console), and powershell.exe silently fails
      // to start, so the script never runs and no UAC prompt appears. The
      // launcher only needs to fire Start-Process -Verb RunAs (which spawns an
      // independent elevated process that survives on its own) and then exit,
      // so it does not need to outlive the parent.
      const child = spawn('powershell.exe', args, { stdio: 'ignore', windowsHide: true });
      // spawn() succeeds synchronously even when the executable cannot be
      // launched; the failure arrives later as an 'error' event. Without this
      // handler that error would be an unhandled exception, and the UI would
      // have already been told the helper started.
      child.on('error', () => {});
      return { started: true };
    } catch (err) {
      return { started: false, reason: err.message };
    }
  });

  // Return basic server status for the connection indicator. "sources" is the
  // number of real OBS overlay sources connected, not counting the app's own
  // preview, status, and reachability-test connections. "listening" and "error"
  // let the UI say why the overlay is unavailable instead of failing silently:
  // a server that never bound its port used to report only to the console, which
  // is invisible in the packaged app.
  ipcMain.handle('server:status', () => {
    const server = deps.getServer();
    return {
      sources: server ? server.getOverlayClientCount() : 0,
      port: deps.getConfig().server.port,
      listening: server ? server.isListening() : false,
      error: server ? server.getLastError() : 'The server was never created.',
      // Which movement capture path is active: 'raw' (reads the hardware input
      // stream, works inside pointer-locking games), 'hook' (cursor fallback,
      // limited by such games), or 'off'.
      movementSource: deps.getMovementSource ? deps.getMovementSource() : 'off'
    };
  });

  // Build a plain-text report of everything that decides whether a second PC can
  // reach the overlay, so a user who is stuck can paste one complete picture
  // instead of answering questions one at a time. The Windows portion runs
  // scripts/diagnose.ps1, which is read-only and needs no elevation.
  //
  // The report contains configuration, network adapter names, and firewall
  // state. It contains no key or mouse data, because the app has none to give.
  ipcMain.handle('diagnostics:report', async () => {
    const cfg = deps.getConfig();
    const server = deps.getServer();
    const port = cfg.server.port;
    const exePath = deps.getAppExePath ? deps.getAppExePath() : null;

    const lines = [];
    lines.push('KeyCast diagnostics');
    lines.push('version: ' + deps.getAppVersion());
    lines.push('packaged: ' + Boolean(exePath));
    lines.push('platform: ' + process.platform + ' ' + os.release());
    lines.push('');
    lines.push('-- Server');
    lines.push('   configured port: ' + port);
    lines.push('   listening: ' + (server ? server.isListening() : false));
    if (server && server.getLastError()) {
      lines.push('   last error: ' + server.getLastError());
    }
    lines.push('   overlay sources connected: ' + (server ? server.getOverlayClientCount() : 0));
    lines.push('   movement capture: ' + (deps.getMovementSource ? deps.getMovementSource() : 'off') +
      ' (raw = hardware input stream, works in games; hook = cursor fallback; off = indicator disabled)');
    lines.push('');
    lines.push('-- Network adapters seen by KeyCast');
    const addresses = listLocalIpAddresses();
    if (addresses.length === 0) {
      lines.push('   none (only loopback). A second PC cannot connect.');
    }
    for (const item of addresses) {
      const marks = [];
      if (item.address === cfg.server.lanAddress) {
        marks.push('chosen');
      }
      if (item.virtual) {
        marks.push('VPN or virtual');
      }
      lines.push('   ' + item.address.padEnd(16) + item.name + (marks.length ? '  (' + marks.join(', ') + ')' : ''));
    }
    lines.push('');

    const windowsReport = await runDiagnosticsScript(deps, port, exePath);
    lines.push(windowsReport);

    return lines.join('\n');
  });

  // Report the running version and whether in-app updates are available. The
  // updater only works in the packaged build, so the UI uses "supported" to
  // explain why the check is disabled when running from source.
  ipcMain.handle('update:info', () => {
    return {
      version: deps.getAppVersion(),
      supported: deps.isUpdateSupported()
    };
  });

  // Trigger a check for a newer GitHub release. Progress and results are pushed
  // back to the renderer on the 'update:status' channel by updater.js. This only
  // checks for and downloads the project's own installer; it touches no input.
  ipcMain.handle('update:check', async () => {
    if (!deps.isUpdateSupported()) {
      return { started: false, reason: 'Updates are only available in the installed app.' };
    }
    try {
      await deps.checkForUpdates();
      return { started: true };
    } catch (err) {
      return { started: false, reason: err && err.message ? err.message : 'Could not check for updates.' };
    }
  });

  // Quit, install the downloaded update, and relaunch. The main process marks
  // the app as quitting before this so the window-close handler allows the exit.
  ipcMain.handle('update:install', () => {
    deps.installUpdate();
  });
}

module.exports = {
  register,
  getLocalIpAddress
};
