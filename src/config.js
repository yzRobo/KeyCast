// config.js
//
// Loads, validates, and saves config.json. This is the only file in the
// project that writes to disk, and it writes configuration only. It never
// writes key or mouse input data. The default config is created on first run
// if one does not exist; all other writes happen only when the user changes a
// setting in the Config UI.

const fs = require('fs');
const path = require('path');

// Built-in theme presets. The Config UI applies one of these as a starting
// point, then lets the user override any individual value. Keeping the values
// here means the overlay, the Config UI, and the default config all agree.
const THEME_PRESETS = {
  'minimal-dark': {
    keyIdle: '#1c1c1c',
    keyPressed: '#ffffff',
    keyHeld: '#e0e0e0',
    textIdle: '#555555',
    textPressed: '#111111',
    borderIdle: '#2e2e2e',
    borderPressed: '#ffffff'
  },
  'minimal-light': {
    keyIdle: '#f0f0f0',
    keyPressed: '#111111',
    keyHeld: '#cccccc',
    textIdle: '#aaaaaa',
    textPressed: '#ffffff',
    borderIdle: '#dddddd',
    borderPressed: '#111111'
  },
  // subtle-glow shares minimal-dark's colors. The faint pressed glow is applied
  // by the overlay stylesheet based on the preset name, not by extra color values.
  'subtle-glow': {
    keyIdle: '#1c1c1c',
    keyPressed: '#ffffff',
    keyHeld: '#e0e0e0',
    textIdle: '#555555',
    textPressed: '#111111',
    borderIdle: '#2e2e2e',
    borderPressed: '#ffffff'
  }
};

const VALID_ANIMATIONS = ['fade', 'pop', 'none'];
const VALID_PRESETS = Object.keys(THEME_PRESETS);

// How the mouse movement indicator draws the direction the mouse is moving.
//   dot    a pad with a marker that pushes off centre and springs back
//   arrow  a single arrow pointing the way, growing with speed
//   trail  a fading trail of recent movement inside the pad
const VALID_MOVEMENT_STYLES = ['dot', 'arrow', 'trail'];

// Returns a fresh default configuration object. Mirrors the schema in the
// project specification exactly.
function getDefaultConfig() {
  return {
    server: {
      port: 8765,
      // The LAN IP the user picked for the 2PC / OBS URL, or null to auto-pick
      // the first detected adapter. Stored so the choice survives restarts.
      lanAddress: null
    },
    profiles: {
      active: 'default',
      list: {
        default: {
          name: 'Default',
          keyboard: {
            enabled: true,
            keys: [
              { key: 'w', label: 'W', x: 1, y: 0 },
              { key: 'a', label: 'A', x: 0, y: 1 },
              { key: 's', label: 'S', x: 1, y: 1 },
              { key: 'd', label: 'D', x: 2, y: 1 },
              { key: 'space', label: 'JUMP', x: 0, y: 2, span: 3 },
              { key: 'ctrl', label: 'CROUCH', x: 0, y: 3, span: 3 }
            ]
          },
          mouse: {
            enabled: false,
            // Grid position of the mouse schematic, in the same cell units as
            // keys. Defaults below the default keyboard rows so it lands where it
            // used to sit; the user can drag it anywhere from here.
            x: 0,
            y: 4,
            buttons: {
              lmb: { show: true, counter: false },
              rmb: { show: true, counter: false },
              mmb: { show: true, counter: false },
              m4: { show: false, counter: false },
              m5: { show: false, counter: false }
            },
            scroll: true,
            // Mouse movement indicator. Off by default: it is the only feature
            // that reads the cursor position, so it is opt-in. sensitivity sets
            // how far the indicator deflects for a given amount of movement.
            movement: {
              show: false,
              style: 'dot',
              sensitivity: 10
            }
          },
          theme: {
            preset: 'minimal-dark',
            keyIdle: '#1c1c1c',
            keyPressed: '#ffffff',
            keyHeld: '#e0e0e0',
            textIdle: '#555555',
            textPressed: '#111111',
            borderIdle: '#2e2e2e',
            borderPressed: '#ffffff',
            animation: 'fade',
            keySize: 48,
            keyGap: 6,
            scale: 1.0,
            backgroundOpacity: 0
          },
          counters: {
            kps: false
          }
        }
      }
    }
  };
}

