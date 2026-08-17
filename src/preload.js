// preload.js
//
// Secure bridge between the Config UI renderer and the main process. The
// renderer runs with context isolation on and Node integration off, so it has
// no direct access to Node or Electron internals. This file exposes a small,
// explicit API surface and nothing more.
//
// PRIVACY MODEL:
// The exposed methods move configuration and computed URLs only. There is no
// method that reads, stores, or transmits key or mouse input.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('keycast', {
  // Read the current configuration object.
  getConfig: () => ipcRenderer.invoke('config:get'),

  // Get a fresh default profile to seed a newly created profile.
  getDefaultProfile: () => ipcRenderer.invoke('config:getDefaultProfile'),

  // Save the full configuration. This triggers the only permitted disk write.
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),

  // Get the OBS Browser Source URLs (localhost and LAN) and the active port.
  getUrls: () => ipcRenderer.invoke('server:urls'),

  // Get the connection status (source count and port).
  getStatus: () => ipcRenderer.invoke('server:status'),

  // Run the firewall helper for 2PC setups. Triggers a Windows UAC prompt.
  fixFirewall: () => ipcRenderer.invoke('firewall:fix'),

  // Build a plain-text report of the server, network adapter, and firewall
  // state, for pasting into a bug report. Read-only; contains no input data.
  getDiagnostics: () => ipcRenderer.invoke('diagnostics:report'),

  // Get the running version and whether in-app updates are supported.
  getUpdateInfo: () => ipcRenderer.invoke('update:info'),

  // Check GitHub for a newer release. Progress arrives via onUpdateStatus.
  checkForUpdates: () => ipcRenderer.invoke('update:check'),

  // Quit, install the downloaded update, and relaunch.
  installUpdate: () => ipcRenderer.invoke('update:install'),

  // Subscribe to update progress pushed by the main process. Returns an
  // unsubscribe function. The payload is a small status object describing the
  // current state (checking, available, downloading, downloaded, none, error).
  onUpdateStatus: (callback) => {
    const handler = (event, status) => callback(status);
    ipcRenderer.on('update:status', handler);
    return () => ipcRenderer.removeListener('update:status', handler);
  }
});
