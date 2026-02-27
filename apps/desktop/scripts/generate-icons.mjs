/**
 * generate-icons.mjs
 *
 * Generates all icon assets required by electron-builder from a single SVG
 * source that matches the 1Gov Mail brand (dark rounded square + mail envelope).
 *
 * Output (all written to apps/desktop/resources/):
 *   icon.icns              – macOS app icon  (requires iconutil, built into macOS)
 *   icon.ico               – Windows app icon (16 / 32 / 48 / 256 px in one file)
 *   icon.png               – Linux app icon  (512 × 512)
 *   tray-icon-template.png – macOS menu-bar tray icon (16 × 16, black template)
 *   tray-icon-template@2x.png – Retina tray icon     (32 × 32, black template)
 *   tray-icon.png          – Windows / Linux tray icon (32 × 32, branded colour)
 *
 * Deps: @resvg/resvg-js (pure-Rust SVG renderer, no system deps)
 *
 * Usage: node scripts/generate-icons.mjs
 */

import { Resvg } from '@resvg/resvg-js';
import { execSync } from 'child_process';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESOURCES = join(__dirname, '..', 'resources');

// ─── SVG builders ─────────────────────────────────────────────────────────────

/**
 * Full-colour app icon: dark #1c1c1e rounded square with a white mail envelope.
 * Mirrors the shape used in apps/web/app/icon.tsx.
 */
function appIconSvg(s) {
  const rx     = Math.round(s * 0.22);             // corner radius
  const stroke = Math.max(1.5, s * 0.042);         // line weight
  const pad    = Math.round(s * 0.18);             // horizontal padding
  const envX   = pad;
  const envW   = s - pad * 2;
  const envH   = Math.round(envW * 0.75);          // 4:3 envelope ratio
  const envY   = Math.round((s - envH) / 2);       // centre vertically
  const envRx  = Math.max(2, Math.round(s * 0.055));
  // V-fold geometry derived from the favicon path in icon.tsx
  const foldY  = envY + Math.round(envH * 0.208);  // where the flap meets the sides
  const midX   = Math.round(s / 2);
  const midY   = envY + Math.round(envH * 0.625);  // flap apex

  return `<svg width="${s}" height="${s}" viewBox="0 0 ${s} ${s}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${s}" height="${s}" rx="${rx}" ry="${rx}" fill="#1c1c1e"/>
  <rect x="${envX}" y="${envY}" width="${envW}" height="${envH}" rx="${envRx}" ry="${envRx}"
        stroke="white" stroke-width="${stroke}" fill="none"/>
  <path d="M${envX} ${foldY} L${midX} ${midY} L${s - envX} ${foldY}"
        stroke="white" stroke-width="${stroke}"
        stroke-linecap="round" stroke-linejoin="round" fill="none"/>
</svg>`;
}

/**
 * Tray template icon: black envelope on a transparent background.
 * macOS auto-inverts template images for dark/light menu-bar contrast.
 * The extra 5 % padding on each side gives it visual breathing room at
 * the 16 × 16 size that most menu bars display.
 */
function trayIconSvg(s) {
  const stroke = Math.max(1, s * 0.1);
  const pad    = Math.round(s * 0.05);
  const envX   = pad;
  const envW   = s - pad * 2;
  const envH   = Math.round(envW * 0.75);
  const envY   = Math.round((s - envH) / 2);
  const envRx  = Math.max(1, Math.round(s * 0.08));
  const foldY  = envY + Math.round(envH * 0.208);
  const midX   = Math.round(s / 2);
  const midY   = envY + Math.round(envH * 0.625);

  return `<svg width="${s}" height="${s}" viewBox="0 0 ${s} ${s}" xmlns="http://www.w3.org/2000/svg">
  <rect x="${envX}" y="${envY}" width="${envW}" height="${envH}" rx="${envRx}" ry="${envRx}"
        stroke="black" stroke-width="${stroke}" fill="none"/>
  <path d="M${envX} ${foldY} L${midX} ${midY} L${s - envX} ${foldY}"
        stroke="black" stroke-width="${stroke}"
        stroke-linecap="round" stroke-linejoin="round" fill="none"/>
</svg>`;
}

// ─── Render ───────────────────────────────────────────────────────────────────

/** Renders an SVG string to a PNG Buffer at exactly `size × size` pixels. */
function svgToPng(svgString, size) {
  const resvg = new Resvg(svgString, {
    fitTo: { mode: 'width', value: size },
  });
  return Buffer.from(resvg.render().asPng());
}

// ─── ICO builder (pure JS) ────────────────────────────────────────────────────

