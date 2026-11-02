// Renders every AppIcon size App Store Connect and Xcode ask for, from one SVG.
//
//   node scripts/make-icons.mjs
//
// Output is committed so CI never needs a rasteriser: the workflow only copies
// deploy/ios/AppIcon.appiconset into the generated Xcode project.
//
// Two rules that decide whether an upload is accepted rather than rejected:
//   * no alpha channel anywhere — App Store rejects a 1024 marketing icon with
//     transparency ("Invalid large app icon ... can't be transparent")
//   * no rounded corners in the artwork — iOS applies the mask (and continuous
//     corner radius) itself, so baking them in double-rounds the icon.
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';

const SOURCE = 'deploy/ios/icon-source.svg';
const OUT_DIR = 'deploy/ios/AppIcon.appiconset';
const MARKETING = 'deploy/ios/app-store-icon-1024.png';
const BACKGROUND = '#080b12';

// Every slot Requested by Xcode's asset catalog validator: iPhone and iPad
// notifications/settings/spotlight/home screen, plus ios-marketing.
const ENTRIES = [
  { idiom: 'iphone', size: '20x20', scale: 2 },
  { idiom: 'iphone', size: '20x20', scale: 3 },
  { idiom: 'iphone', size: '29x29', scale: 2 },
  { idiom: 'iphone', size: '29x29', scale: 3 },
  { idiom: 'iphone', size: '40x40', scale: 2 },
  { idiom: 'iphone', size: '40x40', scale: 3 },
  { idiom: 'iphone', size: '60x60', scale: 2 },
  { idiom: 'iphone', size: '60x60', scale: 3 },
  { idiom: 'ipad', size: '20x20', scale: 1 },
  { idiom: 'ipad', size: '20x20', scale: 2 },
  { idiom: 'ipad', size: '29x29', scale: 1 },
  { idiom: 'ipad', size: '29x29', scale: 2 },
  { idiom: 'ipad', size: '40x40', scale: 1 },
  { idiom: 'ipad', size: '40x40', scale: 2 },
  { idiom: 'ipad', size: '76x76', scale: 1 },
  { idiom: 'ipad', size: '76x76', scale: 2 },
  { idiom: 'ipad', size: '83.5x83.5', scale: 2 },
  { idiom: 'ios-marketing', size: '1024x1024', scale: 1 },
];

const pixels = (size, scale) => Math.round(parseFloat(size) * scale);
const fileName = (size, scale) => `AppIcon-${size.replace(/\./g, '_')}@${scale}x.png`;

const svg = readFileSync(SOURCE);
// Rasterise once at full size, then downscale each slot from it: repeated
// independent renders at 20px would lose the thin rings to the rasteriser.
const base = await sharp(svg, { density: 96 })
  .resize(1024, 1024, { fit: 'cover', kernel: 'lanczos3' })
  .png()
  .toBuffer();

const png = async (px) =>
  sharp(base)
    .resize(px, px, { kernel: 'lanczos3' })
    .flatten({ background: BACKGROUND })
    .removeAlpha()
    .png({ compressionLevel: 9 })
    .toBuffer();

await rm(OUT_DIR, { recursive: true, force: true });
await mkdir(OUT_DIR, { recursive: true });

const images = [];
for (const entry of ENTRIES) {
  const px = pixels(entry.size, entry.scale);
  const file = fileName(entry.size, entry.scale);
  const data = await png(px);
  await writeFile(`${OUT_DIR}/${file}`, data);
  images.push({ filename: file, idiom: entry.idiom, scale: `${entry.scale}x`, size: entry.size });
  const meta = await sharp(data).metadata();
  if (meta.hasAlpha) throw new Error(`${file} still has an alpha channel`);
  if (meta.width !== px || meta.height !== px) {
    throw new Error(`${file} is ${meta.width}x${meta.height}, expected ${px}x${px}`);
  }
}

await writeFile(
  `${OUT_DIR}/Contents.json`,
  `${JSON.stringify({ images, info: { author: 'xcode', version: 1 } }, null, 2)}\n`,
);

const marketing = await png(1024);
await writeFile(MARKETING, marketing);

const listed = images.map((i) => `${i.size}@${i.scale}`).join(' ');
console.log(`icons: ${images.length} slots -> ${OUT_DIR}`);
console.log(`marketing: ${MARKETING} (1024x1024, no alpha)`);
console.log(`sizes: ${listed}`);
