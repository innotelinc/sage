/**
 * Stamps the landing roadmap with the version this repository actually carries.
 *
 * The page keeps three lists: rows marked shipped, rows marked deferred, and rows that are
 * still planned. A page cannot be trusted to remember which of those is true, so the split
 * is checked against package.json every time the page is built, and the heading states the
 * version the repository has reached. A shipped row above that version, a planned row at or
 * below it, or a deferred row that is not below it all fail the build instead of publishing
 * a claim the repository cannot back.
 *
 * Deferred exists because this series is a straight line only while every row is built in
 * order: 6.0 shipped before 5.2–5.9 were written, and saying so on the page is honest,
 * whereas marking them shipped or quietly deleting them would not be.
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

const rows = [...html.matchAll(/<div class="road-row( shipped| deferred)?"><span class="v">v?([0-9.]+)<\/span>/g)].map(
  (match) => ({
    state: match[1] ? match[1].trim() : 'planned',
    version: match[2],
  })
);

if (!rows.length) {
  console.error('No roadmap rows found in web/landing/index.html — the marker changed, so nothing was stamped.');
  process.exit(1);
}

const shipped = rows.filter((row) => row.state === 'shipped');
const deferred = rows.filter((row) => row.state === 'deferred');
const planned = rows.filter((row) => row.state === 'planned');

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
for (const row of deferred) {
  if (compare(row.version, version) >= 0) {
    problems.push(`v${row.version} is marked deferred while package.json says ${version} — deferred means behind a release that happened, not ahead of it`);
  }
}
if (problems.length) {
  console.error('The roadmap and package.json disagree:');
  for (const problem of problems) console.error(`  · ${problem}`);
  process.exit(1);
}

const stamp = `v${version}`;
const counted = deferred.length
  ? `${shipped.length} shipped, ${deferred.length} deferred, ${planned.length} planned`
  : `${shipped.length} shipped, ${planned.length} planned`;
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
