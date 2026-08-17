// testpage.js
//
// The reachability check page served at /test by server.js.
//
// A 2PC setup fails in three different places and all three look identical in
// OBS: a blank Browser Source. The streaming PC cannot reach the gaming PC at
// all; it can reach it but OBS is misconfigured; or everything works and the
// overlay simply has nothing lit yet. This page separates them. Open
// http://<gaming-pc-ip>:<port>/test in an ordinary browser on the streaming PC:
//
//   Page does not load    -> the streaming PC cannot reach KeyCast. Firewall,
//                            wrong address, or the two PCs are not on the same
//                            network. Nothing in OBS will help.
//   Page loads, green     -> the network is fine. The problem is in OBS.
//   Page loads, red       -> HTTP works but the WebSocket does not, which is
//                            unusual because both share one port.
//
// PRIVACY MODEL:
// The page opens a WebSocket purely to confirm the connection is live. It sends
// nothing, ignores every message it receives, and stores nothing. It is styled
// inline with no external font or script request so it renders identically on a
// machine with no internet access.

// Everything is inlined deliberately: this page has to work when the machine
// loading it is offline and when the overlay folder is unreadable.
const TEST_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>KeyCast connection test</title>
<style>
  html, body {
    margin: 0;
    padding: 0;
    min-height: 100%;
    background: #0a0a0a;
    color: #f0f0f0;
    font-family: ui-monospace, Consolas, "Courier New", monospace;
  }
  .wrap {
    max-width: 640px;
    margin: 0 auto;
    padding: 48px 24px;
  }
  .badge {
    display: inline-block;
    padding: 4px 10px;
    border-radius: 999px;
    border: 1.5px solid #2e2e2e;
    font-size: 12px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: #888;
  }
  h1 {
    margin: 20px 0 8px;
    font-size: 34px;
    line-height: 1.2;
    font-weight: 500;
  }
  .sub { color: #999; font-size: 15px; line-height: 1.6; margin: 0 0 28px; }
  .card {
    border: 1.5px solid #2e2e2e;
    border-radius: 10px;
    padding: 18px 20px;
    margin-bottom: 14px;
    background: #131313;
  }
  .card h2 {
    margin: 0 0 6px;
    font-size: 14px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #888;
    font-weight: 500;
  }
  .state { font-size: 19px; display: flex; align-items: center; gap: 10px; }
  .dot { width: 11px; height: 11px; border-radius: 999px; background: #666; flex: none; }
  .ok .dot { background: #4ade80; }
  .ok { color: #4ade80; }
  .bad .dot { background: #f87171; }
  .bad { color: #f87171; }
  .detail { color: #888; font-size: 14px; margin-top: 10px; line-height: 1.6; }
  code {
    background: #1c1c1c;
    border: 1px solid #2e2e2e;
    border-radius: 4px;
    padding: 1px 6px;
    color: #ddd;
  }
  ol { color: #999; font-size: 14px; line-height: 1.8; padding-left: 20px; }
</style>
</head>
<body>
<div class="wrap">
  <span class="badge">KeyCast</span>
  <h1>This page loaded, so the connection works.</h1>
  <p class="sub">
    You reached KeyCast at <code id="host">this address</code>. If you are seeing
    this on your streaming PC, the network side of a 2PC setup is fine.
  </p>

  <div class="card">
    <h2>Overlay data channel</h2>
    <div id="ws" class="state"><span class="dot"></span><span id="wsText">Connecting…</span></div>
    <div class="detail" id="wsDetail">
      The overlay receives your key presses over this channel.
    </div>
  </div>

  <div class="card">
    <h2>Next step</h2>
    <ol>
      <li>Copy this page's address from the browser bar.</li>
      <li>Remove the <code>/test</code> from the end of it.</li>
      <li>Paste the result into your OBS Browser Source URL.</li>
      <li>Set the source size to about 600 by 500, then press a key you have
          added to your KeyCast layout.</li>
    </ol>
    <div class="detail">
      Still blank in OBS? In the Browser Source properties, click
      <code>Refresh cache of current page</code>. Also check that the source is
      not hidden and that no other scene item is covering it.
    </div>
  </div>
</div>
<script>
(function () {
  'use strict';
  document.getElementById('host').textContent = window.location.host;

  var wsEl = document.getElementById('ws');
  var wsText = document.getElementById('wsText');
  var wsDetail = document.getElementById('wsDetail');

  function set(cls, text, detail) {
    wsEl.className = 'state ' + cls;
    wsText.textContent = text;
    if (detail) {
      wsDetail.textContent = detail;
    }
  }

  // role=test keeps this connection out of the "sources connected" count in the
  // KeyCast window, so checking from here does not look like a live OBS source.
  var socket = new WebSocket('ws://' + window.location.host + '?role=test');

  socket.addEventListener('open', function () {
    set('ok', 'Connected', 'Everything is reachable from this PC. Use the same address in OBS, without /test.');
  });
  socket.addEventListener('close', function () {
    set('bad', 'Not connected', 'The page loaded but the data channel did not open. Make sure KeyCast is still running on the other PC.');
  });
  // Messages are ignored on purpose. This page only checks that the channel is
  // open; it never reads, displays, or stores anything sent over it.
})();
</script>
</body>
</html>
`;

function renderTestPage() {
  return TEST_PAGE;
}

module.exports = {
  renderTestPage
};
