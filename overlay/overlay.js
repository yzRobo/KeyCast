// overlay.js
//
// WebSocket client and real-time renderer for the OBS Browser Source.
//
// PRIVACY MODEL:
// This script receives input events over the local WebSocket and turns them
// into visual state. It does not send anything back, does not write to storage
// (no localStorage, no cookies, no fetch to any server), and does not keep an
// event history. The only retained values are the live visual state of each
// key, the in-memory counters, and a short rolling window of recent keypress
// timestamps used purely to compute keys-per-second. All of this is ephemeral
// and resets when the page reloads.

(function () {
  'use strict';

  // How long a key must stay down before it counts as a hold rather than a tap.
  const HOLD_THRESHOLD_MS = 180;
  // Minimum time a tap stays lit so even very fast taps remain visible.
  const MIN_FLASH_MS = 90;
  // Rolling window used for the keys-per-second calculation.
  const KPS_WINDOW_MS = 1000;
  // How long the scroll flash stays lit.
  const SCROLL_FLASH_MS = 150;

  const overlayEl = document.getElementById('overlay');
  const keyboardEl = document.getElementById('keyboard');
  const mouseEl = document.getElementById('mouse');
  const kpsEl = document.getElementById('kps');

  let profile = null;

  // Map of config key name to the set of DOM elements representing it. A single
  // configured key has exactly one element, but using a map keeps lookups by
  // event name simple. Holds element references only, never event data.
  let keyElements = {};
  // Per key runtime state: down timestamp and the pending hold timer.
  let keyState = {};
  // Combo caps. Each is a single displayed key that watches two or more
  // physical keys and flashes when they are pressed within a tight timing
  // window (the Superglide pattern). Holds element references and config only.
  let comboCaps = [];
  // Live physical key state, fed by every key event so combos can evaluate
  // timing regardless of which keys are shown as their own caps. physicalDownAt
  // holds the timestamp of the most recent fresh press per key. These are
  // ephemeral and reset on page load; nothing is persisted.
  let physicalDown = {};
  let physicalDownAt = {};
  // Mouse element references by button name and the scroll wheel element.
  let mouseElements = {};
  let mouseWheelEl = null;
  // In-memory click counters. Reset on every page load. Never persisted.
  let clickCounts = {};
  let counterElements = {};
  // Rolling list of recent keydown timestamps for the KPS counter. Trimmed to
  // the last second on every read. Contains timestamps only, no key identity.
  let kpsTimestamps = [];

  // Apply theme custom properties and animation/preset classes to the overlay.
  function applyTheme(theme) {
    const s = overlayEl.style;
    s.setProperty('--key-idle', theme.keyIdle);
    s.setProperty('--key-pressed', theme.keyPressed);
    s.setProperty('--key-held', theme.keyHeld);
    s.setProperty('--text-idle', theme.textIdle);
    s.setProperty('--text-pressed', theme.textPressed);
    s.setProperty('--border-idle', theme.borderIdle);
    s.setProperty('--border-pressed', theme.borderPressed);
    s.setProperty('--key-size', theme.keySize + 'px');
    s.setProperty('--key-gap', theme.keyGap + 'px');
    s.setProperty('--scale', String(theme.scale));
    s.setProperty('--bg-opacity', String(theme.backgroundOpacity));

    overlayEl.classList.remove('anim-fade', 'anim-pop', 'anim-none');
    overlayEl.classList.add('anim-' + theme.animation);

    overlayEl.classList.remove('theme-minimal-dark', 'theme-minimal-light', 'theme-subtle-glow');
    overlayEl.classList.add('theme-' + theme.preset);
  }

  // Parse a key entry's key string into its parts. A combo joins keys with a
  // plus sign, for example "space+ctrl".
  function comboParts(keyString) {
    return (keyString || '')
      .split('+')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  }

  // Build the keyboard grid from the profile.
  function renderKeyboard(kb) {
    keyboardEl.innerHTML = '';
    keyElements = {};
    keyState = {};
    comboCaps = [];

    if (!kb.enabled) {
      keyboardEl.hidden = true;
      return;
    }
    keyboardEl.hidden = false;

    for (const entry of kb.keys) {
      const el = document.createElement('div');
      el.className = 'key';
      el.style.setProperty('--col', String(entry.x + 1));
      el.style.setProperty('--row', String(entry.y + 1));
      if (entry.span && entry.span > 1) {
        el.style.setProperty('--span', String(entry.span));
      }
      el.textContent = entry.label;
      keyboardEl.appendChild(el);

      const parts = comboParts(entry.key);
      if (parts.length > 1) {
        // A combo cap. It is driven by the timing logic in evaluateCombos, not
        // by the single-key handlers below. An ordered combo (the Superglide
        // preset) additionally requires the keys to be pressed in list order.
        el.classList.add('combo');
        comboCaps.push({
          keys: parts,
          window: typeof entry.window === 'number' ? entry.window : 50,
          ordered: entry.ordered === true,
          el,
          hitTimer: null
        });
      } else if (parts.length === 1) {
        if (!keyElements[parts[0]]) {
          keyElements[parts[0]] = [];
        }
        keyElements[parts[0]].push(el);
      }
    }
  }

  // Build the mouse schematic from the profile.
  function renderMouse(mouse) {
    mouseEl.innerHTML = '';
    mouseElements = {};
    mouseWheelEl = null;
    counterElements = {};

    if (!mouse.enabled) {
      mouseEl.hidden = true;
      return;
    }
    mouseEl.hidden = false;

    const body = document.createElement('div');
    body.className = 'mouse-body';

    const buttons = mouse.buttons;

    if (buttons.lmb.show) {
      const lmb = document.createElement('div');
      lmb.className = 'mouse-btn lmb';
      body.appendChild(lmb);
      mouseElements.lmb = lmb;
    }
    if (buttons.rmb.show) {
      const rmb = document.createElement('div');
      rmb.className = 'mouse-btn rmb';
      body.appendChild(rmb);
      mouseElements.rmb = rmb;
    }
    if (buttons.mmb.show || mouse.scroll) {
      const wheel = document.createElement('div');
      wheel.className = 'mouse-wheel';
      body.appendChild(wheel);
      mouseWheelEl = wheel;
      if (buttons.mmb.show) {
        mouseElements.mmb = wheel;
      }
    }
    if (buttons.m4.show) {
      const m4 = document.createElement('div');
      m4.className = 'mouse-side m4';
      body.appendChild(m4);
      mouseElements.m4 = m4;
    }
    if (buttons.m5.show) {
      const m5 = document.createElement('div');
      m5.className = 'mouse-side m5';
      body.appendChild(m5);
      mouseElements.m5 = m5;
    }

    mouseEl.appendChild(body);

    // Build click counters for any button that has its counter enabled.
    const counterNames = ['lmb', 'rmb', 'mmb', 'm4', 'm5'];
    const enabledCounters = counterNames.filter((n) => buttons[n].show && buttons[n].counter);
    if (enabledCounters.length > 0) {
      const wrap = document.createElement('div');
      wrap.className = 'mouse-counters';
      for (const name of enabledCounters) {
        const row = document.createElement('div');
        row.className = 'mouse-counter';
        const label = document.createElement('span');
        label.className = 'label';
        label.textContent = name.toUpperCase();
        const value = document.createElement('span');
        value.className = 'value';
        value.textContent = '0';
        row.appendChild(label);
        row.appendChild(value);
        wrap.appendChild(row);
        counterElements[name] = value;
        if (clickCounts[name] === undefined) {
          clickCounts[name] = 0;
        }
      }
      mouseEl.appendChild(wrap);
    }
  }

  // Show or hide the KPS counter based on the profile.
  function renderKps(counters) {
    if (counters.kps) {
      kpsEl.hidden = false;
      kpsEl.innerHTML = '<span class="value">0</span> <span>KPS</span>';
    } else {
      kpsEl.hidden = true;
    }
  }

  // Render the entire active profile.
  function renderProfile(p) {
    profile = p;
    applyTheme(p.theme);
    renderKeyboard(p.keyboard);
    renderMouse(p.mouse);
    renderKps(p.counters);
  }

  // Key press handling. Ignores OS auto-repeat by checking existing state.
  function onKeyDown(name) {
    const els = keyElements[name];
    if (!els) {
      return;
    }

    // KPS uses keydown timestamps only. Push the time and rely on trimming.
    kpsTimestamps.push(Date.now());

    if (keyState[name] && keyState[name].down) {
      // Already down (auto-repeat). Do not restart timers.
      return;
    }

    const state = { down: true, downAt: Date.now(), holdTimer: null };
    state.holdTimer = setTimeout(() => {
      for (const el of els) {
        el.classList.add('held');
      }
    }, HOLD_THRESHOLD_MS);
    keyState[name] = state;

    for (const el of els) {
      el.classList.add('pressed');
    }
  }

  function onKeyUp(name) {
    const els = keyElements[name];
    if (!els) {
      return;
    }
    const state = keyState[name];
    if (!state || !state.down) {
      return;
    }
    clearTimeout(state.holdTimer);
    state.down = false;

    const elapsed = Date.now() - state.downAt;
    const release = () => {
      for (const el of els) {
        el.classList.remove('pressed', 'held');
      }
    };

    if (elapsed < MIN_FLASH_MS) {
      // Very fast tap. Keep it lit briefly so it stays visible on stream.
      setTimeout(release, MIN_FLASH_MS - elapsed);
    } else {
      release();
    }
  }

  function onMouseDown(button) {
    // Update the click counter if one is tracked for this button. Counter is an
    // in-memory integer only.
    if (clickCounts[button] !== undefined) {
      clickCounts[button] += 1;
      if (counterElements[button]) {
        counterElements[button].textContent = String(clickCounts[button]);
      }
    }
    const el = mouseElements[button];
    if (el) {
      el.classList.add('active');
    }
  }

  function onMouseUp(button) {
    const el = mouseElements[button];
    if (el) {
      el.classList.remove('active');
    }
  }

  function onWheel(direction) {
    if (!mouseWheelEl) {
      return;
    }
    const cls = direction === 'up' ? 'scroll-up' : 'scroll-down';
    mouseWheelEl.classList.add(cls);
    setTimeout(() => {
      mouseWheelEl.classList.remove(cls);
    }, SCROLL_FLASH_MS);
  }

  // How long a combo success flash stays lit, so a tight hit is clearly visible
  // on stream even though the input itself is a fraction of a second.
  const COMBO_FLASH_MS = 450;

  // Physical key state wrappers. These run for every key event, feed the live
  // physical state used by combos, then defer to the single-key cap handlers.
  function handleKeyDown(name) {
    const wasDown = physicalDown[name] === true;
    physicalDown[name] = true;
    if (!wasDown) {
      // Record the time of a fresh press only, so OS auto-repeat does not skew
      // the combo timing measurement.
      physicalDownAt[name] = Date.now();
      evaluateCombos(name);
    }
    onKeyDown(name);
  }

  function handleKeyUp(name) {
    physicalDown[name] = false;
    onKeyUp(name);
  }

  // Evaluate combo caps after a fresh press of one of their keys. A combo is a
  // success when all of its keys are currently held and the spread between
  // their press times is within the combo's window.
  //
  // An ordered combo additionally requires the keys to be pressed in the listed
  // order, with the last key being the press that completes it. This is the
  // Apex Superglide pattern: jump first, then crouch within the window.
  function evaluateCombos(name) {
    for (const combo of comboCaps) {
      if (!combo.keys.includes(name)) {
        continue;
      }
      const allDown = combo.keys.every((k) => physicalDown[k] === true);
      if (!allDown) {
        continue;
      }

      if (combo.ordered) {
        // The completing press must be the last key in the list.
        if (name !== combo.keys[combo.keys.length - 1]) {
          continue;
        }
        // Each key must have been pressed no earlier than the one before it.
        let inOrder = true;
        for (let i = 1; i < combo.keys.length; i++) {
          if (physicalDownAt[combo.keys[i]] < physicalDownAt[combo.keys[i - 1]]) {
            inOrder = false;
            break;
          }
        }
        if (!inOrder) {
          continue;
        }
        const spread = physicalDownAt[combo.keys[combo.keys.length - 1]] - physicalDownAt[combo.keys[0]];
        if (spread <= combo.window) {
          flashCombo(combo);
        }
      } else {
        const times = combo.keys.map((k) => physicalDownAt[k]);
        const spread = Math.max.apply(null, times) - Math.min.apply(null, times);
        if (spread <= combo.window) {
          flashCombo(combo);
        }
      }
    }
  }

  // Show a brief success highlight on a combo cap.
  function flashCombo(combo) {
    combo.el.classList.add('pressed', 'combo-hit');
    clearTimeout(combo.hitTimer);
    combo.hitTimer = setTimeout(() => {
      combo.el.classList.remove('pressed', 'combo-hit');
    }, COMBO_FLASH_MS);
  }

  // Update the KPS display from the rolling timestamp window.
  function updateKps() {
    if (!profile || !profile.counters.kps) {
      return;
    }
    const cutoff = Date.now() - KPS_WINDOW_MS;
    // Trim old timestamps. This keeps the array bounded to roughly one second
    // of activity and ensures nothing accumulates over time.
    kpsTimestamps = kpsTimestamps.filter((t) => t >= cutoff);
    const valueEl = kpsEl.querySelector('.value');
    if (valueEl) {
      valueEl.textContent = String(kpsTimestamps.length);
    }
  }
  setInterval(updateKps, 100);

  // Dispatch an incoming WebSocket message.
  function handleMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (err) {
      return;
    }

    switch (msg.type) {
      case 'config':
        renderProfile(msg.profile);
        break;
      case 'keydown':
        handleKeyDown(msg.key);
        break;
      case 'keyup':
        handleKeyUp(msg.key);
        break;
      case 'mousedown':
        onMouseDown(msg.button);
        break;
      case 'mouseup':
        onMouseUp(msg.button);
        break;
      case 'wheel':
        onWheel(msg.direction);
        break;
      default:
        break;
    }
    // msg goes out of scope here. No event is stored or logged.
  }

  // WebSocket connection with automatic reconnect. The overlay is served from
  // the same host and port as the WebSocket, so it derives the URL from the
  // page location and never needs a hardcoded address.
  let socket = null;
  let reconnectTimer = null;

  function connect() {
    // Identify this client's role. The Config UI loads this same page in its
    // preview iframe with a "preview" query flag; a real OBS Browser Source
    // loads it without one. This lets the app count real overlay sources for
    // the connection indicator. It carries no input data.
    const params = new URLSearchParams(window.location.search);
    const role = params.has('preview') ? 'preview' : 'overlay';
    const url = 'ws://' + window.location.host + '?role=' + role;
    socket = new WebSocket(url);

    socket.addEventListener('message', (event) => {
      handleMessage(event.data);
    });

    socket.addEventListener('close', () => {
      // Connection dropped (app restarted, port changed, etc.). Retry shortly.
      scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      // Let the close handler drive the reconnect.
      socket.close();
    });
  }

  function scheduleReconnect() {
    if (reconnectTimer) {
      return;
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 1000);
  }

  connect();
})();
