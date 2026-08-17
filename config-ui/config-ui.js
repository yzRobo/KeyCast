// config-ui.js
//
// Logic for the configuration window: profile management, every settings
// control, the OBS URL helpers, and the live preview.
//
// PRIVACY MODEL:
// This window reads and writes config.json (through the main process) and shows
// a live preview. The preview is the real overlay loaded in an iframe; it
// reacts to live input but records nothing. This script keeps a config object
// in memory and a status WebSocket whose only purpose is the connection
// indicator. No input data is stored or logged here.

(function () {
  'use strict';

  const api = window.keycast;

  // Color fields rendered into the theme section, keyed by theme property name.
  const COLOR_FIELDS = [
    'keyIdle', 'keyPressed', 'keyHeld',
    'textIdle', 'textPressed', 'borderIdle', 'borderPressed'
  ];

  // Theme preset colors. Kept in sync with src/config.js. Selecting a preset
  // copies these into the active profile, after which any value can be tweaked.
  const THEME_PRESETS = {
    'minimal-dark': {
      keyIdle: '#1c1c1c', keyPressed: '#ffffff', keyHeld: '#e0e0e0',
      textIdle: '#555555', textPressed: '#111111',
      borderIdle: '#2e2e2e', borderPressed: '#ffffff'
    },
    'minimal-light': {
      keyIdle: '#f0f0f0', keyPressed: '#111111', keyHeld: '#cccccc',
      textIdle: '#aaaaaa', textPressed: '#ffffff',
      borderIdle: '#dddddd', borderPressed: '#111111'
    },
    'subtle-glow': {
      keyIdle: '#1c1c1c', keyPressed: '#ffffff', keyHeld: '#e0e0e0',
      textIdle: '#555555', textPressed: '#111111',
      borderIdle: '#2e2e2e', borderPressed: '#ffffff'
    }
  };

  let config = null;
  let activeId = null;
  let saveTimer = null;
  let statusSocket = null;
  let statusReconnect = null;
  // Indices of the keys currently selected in the visual layout editor. More
  // than one can be selected at a time by rubber-band dragging or shift-click.
  let selectedKeyIndices = new Set();
  // Live references to the editor's key box elements, indexed to match the keys
  // array, so a drag can reposition them without rebuilding the DOM.
  let leBoxes = [];

  // Visual layout editor geometry. CELL is the on-screen size of one grid cell,
  // GAP the space between cells, PAD the inner padding of the editor surface.
  // These are display-only values and do not change the overlay; the overlay
  // uses the key size from the theme.
  const LE_CELL = 46;
  const LE_GAP = 6;
  const LE_PAD = 10;
  const LE_PITCH = LE_CELL + LE_GAP;
  // Mouse footprint in editor cells, matching the overlay mouse proportions
  // (1.6 key-widths wide, 2.4 tall) so the editor preview reflects its real size.
  const LE_MOUSE_W = 1.6;
  const LE_MOUSE_H = 2.4;

  // --- element references ---
  const el = (id) => document.getElementById(id);
  const profileSelect = el('profileSelect');

  function activeProfile() {
    return config.profiles.list[activeId];
  }

  // Persist the current config. Validation happens in the main process, which
  // also rebroadcasts the active profile to the live preview. Debounced so that
  // dragging a slider does not write on every pixel.
  function scheduleSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      await api.saveConfig(config);
    }, 120);
  }

  // --- profile selector ---
  function rebuildProfileOptions() {
    profileSelect.innerHTML = '';
    const ids = Object.keys(config.profiles.list);
    for (const id of ids) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = config.profiles.list[id].name;
      profileSelect.appendChild(opt);
    }
    profileSelect.value = activeId;
  }

  // --- color fields ---
  function buildColorFields() {
    const containers = document.querySelectorAll('.color-field');
    containers.forEach((container) => {
      const name = container.getAttribute('data-color');
      container.innerHTML = '';

      const swatch = document.createElement('span');
      swatch.className = 'color-swatch';
      const input = document.createElement('input');
      input.type = 'color';
      swatch.appendChild(input);

      const hex = document.createElement('span');
      hex.className = 'color-hex';

      container.appendChild(swatch);
      container.appendChild(hex);

      input.addEventListener('input', () => {
        activeProfile().theme[name] = input.value;
        hex.textContent = input.value;
        scheduleSave();
      });

      container._colorInput = input;
      container._hexLabel = hex;
      container._name = name;
    });
  }

  function refreshColorFields() {
    const theme = activeProfile().theme;
    document.querySelectorAll('.color-field').forEach((container) => {
      const name = container._name;
      container._colorInput.value = theme[name];
      container._hexLabel.textContent = theme[name];
    });
  }

  // --- visual layout editor (drag to move, drag edge to resize) ---
  function keySpan(entry) {
    return entry.span && entry.span > 1 ? entry.span : 1;
  }

  // Two keys collide when they sit on the same row and their column ranges
  // overlap. Keys are one cell tall; span only widens them horizontally.
  function keysOverlap(a, b) {
    const as = keySpan(a);
    const bs = keySpan(b);
    return a.y === b.y && a.x < b.x + bs && b.x < a.x + as;
  }

  // Resolve overlaps by bumping keys down a row. Keys whose indices are in the
  // fixed set (the ones being dragged or resized) stay put; anything they land
  // on is pushed down, cascading until nothing overlaps. Always moving down and
  // the iteration guard keep this from looping forever.
  function resolveCollisions(fixed) {
    const keys = activeProfile().keyboard.keys;
    let moved = true;
    let guard = 0;
    while (moved && guard < 2000) {
      moved = false;
      guard += 1;
      for (let i = 0; i < keys.length; i++) {
        for (let j = i + 1; j < keys.length; j++) {
          if (!keysOverlap(keys[i], keys[j])) {
            continue;
          }
          const iFixed = fixed.has(i);
          const jFixed = fixed.has(j);
          let push;
          if (iFixed && !jFixed) {
            push = j;
          } else if (!iFixed && jFixed) {
            push = i;
          } else if (iFixed && jFixed) {
            // Both are being dragged together. They keep their relative spacing,
            // so this should not happen; leave them rather than fight the drag.
            push = -1;
          } else {
            push = j;
          }
          if (push >= 0) {
            keys[push].y += 1;
            moved = true;
          }
        }
      }
    }
  }

  // Update the on-screen position and width of every key box from the current
  // key data, without rebuilding the DOM. Used during a drag so collision
  // bumping is visible live.
  function repositionBoxes() {
    const keys = activeProfile().keyboard.keys;
    keys.forEach((entry, i) => {
      const box = leBoxes[i];
      if (!box) {
        return;
      }
      const span = keySpan(entry);
      box.style.left = (LE_PAD + entry.x * LE_PITCH) + 'px';
      box.style.top = (LE_PAD + entry.y * LE_PITCH) + 'px';
      box.style.width = (span * LE_CELL + (span - 1) * LE_GAP) + 'px';
    });
  }

  function highlightSelection() {
    leBoxes.forEach((box, i) => {
      if (box) {
        box.classList.toggle('selected', selectedKeyIndices.has(i));
      }
    });
  }

  function renderLayoutEditor() {
    const editor = el('layoutEditor');
    editor.innerHTML = '';
    leBoxes = [];
    const kb = activeProfile().keyboard;
    const keys = kb.keys;
    const mouse = activeProfile().mouse;

    // The editor is usable when either the keyboard or the mouse is on, so the
    // mouse can still be positioned with the keyboard hidden.
    editor.classList.toggle('disabled', !(kb.enabled || mouse.enabled));

    // Drop any selected indices that no longer exist.
    selectedKeyIndices.forEach((i) => {
      if (i >= keys.length) {
        selectedKeyIndices.delete(i);
      }
    });

    // Bind the rubber-band selection handler once. It fires only on empty editor
    // space, because key boxes stop the event from reaching here.
    if (!editor._bgBound) {
      editor.addEventListener('pointerdown', (e) => {
        if (!activeProfile().keyboard.enabled) {
          return;
        }
        e.preventDefault();
        startMarquee(e);
      });
      editor._bgBound = true;
    }

    // Size the grid to fit the keys, with a little spare room to drag into.
    let maxCol = 6;
    let maxRow = 4;
    keys.forEach((entry) => {
      maxCol = Math.max(maxCol, entry.x + keySpan(entry));
      maxRow = Math.max(maxRow, entry.y + 1);
    });
    if (mouse.enabled) {
      maxCol = Math.max(maxCol, Math.ceil(mouse.x + LE_MOUSE_W));
      maxRow = Math.max(maxRow, Math.ceil(mouse.y + LE_MOUSE_H));
    }
    maxCol += 1;
    maxRow += 1;

    editor.style.setProperty('--pitch', LE_PITCH + 'px');
    editor.style.setProperty('--pad', LE_PAD + 'px');
    editor.style.width = (LE_PAD * 2 + maxCol * LE_PITCH - LE_GAP) + 'px';
    editor.style.height = (LE_PAD * 2 + maxRow * LE_PITCH - LE_GAP) + 'px';

    keys.forEach((entry, index) => {
      const span = keySpan(entry);
      const box = document.createElement('div');
      box.className = 'le-key' + (selectedKeyIndices.has(index) ? ' selected' : '');
      box.style.left = (LE_PAD + entry.x * LE_PITCH) + 'px';
      box.style.top = (LE_PAD + entry.y * LE_PITCH) + 'px';
      box.style.width = (span * LE_CELL + (span - 1) * LE_GAP) + 'px';
      box.style.height = LE_CELL + 'px';

      const label = document.createElement('span');
      label.className = 'le-key-label';
      label.textContent = entry.label || entry.key || '?';
      box.appendChild(label);

      const handle = document.createElement('div');
      handle.className = 'le-handle';
      handle.title = 'Drag to change width';
      box.appendChild(handle);

      box.addEventListener('pointerdown', (e) => {
        if (e.target === handle) {
          return;
        }
        e.preventDefault();
        // Do not let this reach the editor background (rubber-band) handler.
        e.stopPropagation();

        if (e.shiftKey) {
          // Shift-click toggles this key in the selection without dragging.
          if (selectedKeyIndices.has(index)) {
            selectedKeyIndices.delete(index);
          } else {
            selectedKeyIndices.add(index);
          }
          highlightSelection();
          return;
        }

        startGroupMove(e, index);
      });

      handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        selectedKeyIndices = new Set([index]);
        highlightSelection();
        startResize(e, index, box);
      });

      editor.appendChild(box);
      leBoxes[index] = box;
    });

    // The mouse schematic is draggable in the same space as the keys. It is not
    // part of the keys array, so it is rendered and dragged on its own and may
    // overlap keys by design.
    if (mouse.enabled) {
      const mbox = document.createElement('div');
      mbox.className = 'le-mouse';
      mbox.title = 'Drag to move the mouse overlay';
      mbox.style.left = (LE_PAD + mouse.x * LE_PITCH) + 'px';
      mbox.style.top = (LE_PAD + mouse.y * LE_PITCH) + 'px';
      mbox.style.width = (LE_MOUSE_W * LE_CELL) + 'px';
      mbox.style.height = (LE_MOUSE_H * LE_CELL) + 'px';

      const mlabel = document.createElement('span');
      mlabel.className = 'le-mouse-label';
      mlabel.textContent = 'MOUSE';
      mbox.appendChild(mlabel);

      mbox.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        // Keep the editor background (rubber-band) handler from firing.
        e.stopPropagation();
        startMouseMove(e, mbox);
      });

      editor.appendChild(mbox);
    }
  }

  // Move the mouse schematic. It is independent of the keys, so it has its own
  // whole-cell drag that updates the mouse x/y. It does not run collision
  // resolution; the mouse is free to sit anywhere, including over keys.
  function startMouseMove(e, box) {
    const mouse = activeProfile().mouse;
    const startPX = e.clientX;
    const startPY = e.clientY;
    const x0 = mouse.x;
    const y0 = mouse.y;
    box.classList.add('dragging');

    const move = (ev) => {
      const dx = Math.round((ev.clientX - startPX) / LE_PITCH);
      const dy = Math.round((ev.clientY - startPY) / LE_PITCH);
      mouse.x = Math.max(0, x0 + dx);
      mouse.y = Math.max(0, y0 + dy);
      box.style.left = (LE_PAD + mouse.x * LE_PITCH) + 'px';
      box.style.top = (LE_PAD + mouse.y * LE_PITCH) + 'px';
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      renderLayoutEditor();
      populateMousePosition();
      scheduleSave();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // Move one or more keys. If the pressed key is not already part of the
  // selection, it becomes the sole selection. All selected keys move together by
  // the same whole-cell delta, and anything they overlap is bumped down a row.
  function startGroupMove(e, anchorIndex) {
    const keys = activeProfile().keyboard.keys;
    if (!selectedKeyIndices.has(anchorIndex)) {
      selectedKeyIndices = new Set([anchorIndex]);
      highlightSelection();
    }

    const fixed = new Set(selectedKeyIndices);
    const starts = [];
    fixed.forEach((i) => starts.push({ i: i, x0: keys[i].x, y0: keys[i].y }));
    const minX0 = Math.min.apply(null, starts.map((s) => s.x0));
    const minY0 = Math.min.apply(null, starts.map((s) => s.y0));

    const startPX = e.clientX;
    const startPY = e.clientY;
    fixed.forEach((i) => leBoxes[i] && leBoxes[i].classList.add('dragging'));

    const move = (ev) => {
      const dx = Math.round((ev.clientX - startPX) / LE_PITCH);
      const dy = Math.round((ev.clientY - startPY) / LE_PITCH);
      // Clamp the shift so no selected key crosses the top or left edge while
      // keeping the group's relative spacing.
      const sx = Math.max(dx, -minX0);
      const sy = Math.max(dy, -minY0);
      starts.forEach((s) => {
        keys[s.i].x = s.x0 + sx;
        keys[s.i].y = s.y0 + sy;
      });
      resolveCollisions(fixed);
      repositionBoxes();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      renderLayoutEditor();
      renderKeyList();
      scheduleSave();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // Drag the right edge of a key to change its span (width in cells). Widening
  // onto a neighbour bumps the neighbour down.
  function startResize(e, index, box) {
    const keys = activeProfile().keyboard.keys;
    const entry = keys[index];
    const startPX = e.clientX;
    const startSpan = keySpan(entry);
    box.classList.add('resizing');

    const move = (ev) => {
      const d = Math.round((ev.clientX - startPX) / LE_PITCH);
      const span = Math.min(12, Math.max(1, startSpan + d));
      if (span > 1) {
        entry.span = span;
      } else {
        delete entry.span;
      }
      resolveCollisions(new Set([index]));
      repositionBoxes();
    };
    const up = () => {
      box.classList.remove('resizing');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      renderLayoutEditor();
      renderKeyList();
      scheduleSave();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // Rubber-band selection. Dragging on empty editor space draws a rectangle and
  // selects every key it touches. A plain click on empty space clears the
  // selection.
  function startMarquee(e) {
    const editor = el('layoutEditor');
    const rect = editor.getBoundingClientRect();
    const startX = e.clientX - rect.left + editor.scrollLeft;
    const startY = e.clientY - rect.top + editor.scrollTop;

    const marquee = document.createElement('div');
    marquee.className = 'le-marquee';
    editor.appendChild(marquee);

    let moved = false;
    let pending = new Set();

    const move = (ev) => {
      const curX = ev.clientX - rect.left + editor.scrollLeft;
      const curY = ev.clientY - rect.top + editor.scrollTop;
      const x = Math.min(startX, curX);
      const y = Math.min(startY, curY);
      const w = Math.abs(curX - startX);
      const h = Math.abs(curY - startY);
      if (w > 3 || h > 3) {
        moved = true;
      }
      marquee.style.left = x + 'px';
      marquee.style.top = y + 'px';
      marquee.style.width = w + 'px';
      marquee.style.height = h + 'px';

      pending = new Set();
      leBoxes.forEach((box, i) => {
        if (!box) {
          return;
        }
        const hit = box.offsetLeft < x + w && x < box.offsetLeft + box.offsetWidth &&
          box.offsetTop < y + h && y < box.offsetTop + box.offsetHeight;
        box.classList.toggle('selected', hit);
        if (hit) {
          pending.add(i);
        }
      });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      marquee.remove();
      if (moved) {
        selectedKeyIndices = pending;
      } else {
        // Plain click on empty space clears the selection.
        selectedKeyIndices = new Set();
      }
      highlightSelection();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // --- Superglide preset section ---
  function renderSuperglide() {
    const sg = findSuperglide();
    el('sgEnabled').checked = !!sg;
    el('sgFields').hidden = !sg;
    if (sg) {
      const parts = comboParts(sg.key);
      el('sgKey1').value = parts[0] || '';
      el('sgKey2').value = parts[1] || '';
      el('sgWindow').value = typeof sg.window === 'number' ? sg.window : 33;
    }
  }

  // Rebuild the Superglide key string from the two key boxes, in order.
  function updateSuperglideKeys() {
    const sg = findSuperglide();
    if (!sg) {
      return;
    }
    const first = el('sgKey1').value.trim().toLowerCase();
    const second = el('sgKey2').value.trim().toLowerCase();
    // Keep both in order. If one is missing the cap simply will not trigger
    // until both are filled in.
    sg.key = [first, second].filter(Boolean).join('+');
    renderKeyList();
    renderLayoutEditor();
    scheduleSave();
  }

  // --- key layout editor (numeric list) ---
  function renderKeyList() {
    const list = el('keyList');
    list.innerHTML = '';
    const keys = activeProfile().keyboard.keys;

    keys.forEach((entry, index) => {
      // The Superglide combo is edited in its own section, not in this list, so
      // it is not shown here. The array index is preserved for the other rows.
      if (entry.ordered === true) {
        return;
      }

      const row = document.createElement('div');
      row.className = 'key-row';

      const keyInput = makeMiniInput('text', entry.key);
      keyInput.addEventListener('input', () => {
        entry.key = keyInput.value.trim().toLowerCase();
        // Becoming or ceasing to be a combo changes whether the timing field
        // applies, so refresh the row and its enabled state.
        syncComboField();
        renderLayoutEditor();
        scheduleSave();
      });

      const labelInput = makeMiniInput('text', entry.label);
      labelInput.addEventListener('input', () => {
        entry.label = labelInput.value;
        renderLayoutEditor();
        scheduleSave();
      });

      const xInput = makeMiniInput('number', entry.x);
      xInput.addEventListener('input', () => {
        entry.x = clampInt(xInput.value, 0, 64, 0);
        renderLayoutEditor();
        scheduleSave();
      });

      const yInput = makeMiniInput('number', entry.y);
      yInput.addEventListener('input', () => {
        entry.y = clampInt(yInput.value, 0, 64, 0);
        renderLayoutEditor();
        scheduleSave();
      });

      const spanInput = makeMiniInput('number', entry.span || 1);
      spanInput.addEventListener('input', () => {
        const span = clampInt(spanInput.value, 1, 12, 1);
        if (span > 1) {
          entry.span = span;
        } else {
          delete entry.span;
        }
        renderLayoutEditor();
        scheduleSave();
      });

      // Combo timing window in milliseconds. Only applies when the Key field is
      // a combo (contains a plus sign). Disabled and blank otherwise.
      const windowInput = makeMiniInput('number', entry.window || '');
      windowInput.min = '1';
      windowInput.max = '2000';
      windowInput.title = 'Combo timing window in milliseconds';
      windowInput.addEventListener('input', () => {
        if (isComboKey(entry.key)) {
          entry.window = clampInt(windowInput.value, 1, 2000, 50);
        } else {
          delete entry.window;
        }
        scheduleSave();
      });

      const syncComboField = () => {
        const combo = isComboKey(entry.key);
        windowInput.disabled = !combo;
        if (combo) {
          if (typeof entry.window !== 'number') {
            entry.window = 50;
          }
          windowInput.value = entry.window;
          windowInput.placeholder = '';
        } else {
          delete entry.window;
          windowInput.value = '';
          windowInput.placeholder = '-';
        }
      };
      syncComboField();

      const remove = document.createElement('button');
      remove.className = 'key-remove';
      remove.textContent = 'x';
      remove.title = 'Remove key';
      remove.addEventListener('click', () => {
        keys.splice(index, 1);
        // Removing a key shifts every later index, so clear the selection rather
        // than try to remap it.
        selectedKeyIndices = new Set();
        renderKeyList();
        renderLayoutEditor();
        scheduleSave();
      });

      row.appendChild(keyInput);
      row.appendChild(labelInput);
      row.appendChild(xInput);
      row.appendChild(yInput);
      row.appendChild(spanInput);
      row.appendChild(windowInput);
      row.appendChild(remove);
      list.appendChild(row);
    });
  }

  function makeMiniInput(type, value) {
    const input = document.createElement('input');
    input.type = type;
    input.className = 'mini-input';
    input.value = value;
    if (type === 'number') {
      input.min = '0';
    }
    return input;
  }

  // Split a key string into its parts. A combo joins keys with a plus sign.
  function comboParts(keyString) {
    return (keyString || '').split('+').map((s) => s.trim()).filter(Boolean);
  }

  // A key is a combo when it joins two or more keys with a plus sign.
  function isComboKey(keyString) {
    return comboParts(keyString).length > 1;
  }

  // The Superglide is stored as an ordered combo key entry. There is at most
  // one, managed by the dedicated Superglide section.
  function findSuperglide() {
    return activeProfile().keyboard.keys.find((k) => k.ordered === true);
  }

  function clampInt(value, min, max, fallback) {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, n));
  }

  // Reflect the mouse grid position into its numeric inputs.
  function populateMousePosition() {
    const m = activeProfile().mouse;
    if (el('mouseX')) {
      el('mouseX').value = m.x;
    }
    if (el('mouseY')) {
      el('mouseY').value = m.y;
    }
  }

  // Fill the movement indicator controls and show or hide the ones that only
  // apply while the indicator is on. A profile saved by an older KeyCast has no
  // movement block, so fall back to the defaults the main process validates to.
  function renderMovementControls() {
    const movement = activeProfile().mouse.movement || { show: false, style: 'dot', sensitivity: 10 };
    el('mouseMoveShow').checked = movement.show;
    el('mouseMoveStyle').value = movement.style;
    el('sliderMoveSensitivity').value = movement.sensitivity;
    el('valMoveSensitivity').textContent = String(movement.sensitivity);
    el('mouseMoveFields').hidden = !movement.show;
  }

  // Movement settings live under mouse.movement, which older configs lack.
  // Everything that writes one goes through here so the block is created once.
  function movementSettings() {
    const mouse = activeProfile().mouse;
    if (!mouse.movement || typeof mouse.movement !== 'object') {
      mouse.movement = { show: false, style: 'dot', sensitivity: 10 };
    }
    return mouse.movement;
  }

  // --- populate all controls from the active profile ---
  function populate() {
    const p = activeProfile();

    el('kbEnabled').checked = p.keyboard.enabled;
    selectedKeyIndices = new Set();
    renderKeyList();
    renderLayoutEditor();
    renderSuperglide();

    el('mouseEnabled').checked = p.mouse.enabled;
    populateMousePosition();
    el('mouseLmbShow').checked = p.mouse.buttons.lmb.show;
    el('mouseLmbCounter').checked = p.mouse.buttons.lmb.counter;
    el('mouseRmbShow').checked = p.mouse.buttons.rmb.show;
    el('mouseRmbCounter').checked = p.mouse.buttons.rmb.counter;
    el('mouseMmbShow').checked = p.mouse.buttons.mmb.show;
    el('mouseMmbCounter').checked = p.mouse.buttons.mmb.counter;
    el('mouseM4Show').checked = p.mouse.buttons.m4.show;
    el('mouseM4Counter').checked = p.mouse.buttons.m4.counter;
    el('mouseM5Show').checked = p.mouse.buttons.m5.show;
    el('mouseM5Counter').checked = p.mouse.buttons.m5.counter;
    el('mouseScroll').checked = p.mouse.scroll;
    renderMovementControls();

    el('themePreset').value = p.theme.preset;
    refreshColorFields();
    el('themeAnimation').value = p.theme.animation;

    el('sliderKeySize').value = p.theme.keySize;
    el('valKeySize').textContent = p.theme.keySize + 'px';
    el('sliderKeyGap').value = p.theme.keyGap;
    el('valKeyGap').textContent = p.theme.keyGap + 'px';
    el('sliderScale').value = p.theme.scale;
    el('valScale').textContent = Number(p.theme.scale).toFixed(2) + 'x';

    el('kpsToggle').checked = p.counters.kps;

    el('portInput').value = config.server.port;
  }

  // --- bind static controls ---
  function bindControls() {
    profileSelect.addEventListener('change', () => {
      activeId = profileSelect.value;
      config.profiles.active = activeId;
      populate();
      scheduleSave();
    });

    el('profileAdd').addEventListener('click', onAddProfile);
    el('profileRename').addEventListener('click', onRenameProfile);
    el('profileDuplicate').addEventListener('click', onDuplicateProfile);
    el('profileDelete').addEventListener('click', onDeleteProfile);

    el('kbEnabled').addEventListener('change', (e) => {
      activeProfile().keyboard.enabled = e.target.checked;
      renderLayoutEditor();
      scheduleSave();
    });
    el('keyAdd').addEventListener('click', () => {
      const keys = activeProfile().keyboard.keys;
      // Place the new key just below the lowest existing row so it lands in an
      // empty spot, ready to drag into position.
      const nextRow = keys.reduce((max, k) => Math.max(max, k.y + 1), 0);
      keys.push({ key: '', label: 'NEW', x: 0, y: nextRow });
      selectedKeyIndices = new Set([keys.length - 1]);
      renderKeyList();
      renderLayoutEditor();
      scheduleSave();
    });

    // Superglide preset controls.
    el('sgEnabled').addEventListener('change', (e) => {
      const keys = activeProfile().keyboard.keys;
      if (e.target.checked) {
        if (!findSuperglide()) {
          const nextRow = keys.reduce((max, k) => Math.max(max, k.y + 1), 0);
          // Defaults: jump (space) then crouch (ctrl), within 33 ms. The user
          // changes the two keys and the window to match their setup and FPS.
          keys.push({
            key: 'space+ctrl',
            label: 'SUPERGLIDE',
            ordered: true,
            window: 33,
            x: 0,
            y: nextRow
          });
        }
      } else {
        const index = keys.findIndex((k) => k.ordered === true);
        if (index >= 0) {
          keys.splice(index, 1);
        }
      }
      renderSuperglide();
      renderKeyList();
      renderLayoutEditor();
      scheduleSave();
    });

    el('sgKey1').addEventListener('input', updateSuperglideKeys);
    el('sgKey2').addEventListener('input', updateSuperglideKeys);
    el('sgWindow').addEventListener('input', () => {
      const sg = findSuperglide();
      if (sg) {
        sg.window = clampInt(el('sgWindow').value, 1, 2000, 33);
        scheduleSave();
      }
    });

    // Toggling the mouse also re-renders the editor so its draggable box appears
    // or disappears.
    el('mouseEnabled').addEventListener('change', (e) => {
      activeProfile().mouse.enabled = e.target.checked;
      renderLayoutEditor();
      scheduleSave();
    });
    el('mouseX').addEventListener('input', () => {
      activeProfile().mouse.x = clampInt(el('mouseX').value, 0, 64, 0);
      renderLayoutEditor();
      scheduleSave();
    });
    el('mouseY').addEventListener('input', () => {
      activeProfile().mouse.y = clampInt(el('mouseY').value, 0, 64, 0);
      renderLayoutEditor();
      scheduleSave();
    });
    bindMouseToggle('mouseLmbShow', (p, v) => { p.mouse.buttons.lmb.show = v; });
    bindMouseToggle('mouseLmbCounter', (p, v) => { p.mouse.buttons.lmb.counter = v; });
    bindMouseToggle('mouseRmbShow', (p, v) => { p.mouse.buttons.rmb.show = v; });
    bindMouseToggle('mouseRmbCounter', (p, v) => { p.mouse.buttons.rmb.counter = v; });
    bindMouseToggle('mouseMmbShow', (p, v) => { p.mouse.buttons.mmb.show = v; });
    bindMouseToggle('mouseMmbCounter', (p, v) => { p.mouse.buttons.mmb.counter = v; });
    bindMouseToggle('mouseM4Show', (p, v) => { p.mouse.buttons.m4.show = v; });
    bindMouseToggle('mouseM4Counter', (p, v) => { p.mouse.buttons.m4.counter = v; });
    bindMouseToggle('mouseM5Show', (p, v) => { p.mouse.buttons.m5.show = v; });
    bindMouseToggle('mouseM5Counter', (p, v) => { p.mouse.buttons.m5.counter = v; });
    bindMouseToggle('mouseScroll', (p, v) => { p.mouse.scroll = v; });

    // Movement indicator. Turning it on is what makes the main process attach
    // the cursor hook, so this toggle is the whole opt-in.
    el('mouseMoveShow').addEventListener('change', (e) => {
      movementSettings().show = e.target.checked;
      el('mouseMoveFields').hidden = !e.target.checked;
      scheduleSave();
    });
    el('mouseMoveStyle').addEventListener('change', (e) => {
      movementSettings().style = e.target.value;
      scheduleSave();
    });
    el('sliderMoveSensitivity').addEventListener('input', (e) => {
      const value = clampInt(e.target.value, 1, 30, 10);
      movementSettings().sensitivity = value;
      el('valMoveSensitivity').textContent = String(value);
      scheduleSave();
    });

    el('themePreset').addEventListener('change', (e) => {
      const preset = e.target.value;
      activeProfile().theme.preset = preset;
      // Applying a preset copies its colors into the profile. The user can then
      // override any individual color.
      const colors = THEME_PRESETS[preset];
      if (colors) {
        Object.assign(activeProfile().theme, colors);
        refreshColorFields();
      }
      scheduleSave();
    });

    el('themeAnimation').addEventListener('change', (e) => {
      activeProfile().theme.animation = e.target.value;
      scheduleSave();
    });

    bindSlider('sliderKeySize', 'valKeySize', (p, v) => { p.theme.keySize = v; }, (v) => v + 'px', true);
    bindSlider('sliderKeyGap', 'valKeyGap', (p, v) => { p.theme.keyGap = v; }, (v) => v + 'px', true);
    bindSlider('sliderScale', 'valScale', (p, v) => { p.theme.scale = v; }, (v) => Number(v).toFixed(2) + 'x', false);

    el('kpsToggle').addEventListener('change', (e) => {
      activeProfile().counters.kps = e.target.checked;
      scheduleSave();
    });

    el('portInput').addEventListener('change', async (e) => {
      const port = clampInt(e.target.value, 1, 65535, 8765);
      e.target.value = port;
      config.server.port = port;
      await api.saveConfig(config);
      // The server restarts on the new port. Refresh the URLs and reload the
      // preview so it reconnects to the new address, and re-read the server
      // state straight away so a port that is also taken says so immediately
      // rather than after the next poll.
      await loadUrls();
      reloadPreview();
      reconnectStatus();
      pollSources();
    });

    el('copyLocalhost').addEventListener('click', () => copyText(el('urlLocalhost').textContent));
    el('copyLan').addEventListener('click', () => copyText(el('urlLan').textContent));
    el('copyTest').addEventListener('click', () => copyText(el('urlTest').textContent));

    // Choosing a network adapter saves the address and refreshes the LAN URL.
    // An empty value (no adapters) clears the choice back to auto-pick.
    el('lanAdapter').addEventListener('change', async () => {
      config.server.lanAddress = el('lanAdapter').value || null;
      await api.saveConfig(config);
      await loadUrls();
    });

    el('fixFirewall').addEventListener('click', async () => {
      if (!api.fixFirewall) {
        // The handler is loaded at app startup. If it is missing, the app is
        // running older code and needs a full restart (quit from the tray).
        showToast('Restart KeyCast (quit from the tray) to enable this button.');
        return;
      }
      try {
        const result = await api.fixFirewall();
        if (result && result.started) {
          showToast('Approve the Windows prompt to allow the connection.');
        } else {
          showToast((result && result.reason) || 'Could not start the firewall helper.');
        }
      } catch (err) {
        showToast('Could not start the firewall helper.');
      }
    });

    el('copyDiagnostics').addEventListener('click', async () => {
      if (!api.getDiagnostics) {
        showToast('Restart KeyCast (quit from the tray) to enable this button.');
        return;
      }
      const button = el('copyDiagnostics');
      const original = button.textContent;
      // Reading the firewall rule list takes a few seconds on some machines, so
      // say something rather than looking frozen.
      button.disabled = true;
      button.textContent = 'Collecting…';
      try {
        const report = await api.getDiagnostics();
        await copyText(report);
      } catch (err) {
        showToast('Could not build the diagnostics report.');
      } finally {
        button.disabled = false;
        button.textContent = original;
      }
    });

    el('updateCheck').addEventListener('click', async () => {
      if (!api.checkForUpdates) {
        showToast('Restart KeyCast (quit from the tray) to enable this button.');
        return;
      }
      // Remember that the user asked, so status events can surface a toast even
      // though the automatic startup check stays silent.
      manualUpdateCheck = true;
      showToast('Checking for updates…');
      setUpdateStatus('Checking for updates…');
      try {
        const result = await api.checkForUpdates();
        // result.started is false when the check could not run at all, e.g. when
        // running from source (updates only work in the installed app).
        if (result && !result.started) {
          manualUpdateCheck = false;
          showToast(result.reason || 'Could not check for updates.');
          setUpdateStatus(result.reason || 'Could not check for updates.');
        }
      } catch (err) {
        manualUpdateCheck = false;
        showToast('Could not check for updates.');
        setUpdateStatus('Could not check for updates.');
      }
    });

    el('updateInstall').addEventListener('click', installDownloadedUpdate);
    el('updateBannerInstall').addEventListener('click', installDownloadedUpdate);
    el('updateBannerDismiss').addEventListener('click', () => {
      updateBannerDismissed = true;
      el('updateBanner').hidden = true;
    });
  }

  async function installDownloadedUpdate() {
    if (!api.installUpdate) {
      return;
    }
    await api.installUpdate();
  }

  function bindMouseToggle(id, apply) {
    el(id).addEventListener('change', (e) => {
      apply(activeProfile(), e.target.checked);
      scheduleSave();
    });
  }

  function bindSlider(sliderId, valueId, apply, format, isInt) {
    const slider = el(sliderId);
    const label = el(valueId);
    slider.addEventListener('input', () => {
      const v = isInt ? parseInt(slider.value, 10) : parseFloat(slider.value);
      apply(activeProfile(), v);
      label.textContent = format(v);
      scheduleSave();
    });
  }

  // --- profile actions ---
  function makeProfileId() {
    let n = 1;
    while (config.profiles.list['profile-' + n]) {
      n += 1;
    }
    return 'profile-' + n;
  }

  async function onAddProfile() {
    const name = await promptName('New profile', 'New Profile');
    if (name === null) {
      return;
    }
    const id = makeProfileId();
    const fresh = await api.getDefaultProfile();
    fresh.name = name || 'New Profile';
    config.profiles.list[id] = fresh;
    activeId = id;
    config.profiles.active = id;
    rebuildProfileOptions();
    populate();
    scheduleSave();
  }

  async function onRenameProfile() {
    const current = activeProfile().name;
    const name = await promptName('Rename profile', current);
    if (name === null || name.length === 0) {
      return;
    }
    activeProfile().name = name;
    rebuildProfileOptions();
    scheduleSave();
  }

  async function onDuplicateProfile() {
    const source = activeProfile();
    const name = await promptName('Duplicate profile', source.name + ' copy');
    if (name === null) {
      return;
    }
    const id = makeProfileId();
    const clone = JSON.parse(JSON.stringify(source));
    clone.name = name || source.name + ' copy';
    config.profiles.list[id] = clone;
    activeId = id;
    config.profiles.active = id;
    rebuildProfileOptions();
    populate();
    scheduleSave();
  }

  async function onDeleteProfile() {
    const ids = Object.keys(config.profiles.list);
    if (ids.length <= 1) {
      showToast('At least one profile is required.');
      return;
    }
    const ok = await confirmDialog('Delete profile', 'Delete the profile "' + activeProfile().name + '"? This cannot be undone.');
    if (!ok) {
      return;
    }
    delete config.profiles.list[activeId];
    activeId = Object.keys(config.profiles.list)[0];
    config.profiles.active = activeId;
    rebuildProfileOptions();
    populate();
    scheduleSave();
  }

  // --- OBS URLs ---
  async function loadUrls() {
    const urls = await api.getUrls();
    el('urlLocalhost').textContent = urls.localhost;
    el('urlLan').textContent = urls.lan;
    // urls.test is absent when running against an older main process that has
    // not been restarted yet, so derive it rather than showing "undefined".
    el('urlTest').textContent = urls.test || (urls.lan + '/test');
    populateLanAdapters(urls);
  }

  // Fill the network adapter dropdown from the detected addresses and select the
  // active one. A machine with VPNs or virtual adapters (Tailscale, WSL,
  // VirtualBox) shows several entries here, so the user can pick the one the
  // streaming PC can actually reach.
  function populateLanAdapters(urls) {
    const select = el('lanAdapter');
    if (!select) {
      return;
    }
    select.innerHTML = '';

    const addresses = urls.addresses || [];
    if (addresses.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No network adapters detected';
      select.appendChild(opt);
      select.disabled = true;
      return;
    }

    select.disabled = false;
    for (const item of addresses) {
      const opt = document.createElement('option');
      opt.value = item.address;
      // Adapters that look like a VPN, a VM bridge, or WSL are called out,
      // because picking one of those is the usual reason the streaming PC never
      // connects. The list is ordered most-likely first by the main process.
      opt.textContent = item.name + ' - ' + item.address + (item.virtual ? '  (VPN or virtual)' : '');
      select.appendChild(opt);
    }
    if (urls.selectedAddress) {
      select.value = urls.selectedAddress;
    }
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      showToast('Copied to clipboard');
    } catch (err) {
      showToast('Copy failed. Select the URL and copy manually.');
    }
  }

  // --- live preview ---
  // The preview iframe loads the real overlay with a "preview" flag so the
  // server can tell it apart from a real OBS source in the connection count.
  async function reloadPreview() {
    const urls = await api.getUrls();
    el('preview').src = urls.localhost + '?preview=1';
  }

  // --- connection status indicator ---
  // Two pieces of information drive the indicator:
  //   1. Whether the KeyCast server is reachable. The Config UI opens its own
  //      WebSocket (role "status") to detect this. It sends nothing.
  //   2. How many real OBS overlay sources are connected, polled from the main
  //      process. This is what tells you OBS is actually receiving the overlay.
  let serverReachable = false;
  let sourceCount = 0;
  // Whether the main process actually has a listening socket, and why not if it
  // does not. These come from IPC rather than from the status WebSocket, because
  // the whole point is to describe the case where no socket exists to connect to.
  let serverListening = true;
  let serverError = null;

  function connectStatus() {
    const port = config.server.port;
    statusSocket = new WebSocket('ws://localhost:' + port + '?role=status');

    statusSocket.addEventListener('open', () => {
      serverReachable = true;
      applyStatus();
      pollSources();
    });
    statusSocket.addEventListener('close', () => {
      serverReachable = false;
      sourceCount = 0;
      applyStatus();
      scheduleStatusReconnect();
    });
    statusSocket.addEventListener('error', () => {
      statusSocket.close();
    });
  }

  function scheduleStatusReconnect() {
    if (statusReconnect) {
      return;
    }
    statusReconnect = setTimeout(() => {
      statusReconnect = null;
      connectStatus();
    }, 1000);
  }

  function reconnectStatus() {
    if (statusSocket) {
      try {
        statusSocket.close();
      } catch (err) {
        // already closed
      }
    }
  }

  // Poll the server state and refresh the indicator. This runs whether or not
  // the status WebSocket is up: when the server never started there is nothing
  // to connect to, and that is exactly the case the user needs explained.
  async function pollSources() {
    try {
      const status = await api.getStatus();
      sourceCount = status.sources;
      // An older main process that has not been restarted omits these fields.
      // Treat a missing value as "listening" so the UI does not invent a fault.
      serverListening = status.listening !== false;
      serverError = status.error || null;
    } catch (err) {
      sourceCount = 0;
    }
    applyStatus();
  }
  setInterval(pollSources, 2000);

  // Render the indicator from the current server and source state. Four states:
  // server not running, server running but unreachable, server up with no
  // sources, and server up with sources.
  function applyStatus() {
    const node = el('connStatus');
    const text = node.querySelector('.status-text');
    node.classList.remove('connected', 'disconnected', 'idle');

    const errorNode = el('serverError');
    if (errorNode) {
      const failed = !serverListening;
      errorNode.hidden = !failed;
      errorNode.textContent = failed
        ? (serverError || 'The server is not running. Try a different port.')
        : '';
    }

    if (!serverListening) {
      node.classList.add('disconnected');
      text.textContent = 'Server not running';
      node.title = serverError || 'The server could not start. See the Server section.';
      return;
    }
    node.title = '';
    if (!serverReachable) {
      node.classList.add('disconnected');
      text.textContent = 'Server offline';
      return;
    }
    if (sourceCount > 0) {
      node.classList.add('connected');
      text.textContent = sourceCount === 1 ? '1 source connected' : sourceCount + ' sources connected';
      return;
    }
    node.classList.add('idle');
    text.textContent = 'Waiting for OBS';
  }

  // --- updates ---
  // True while a user-initiated check is in flight, so status events can show a
  // toast. The automatic startup check leaves this false and stays silent.
  let manualUpdateCheck = false;

  // Set the small status line under the "App updates" label.
  function setUpdateStatus(message) {
    const node = el('updateStatus');
    if (node) {
      node.textContent = message;
    }
  }

  // Set true when the user clicks "Later" so informational banner updates do not
  // keep re-showing it. The "ready to install" banner forces past this.
  let updateBannerDismissed = false;

  // Show the top banner. When actionable is true the Restart & Update button
  // appears; otherwise it is informational (e.g. downloading). A non-forced call
  // respects a prior dismissal; force is used for the final "ready" state.
  function showUpdateBanner(message, actionable, force) {
    if (updateBannerDismissed && !force) {
      return;
    }
    if (force) {
      updateBannerDismissed = false;
    }
    el('updateBannerText').textContent = message;
    el('updateBannerInstall').hidden = !actionable;
    el('updateBanner').hidden = false;
  }

  // Hide the banner and clear any prior dismissal, so a later real update can
  // surface it again. Called when a check finds no update or fails, so the
  // banner can never get stuck after a transient or cancelled download.
  function hideUpdateBanner() {
    updateBannerDismissed = false;
    el('updateBanner').hidden = true;
  }

  // Render an update status object pushed from the main process. Each state is
  // handled idempotently so messages can arrive in any order or be missed.
  function renderUpdateStatus(status) {
    const checkBtn = el('updateCheck');
    const installBtn = el('updateInstall');
    if (!status) {
      return;
    }
    switch (status.state) {
      case 'checking':
        checkBtn.disabled = true;
        setUpdateStatus('Checking for updates…');
        break;
      case 'available':
        checkBtn.disabled = true;
        setUpdateStatus('Update found' + (status.version ? ' (v' + status.version + ')' : '') + '. Downloading…');
        showUpdateBanner('Downloading update' + (status.version ? ' v' + status.version : '') + '…', false);
        break;
      case 'downloading':
        checkBtn.disabled = true;
        setUpdateStatus('Downloading update… ' + (status.percent != null ? status.percent + '%' : ''));
        showUpdateBanner('Downloading update… ' + (status.percent != null ? status.percent + '%' : ''), false);
        break;
      case 'downloaded': {
        checkBtn.hidden = true;
        installBtn.hidden = false;
        const msg = 'Update' + (status.version ? ' v' + status.version : '') + ' ready. Restart to finish installing.';
        setUpdateStatus(msg);
        showUpdateBanner('KeyCast' + (status.version ? ' v' + status.version : '') + ' is ready to install.', true, true);
        if (manualUpdateCheck) { showToast(msg); manualUpdateCheck = false; }
        break;
      }
      case 'none': {
        checkBtn.disabled = false;
        hideUpdateBanner();
        const msg = 'You are on the latest version' + (status.version ? ' (v' + status.version + ')' : '') + '.';
        setUpdateStatus(msg);
        if (manualUpdateCheck) { showToast(msg); manualUpdateCheck = false; }
        break;
      }
      case 'error': {
        checkBtn.disabled = false;
        hideUpdateBanner();
        const msg = 'Update check failed: ' + (status.message || 'unknown error') + '.';
        setUpdateStatus(msg);
        if (manualUpdateCheck) { showToast(msg); manualUpdateCheck = false; }
        break;
      }
      default:
        break;
    }
  }

  // Load the running version, reflect whether updates are supported, and
  // subscribe to progress pushed by the main process.
  async function initUpdates() {
    if (!api.getUpdateInfo) {
      return;
    }
    try {
      const info = await api.getUpdateInfo();
      if (info && info.version) {
        el('appVersion').textContent = 'v' + info.version;
      }
      if (info && !info.supported) {
        // Keep the button clickable so a click gives clear feedback (a toast)
        // rather than silently doing nothing. The check itself is a no-op when
        // running from source; updates only work in the installed app.
        setUpdateStatus('In-app updates work in the installed app only (you are running from source).');
      }
    } catch (err) {
      // Non-fatal: the section still shows its default hint.
    }
    if (api.onUpdateStatus) {
      api.onUpdateStatus(renderUpdateStatus);
    }
  }

  // --- toast ---
  let toastTimer = null;
  function showToast(message) {
    const toast = el('toast');
    toast.textContent = message;
    toast.classList.add('show');
    if (toastTimer) {
      clearTimeout(toastTimer);
    }
    toastTimer = setTimeout(() => {
      toast.classList.remove('show');
    }, 1800);
  }

  // --- modal dialogs (name prompt and confirm) ---
  function buildModal() {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    document.body.appendChild(backdrop);
    return backdrop;
  }
  const modalBackdrop = buildModal();

  function promptName(title, initial) {
    return new Promise((resolve) => {
      modalBackdrop.innerHTML = '';
      const modal = document.createElement('div');
      modal.className = 'modal';

      const heading = document.createElement('div');
      heading.className = 'modal-title';
      heading.textContent = title;

      const input = document.createElement('input');
      input.className = 'text-input';
      input.type = 'text';
      input.value = initial || '';

      const actions = document.createElement('div');
      actions.className = 'modal-actions';
      const cancel = document.createElement('button');
      cancel.className = 'btn';
      cancel.textContent = 'Cancel';
      const confirm = document.createElement('button');
      confirm.className = 'btn';
      confirm.textContent = 'Save';

      actions.appendChild(cancel);
      actions.appendChild(confirm);
      modal.appendChild(heading);
      modal.appendChild(input);
      modal.appendChild(actions);
      modalBackdrop.appendChild(modal);
      modalBackdrop.classList.add('show');
      input.focus();
      input.select();

      const close = (value) => {
        modalBackdrop.classList.remove('show');
        resolve(value);
      };
      cancel.addEventListener('click', () => close(null));
      confirm.addEventListener('click', () => close(input.value.trim()));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          close(input.value.trim());
        } else if (e.key === 'Escape') {
          close(null);
        }
      });
    });
  }

  function confirmDialog(title, message) {
    return new Promise((resolve) => {
      modalBackdrop.innerHTML = '';
      const modal = document.createElement('div');
      modal.className = 'modal';

      const heading = document.createElement('div');
      heading.className = 'modal-title';
      heading.textContent = title;

      const text = document.createElement('div');
      text.className = 'modal-message';
      text.textContent = message;

      const actions = document.createElement('div');
      actions.className = 'modal-actions';
      const cancel = document.createElement('button');
      cancel.className = 'btn';
      cancel.textContent = 'Cancel';
      const confirm = document.createElement('button');
      confirm.className = 'btn danger';
      confirm.textContent = 'Delete';

      actions.appendChild(cancel);
      actions.appendChild(confirm);
      modal.appendChild(heading);
      modal.appendChild(text);
      modal.appendChild(actions);
      modalBackdrop.appendChild(modal);
      modalBackdrop.classList.add('show');

      const close = (value) => {
        modalBackdrop.classList.remove('show');
        resolve(value);
      };
      cancel.addEventListener('click', () => close(false));
      confirm.addEventListener('click', () => close(true));
    });
  }

  // --- init ---
  async function init() {
    config = await api.getConfig();
    activeId = config.profiles.active;

    rebuildProfileOptions();
    buildColorFields();
    bindControls();
    populate();
    await loadUrls();
    await reloadPreview();
    connectStatus();
    await initUpdates();
  }

  init();
})();