// Clamp a number into a range, falling back to a default when the input is not
// a finite number.
function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, n));
}

function isHexColor(value) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
}

// Loose IPv4 check, used only to keep a garbage lanAddress out of the saved
// config. The value is for display in the OBS URL; it is never dialed by the app.
function isIpv4(value) {
  return typeof value === 'string' && /^(\d{1,3})(\.\d{1,3}){3}$/.test(value);
}

function pickColor(value, fallback) {
  return isHexColor(value) ? value : fallback;
}

// Validate and normalize a single key entry. Drops invalid entries by returning
// null so the caller can filter them out.
function validateKey(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  if (typeof entry.key !== 'string' || entry.key.length === 0) {
    return null;
  }
  const validated = {
    key: entry.key,
    label: typeof entry.label === 'string' ? entry.label : entry.key.toUpperCase(),
    x: clampNumber(entry.x, 0, 64, 0),
    y: clampNumber(entry.y, 0, 64, 0)
  };
  // span is optional. Only include it when it is a sensible value above 1.
  const span = clampNumber(entry.span, 1, 12, 1);
  if (span > 1) {
    validated.span = span;
  }
  // A combo key joins two or more keys with a plus sign, for example
  // "space+ctrl". The window is how close (in milliseconds) the presses must
  // land to count as a successful tight-timing hit. It only applies to combos.
  const isCombo = entry.key.includes('+');
  if (isCombo) {
    const windowMs = clampNumber(entry.window, 1, 2000, 50);
    validated.window = Math.round(windowMs);
    // An ordered combo requires its keys to be pressed in order (the Superglide
    // preset). Only meaningful for combos.
    if (entry.ordered === true) {
      validated.ordered = true;
    }
  }
  return validated;
}

function validateMouseButton(button) {
  const safe = button && typeof button === 'object' ? button : {};
  return {
    show: safe.show === true,
    counter: safe.counter === true
  };
}

// Validate the mouse movement indicator settings. A config written by an older
// KeyCast has no movement block at all, so every field falls back to a default
// and the feature stays off until the user turns it on.
function validateMouseMovement(movement, defaults) {
  const safe = movement && typeof movement === 'object' ? movement : {};
  return {
    show: safe.show === true,
    style: VALID_MOVEMENT_STYLES.includes(safe.style) ? safe.style : defaults.style,
    sensitivity: Math.round(clampNumber(safe.sensitivity, 1, 30, defaults.sensitivity))
  };
}

// Validate and normalize a single profile against the schema. Unknown fields
// are dropped and missing fields are filled from the default profile.
function validateProfile(profile, fallbackName) {
  const defaults = getDefaultConfig().profiles.list.default;
  const safe = profile && typeof profile === 'object' ? profile : {};

  const keyboardSafe = safe.keyboard && typeof safe.keyboard === 'object' ? safe.keyboard : {};
  const keys = Array.isArray(keyboardSafe.keys)
    ? keyboardSafe.keys.map(validateKey).filter(Boolean)
    : defaults.keyboard.keys;

  const mouseSafe = safe.mouse && typeof safe.mouse === 'object' ? safe.mouse : {};
  const buttonsSafe = mouseSafe.buttons && typeof mouseSafe.buttons === 'object' ? mouseSafe.buttons : {};

  const themeSafe = safe.theme && typeof safe.theme === 'object' ? safe.theme : {};
  const preset = VALID_PRESETS.includes(themeSafe.preset) ? themeSafe.preset : 'minimal-dark';
  const animation = VALID_ANIMATIONS.includes(themeSafe.animation) ? themeSafe.animation : 'fade';

  const countersSafe = safe.counters && typeof safe.counters === 'object' ? safe.counters : {};

  return {
    name: typeof safe.name === 'string' && safe.name.length > 0 ? safe.name : fallbackName,
    keyboard: {
      enabled: keyboardSafe.enabled !== false,
      keys
    },
    mouse: {
      enabled: mouseSafe.enabled === true,
      x: clampNumber(mouseSafe.x, 0, 64, defaults.mouse.x),
      y: clampNumber(mouseSafe.y, 0, 64, defaults.mouse.y),
      buttons: {
        lmb: validateMouseButton(buttonsSafe.lmb),
        rmb: validateMouseButton(buttonsSafe.rmb),
        mmb: validateMouseButton(buttonsSafe.mmb),
        m4: validateMouseButton(buttonsSafe.m4),
        m5: validateMouseButton(buttonsSafe.m5)
      },
      scroll: mouseSafe.scroll !== false,
      movement: validateMouseMovement(mouseSafe.movement, defaults.mouse.movement)
    },
    theme: {
      preset,
      keyIdle: pickColor(themeSafe.keyIdle, defaults.theme.keyIdle),
      keyPressed: pickColor(themeSafe.keyPressed, defaults.theme.keyPressed),
      keyHeld: pickColor(themeSafe.keyHeld, defaults.theme.keyHeld),
      textIdle: pickColor(themeSafe.textIdle, defaults.theme.textIdle),
      textPressed: pickColor(themeSafe.textPressed, defaults.theme.textPressed),
      borderIdle: pickColor(themeSafe.borderIdle, defaults.theme.borderIdle),
      borderPressed: pickColor(themeSafe.borderPressed, defaults.theme.borderPressed),
      animation,
      keySize: clampNumber(themeSafe.keySize, 24, 128, defaults.theme.keySize),
      keyGap: clampNumber(themeSafe.keyGap, 0, 48, defaults.theme.keyGap),
      scale: clampNumber(themeSafe.scale, 0.5, 3.0, defaults.theme.scale),
      backgroundOpacity: clampNumber(themeSafe.backgroundOpacity, 0, 1, defaults.theme.backgroundOpacity)
    },
    counters: {
      kps: countersSafe.kps === true
    }
  };
}

