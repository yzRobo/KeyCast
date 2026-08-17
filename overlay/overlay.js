// overlay.js
//
// WebSocket client and real-time renderer for the OBS Browser Source.
//
// PRIVACY MODEL:
// This script receives input events over the local WebSocket and turns them
// into visual state. It does not send anything back, does not write to storage
// (no localStorage, no cookies, no fetch to any server), and does not keep an
// event history. The only retained values are the live visual state of each
// key, the in-memory counters, a short rolling window of recent keypress
// timestamps used purely to compute keys-per-second, and the movement
// indicator's current deflection and trail, which are visual positions derived
// from relative deltas (no cursor coordinates ever arrive here). All of this is
// ephemeral and resets when the page reloads.

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
  const stageEl = document.getElementById('stage');
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
  // Movement indicator state. movementConfig holds the active profile's
  // settings, the elements are the pad and its marks, and the vectors are the
  // current and target deflection in unit coordinates (-1..1 on each axis).
  // These are live visual state, not an input history: each incoming delta
  // overwrites the target and is then gone.
  let movementConfig = null;
  let movementEls = null;
  let moveTargetX = 0;
  let moveTargetY = 0;
  let moveCurX = 0;
  let moveCurY = 0;
  let lastMoveAt = 0;
  // Recent marker positions for the trail style. A fixed-length ring of screen
  // offsets inside the pad, not cursor positions and not input data.
  let moveTrail = [];
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
    movementEls = null;
    movementConfig = null;

    if (!mouse.enabled) {
      mouseEl.hidden = true;
      return;
    }
    mouseEl.hidden = false;

    // Position the mouse within the stage from its grid coordinates.
    mouseEl.style.setProperty('--mouse-x', String(mouse.x));
    mouseEl.style.setProperty('--mouse-y', String(mouse.y));

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

    renderMovement(mouse.movement, body);

    // Build click counters for any button that has its counter enabled.
    const counterNames = ['lmb', 'rmb', 'mmb', 'm4', 'm5'];
    const enabledCounters = counterNames.filter((n) => buttons[n].show && buttons[n].counter);
    if (enabledCounters.length > 0) {
      const wrap = document.createElement('div');
      wrap.className = 'mouse-counters';
      for (const name of enabledCounters) {
        // Preserve the running count across re-renders. A config change rebuilds
        // this DOM, but the in-memory count carries over, so seed the display
        // from it rather than resetting the visible number to zero.
        if (clickCounts[name] === undefined) {
          clickCounts[name] = 0;
        }
        const row = document.createElement('div');
        row.className = 'mouse-counter';
        const label = document.createElement('span');
        label.className = 'label';
        label.textContent = name.toUpperCase();
        const value = document.createElement('span');
        value.className = 'value';
        value.textContent = String(clickCounts[name]);
        row.appendChild(label);
        row.appendChild(value);
        wrap.appendChild(row);
        counterElements[name] = value;
      }
      mouseEl.appendChild(wrap);
    }
  }

  // Show or hide the KPS counter based on the profile.
  function renderKps(counters) {
    if (counters.kps) {
      kpsEl.hidden = false;
      kpsEl.innerHTML = '<span class="value">0</span> <span>KPS</span>';
      // Repopulate immediately from the rolling window so a re-render does not
      // flash a stale zero before the next 100ms tick.
      updateKps();
    } else {
      kpsEl.hidden = true;
    }
  }

  // Size the stage to enclose both the keyboard and the mouse. The mouse is
  // absolutely positioned, so it does not stretch the stage on its own; without
  // this the stage stops at the keyboard's bounds and a mouse placed beyond them
  // (the default below-the-keys position, for example) falls outside the render
  // area. Measuring the laid-out elements covers their real size, including the
  // mouse counters and side buttons. KPS, which flows after the stage, then sits
  // below whichever element reaches lowest.
  function sizeStage() {
    // Clear any previous explicit size so the keyboard reports its natural size.
    stageEl.style.width = '';
    stageEl.style.height = '';

    let width = keyboardEl.offsetWidth;
    let height = keyboardEl.offsetHeight;

    if (!mouseEl.hidden) {
      // offsetParent is the stage (position: relative), so these are stage-local.
      width = Math.max(width, mouseEl.offsetLeft + mouseEl.offsetWidth);
      height = Math.max(height, mouseEl.offsetTop + mouseEl.offsetHeight);
    }

    stageEl.style.width = width + 'px';
    stageEl.style.height = height + 'px';
  }

  // Render the entire active profile.
  function renderProfile(p) {
    profile = p;
    applyTheme(p.theme);
    renderKeyboard(p.keyboard);
    renderMouse(p.mouse);
    renderKps(p.counters);
    // Run after the keyboard and mouse exist and the theme sizes are applied, so
    // the measurements reflect the final layout.
    sizeStage();
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

  // --- mouse movement indicator ---
  //
  // The app sends relative deltas, never cursor positions. Each delta is turned
  // into a target deflection, the drawn marker eases toward that target, and the
  // target falls back to centre once deltas stop arriving. Nothing accumulates:
  // a new delta replaces the target rather than adding to a history.

  // How long after the last delta the indicator starts returning to centre.
  const MOVE_IDLE_MS = 60;
  // Per-frame easing toward the target. Higher is snappier, lower is smoother.
  const MOVE_SMOOTHING = 0.3;
  // Below this deflection the indicator is treated as at rest.
  const MOVE_DEADZONE = 0.02;
  // Number of marks in the trail style.
  const TRAIL_LENGTH = 10;

  let moveRaf = null;

  // Build the movement pad for the active style, drawn on the palm area of the
  // mouse body (the space below the buttons and wheel), so the indicator reads
  // as part of the mouse rather than a separate gauge. Returns without creating
  // anything when the indicator is turned off, so it costs nothing when unused.
  function renderMovement(movement, body) {
    const cfg = movement && typeof movement === 'object' ? movement : null;
    stopMovementLoop();

    if (!cfg || !cfg.show) {
      return;
    }

    movementConfig = cfg;
    const style = cfg.style === 'arrow' || cfg.style === 'trail' ? cfg.style : 'dot';

    const pad = document.createElement('div');
    pad.className = 'move-pad style-' + style;

    const els = { style, pad, dot: null, arrow: null, marks: [] };

    if (style === 'arrow') {
      // Drawn in an SVG whose viewBox is centred on the origin, so the rotate
      // and scale below pivot on the pad centre with no extra bookkeeping.
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '-50 -50 100 100');
      svg.setAttribute('class', 'move-arrow');
      const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      const shaft = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      shaft.setAttribute('x1', '0');
      shaft.setAttribute('y1', '0');
      shaft.setAttribute('x2', '30');
      shaft.setAttribute('y2', '0');
      const head = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      head.setAttribute('points', '30,-9 44,0 30,9');
      group.appendChild(shaft);
      group.appendChild(head);
      svg.appendChild(group);
      pad.appendChild(svg);
      els.arrow = group;
      // Visibility is driven on the svg element, because that is where the
      // stylesheet's initial opacity: 0 lives; fading the inner group instead
      // would leave the svg permanently transparent.
      els.arrowSvg = svg;
    } else {
      // Both the dot and the trail draw round marks. The trail adds older marks
      // behind the current one; the dot style has just the one.
      const count = style === 'trail' ? TRAIL_LENGTH : 1;
      for (let i = 0; i < count; i++) {
        const mark = document.createElement('div');
        mark.className = 'move-mark';
        pad.appendChild(mark);
        els.marks.push(mark);
      }
      els.dot = els.marks[els.marks.length - 1];
      els.dot.classList.add('lead');
    }

    body.appendChild(pad);
    movementEls = els;

    // Start from rest so a config change does not fling the marker.
    moveTargetX = 0;
    moveTargetY = 0;
    moveCurX = 0;
    moveCurY = 0;
    moveTrail = [];
    lastMoveAt = 0;
    startMovementLoop();
  }

  // Turn one delta into a target deflection. The delta is read, clamped, and
  // dropped; it is never appended to anything.
  function onMouseMove(dx, dy) {
    if (!movementEls || !movementConfig) {
      return;
    }
    // sensitivity 10 puts a brisk flick (about 100 px between flushes) at full
    // deflection; higher values reach full deflection sooner.
    const gain = movementConfig.sensitivity / 1000;
    let tx = dx * gain;
    let ty = dy * gain;
    const mag = Math.sqrt(tx * tx + ty * ty);
    if (mag > 1) {
      tx /= mag;
      ty /= mag;
    }
    moveTargetX = tx;
    moveTargetY = ty;
    lastMoveAt = Date.now();
  }

  function startMovementLoop() {
    if (moveRaf === null) {
      moveRaf = requestAnimationFrame(movementFrame);
    }
  }

  function stopMovementLoop() {
    if (moveRaf !== null) {
      cancelAnimationFrame(moveRaf);
      moveRaf = null;
    }
  }

  function movementFrame() {
    if (!movementEls) {
      moveRaf = null;
      return;
    }

    // Once deltas stop arriving the mouse is still, so aim for centre.
    if (Date.now() - lastMoveAt > MOVE_IDLE_MS) {
      moveTargetX = 0;
      moveTargetY = 0;
    }

    moveCurX += (moveTargetX - moveCurX) * MOVE_SMOOTHING;
    moveCurY += (moveTargetY - moveCurY) * MOVE_SMOOTHING;

    const mag = Math.min(1, Math.sqrt(moveCurX * moveCurX + moveCurY * moveCurY));
    const active = mag > MOVE_DEADZONE;

    if (movementEls.style === 'arrow') {
      if (active) {
        const angle = Math.atan2(moveCurY, moveCurX) * 180 / Math.PI;
        const scale = 0.4 + 0.6 * mag;
        movementEls.arrow.setAttribute('transform', 'rotate(' + angle.toFixed(1) + ') scale(' + scale.toFixed(3) + ')');
        movementEls.arrowSvg.style.opacity = String(0.25 + 0.75 * mag);
      } else {
        movementEls.arrowSvg.style.opacity = '0';
      }
    } else if (movementEls.style === 'trail') {
      moveTrail.push({ x: moveCurX, y: moveCurY });
      while (moveTrail.length > TRAIL_LENGTH) {
        moveTrail.shift();
      }
      // Oldest mark first, so the last element in the pool is always the
      // current position and keeps the brightest treatment.
      const offset = TRAIL_LENGTH - moveTrail.length;
      for (let i = 0; i < TRAIL_LENGTH; i++) {
        const mark = movementEls.marks[i];
        const point = moveTrail[i - offset];
        if (!point) {
          mark.style.opacity = '0';
          continue;
        }
        setMarkPosition(mark, point.x, point.y);
        // Fade from the oldest mark to the current one.
        const age = (i + 1) / TRAIL_LENGTH;
        mark.style.opacity = String((0.05 + 0.95 * age * age) * (0.35 + 0.65 * mag));
      }
    } else {
      const mark = movementEls.dot;
      setMarkPosition(mark, moveCurX, moveCurY);
      mark.style.opacity = String(0.35 + 0.65 * mag);
    }

    moveRaf = requestAnimationFrame(movementFrame);
  }

  // Place a mark inside the pad. The two custom properties are unit-less
  // multipliers the stylesheet turns into a distance from the pad centre, so the
  // indicator scales with the theme's key size without any pixel maths here.
  function setMarkPosition(mark, x, y) {
    mark.style.setProperty('--mx', x.toFixed(4));
    mark.style.setProperty('--my', y.toFixed(4));
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
      case 'mousemove':
        // A relative delta only. It sets the indicator's target and is then
        // gone; no position is reconstructed or kept.
        onMouseMove(msg.dx, msg.dy);
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