/**
 * Builds a Windows .ico file from an array of { size, buf } entries.
 * ICO stores multiple PNG-encoded images in a single file.
 * Sizes: 16, 32, 48, 256 cover every Windows UI context.
 */
function buildIco(entries) {
  const count      = entries.length;
  const HEADER     = 6;
  const DIR_ENTRY  = 16;
  const dataOffset = HEADER + count * DIR_ENTRY;

  // Calculate where each image starts in the file
  const offsets = [];
  let pos = dataOffset;
  for (const { buf } of entries) {
    offsets.push(pos);
    pos += buf.length;
  }

  const ico = Buffer.alloc(pos);
  ico.writeUInt16LE(0, 0);      // Reserved
  ico.writeUInt16LE(1, 2);      // Type: 1 = ICO
  ico.writeUInt16LE(count, 4);  // Number of images

  for (let i = 0; i < count; i++) {
    const base     = HEADER + i * DIR_ENTRY;
    const { size, buf } = entries[i];
    ico.writeUInt8(size >= 256 ? 0 : size, base);      // Width  (0 = 256)
    ico.writeUInt8(size >= 256 ? 0 : size, base + 1);  // Height (0 = 256)
    ico.writeUInt8(0, base + 2);                        // Colour palette count
    ico.writeUInt8(0, base + 3);                        // Reserved
    ico.writeUInt16LE(1,  base + 4);                    // Colour planes
    ico.writeUInt16LE(32, base + 6);                    // Bits per pixel
    ico.writeUInt32LE(buf.length, base + 8);            // Data size in bytes
    ico.writeUInt32LE(offsets[i], base + 12);           // Offset in file
  }

  let writeAt = dataOffset;
  for (const { buf } of entries) {
    buf.copy(ico, writeAt);
    writeAt += buf.length;
  }

  return ico;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  mkdirSync(RESOURCES, { recursive: true });
  console.log('Generating 1Gov Mail icons…\n');

  // Pre-render every size we need for the app icon
  const APP_SIZES = [16, 32, 48, 64, 128, 256, 512, 1024];
  const pngMap = {};
  for (const s of APP_SIZES) {
    pngMap[s] = svgToPng(appIconSvg(s), s);
    console.log(`  app icon ${String(s).padStart(4)}×${s}`);
  }

  // ── Linux ──────────────────────────────────────────────────────────────────
  writeFileSync(join(RESOURCES, 'icon.png'), pngMap[512]);
  console.log('\n  → icon.png        (Linux 512×512)');

  // ── macOS .icns via iconutil ───────────────────────────────────────────────
  const iconsetDir = join(RESOURCES, 'icon.iconset');
  mkdirSync(iconsetDir, { recursive: true });

  const ICONSET = [
    ['icon_16x16.png',      16],
    ['icon_16x16@2x.png',   32],
    ['icon_32x32.png',      32],
    ['icon_32x32@2x.png',   64],
    ['icon_128x128.png',   128],
    ['icon_128x128@2x.png',256],
    ['icon_256x256.png',   256],
    ['icon_256x256@2x.png',512],
    ['icon_512x512.png',   512],
    ['icon_512x512@2x.png',1024],
  ];

  for (const [name, size] of ICONSET) {
    writeFileSync(join(iconsetDir, name), pngMap[size]);
  }

  try {
    execSync(
      `iconutil -c icns "${iconsetDir}" -o "${join(RESOURCES, 'icon.icns')}"`,
      { stdio: 'pipe' },
    );
    rmSync(iconsetDir, { recursive: true, force: true });
    console.log('  → icon.icns       (macOS)');
  } catch {
    console.log('  ⚠  icon.icns skipped — iconutil is only available on macOS.');
    console.log('     The icon.iconset folder has been kept for manual conversion.');
  }

  // ── Windows .ico ───────────────────────────────────────────────────────────
  const icoEntries = [16, 32, 48, 256].map((size) => ({ size, buf: pngMap[size] }));
  writeFileSync(join(RESOURCES, 'icon.ico'), buildIco(icoEntries));
  console.log('  → icon.ico        (Windows 16/32/48/256)');

  // ── Tray icons ─────────────────────────────────────────────────────────────
  writeFileSync(join(RESOURCES, 'tray-icon-template.png'),    svgToPng(trayIconSvg(16), 16));
  writeFileSync(join(RESOURCES, 'tray-icon-template@2x.png'), svgToPng(trayIconSvg(32), 32));
  writeFileSync(join(RESOURCES, 'tray-icon.png'),             pngMap[32]);
  console.log('  → tray icons      (16×16, 32×32 template + 32×32 colour)');

  console.log('\nAll icons written to apps/desktop/resources/');
}

main();