// Validate and normalize a full configuration object. Always returns a complete,
// schema-correct config that the rest of the app can trust.
function validateConfig(input) {
  const safe = input && typeof input === 'object' ? input : {};

  const serverSafe = safe.server && typeof safe.server === 'object' ? safe.server : {};
  const port = clampNumber(serverSafe.port, 1, 65535, 8765);
  const lanAddress = isIpv4(serverSafe.lanAddress) ? serverSafe.lanAddress : null;

  const profilesSafe = safe.profiles && typeof safe.profiles === 'object' ? safe.profiles : {};
  const listSafe = profilesSafe.list && typeof profilesSafe.list === 'object' ? profilesSafe.list : {};

  const validatedList = {};
  const ids = Object.keys(listSafe);
  for (const id of ids) {
    validatedList[id] = validateProfile(listSafe[id], id);
  }

  // Guarantee at least one profile exists.
  if (Object.keys(validatedList).length === 0) {
    const fallback = getDefaultConfig();
    return fallback;
  }

  // Guarantee the active profile points at a real profile.
  let active = profilesSafe.active;
  if (typeof active !== 'string' || !validatedList[active]) {
    active = Object.keys(validatedList)[0];
  }

  return {
    server: { port, lanAddress },
    profiles: {
      active,
      list: validatedList
    }
  };
}

// Load configuration from disk. Creates the default config file on first run
// if it does not exist. Returns a validated config object.
function load(configPath) {
  if (!fs.existsSync(configPath)) {
    const defaults = getDefaultConfig();
    // First-run creation of config.json. This is configuration data, not input
    // data, and is explicitly permitted by the specification.
    writeConfigFile(configPath, defaults);
    console.log('No config.json found. A default configuration was created.');
    return defaults;
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    return validateConfig(parsed);
  } catch (err) {
    // A corrupt or unreadable config should not crash the app. Fall back to
    // defaults in memory without overwriting the user's file.
    console.log('config.json could not be read or parsed. Using default configuration in memory.');
    console.log('Reason: ' + err.message);
    return getDefaultConfig();
  }
}

// Write a config object to disk as formatted JSON. Used for first-run creation
// and for user-triggered saves from the Config UI.
function writeConfigFile(configPath, config) {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

// Save a configuration object. Validates first so a malformed payload from the
// UI can never corrupt the file. Returns the validated config that was written.
function save(configPath, config) {
  const validated = validateConfig(config);
  writeConfigFile(configPath, validated);
  return validated;
}

module.exports = {
  THEME_PRESETS,
  VALID_ANIMATIONS,
  VALID_PRESETS,
  VALID_MOVEMENT_STYLES,
  getDefaultConfig,
  validateConfig,
  load,
  save
};
