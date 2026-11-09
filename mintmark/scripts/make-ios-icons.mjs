// Draws the Mintmark app icon at every size an iOS asset catalogue wants, with
// no image dependency: a tiny PNG encoder plus a procedural brass coin on ink.
// Run with `node scripts/make-ios-icons.mjs` from the app root.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { deflateSync } from 'node:zlib'

const OUT = join('deploy', 'ios', 'AppIcon.appiconset')

const crcTable = new Int32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  crcTable[n] = c
}
const crc32 = (buf) => {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}
/** RGB, 8-bit, no alpha — App Store Connect rejects an alpha channel on the marketing icon. */
function encodePng(width, height, rgb) {
  const stride = width * 3
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const mix = (a, b, t) => a + (b - a) * t
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
const smooth = (edge0, edge1, x) => {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

const INK = [26, 23, 18]
const INK_DEEP = [15, 13, 10]

/** Colour of one point, in 0..1 icon space. */
function shade(x, y) {
  const dx = x - 0.5
  const dy = y - 0.5
  const d = Math.sqrt(dx * dx + dy * dy)
  const r = 0.368

  // Warm paper-to-ink vignette behind the coin.
  const vignette = smooth(0.1, 0.85, d / 0.72)
  let rgb = [mix(34, INK_DEEP[0], vignette), mix(30, INK_DEEP[1], vignette), mix(24, INK_DEEP[2], vignette)]

  const cover = smooth(r + 0.004, r - 0.004, d)
  if (cover <= 0) return rgb

  const t = d / r
  // Brass, lit from the upper left.
  const light = 0.5 + 0.5 * Math.cos(Math.atan2(dy + 0.2, dx + 0.22))
  let brass = [mix(120, 246, light * (1 - t * 0.55)), mix(88, 205, light * (1 - t * 0.5)), mix(38, 130, light * (1 - t * 0.45))]

  // Inner ring, struck a little deeper than the field.
  const ring = smooth(0.735, 0.705, t) * smooth(0.66, 0.69, t)
  brass = brass.map((channel, index) => mix(channel, [96, 68, 26][index], ring * 0.42))

  // Milled edge: fine radial teeth, then a darker rim.
  if (t > 0.955) {
    const teeth = 0.5 + 0.5 * Math.sin(Math.atan2(dy, dx) * 108)
    const depth = smooth(0.955, 1, t)
    brass = brass.map((channel, index) => mix(channel, [82, 57, 21][index], depth * (0.35 + teeth * 0.5)))
  }

  // A specular sheen across the upper left of the field.
  const sheen = Math.exp(-(((x - 0.38) ** 2 + (y - 0.33) ** 2) / 0.0075))
  brass = brass.map((channel) => Math.min(255, channel + sheen * 34))

  return rgb.map((channel, index) => mix(channel, brass[index], cover))
}

function render(size, supersample) {
  const big = size * supersample
  const accum = new Float64Array(size * size * 3)
  for (let by = 0; by < big; by++) {
    const y = (by + 0.5) / big
    const oy = Math.floor(by / supersample)
    for (let bx = 0; bx < big; bx++) {
      const [r, g, b] = shade((bx + 0.5) / big, y)
      const index = (oy * size + Math.floor(bx / supersample)) * 3
      accum[index] += r
      accum[index + 1] += g
      accum[index + 2] += b
    }
  }
  const per = supersample * supersample
  const rgb = Buffer.alloc(size * size * 3)
  for (let i = 0; i < size * size * 3; i++) rgb[i] = Math.max(0, Math.min(255, Math.round(accum[i] / per)))
  return encodePng(size, size, rgb)
}

const icons = [
  ['AppIcon-20x20@1x.png', 20],
  ['AppIcon-20x20@2x.png', 40],
  ['AppIcon-20x20@3x.png', 60],
  ['AppIcon-29x29@1x.png', 29],
  ['AppIcon-29x29@2x.png', 58],
  ['AppIcon-29x29@3x.png', 87],
  ['AppIcon-40x40@1x.png', 40],
  ['AppIcon-40x40@2x.png', 80],
  ['AppIcon-40x40@3x.png', 120],
  ['AppIcon-60x60@2x.png', 120],
  ['AppIcon-60x60@3x.png', 180],
  ['AppIcon-76x76@1x.png', 76],
  ['AppIcon-76x76@2x.png', 152],
  ['AppIcon-83_5x83_5@2x.png', 167],
  ['AppIcon-1024x1024@1x.png', 1024],
]

mkdirSync(OUT, { recursive: true })
for (const [name, size] of icons) {
  const png = render(size, size <= 180 ? 4 : 3)
  writeFileSync(join(OUT, name), png)
  console.log(`${name} ${size}x${size} ${png.length} bytes`)
}

const entry = (size, scale, idiom) => ({
  size,
  scale: `${scale}x`,
  idiom,
  filename: `AppIcon-${size.replace('.', '_').replace('x', 'x')}${scale === 1 ? '@1x' : `@${scale}x`}.png`,
})
const fileFor = (px) => {
  const match = icons.find(([, size]) => size === px)
  if (!match) throw new Error(`no icon rendered at ${px}px`)
  return match[0]
}

const images = [
  ...[
    [20, 2],
    [20, 3],
    [29, 2],
    [29, 3],
    [40, 2],
    [40, 3],
    [60, 2],
    [60, 3],
  ].map(([points, scale]) => ({ size: `${points}x${points}`, scale: `${scale}x`, idiom: 'iphone', filename: fileFor(points * scale) })),
  ...[
    [20, 1],
    [20, 2],
    [29, 1],
    [29, 2],
    [40, 1],
    [40, 2],
    [76, 1],
    [76, 2],
    [83.5, 2],
  ].map(([points, scale]) => ({ size: `${points}x${points}`, scale: `${scale}x`, idiom: 'ipad', filename: fileFor(Math.round(points * scale)) })),
  { size: '1024x1024', scale: '1x', idiom: 'ios-marketing', filename: 'AppIcon-1024x1024@1x.png' },
]

writeFileSync(join(OUT, 'Contents.json'), JSON.stringify({ images, info: { author: 'xcode', version: 1 } }, null, 2) + '\n')
console.log(`Contents.json: ${images.length} entries`)

mkdirSync(dirname(join(OUT, 'x')), { recursive: true })
writeFileSync(join('deploy', 'ios', 'app-store-icon-1024.png'), render(1024, 3))
console.log('deploy/ios/app-store-icon-1024.png written')
