/**
 * Sage's App Store header and search-results art.
 *
 * Both pieces are the same slot size as the screenshots (1206x2622 on the 6.3 inch
 * phone, 2064x2752 on the 13 inch iPad), because App Store Connect's "Header and
 * Search Results" slots take exactly the size the screenshots take. Each one is a
 * band of type above a real capture from deploy/ios/store-*, so the artwork can
 * never drift away from the interface it advertises.
 *
 * The palette is read off the app icon and public/styles.css: navy #080b12, sky
 * #38bdf8 for the eyebrow, mint #6ee7b7 for the rule, near-white ink and slate deck.
 *
 *     SAGE_URL=http://127.0.0.1:8799/ node scripts/store-shots.mjs   # first
 *     node scripts/make-store-art.mjs
 *
 * Writes header-<w>x<h>.png and search-results-<w>x<h>.png into deploy/ios/store-art,
 * RGB with no alpha channel (App Store Connect rejects alpha).
 */
import { readFile, mkdir } from 'node:fs/promises';
import sharp from 'sharp';

const NAVY = '#080b12';
const BAND = '#0b1019';
const INK = '#e7edf7';
const MUTED = '#9aa7bb';
const SKY = '#38bdf8';
const MINT = '#6ee7b7';
const EDGE = '#1d2836';

const OUT = 'deploy/ios/store-art';
const FONT = "'Segoe UI', Inter, 'Helvetica Neue', Arial, sans-serif";

const SLOTS = [
  { dir: 'deploy/ios/store-phone', width: 1206, height: 2622, label: 'iPhone 6.3' },
  { dir: 'deploy/ios/store-ipad', width: 2064, height: 2752, label: 'iPad 13' },
];

const PIECES = [
  {
    file: 'header',
    capture: '01-live.png',
    eyebrow: 'COURSE-TAKING AGENT',
    headline: ['The class,', 'taken for you.'],
    deck: ['It listens, watches and reads the lecture,', 'then answers in your own voice.'],
  },
  {
    file: 'search-results',
    capture: '06-memory.png',
    eyebrow: 'SAGE',
    headline: ['What it learned,', 'one study pack'],
    deck: null,
  },
];

const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The band is measured off the type, not a fraction of the height: the iPad slot is
 * almost twice as wide as the phone but barely taller, so a fraction would either
 * crowd the copy on one or leave a hole above the panel on the other.
 */
function layout({ width, height, piece }) {
  // Type is set from a width cap so the iPad does not get phone copy doubled in size.
  const base = Math.min(width, 1300);
  const margin = Math.round(width * 0.083);
  const ruleY = Math.round(height * 0.032);
  const ruleW = Math.round(base * 0.07);
  const ruleH = Math.max(4, Math.round(height * 0.0017));

  const eyebrowSize = Math.round(base * 0.026);
  const eyebrowY = ruleY + ruleH + Math.round(eyebrowSize * 1.9);
  const headSize = Math.round(base * (piece.deck ? 0.093 : 0.104));
  const deckSize = Math.round(base * 0.0305);

  const lines = [];
  let y = eyebrowY + Math.round(headSize * 1.18);
  for (const line of piece.headline) {
    lines.push({
      text: line,
      y,
      size: headSize,
      weight: 700,
      fill: INK,
      spacing: -Math.round(headSize * 0.02),
    });
    y += Math.round(headSize * 1.12);
  }
  if (piece.deck) {
    y += Math.round(deckSize * 0.5);
    for (const line of piece.deck) {
      lines.push({ text: line, y, size: deckSize, weight: 400, fill: MUTED, spacing: 0 });
      y += Math.round(deckSize * 1.42);
    }
  }

  return {
    band: y + Math.round(height * 0.022),
    margin,
    ruleY,
    ruleW,
    ruleH,
    eyebrowSize,
    eyebrowY,
    lines,
  };
}

function svg({ width, height, layout: l, panelTop, panelHeight, panel, piece }) {
  const r = Math.round(width * 0.046);
  const texts = l.lines
    .map(
      (line) =>
        `<text x="${l.margin}" y="${line.y}" font-family="${FONT}" font-size="${line.size}" ` +
        `font-weight="${line.weight}" fill="${line.fill}" letter-spacing="${line.spacing}">${escape(line.text)}</text>`,
    )
    .join('\n  ');

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
       width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="band" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${BAND}"/>
      <stop offset="1" stop-color="${NAVY}"/>
    </linearGradient>
    <clipPath id="panel">
      <path d="M0 ${panelTop + r} a${r} ${r} 0 0 1 ${r} ${-r} H${width - r} a${r} ${r} 0 0 1 ${r} ${r} V${height} H0 Z"/>
    </clipPath>
  </defs>

  <rect width="${width}" height="${height}" fill="${NAVY}"/>
  <rect width="${width}" height="${l.band}" fill="url(#band)"/>

  <rect x="${l.margin}" y="${l.ruleY}" width="${l.ruleW}" height="${l.ruleH}" fill="${MINT}"/>
  <text x="${l.margin}" y="${l.eyebrowY}" font-family="${FONT}" font-size="${l.eyebrowSize}"
        font-weight="600" fill="${SKY}" letter-spacing="${Math.round(Math.min(width, 1300) * 0.0075)}">${escape(piece.eyebrow)}</text>

  ${texts}

  <g clip-path="url(#panel)">
    <image x="0" y="${l.band}" width="${width}" height="${panelHeight}"
           preserveAspectRatio="xMidYMin slice" xlink:href="data:image/png;base64,${panel}"/>
  </g>
  <path d="M0 ${l.band + r} a${r} ${r} 0 0 1 ${r} ${-r} H${width - r} a${r} ${r} 0 0 1 ${r} ${r}"
        fill="none" stroke="${EDGE}" stroke-width="2"/>
</svg>`;
}

await mkdir(OUT, { recursive: true });

for (const slot of SLOTS) {
  for (const piece of PIECES) {
    const capture = await readFile(`${slot.dir}/${piece.capture}`);
    const l = layout({ width: slot.width, height: slot.height, piece });
    // The panel is the capture from just under its own top bar down to the bottom of
    // the slot, so the app's breadcrumb never appears twice with the eyebrow.
    const sourceTop = Math.round(slot.height * 0.072);
    const panelHeight = slot.height - l.band;
    if (sourceTop + panelHeight > slot.height) {
      throw new Error(`${piece.file}: panel ${panelHeight}px does not fit under a ${l.band}px band`);
    }
    const source = await sharp(capture)
      .extract({ left: 0, top: sourceTop, width: slot.width, height: panelHeight })
      .png()
      .toBuffer();

    const out = `${OUT}/${piece.file}-${slot.width}x${slot.height}.png`;
    await sharp(
      Buffer.from(
        svg({
          width: slot.width,
          height: slot.height,
          layout: l,
          panelTop: l.band,
          panelHeight,
          panel: source.toString('base64'),
          piece,
        }),
      ),
    )
      .flatten({ background: NAVY })
      .png({ compressionLevel: 9 })
      .toFile(out);

    const meta = await sharp(out).metadata();
    if (meta.width !== slot.width || meta.height !== slot.height || meta.hasAlpha) {
      throw new Error(`${out}: ${meta.width}x${meta.height} alpha=${meta.hasAlpha}`);
    }
    console.log(`  ${slot.label} · ${out} · ${meta.width}x${meta.height} · band ${l.band}px`);
  }
}
