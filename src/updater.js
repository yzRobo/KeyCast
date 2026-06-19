// updater.js
//
// In-app update support, built on electron-updater. KeyCast publishes its
// installer to GitHub Releases (see the "publish" block in package.json), and
// this module checks that same location for a newer version, downloads it in
// the background, and installs it on request.
//
// Flow (see config-ui for the matching UI):
//   1. On startup the main process calls checkForUpdates() once.
//   2. As electron-updater works, this module forwards a small status object to
//      the Config UI window on the 'update:status' channel.
//   3. When a build has finished downloading, the UI shows a "Restart & Update"
//      button that calls quitAndInstall().
//
// PRIVACY MODEL:
// The only network traffic here is the version check and installer download
// against the project's own GitHub Releases. No key or mouse input is read,
// stored, or transmitted. Nothing about the user is sent in the request.

// electron-updater exposes autoUpdater as a lazy getter that constructs the
// updater (and reads electron's app) the instant it is accessed. We must not
// touch it at module load time, before app is ready, so require it lazily from
// inside the functions below, all of which run after app.whenReady.
let autoUpdater = null;
function getAutoUpdater() {
  if (!autoUpdater) {
    autoUpdater = require('electron-updater').autoUpdater;
  }
  return autoUpdater;
}

// Returns the live Config UI window, or null. Set in init().
let getWindow = null;
let wired = false;

// Send a status update to the renderer if the window is still alive. The
// renderer treats every state idempotently, so dropping a message (window not
// yet open) is harmless.
function send(status) {
  const win = getWindow ? getWindow() : null;
  if (win && !win.isDestroyed()) {
    win.webContents.send('update:status', status);
  }
}

// Wire electron-updater once. deps.getWindow returns the Config UI window so we
// can push progress to it.
function init(deps) {
  getWindow = deps.getWindow;

  if (wired) {
    return;
  }
  wired = true;

  const au = getAutoUpdater();

  // Download automatically once an update is found, but never install on quit
  // without the user pressing the button.
  au.autoDownload = true;
  au.autoInstallOnAppQuit = false;

  au.on('checking-for-update', () => {
    send({ state: 'checking' });
  });
  au.on('update-available', (info) => {
    send({ state: 'available', version: info && info.version });
  });
  au.on('update-not-available', (info) => {
    send({ state: 'none', version: info && info.version });
  });
  au.on('download-progress', (progress) => {
    send({ state: 'downloading', percent: Math.round(progress && progress.percent ? progress.percent : 0) });
  });
  au.on('update-downloaded', (info) => {
    send({ state: 'downloaded', version: info && info.version });
  });
  au.on('error', (err) => {
    send({ state: 'error', message: err && err.message ? err.message : String(err) });
  });
}

// Ask GitHub whether a newer release exists. Resolves quietly; progress is
// reported through the events wired in init(). Errors are surfaced both via the
// 'error' event and the rejected promise so callers can react if they wish.
function checkForUpdates() {
  return getAutoUpdater().checkForUpdates();
}

// Quit and install the downloaded update, then relaunch. The caller must mark
// the app as quitting first so the window's close handler does not cancel it.
function quitAndInstall() {
  getAutoUpdater().quitAndInstall();
}

module.exports = {
  init,
  checkForUpdates,
  quitAndInstall
};
