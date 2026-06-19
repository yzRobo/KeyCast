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
const { spawn } = require('child_process');
const { ipcMain } = require('electron');
const config = require('./config');

// List every non-internal IPv4 address with the name of the adapter it belongs
// to. A machine often has several (Ethernet, Wi-Fi, plus VPN and virtual
// adapters like Tailscale, WSL, or VirtualBox), and the right one for a 2PC
// setup is the adapter the streaming PC can actually reach. The user picks from
// this list. This reads the local network interface list only; it makes no
// network connection.
function listLocalIpAddresses() {
  const interfaces = os.networkInterfaces();
  const results = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        results.push({ name, address: iface.address });
      }
    }
  }
  return results;
}

// The machine's first detected local IPv4 address, or null if only loopback is
// available. Used as the fallback when the user has not chosen an adapter.
function getLocalIpAddress() {
  const list = listLocalIpAddresses();
  return list.length > 0 ? list[0].address : null;
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

    return {
      port,
      localhost: 'http://localhost:' + port,
      lan: selected ? 'http://' + selected + ':' + port : 'No local network address detected',
      selectedAddress: selected,
      addresses: addresses.map((a) => ({
        name: a.name,
        address: a.address,
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
    try {
      // Do NOT pass detached: true here. On Windows that creates the process
      // with DETACHED_PROCESS (no console), and powershell.exe silently fails
      // to start, so the script never runs and no UAC prompt appears. The
      // launcher only needs to fire Start-Process -Verb RunAs (which spawns an
      // independent elevated process that survives on its own) and then exit,
      // so it does not need to outlive the parent.
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        { stdio: 'ignore', windowsHide: true }
      );
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
  // preview and status connections.
  ipcMain.handle('server:status', () => {
    const server = deps.getServer();
    return {
      sources: server ? server.getOverlayClientCount() : 0,
      port: deps.getConfig().server.port
    };
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
