// server.js
//
// Runs two things on a single port:
//   1. An HTTP server that serves the static overlay files (the OBS Browser
//      Source).
//   2. A WebSocket server that pushes input events to every connected client
//      (overlay instances and the Config UI live preview).
//
// PRIVACY MODEL:
// Input events arrive from listener.js, are serialized, written to each open
// socket, and then go out of scope. The server keeps a set of client
// connections so it can broadcast, but it never keeps the events themselves.
// Nothing is buffered, queued for replay, or logged.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// Minimal content-type table for the handful of files the overlay needs.
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8'
};

// Create a server controller. options:
//   overlayDir   absolute path to the overlay/ directory
//   getProfile   function returning the current active profile object, sent to
//                each client on connect and whenever config changes
function createServer({ overlayDir, getProfile }) {
  let httpServer = null;
  let wss = null;
  let currentPort = null;

  // Serve a static file from the overlay directory only. The requested path is
  // resolved and checked so it cannot escape the overlay directory.
  function serveStatic(req, res) {
    let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath === '/') {
      urlPath = '/index.html';
    }

    const resolved = path.normalize(path.join(overlayDir, urlPath));
    if (!resolved.startsWith(overlayDir)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }

    fs.readFile(resolved, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      const ext = path.extname(resolved).toLowerCase();
      const type = CONTENT_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type });
      res.end(data);
    });
  }

  // Read the role label from a connecting client's URL query string. The real
  // OBS overlay connects with role "overlay" (the default), the in-app preview
  // with "preview", and the status indicator with "status".
  function parseRole(req) {
    try {
      const parsed = new URL(req.url, 'http://localhost');
      return parsed.searchParams.get('role') || 'overlay';
    } catch (err) {
      return 'overlay';
    }
  }

  // Send the current active profile to a single client so it can render the
  // correct layout and theme immediately on connect.
  function sendConfig(socket) {
    if (socket.readyState !== socket.OPEN) {
      return;
    }
    const profile = getProfile();
    socket.send(JSON.stringify({ type: 'config', profile }));
  }

  // Start listening on the given port. Resolves once the server is up. Binds to
  // all local interfaces so a second PC on the same LAN can reach the overlay.
  // No router port forwarding is involved, so this is not exposed to the
  // internet. The app never makes outbound internet connections.
  function start(port) {
    return new Promise((resolve, reject) => {
      httpServer = http.createServer(serveStatic);
      wss = new WebSocketServer({ server: httpServer });

      wss.on('connection', (socket, req) => {
        // Record the connecting client's role so the status indicator can count
        // real OBS overlay sources separately from the app's own preview and
        // status connections. This is a single string label, not input data.
        socket._role = parseRole(req);
        // A new overlay or preview client connected. Send it the current config
        // so it can render. No client identity or input is recorded.
        sendConfig(socket);
      });

      httpServer.on('error', (err) => {
        reject(err);
      });

      httpServer.listen(port, '0.0.0.0', () => {
        currentPort = port;
        console.log('Server listening on port ' + port + '. Overlay and WebSocket are served locally only.');
        resolve();
      });
    });
  }

  // Broadcast a single input event to every connected client. The event object
  // is serialized and written to each open socket, then released. It is never
  // stored on the server.
  function broadcast(event) {
    if (!wss) {
      return;
    }
    const message = JSON.stringify(event);
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) {
        client.send(message);
      }
    }
  }

  // Push an updated active profile to every connected client. Called after the
  // user changes a setting in the Config UI.
  function broadcastConfig() {
    if (!wss) {
      return;
    }
    const profile = getProfile();
    const message = JSON.stringify({ type: 'config', profile });
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) {
        client.send(message);
      }
    }
  }

  // Number of currently connected clients of all kinds. A count only.
  function getClientCount() {
    return wss ? wss.clients.size : 0;
  }

  // Number of connected real overlay sources (OBS Browser Sources), excluding
  // the app's own live preview and status connections. This is what the Config
  // UI status indicator reports. A count only, no client data is exposed.
  function getOverlayClientCount() {
    if (!wss) {
      return 0;
    }
    let count = 0;
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN && client._role !== 'preview' && client._role !== 'status') {
        count += 1;
      }
    }
    return count;
  }

  // Close the server. Used on shutdown and before restarting on a new port.
  function close() {
    return new Promise((resolve) => {
      if (wss) {
        for (const client of wss.clients) {
          client.terminate();
        }
        wss.close();
        wss = null;
      }
      if (httpServer) {
        httpServer.close(() => {
          httpServer = null;
          currentPort = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  // Restart on a new port. Used when the user changes the port in the Config UI.
  async function restart(port) {
    await close();
    await start(port);
  }

  function getPort() {
    return currentPort;
  }

  return {
    start,
    close,
    restart,
    broadcast,
    broadcastConfig,
    getClientCount,
    getOverlayClientCount,
    getPort
  };
}

module.exports = {
  createServer
};
