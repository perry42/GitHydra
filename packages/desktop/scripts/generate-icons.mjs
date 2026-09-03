#!/usr/bin/env node
// Generates the macOS .icns and Linux PNG icon set from the single source-of-truth
// Windows .ico that ships at packages/desktop/build/icon.ico (also used as-is for the
// Windows target — it's already a valid multi-resolution 32bpp .ico).
//
// Why derive from the .ico instead of keeping a separate master PNG: the .ico already
// embeds a PNG-compressed frame nominally labelled "256x256" in its directory entry but
// whose actual IHDR is 512x512 (common for icon generators — the ICO directory's size byte
// maxes out at 255, so a bigger embedded PNG is stored under the nearest slot). That 512x512
// frame is the highest-resolution source available anywhere in this asset, so we extract it
// at generation time rather than tracking a redundant duplicate PNG in git. Re-run this
// script (`npm run generate:icons` from packages/desktop) any time build/icon.ico changes.
//
// Output:
//   build/icon.icns       — Apple ICNS (created purely in JS via png2icons; no macOS/iconutil
//                            dependency, so this also runs on Windows/Linux CI).
//   build/icons/*.png     — Linux icon set at the sizes a .desktop/AppImage/deb expects.
//
// Known limitation (flagged, not hidden): the source tops out at 512x512. macOS icns's
// largest slot (512x512@2x = 1024x1024 raster) is therefore upscaled 2x from that 512
// source by png2icons' bicubic resampler rather than sourced losslessly. Every other mac
// and Linux size is at or below 512, so this only affects the single largest icns entry.
// If a native 1024x1024 export of the source artwork ever becomes available, swap it in
// as the extraction target below for a fully lossless top size.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import * as png2icons from "png2icons";

const __dirname = dirname(fileURLToPath(import.meta.url));
const buildDir = join(__dirname, "..", "build");
const icoPath = join(buildDir, "icon.ico");
const icnsPath = join(buildDir, "icon.icns");
const iconsDir = join(buildDir, "icons");

const LINUX_SIZES = [16, 32, 48, 64, 128, 256, 512];

function extractLargestPngFrame(icoBuffer) {
  const count = icoBuffer.readUInt16LE(4);
  let best = null;
  for (let i = 0; i < count; i++) {
    const off = 6 + i * 16;
    const dirWidth = icoBuffer[off] || 256;
    const dirHeight = icoBuffer[off + 1] || 256;
    const bytesInRes = icoBuffer.readUInt32LE(off + 8);
    const imageOffset = icoBuffer.readUInt32LE(off + 12);
    const frame = icoBuffer.subarray(imageOffset, imageOffset + bytesInRes);
    const isPng = frame[0] === 0x89 && frame[1] === 0x50 && frame[2] === 0x4e && frame[3] === 0x47;
    if (!isPng) continue;
    // The embedded PNG's own IHDR is the real resolution — trust that over the directory's
    // (possibly capped-at-255) width/height bytes, per the module doc comment above.
    const realWidth = frame.readUInt32BE(16);
    const realHeight = frame.readUInt32BE(20);
    if (!best || realWidth > best.width) {
      best = { width: realWidth, height: realHeight, dirWidth, dirHeight, data: Buffer.from(frame) };
    }
  }
  if (!best) {
    throw new Error("No PNG-compressed frame found inside build/icon.ico to use as the icns/Linux source.");
  }
  return best;
}

async function main() {
  if (!existsSync(icoPath)) {
    throw new Error(`Expected source icon at ${icoPath} — see build/icon.ico's provenance in CLAUDE.md/DESIGN.md.`);
  }
  const icoBuffer = readFileSync(icoPath);
  const source = extractLargestPngFrame(icoBuffer);
  console.log(
    `Extracted ${source.width}x${source.height} PNG frame from icon.ico (directory slot said ${source.dirWidth}x${source.dirHeight}) as the master raster.`,
  );

  mkdirSync(iconsDir, { recursive: true });

  // --- macOS .icns ---
  // BICUBIC2: fast, good-to-very-good quality per png2icons' own docs; numOfColors=0 keeps
  // full lossless color (the icns PNG chunks aren't palette-reduced).
  const icnsBuffer = png2icons.createICNS(source.data, png2icons.BICUBIC2, 0);
  if (!icnsBuffer) {
    throw new Error("png2icons.createICNS returned null — icns generation failed.");
  }
  writeFileSync(icnsPath, icnsBuffer);
  console.log(`Wrote ${icnsPath} (${icnsBuffer.length.toLocaleString()} bytes).`);

  // --- Linux PNG set ---
  for (const size of LINUX_SIZES) {
    const outPath = join(iconsDir, `${size}x${size}.png`);
    await sharp(source.data, { limitInputPixels: false })
      .resize(size, size, { fit: "cover", kernel: sharp.kernel.lanczos3 })
      .png({ compressionLevel: 9 })
      .toFile(outPath);
    console.log(`Wrote ${outPath}.`);
  }

  console.log("\nDone. build/icon.ico (source), build/icon.icns, and build/icons/*.png are ready for electron-builder.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
