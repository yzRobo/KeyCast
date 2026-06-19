// main.js
//
// Electron main process entry point. Coordinates the whole app:
//   1. Loads and validates config.json (creates a default on first run).
//   2. Starts the WebSocket and HTTP server on the configured port.
//   3. Starts the global key and mouse listener.
//   4. Broadcasts every input event to connected clients, then discards it.
//   5. Opens the Config UI window.
//   6. Keeps running in the system tray when the window is closed.
//
// PRIVACY MODEL:
// The only data path for input is listener -> server.broadcast -> connected
// clients. The event is never stored or logged. The only disk write is the
// user-triggered config save handled in ipc.js, plus the first-run default
// config creation in config.js.

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Tray, Menu, nativeImage } = require('electron');

const config = require('./config');
const listener = require('./listener');
const { createServer } = require('./server');
const ipc = require('./ipc');
const updater = require('./updater');

const OVERLAY_DIR = path.join(__dirname, '..', 'overlay');
const ICON_PNG = path.join(__dirname, '..', 'build', 'icon.png');

let currentConfig = null;
let server = null;
let configWindow = null;
let tray = null;
let isQuitting = false;

// Decide where config.json lives. When packaged, the install directory is not
// reliably writable, so use Electron's per-user data directory. When running
// from source, keep it in the project root so it is easy to find and audit.
function getConfigPath() {
  if (app.isPackaged) {
    return path.join(app.getPath('userData'), 'config.json');
  }
  return path.join(__dirname, '..', 'config.json');
}

// Absolute path to the firewall helper script. When packaged, the scripts
// folder is unpacked from the asar archive (see asarUnpack in package.json) so
// PowerShell can run the file from disk.
function getFirewallScriptPath() {
  const relative = path.join('scripts', 'fix-connection.ps1');
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', relative);
  }
  return path.join(__dirname, '..', relative);
}

// The active profile object, sent to clients for rendering.
function getActiveProfile() {
  const profiles = currentConfig.profiles;
  return profiles.list[profiles.active];
}

function createConfigWindow() {
  configWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0a0a0a',
    title: 'KeyCast',
    icon: fs.existsSync(ICON_PNG) ? ICON_PNG : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Security: isolate the renderer fully. The UI talks to the main process
      // only through the small API exposed in preload.js.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  configWindow.loadFile(path.join(__dirname, '..', 'config-ui', 'index.html'));

  // Closing the window hides the app to the tray instead of quitting, so the
  // overlay keeps working during a stream. Quit is available from the tray.
  configWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      configWindow.hide();
    }
  });
}

function showConfigWindow() {
  if (!configWindow) {
    createConfigWindow();
    return;
  }
  configWindow.show();
  configWindow.focus();
}

// Build a tiny fallback tray icon if the real icon file is missing, so the tray
// always appears. The real icon is a W keycap generated into build/icon.png.
function loadTrayIcon() {
  if (fs.existsSync(ICON_PNG)) {
    return nativeImage.createFromPath(ICON_PNG);
  }
  return nativeImage.createEmpty();
}

function createTray() {
  tray = new Tray(loadTrayIcon());
  tray.setToolTip('KeyCast');
  const menu = Menu.buildFromTemplate([
    { label: 'Open KeyCast', click: () => showConfigWindow() },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(menu);
  tray.on('double-click', () => showConfigWindow());
}

// Apply a saved config. Restart the server if the port changed, then push the
// active profile to all connected clients so the overlay updates live.
async function onConfigSaved(validated) {
  const previousPort = server ? server.getPort() : null;
  currentConfig = validated;

  if (previousPort !== null && validated.server.port !== previousPort) {
    try {
      await server.restart(validated.server.port);
    } catch (err) {
      console.log('Could not restart the server on port ' + validated.server.port + '.');
      console.log('Reason: ' + err.message);
    }
  }

  server.broadcastConfig();
}

async function start() {
  const configPath = getConfigPath();
  currentConfig = config.load(configPath);

  // Start the server first so clients have somewhere to connect.
  server = createServer({
    overlayDir: OVERLAY_DIR,
    getProfile: getActiveProfile
  });

  try {
    await server.start(currentConfig.server.port);
  } catch (err) {
    console.log('The server could not start on port ' + currentConfig.server.port + '.');
    console.log('Reason: ' + err.message);
    console.log('Another application may be using that port. Change the port in the Config UI.');
  }

  // Start global input capture. Each event is broadcast immediately and then
  // discarded by the server. Nothing is retained here or downstream.
  listener.start((event) => {
    server.broadcast(event);
  });

  // Wire up the in-app updater so it can push progress to the Config UI. The
  // window may not exist yet on the first status message; updater.js guards for
  // that. quitAndInstall closes the window, so mark the app as quitting first or
  // the window-close handler would cancel the relaunch.
  updater.init({ getWindow: () => configWindow });

  // Wire up IPC for the Config UI.
  ipc.register({
    getConfig: () => currentConfig,
    setConfig: (next) => { currentConfig = next; },
    getConfigPath,
    getFirewallScriptPath,
    getServer: () => server,
    onConfigSaved,
    isUpdateSupported: () => app.isPackaged,
    getAppVersion: () => app.getVersion(),
    checkForUpdates: () => updater.checkForUpdates(),
    installUpdate: () => {
      isQuitting = true;
      updater.quitAndInstall();
    }
  });

  createTray();
  createConfigWindow();

  // Check for a newer release once at startup. Updates only work in the packaged
  // app (electron-updater needs the installed metadata), so skip the check when
  // running from source. Failures are reported to the UI by updater.js.
  if (app.isPackaged) {
    updater.checkForUpdates().catch(() => {});
  }
}

// Enforce a single running instance so we do not bind the port twice.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showConfigWindow();
  });

  app.whenReady().then(start);

  // Do not quit when the window closes. The app lives in the tray until the
  // user explicitly quits.
  app.on('window-all-closed', () => {
    // Intentionally empty on all platforms: KeyCast keeps running in the tray.
  });

  app.on('activate', () => {
    showConfigWindow();
  });

  // Clean shutdown: stop capture and close the server. There is no buffered
  // input to flush because none is ever kept.
  app.on('before-quit', () => {
    isQuitting = true;
    try {
      listener.stop();
    } catch (err) {
      // listener may not have started
    }
    if (server) {
      server.close();
    }
  });
}
