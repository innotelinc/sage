/**
 * Nothing scratch sits unnoticed in the repository root.
 *
 * A `.tmp-magnate.html` cut from another project, or a screenshot left behind by a
 * test run, is invisible for weeks and then leaves with an unrelated `git add -A`.
 * This names them: it reads the root, flags the patterns that are always scratch,
 * and exits non-zero with the list so a commit and CI both stop on it.
 *
 * Tracked files are not exempt. A scratch file that got committed is exactly the
 * case this is for, so a root file that is genuinely wanted — there is none today —
 * belongs in KEEP with a reason beside it.
 *
 *   node scripts/check-scratch.mjs
 */
import { readdirSync, statSync } from 'node:fs';

const SCRATCH = [
  { pattern: /^\.tmp/i, why: 'a scratch copy of something' },
  { pattern: /^tmp[-_.]/i, why: 'a scratch file' },
  { pattern: /^screens?[ _-]?shot/i, why: 'a screenshot from a test run' },
  { pattern: /^screen[ _-]?rec/i, why: 'a recording from a test run' },
  { pattern: /^\.DS_Store$/, why: 'a Finder artefact' },
  { pattern: /\.(png|jpe?g|gif|webp|bmp|tiff?|mov|mp4)$/i, why: 'an image or recording at the root' },
];

/** Root files that are allowed to match a scratch pattern, with the reason. */
const KEEP = new Set([]);

const found = [];
for (const name of readdirSync('.')) {
  if (KEEP.has(name)) continue;
  let stat;
  try {
    stat = statSync(name);
  } catch {
    continue;
  }
  if (!stat.isFile()) continue;
  for (const rule of SCRATCH) {
    if (rule.pattern.test(name)) {
      found.push({ name, why: rule.why });
      break;
    }
  }
}

if (!found.length) {
  console.log('root: no scratch files');
  process.exit(0);
}

console.error(`root: ${found.length} scratch file(s) that do not belong here`);
for (const file of found) console.error(`  ${file.name} — ${file.why}`);
console.error('  move it where it belongs, commit it deliberately with a KEEP entry, or delete it');
process.exit(1);
