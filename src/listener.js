// listener.js
//
// Global keyboard and mouse capture using uiohook-napi. This is the only place
// in the app where raw input is observed.
//
// PRIVACY MODEL (applies to this entire file):
// Each hook callback receives a single event, converts it into a small display
// descriptor, hands that descriptor to the broadcast callback, and returns.
// No event is appended to an array, stored in a buffer, written to a variable
// that outlives the callback, or logged. There is no input history anywhere in
// this module. Every individual capture point below repeats this guarantee
// inline so the code can be audited at a glance.
//
// The mouse movement indicator has two capture paths, tried in this order:
//
//   raw    The native module in native/rawinput reads relative motion from the
//          Windows Raw Input stream, the same source games use. It sees only
//          the movement counts the device reported; no cursor position exists
//          anywhere on this path. This is what makes the indicator work inside
//          games that lock the pointer.
//   hook   Fallback via the uiohook cursor events when the native module is
//          not built (running from source without a compiler) or fails to
//          start. Computing "which way did the mouse move" from cursor events
//          requires the previous cursor position: exactly one coordinate pair
//          is kept, overwritten by the next event, and never sent anywhere.
//
// Both paths broadcast relative deltas only, and neither is active unless a
// profile actually displays the indicator. Set the KEYCAST_NO_RAWINPUT
// environment variable to force the hook path for troubleshooting.

const { uIOhook, UiohookKey } = require('uiohook-napi');

// libuiohook event type numbers. uiohook-napi maps most of these to named
// events, but it has no case for EVENT_MOUSE_DRAGGED, so a drag is dispatched
// on the generic 'input' event and nowhere else. Windows reports every cursor
// move as a drag while any mouse button is held, which for a shooter means all
// movement while firing. Listening on 'input' and accepting both numbers is the
// only way to see continuous movement.
const EVENT_MOUSE_MOVED = 9;
const EVENT_MOUSE_DRAGGED = 10;

// How often accumulated movement is flushed to the overlay. A gaming mouse
// reports at up to 1000 Hz; broadcasting each report would flood the socket for
// no visual gain, so deltas are summed and sent at roughly display rate.
const MOVE_FLUSH_MS = 16;

// Single-event jumps larger than this are treated as a cursor warp rather than
// real movement (hook path only; the raw path never sees warps because
// programmatic cursor moves do not come from the device). Games that lock the
// pointer routinely snap it back to the centre of the screen every frame, and
// counting those snaps would cancel out the movement that preceded them. A
// genuine fast flick still moves far less than this between two hook reports.
const WARP_JUMP_PX = 220;

// Raw input deltas are hardware counts with no pointer acceleration applied, so
// they run hotter than cursor pixels. Scaled down so the two paths feel alike
// at the same sensitivity setting.
const RAW_SCALE = 0.5;

// Load the native raw input reader. Optional on purpose: running from source
// without a compiler, on another platform, or with KEYCAST_NO_RAWINPUT set all
// leave it null and movement falls back to the cursor hook. When packaged, the
// binary lives outside the asar archive and Electron redirects this require to
// the unpacked copy automatically.
function loadRawInput() {
  if (process.platform !== 'win32' || process.env.KEYCAST_NO_RAWINPUT) {
    return null;
  }
  const path = require('path');
  try {
    return require(path.join(__dirname, '..', 'native', 'rawinput', 'build', 'Release', 'rawinput.node'));
  } catch (err) {
    return null;
  }
}

const rawInput = loadRawInput();

// Build a reverse lookup from uiohook keycode to a normalized key name that
// matches the names used in config.json (lowercase letters, "space", "ctrl",
// and so on). This map is static metadata about the keyboard layout. It holds
// no input data.
function buildKeycodeNameMap() {
  const map = {};

  // Normalize a UiohookKey property name into a config-style key name.
  function normalize(name) {
    // Single letters A-Z become lowercase: "W" -> "w".
    if (/^[A-Z]$/.test(name)) {
      return name.toLowerCase();
    }
    // Modifier variants collapse to a single base name so a configured "ctrl"
    // key lights up for either the left or right physical key.
    const collapse = {
      Ctrl: 'ctrl', CtrlRight: 'ctrl',
      Shift: 'shift', ShiftRight: 'shift',
      Alt: 'alt', AltRight: 'alt',
      Meta: 'meta', MetaRight: 'meta',
      ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right'
    };
    if (collapse[name]) {
      return collapse[name];
    }
    // Everything else (Space, Enter, Tab, F1, Numpad0, Semicolon, ...) becomes
    // its lowercase form: "Space" -> "space".
    return name.toLowerCase();
  }

  for (const propName of Object.keys(UiohookKey)) {
    const code = UiohookKey[propName];
    if (typeof code === 'number') {
      map[code] = normalize(propName);
    }
  }
  return map;
}

const KEYCODE_TO_NAME = buildKeycodeNameMap();

// uiohook mouse button numbers mapped to the names used in config.json.
const MOUSE_BUTTON_NAMES = {
  1: 'lmb',
  2: 'rmb',
  3: 'mmb',
  4: 'm4',
  5: 'm5'
};

let running = false;

// Movement capture state. All of it is reset whenever the hook is detached.
//   emit         the broadcast callback, held while the listener runs
//   movementOn   whether the cursor hook is currently attached
//   lastX/lastY  the previous cursor position, the one retained value described
//                in the privacy note at the top of this file
//   accumX/Y     movement summed since the last flush
//   flushTimer   the interval that drains the accumulator
//   moveSource   which capture path is active: 'raw', 'hook', or 'off'
let emit = null;
let movementOn = false;
let moveSource = 'off';
let lastX = null;
let lastY = null;
let accumX = 0;
let accumY = 0;
let flushTimer = null;

