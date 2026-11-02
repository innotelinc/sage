/**
 * A short tally of what this instance answered, so the panel can say whether it
 * is being used and whether anything is being refused at the door.
 *
 * Counts and status codes only: no prompts, no transcripts, no keys. One JSON
 * file next to the panel's settings, written through a single queue so two
 * requests cannot interleave into a broken document.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const KEEP_DAYS = 14;
const DAY_MS = 86400000;
let days = null;
let queue = Promise.resolve();

function file() {
  return path.join(process.env.SAGE_DATA_DIR || path.join(process.cwd(), 'data'), 'usage.json');
}

function dayKey(offset = 0) {
  return new Date(Date.now() - offset * DAY_MS).toISOString().slice(0, 10);
}

export async function loadUsage() {
  try {
    const parsed = JSON.parse(await readFile(file(), 'utf8'));
    days = parsed && typeof parsed.days === 'object' && parsed.days ? parsed.days : {};
  } catch {
    days = {};
  }
  return days;
}

function bucket() {
  if (!days) days = {};
  const cutoff = Date.now() - KEEP_DAYS * DAY_MS;
  for (const day of Object.keys(days)) {
    if (new Date(`${day}T00:00:00Z`).getTime() < cutoff) delete days[day];
  }
  const key = dayKey();
  days[key] = days[key] || { chat: 0, other: 0, refused: 0 };
  return days[key];
}

function persist() {
  const snapshot = JSON.stringify({ version: 1, days }, null, 2);
  queue = queue
    .then(async () => {
      await mkdir(path.dirname(file()), { recursive: true, mode: 0o700 });
      await writeFile(file(), `${snapshot}\n`, { mode: 0o600 });
    })
    .catch(() => {});
  return queue;
}

export function recordRequest(pathname, status) {
  const path = String(pathname || '');
  if (!path.startsWith('/api/')) return;
  const entry = bucket();
  if (status === 401 || status === 403) entry.refused += 1;
  else if (path === '/api/chat') entry.chat += 1;
  else entry.other += 1;
  persist();
}

export function usageSummary(count = 7) {
  const rows = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = dayKey(offset);
    const entry = (days && days[date]) || { chat: 0, other: 0, refused: 0 };
    rows.push({ date, chat: entry.chat || 0, other: entry.other || 0, refused: entry.refused || 0 });
  }
  const total = rows.reduce(
    (sum, row) => ({ chat: sum.chat + row.chat, other: sum.other + row.other, refused: sum.refused + row.refused }),
    { chat: 0, other: 0, refused: 0 },
  );
  return { rows, total, since: rows[0] ? rows[0].date : dayKey() };
}
