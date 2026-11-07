/**
 * Stamps the landing roadmap with the version this repository actually carries.
 *
 * The page keeps two lists: rows marked shipped, and rows that are still planned. A page
 * cannot be trusted to remember which of those is true, so the split is checked against
 * package.json every time the page is built, and the heading states the version the
 * repository has reached. A shipped row above that version, or a planned row at or below
 * it, fails the build instead of publishing a claim the repository cannot back.
 *
 * `--check` compares without writing, which is what a CI step wants when the committed
 * page should already be stamped.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = join(ROOT, 'web', 'landing', 'index.html');
const CHECK = process.argv.includes('--check');

const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`package.json carries no usable version (${version}).`);
  process.exit(1);
}

/** `5.1.0` and `v5.1` compare by number, so a short row is not judged as a string. */
function tuple(value) {
  const parts = String(value).replace(/^v/i, '').split('.').map((part) => Number(part) || 0);
  while (parts.length < 3) parts.push(0);
  return parts.slice(0, 3);
}

function compare(a, b) {
  const left = tuple(a);
  const right = tuple(b);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

const html = readFileSync(PAGE, 'utf8');

const rows = [...html.matchAll(/<div class="road-row( shipped)?"><span class="v">v?([0-9.]+)<\/span>/g)].map((match) => ({
  shipped: Boolean(match[1]),
  version: match[2],
}));

if (!rows.length) {
  console.error('No roadmap rows found in web/landing/index.html — the marker changed, so nothing was stamped.');
  process.exit(1);
}

const shipped = rows.filter((row) => row.shipped);
const planned = rows.filter((row) => !row.shipped);

const problems = [];
for (let index = 1; index < shipped.length; index += 1) {
  if (compare(shipped[index].version, shipped[index - 1].version) <= 0) {
    problems.push(`shipped rows are out of order at v${shipped[index].version}`);
  }
}
for (const row of shipped) {
  if (compare(row.version, version) > 0) {
    problems.push(`v${row.version} is marked shipped, but package.json says ${version}`);
  }
}
for (const row of planned) {
  if (compare(row.version, version) <= 0) {
    problems.push(`v${row.version} is still listed as planned, but package.json says ${version} — it has shipped`);
  }
}
if (problems.length) {
  console.error('The roadmap and package.json disagree:');
  for (const problem of problems) console.error(`  · ${problem}`);
  process.exit(1);
}

const stamp = `v${version}`;
const counted = `${shipped.length} shipped, ${planned.length} planned`;
const stamped = html
  .replace(/(<b class="stamp-version">)[^<]*(<\/b>)/, (_all, open, close) => `${open}${stamp}${close}`)
  .replace(/(<span class="stamp-count">)[^<]*(<\/span>)/, (_all, open, close) => `${open}${counted}${close}`);

if (!/<b class="stamp-version">/.test(html)) {
  console.error('The stamp marker is missing from the page, so there was nowhere to write the version.');
  process.exit(1);
}

if (CHECK) {
  if (stamped !== html) {
    console.error(`The roadmap stamp is stale: it should read ${stamp} — ${counted}. Run node scripts/stamp-roadmap.mjs.`);
    process.exit(1);
  }
  console.log(`roadmap stamp is current: ${stamp} — ${counted}`);
  process.exit(0);
}

if (stamped !== html) writeFileSync(PAGE, stamped);
console.log(`roadmap stamped: ${stamp} — ${counted}`);
