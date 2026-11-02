/**
 * The universal App Store creative asset.
 *
 * One 16:9 PNG of exactly 5244x2950 fills both the product page header (3840x1646)
 * and the search result card (3:2), so Apple's "Use header asset in search results"
 * shortcut applies and the artwork cannot drift between the two placements. It is a
 * PNG because the API catalog accepts nothing else, and it is flattened because
 * neither placement allows alpha.
 *
 * Apple's asset rules are followed on purpose: no prices, no URLs, no awards, no
 * other platform's marks, and everything that matters sits inside the centre.
 */
import { readFile, mkdir } from 'node:fs/promises';
import sharp from 'sharp';

const WIDTH = 5244;
const HEIGHT = 2950;
const OUT = 'deploy/ios/store-header/header-universal.png';
const ICON = 'deploy/ios/AppIcon.appiconset/AppIcon-1024x1024@1x.png';

await mkdir('deploy/ios/store-header', { recursive: true });
const icon = await readFile(ICON);
const iconUri = `data:image/png;base64,${icon.toString('base64')}`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#080b12"/>
      <stop offset="0.55" stop-color="#0e1420"/>
      <stop offset="1" stop-color="#131b2a"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.24" cy="0.34" r="0.62">
      <stop offset="0" stop-color="#6ee7b7" stop-opacity="0.20"/>
      <stop offset="1" stop-color="#6ee7b7" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="rule" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#6ee7b7"/>
      <stop offset="1" stop-color="#6ee7b7" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#glow)"/>

  <g font-family="Segoe UI, Helvetica Neue, Arial, sans-serif">
    <image xlink:href="${iconUri}" x="470" y="1015" width="920" height="920"/>

    <text x="1520" y="1290" fill="#e7edf7" font-size="430" font-weight="700"
          letter-spacing="-6">Sage</text>
    <text x="1528" y="1520" fill="#6ee7b7" font-size="168" font-weight="600">Sits in your lecture.</text>
    <text x="1528" y="1720" fill="#e7edf7" font-size="168" font-weight="600"
          opacity="0.92">Answers with the reasoning.</text>

    <rect x="1528" y="1852" width="1560" height="6" fill="url(#rule)"/>

    <!-- One measured line, not six hand-positioned labels: fixed x values collided
         the moment the font fell back to a different metrics table. -->
    <text x="1528" y="2030" fill="#8b98ad" font-size="126" font-weight="500"
          letter-spacing="3">Listen · Watch · Aim · Answer · Quiz · Essay</text>
  </g>
</svg>`;

const png = await sharp(Buffer.from(svg), { density: 96 })
  .resize(WIDTH, HEIGHT, { fit: 'fill' })
  .flatten({ background: '#080b12' })
  .png({ compressionLevel: 9 })
  .toBuffer();

await sharp(png).toFile(OUT);
const info = await sharp(OUT).metadata();
if (info.width !== WIDTH || info.height !== HEIGHT) {
  throw new Error(`wrong size: ${info.width}x${info.height}`);
}
if (info.hasAlpha) throw new Error('the asset must not carry an alpha channel');
console.log(`  ${OUT} · ${info.width}x${info.height} · alpha ${info.hasAlpha ? 'yes' : 'no'}`);
