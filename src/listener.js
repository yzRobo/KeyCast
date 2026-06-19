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

const { uIOhook, UiohookKey } = require('uiohook-napi');

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

// Start global capture. onEvent is called once per input event with a small
// plain descriptor object. The caller (the server) broadcasts it and then lets
// it go out of scope. This module keeps no reference to it.
function start(onEvent) {
  if (running) {
    return;
  }

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
    // Positive rotation is treated as scroll up, negative as scroll down. Only
    // the direction is used to drive a brief flash. The event is broadcast
    // immediately and then discarded. No scroll data is stored or logged.
    const direction = e.rotation > 0 ? 'up' : 'down';
    onEvent({ type: 'wheel', direction });
  });

  uIOhook.start();
  running = true;
  console.log('Input listener started. Events are broadcast to clients only and never stored.');
}

// Stop global capture and remove all listeners. There is no buffered data to
// flush because none is ever kept.
function stop() {
  if (!running) {
    return;
  }
  uIOhook.removeAllListeners();
  uIOhook.stop();
  running = false;
  console.log('Input listener stopped.');
}

module.exports = {
  start,
  stop
};
