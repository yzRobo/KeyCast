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

The optional mouse movement indicator is the one feature that reads the cursor
position, so it is off by default and hooked only while a profile displays it.
Computing "which way did the mouse move" requires remembering the previous
cursor position: exactly one coordinate pair is kept in memory, overwritten by
the next event, and never written anywhere. What is sent to the overlay is the
relative direction of movement only, never where the pointer is on screen.

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

If the overlay ever looks stale after a KeyCast update, open the Browser source
properties and click **Refresh cache of current page**.

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
- **Movement indicator:** shows which way you are moving the mouse, drawn on the
  palm area of the mouse. Three styles: a dot that pushes off centre and springs
  back, an arrow that points the way and grows with speed, and a fading trail.
  The sensitivity slider sets how far a flick deflects it. Off by default; see
  [Privacy and Security](#privacy-and-security) for what it does and does not
  read.
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

**Start with the test page.** KeyCast serves a connection check at
`http://<gaming-pc-ip>:<port>/test` (the exact address is shown in the OBS
Browser Source section, labeled "Test page"). Open it in a normal web browser on
the streaming PC:

- **It loads:** the network is fine. The problem is in OBS. Check that the
  Browser Source URL is the 2PC / LAN address (not `localhost`, which only works
  on the gaming PC itself), click **Refresh cache of current page** in the
  source properties, and make sure the source is visible and not covered.
- **It does not load:** the streaming PC cannot reach the gaming PC. Nothing in
  OBS will help until it does. Work through the list below.

**The streaming PC cannot reach the gaming PC.**

1. On the gaming PC, open KeyCast, go to **2PC Connection**, and click **Allow
   through firewall**. Approve the Windows permission prompt (expected, because
   firewall changes need administrator rights). Besides allowing the port, this
   also turns off any rule that is actively blocking KeyCast. Windows creates
   one of those when its "allow this app on the network" prompt gets dismissed,
   and a blocking rule overrides every allow rule, so this is worth clicking
   even if you have allowed the port before.
2. Check the **Network adapter** dropdown. If your gaming PC has a VPN or a
   virtual adapter (Tailscale, WSL, VirtualBox), the auto-detected address may
   be on the wrong network. Entries marked "VPN or virtual" are usually not the
   one you want. Both PCs must be on the same network for a LAN setup.
3. If you use a VPN, its client may block local network traffic. Look for an
   "allow LAN" or "local network sharing" setting, or disconnect the VPN once to
   test. Turning the VPN off and on does not help if the setting is the problem.
4. If you use a third-party security suite (Norton, ESET, Kaspersky,
   Bitdefender, Avast, McAfee), it has its own firewall and ignores Windows
   Firewall rules. Allow KeyCast there as well.
5. Still stuck? Click **Copy diagnostics** in the 2PC Connection section and
   paste the report into a [GitHub issue](https://github.com/yzRobo/KeyCast/issues).
   It covers the server, adapters, and firewall state, and contains no input
   data.

You can also run the firewall fix by hand: open the `scripts` folder,
right-click `fix-connection.ps1`, and choose **Run with PowerShell**. It does
the same thing as the button and prints what it found.

**The Server section shows a red error.** Another program has the port. Change
the port (for example to 8766); KeyCast restarts the server on the new port
right away. The OBS URLs update automatically, so update the URL in OBS too. On
a 2PC setup, click **Allow through firewall** again for the new port.

The connection indicator in the top right also tells you where things stand:
"Server not running" means the port could not be opened, "Waiting for OBS" means
the server is up but no source has connected, and a count appears once OBS
reaches the overlay.

---

## License

KeyCast is free software under the GNU General Public License v3. See
[LICENSE](LICENSE) for the full text.
