// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * test-agent helper: minimal, dependency-free 8-bit PNG decoder + pixel sampler, added specifically
 * to give Playwright specs a way to assert on actually-rendered pixel colors — not just computed
 * CSS values — for cases (like a native `<input type="date">`'s Chromium-internal calendar glyph,
 * specs/filter-bar-visual-redesign.md FR-253/AC7) where `getComputedStyle` can report a CSS rule
 * "took" even when the browser's native rendering ignores it. Playwright's own screenshot API only
 * writes bytes to disk; nothing in this repo's existing deps (`@playwright/test`) decodes them back
 * for a pixel-level assertion, and adding a real PNG library felt like more permanent surface than
 * this one narrow need justifies — so this decoder only supports what `page.screenshot()`/
 * `locator.screenshot()` actually produce (8-bit depth, non-interlaced, colorType 2 RGB or 6 RGBA),
 * not the general PNG spec.
 */
import * as fs from "node:fs";
import * as zlib from "node:zlib";

export interface DecodedPng {
  width: number;
  height: number;
  channels: number;
  pixels: Buffer;
}

export function decodePng(filePath: string): DecodedPng {
  const buf = fs.readFileSync(filePath);
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks: Buffer[] = [];
  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const data = buf.subarray(dataStart, dataStart + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset = dataStart + len + 4; // skip CRC
  }
  if (bitDepth !== 8) throw new Error(`decodePng: only 8-bit depth supported, got ${bitDepth}`);
  if (colorType !== 2 && colorType !== 6) throw new Error(`decodePng: only colorType 2/6 supported, got ${colorType}`);
  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  let rawOffset = 0;
  let prevLine = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filterType = raw[rawOffset++];
    const line = raw.subarray(rawOffset, rawOffset + stride);
    rawOffset += stride;
    const outLine = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? outLine[x - channels] : 0;
      const b = prevLine[x];
      const c = x >= channels ? prevLine[x - channels] : 0;
      let value = line[x];
      switch (filterType) {
        case 0:
          break;
        case 1:
          value = (value + a) & 0xff;
          break;
        case 2:
          value = (value + b) & 0xff;
          break;
        case 3:
          value = (value + Math.floor((a + b) / 2)) & 0xff;
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          value = (value + pr) & 0xff;
          break;
        }
        default:
          throw new Error(`decodePng: unknown filter type ${filterType}`);
      }
      outLine[x] = value;
    }
    outLine.copy(pixels, y * stride);
    prevLine = outLine;
  }
  return { width, height, channels, pixels };
}

export function getPixel(img: DecodedPng, x: number, y: number): { r: number; g: number; b: number } {
  const idx = y * img.width * img.channels + x * img.channels;
  return { r: img.pixels[idx], g: img.pixels[idx + 1], b: img.pixels[idx + 2] };
}

/** Counts pixels in `img` within `maxDistance` (per-channel Chebyshev distance) of `hex` (e.g. "000000"). */
export function countPixelsNearColor(img: DecodedPng, hex: string, maxDistance = 0): number {
  const target = { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) };
  let count = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const p = getPixel(img, x, y);
      if (
        Math.abs(p.r - target.r) <= maxDistance &&
        Math.abs(p.g - target.g) <= maxDistance &&
        Math.abs(p.b - target.b) <= maxDistance
      ) {
        count++;
      }
    }
  }
  return count;
}