// Handle one raw hook event, picking out cursor movement. Registered on the
// generic 'input' event because dragged movement is not dispatched under any
// named event (see EVENT_MOUSE_DRAGGED above).
function onRawInput(e) {
  if (!e || (e.type !== EVENT_MOUSE_MOVED && e.type !== EVENT_MOUSE_DRAGGED)) {
    return;
  }

  const x = e.x;
  const y = e.y;

  if (lastX === null) {
    // First sighting. There is no previous position to compare against yet, so
    // there is no movement to report.
    lastX = x;
    lastY = y;
    return;
  }

  const dx = x - lastX;
  const dy = y - lastY;
  lastX = x;
  lastY = y;

  // Discard warps: a pointer-locked game snapping the cursor back to centre, or
  // the pointer crossing to another monitor. Only the reference position is
  // updated, which happened above.
  if (Math.abs(dx) > WARP_JUMP_PX || Math.abs(dy) > WARP_JUMP_PX) {
    return;
  }

  accumX += dx;
  accumY += dy;
}

// Send whatever movement has accumulated since the last tick, then clear it.
// Nothing is sent while the mouse is still, so an idle machine produces no
// traffic at all.
function flushMovement() {
  let dx = 0;
  let dy = 0;
  if (moveSource === 'raw') {
    // The native side sums device counts and hands them over atomically. This
    // read also resets its accumulator, so nothing lingers in native memory.
    const d = rawInput.getDelta();
    dx = Math.round(d.dx * RAW_SCALE);
    dy = Math.round(d.dy * RAW_SCALE);
  } else {
    dx = accumX;
    dy = accumY;
    accumX = 0;
    accumY = 0;
  }
  if (dx === 0 && dy === 0) {
    return;
  }
  if (emit) {
    // A relative delta only. No cursor position ever leaves this module.
    // The descriptor is broadcast immediately and then discarded.
    emit({ type: 'mousemove', dx, dy });
  }
}

// Attach or detach movement capture. Called by main.js from the active profile,
// so capture exists only while the overlay actually draws movement. Prefers the
// raw input reader and falls back to the cursor hook.
function setMouseMovement(enabled) {
  const next = Boolean(enabled) && running;
  if (next === movementOn) {
    return;
  }

  if (next) {
    if (rawInput && rawInput.start()) {
      moveSource = 'raw';
      console.log('Mouse movement capture on (raw input). Relative device motion only; no cursor position exists on this path.');
    } else {
      uIOhook.on('input', onRawInput);
      moveSource = 'hook';
      console.log('Mouse movement capture on (cursor hook fallback). Only relative deltas are broadcast; cursor position is never sent or stored.');
    }
    flushTimer = setInterval(flushMovement, MOVE_FLUSH_MS);
    movementOn = true;
    return;
  }

  if (moveSource === 'raw') {
    rawInput.stop();
  } else {
    uIOhook.off('input', onRawInput);
  }
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  // Drop the retained hook-path position and any partial movement.
  lastX = null;
  lastY = null;
  accumX = 0;
  accumY = 0;
  moveSource = 'off';
  movementOn = false;
  console.log('Mouse movement capture off.');
}

// Which movement capture path is active. Shown in the diagnostics report so a
// support thread can tell instantly whether in-game movement should work.
function getMovementSource() {
  return moveSource;
}

// Start global capture. onEvent is called once per input event with a small
// plain descriptor object. The caller (the server) broadcasts it and then lets
// it go out of scope. This module keeps no reference to it.
function start(onEvent) {
  if (running) {
    return;
  }

  emit = onEvent;

  uIOhook.on('keydown', (e) => {
    const name = KEYCODE_TO_NAME[e.keycode];
    if (!name) {
      return;
    }
    // Key press is converted to a display descriptor and broadcast immediately.
    // It is not stored, buffered, or logged anywhere.
    onEvent({ type: 'keydown', key: name });
  });

  uIOhook.on('keyup', (e) => {
    const name = KEYCODE_TO_NAME[e.keycode];
    if (!name) {
      return;
    }
    // Key release is broadcast immediately and then discarded. No retention.
    onEvent({ type: 'keyup', key: name });
  });

  uIOhook.on('mousedown', (e) => {
    const button = MOUSE_BUTTON_NAMES[e.button];
    if (!button) {
      return;
    }
    // Mouse press is broadcast immediately and then discarded. No retention.
    onEvent({ type: 'mousedown', button });
  });

  uIOhook.on('mouseup', (e) => {
    const button = MOUSE_BUTTON_NAMES[e.button];
    if (!button) {
      return;
    }
    // Mouse release is broadcast immediately and then discarded. No retention.
    onEvent({ type: 'mouseup', button });
  });

  uIOhook.on('wheel', (e) => {
    // uiohook reports a positive rotation for a scroll DOWN and a negative
    // rotation for a scroll UP on Windows (verified against real hardware), so
    // map it accordingly. Only the direction is used to drive a brief flash. The
    // event is broadcast immediately and then discarded. No scroll data is
    // stored or logged.
    const direction = e.rotation > 0 ? 'down' : 'up';
    onEvent({ type: 'wheel', direction });
  });

  uIOhook.start();
  running = true;
  console.log('Input listener started. Events are broadcast to clients only and never stored.');
}

// Stop global capture and remove all listeners. There is no buffered data to
// flush because none is ever kept, and the one retained cursor position is
// dropped here.
function stop() {
  if (!running) {
    return;
  }
  setMouseMovement(false);
  uIOhook.removeAllListeners();
  uIOhook.stop();
  emit = null;
  running = false;
  console.log('Input listener stopped.');
}

module.exports = {
  start,
  stop,
  setMouseMovement,
  getMovementSource
};
