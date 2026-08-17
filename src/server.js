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
const { renderTestPage } = require('./testpage');

// Minimal content-type table for the handful of files the overlay needs.
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8'
};

// OBS's embedded browser caches aggressively, which means an overlay file kept
// from a previous KeyCast version can survive an update and render stale. The
// overlay is served from the local machine, so caching buys nothing.
const NO_STORE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache'
};

function headers(contentType) {
  return Object.assign({ 'Content-Type': contentType }, NO_STORE);
}

// Create a server controller. options:
//   overlayDir   absolute path to the overlay/ directory
//   getProfile   function returning the current active profile object, sent to
//                each client on connect and whenever config changes
function createServer({ overlayDir, getProfile }) {
  let httpServer = null;
  let wss = null;
  let currentPort = null;
  // Why the server is not listening, kept so the Config UI can show a reason
  // instead of a silent failure. A message string, never input data.
  let lastError = null;

  // Normalized overlay root with a trailing separator, so the containment check
  // below cannot be satisfied by a sibling directory whose name merely starts
  // with the overlay directory's name.
  const overlayRoot = path.normalize(overlayDir) + path.sep;

  // Serve a static file from the overlay directory only. The requested path is
  // resolved and checked so it cannot escape the overlay directory.
  function serveStatic(req, res) {
    let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath === '/') {
      urlPath = '/index.html';
    }

    // Reachability check page. Served from memory as an explicit route rather
    // than a file on disk, so it works even if the overlay folder is missing.
    // Opening this URL in a normal browser on the streaming PC is the fastest
    // way to tell a network problem apart from an OBS problem.
    if (urlPath === '/test' || urlPath === '/test/' || urlPath === '/test.html') {
      res.writeHead(200, headers('text/html; charset=utf-8'));
      res.end(renderTestPage());
      return;
    }

    const resolved = path.normalize(path.join(overlayRoot, urlPath));
    if (!resolved.startsWith(overlayRoot)) {
      res.writeHead(403, headers('text/plain; charset=utf-8'));
      res.end('Forbidden');
      return;
    }

    fs.readFile(resolved, (err, data) => {
      if (err) {
        res.writeHead(404, headers('text/plain; charset=utf-8'));
        res.end('Not found');
        return;
      }
      const ext = path.extname(resolved).toLowerCase();
      const type = CONTENT_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, headers(type));
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
      const server = http.createServer(serveStatic);
      httpServer = server;
      wss = new WebSocketServer({ server });

      // ws re-emits the HTTP server's 'error' events on the WebSocketServer.
      // An 'error' event with no listener is fatal in Node, so without this
      // handler a taken port would crash the whole app instead of rejecting
      // the start promise. The HTTP server's own handler below does the real
      // work; this one only stops the duplicate from killing the process.
      wss.on('error', () => {});

      wss.on('connection', (socket, req) => {
        // Record the connecting client's role so the status indicator can count
        // real OBS overlay sources separately from the app's own preview and
        // status connections. This is a single string label, not input data.
        socket._role = parseRole(req);
        // A new overlay or preview client connected. Send it the current config
        // so it can render. No client identity or input is recorded.
        sendConfig(socket);
      });

      // Settled guards the promise: a listen failure must reject once, while any
      // later error (an adapter disappearing, for example) must not tear the
      // process down through an unhandled 'error' event.
      let settled = false;

      server.on('error', (err) => {
        if (settled) {
          console.log('Server error after startup: ' + err.message);
          return;
        }
        settled = true;
        // The failed server can never listen, so drop it rather than leaving a
        // half-built instance behind for the next start attempt to trip over.
        currentPort = null;
        lastError = describeListenError(err, port);
        try {
          wss.close();
        } catch (closeErr) {
          // Nothing to close if the underlying server never bound.
        }
        wss = null;
        httpServer = null;
        reject(err);
      });

      server.listen(port, '0.0.0.0', () => {
        settled = true;
        currentPort = port;
        lastError = null;
        console.log('Server listening on port ' + port + '. Overlay and WebSocket are served locally only.');
        resolve();
      });
    });
  }

  // Turn a listen failure into a sentence the Config UI can show. Without this
  // the only record of the failure is a console line nobody sees in the packaged
  // app, which leaves the user staring at an overlay that never appears.
  function describeListenError(err, port) {
    if (err && err.code === 'EADDRINUSE') {
      return 'Port ' + port + ' is already in use by another program. Choose a different port.';
    }
    if (err && err.code === 'EACCES') {
      return 'Windows refused to open port ' + port + '. Choose a port above 1024.';
    }
    return 'The server could not start on port ' + port + '. ' + ((err && err.message) || '');
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

  // Roles that are not a real OBS Browser Source: the app's own live preview,
  // its status probe, and the reachability check page.
  const INTERNAL_ROLES = ['preview', 'status', 'test'];

  // Number of connected real overlay sources (OBS Browser Sources), excluding
  // the app's own live preview, status, and reachability-test connections. This
  // is what the Config UI status indicator reports. A count only, no client data
  // is exposed.
  function getOverlayClientCount() {
    if (!wss) {
      return 0;
    }
    let count = 0;
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN && !INTERNAL_ROLES.includes(client._role)) {
        count += 1;
      }
    }
    return count;
  }

  // Close the server. Used on shutdown and before restarting on a new port.
  // currentPort is cleared up front so the controller never reports itself as
  // listening while the socket is on its way down.
  function close() {
    return new Promise((resolve) => {
      currentPort = null;
      if (wss) {
        for (const client of wss.clients) {
          client.terminate();
        }
        wss.close();
        wss = null;
      }
      if (httpServer) {
        const server = httpServer;
        httpServer = null;
        server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  // Restart on a new port. Used when the user changes the port in the Config UI,
  // and to recover a server that never came up. A failed start leaves the
  // controller cleanly stopped with lastError set, so the caller can report why
  // and the next attempt starts from a known state.
  async function restart(port) {
    await close();
    await start(port);
  }

  function getPort() {
    return currentPort;
  }

  // Whether the server is actually accepting connections. A port number in the
  // config is not proof of this: the listen can fail while the setting stands.
  function isListening() {
    return currentPort !== null;
  }

  // The reason the last start attempt failed, or null. A message only.
  function getLastError() {
    return lastError;
  }

  return {
    start,
    close,
    restart,
    broadcast,
    broadcastConfig,
    getClientCount,
    getOverlayClientCount,
    getPort,
    isListening,
    getLastError
  };
}

module.exports = {
  createServer
};
