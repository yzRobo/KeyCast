// generate-icon.js
//
// Generates the KeyCast program icon (a W keycap) as build/icon.png and
// build/icon.ico, with no external dependencies. It renders the artwork at 4x
// scale into an RGBA buffer, downsamples for anti-aliasing, and encodes the
// result using Node's built-in zlib. Re-run with: node build/generate-icon.js
//
// This is a build-time asset generator. It has nothing to do with input
// capture and stores no user data.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;
const SS = 4; // supersampling factor for smooth edges
const W = SIZE * SS;
const H = SIZE * SS;

// RGBA buffer, transparent by default so the icon has rounded transparent
// corners.
const buf = new Uint8ClampedArray(W * H * 4);

function setPixel(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= W || y >= H) {
    return;
  }
  const i = (y * W + x) * 4;
  buf[i] = r;
  buf[i + 1] = g;
  buf[i + 2] = b;
  buf[i + 3] = a;
}

function hexToRgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16)
  ];
}

// Fill a rounded rectangle (coordinates in supersampled space).
function fillRoundRect(x, y, w, h, radius, hex) {
  const [r, g, b] = hexToRgb(hex);
  const rad = radius * SS;
  const x0 = x * SS;
  const y0 = y * SS;
  const x1 = (x + w) * SS;
  const y1 = (y + h) * SS;

  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      let inside = true;
      // Check each corner region.
      if (px < x0 + rad && py < y0 + rad) {
        inside = dist(px, py, x0 + rad, y0 + rad) <= rad;
      } else if (px > x1 - rad && py < y0 + rad) {
        inside = dist(px, py, x1 - rad, y0 + rad) <= rad;
      } else if (px < x0 + rad && py > y1 - rad) {
        inside = dist(px, py, x0 + rad, y1 - rad) <= rad;
      } else if (px > x1 - rad && py > y1 - rad) {
        inside = dist(px, py, x1 - rad, y1 - rad) <= rad;
      }
      if (inside) {
        setPixel(px, py, r, g, b, 255);
      }
    }
  }
}

// Stroke a rounded rectangle outline of a given thickness.
function strokeRoundRect(x, y, w, h, radius, thickness, hex) {
  fillRoundRect(x, y, w, h, radius, hex);
  // Carve out the interior by leaving it to be overpainted later. The caller
  // paints the inner fill afterwards, so this just lays the border color first.
}

function dist(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

// Draw a thick line segment as a series of filled disks for rounded joins.
function thickLine(x1, y1, x2, y2, thickness, hex) {
  const [r, g, b] = hexToRgb(hex);
  const rad = (thickness * SS) / 2;
  const sx = x1 * SS;
  const sy = y1 * SS;
  const ex = x2 * SS;
  const ey = y2 * SS;
  const len = dist(sx, sy, ex, ey);
  const steps = Math.ceil(len);
  for (let s = 0; s <= steps; s++) {
    const t = steps === 0 ? 0 : s / steps;
    const cx = sx + (ex - sx) * t;
    const cy = sy + (ey - sy) * t;
    const minX = Math.floor(cx - rad);
    const maxX = Math.ceil(cx + rad);
    const minY = Math.floor(cy - rad);
    const maxY = Math.ceil(cy + rad);
    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        if (dist(px, py, cx, cy) <= rad) {
          setPixel(px, py, r, g, b, 255);
        }
      }
    }
  }
}

// --- Compose the icon (coordinates in 256-space) ---

// Rounded square backing.
fillRoundRect(8, 8, 240, 240, 52, '#0a0a0a');

// Keycap outer body (border color first, then inner fill on top).
fillRoundRect(48, 44, 160, 168, 30, '#2e2e2e');
fillRoundRect(52, 48, 152, 156, 27, '#161616');

// Inner top surface for a subtle keycap step.
fillRoundRect(64, 60, 128, 120, 20, '#1c1c1c');

// The W glyph, drawn as four thick strokes with rounded joins.
const glyph = '#ededed';
const t = 13;
thickLine(80, 84, 104, 164, t, glyph);
thickLine(104, 164, 128, 116, t, glyph);
thickLine(128, 116, 152, 164, t, glyph);
thickLine(152, 164, 176, 84, t, glyph);

// --- Downsample from supersampled buffer to final RGBA ---
const out = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let dy = 0; dy < SS; dy++) {
      for (let dx = 0; dx < SS; dx++) {
        const sx = x * SS + dx;
        const sy = y * SS + dy;
        const i = (sy * W + sx) * 4;
        r += buf[i];
        g += buf[i + 1];
        b += buf[i + 2];
        a += buf[i + 3];
      }
    }
    const n = SS * SS;
    const o = (y * SIZE + x) * 4;
    out[o] = Math.round(r / n);
    out[o + 1] = Math.round(g / n);
    out[o + 2] = Math.round(b / n);
    out[o + 3] = Math.round(a / n);
  }
}

// --- PNG encoding ---
function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i];
    for (let k = 0; k < 8; k++) {
      crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, width, height) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  // Add the per-row filter byte (0 = none).
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idatData = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idatData),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const png = encodePng(out, SIZE, SIZE);
const pngPath = path.join(__dirname, 'icon.png');
fs.writeFileSync(pngPath, png);
console.log('Wrote ' + pngPath);

// --- ICO encoding (single 256x256 entry wrapping the PNG) ---
// Windows Vista and later support PNG-compressed icon entries, which keeps this
// simple and lossless.
function encodeIco(pngBuffer) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = icon
  header.writeUInt16LE(1, 4); // image count

  const entry = Buffer.alloc(16);
  entry[0] = 0; // width 0 means 256
  entry[1] = 0; // height 0 means 256
  entry[2] = 0; // color palette
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4);  // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(pngBuffer.length, 8); // image size
  entry.writeUInt32LE(6 + 16, 12); // offset to image data

  return Buffer.concat([header, entry, pngBuffer]);
}

const ico = encodeIco(png);
const icoPath = path.join(__dirname, 'icon.ico');
fs.writeFileSync(icoPath, ico);
console.log('Wrote ' + icoPath);
