# KeyCast

A clean, minimal keyboard and mouse overlay for streamers. It runs on your
gaming PC and shows your inputs in OBS as a Browser Source. It stores nothing.

## Contents

- [Privacy and Security](#privacy-and-security)
- [Quick Start (Installer)](#quick-start-installer)
- [Run from Source](#run-from-source)
- [OBS Setup](#obs-setup)
- [2PC Setup](#2pc-setup)
- [Configuration](#configuration)
- [Profiles](#profiles)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Privacy and Security

KeyCast does not store your keystrokes. Ever.

- Each key and mouse event is shown on the overlay, then immediately discarded.
- Nothing is written to disk. No logs, no history, no statistics.
- KPS and click counters live in memory and reset every time the app starts.
- KeyCast never connects to the internet. No telemetry, no analytics.

Because it watches your input, you should be able to trust it. The full source is
readable, and every place that reads an input has a comment confirming the data
is not stored. The one file that touches raw input is
[src/listener.js](src/listener.js).

The only outbound request is to Google Fonts, for the typefaces. No input is
involved. To run fully offline, swap the Google Fonts links for local font files.

---

## Quick Start (Installer)

Best for most users.

1. Download the installer from the [latest release](https://github.com/yzRobo/KeyCast/releases/latest).
2. Run the `.exe` and follow the prompts.
3. Launch KeyCast. The settings window opens and the overlay starts on its own.

Windows may show a blue SmartScreen warning the first time, because the app is not
code-signed. Click **More info**, then **Run anyway**. It only appears once.

---

## Run from Source

For users who want to read the code first. Requires
[Node.js](https://nodejs.org/) 18 or newer.

```
git clone https://github.com/yzRobo/KeyCast.git keycast
cd keycast
npm install
npm start
```

On first run KeyCast creates a default `config.json`, starts the server, and
opens the settings window.

---

## OBS Setup

1. In OBS, add a **Browser** source.
2. Set the **URL** to the one shown in the KeyCast "OBS Browser Source" box
   (for a single PC, something like `http://localhost:8765`).
3. Set size to about **600 x 500**. Adjust to taste.

The background is transparent, so it sits cleanly over your scene. The overlay
reconnects on its own if KeyCast restarts.

---

## 2PC Setup

Game on one PC, OBS on another.

**Same network (most common):** No port forwarding needed. KeyCast shows your
gaming PC's local IP in the settings window, labeled "2PC / LAN". Use that as the
OBS URL on the streaming PC, for example `http://192.168.1.42:8765`. If it does
not connect, see [Troubleshooting](#troubleshooting).

If your gaming PC has more than one network adapter (a VPN, or a virtual adapter
from WSL or a VM), the auto-detected address may be the wrong one. Use the
**Network adapter** dropdown in the OBS Browser Source section to pick the
adapter your streaming PC is on; the 2PC / LAN URL updates to match, and your
choice is remembered.

**Different networks:** Install [Tailscale](https://tailscale.com/) on both PCs
and use the gaming PC's Tailscale IP as the OBS URL instead. Nothing else to set
up.

---

## Configuration

Everything is set in the KeyCast window. No file editing needed.

- **Keyboard:** turn it on or off and arrange the keys. Drag a key on the grid to
  move it, and dropping it onto other keys bumps them down a row to make room.
  Drag its right edge to make it wider. Drag across empty space to select several
  keys at once (or shift-click to add and remove them from a selection) and move
  them together. The list below also lets you set exact values and add, remove,
  or relabel keys.
- **Combo keys:** join two or more keys with a plus sign in the Key field (for
  example `space+ctrl`) to make a single cap that flashes only when those keys
  are pressed within a tight timing window. The `ms` field next to each key sets
  that window in milliseconds.
- **Superglide preset:** the Superglide section is a ready-made combo for the
  Apex Legends Superglide. Turn it on, enter your two keys (jump first, then
  crouch), and set the timing window. Unlike a plain combo, order matters here:
  jump must land before crouch, and crouch must follow within the window. The
  window gets tighter at higher frame rates (about one frame: 16 ms at 60 FPS,
  7 ms at 144 FPS), so tune it to your setup. Drag the SUPERGLIDE cap on the grid
  to position it.
- **Mouse:** turn the mouse on or off, pick which buttons show, toggle the scroll
  flash and per-button click counters. Position it anywhere by dragging the
  MOUSE box in the layout editor, or set its grid column and row in the Mouse
  section.
- **Theme:** choose a preset, then change any color, the animation, and the size,
  gap, and scale.
- **Counters:** turn the keys-per-second display on or off.
- **Server:** change the port.

Changes save instantly, and the live preview on the right shows the real overlay
reacting to your input. Settings are saved in `config.json`, the only file
KeyCast writes.

---

## Profiles

Keep different layouts for different games.

- **Add** creates a new layout. **Rename** and **Duplicate** do what they say.
- **Switch** with the dropdown at the top. The overlay updates right away.
- **Delete** removes the current layout. One profile always stays.

The selected profile is the one shown on the overlay.

---

## Troubleshooting

**Overlay works on the gaming PC but not the streaming PC.** The gaming PC's
firewall is blocking the connection. The connection indicator in the top right of
the KeyCast window also helps here: "Waiting for OBS" means no source has
connected yet, and a count appears once OBS reaches the overlay.

The easiest fix is built into the app:

1. On the gaming PC, open KeyCast and go to the **2PC Connection** section.
2. Click **Allow through firewall**.
3. Approve the Windows permission prompt. This is expected, because firewall
   changes need administrator rights.

That adds one firewall rule for the KeyCast port and is safe to click more than
once.

If you prefer to do it by hand, or the button does not work, run the script
directly: open the `scripts` folder, right-click `fix-connection.ps1`, and choose
**Run with PowerShell** (or **Run as administrator** if it does not elevate on
its own). It does the same thing.

**The app says the port is in use.** Another program has the port. In the Server
section, change the port (for example to 8766). The OBS URL updates automatically,
so update it in OBS. On a 2PC setup, re-run `fix-connection.ps1` for the new port.

---

## License

KeyCast is free software under the GNU General Public License v3. See
[LICENSE](LICENSE) for the full text.
