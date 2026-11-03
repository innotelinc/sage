/* Spaced revision — what the course got wrong, asked again on expanding
   intervals. Everything here is pure: the caller supplies the clock, so the
   interval rules can be proven in Node without waiting a day.

   An item is born on the first miss and due the next day. Each time it comes
   back right it moves one step out (1, 3, 7, 21 days); a miss returns it to the
   start, so the next day catches it again. Four in a row and it is learnt and
   stops being asked. */

export const INTERVALS = [1, 3, 7, 21];
const DAY = 86400000;
const STORE_KEY = 'sage.review.v1';

/* Confidence has been written as a 0-1 fraction and as a 0-100 percent in
   different releases; both mean the same thing here. */
function asPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return number <= 1 ? number * 100 : number;
}

export function dayKey(at = Date.now()) {
  const date = new Date(at);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function itemKey(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

export function emptyReview() {
  return { items: {}, days: {}, streak: 0, lastDone: '' };
}

export function ensureReview(raw) {
  const base = emptyReview();
  if (!raw || typeof raw !== 'object') return base;
  return {
    ...base,
    ...raw,
    items: raw.items && typeof raw.items === 'object' ? raw.items : {},
    days: raw.days && typeof raw.days === 'object' ? raw.days : {},
    streak: Number(raw.streak) || 0,
  };
}

/* ── where items come from ─────────────────────────────────────── */

/* A paper's lost marks are wrong answers; a quiz item or an answer the model was
   under 60% sure of is shaky. Nothing else is guessed at: a confident answer is
   not revision material. */
export function buildCandidates(history = {}) {
  history = history && typeof history === 'object' ? history : {};
  const found = [];
  const papers = Array.isArray(history.papers) ? history.papers : [];
  for (const paper of [...papers].reverse()) {
    for (const fix of Array.isArray(paper.fixes) ? paper.fixes : []) {
      const prompt = String(fix.prompt || '').trim();
      const fixText = String(fix.fix || '').trim();
      if (!prompt || !fixText) continue;
      found.push({
        prompt,
        answer: fixText,
        source: 'paper',
        note: `${paper.question || 'A practice paper'} - marks left on the table`,
      });
    }
  }

  const quizzes = Array.isArray(history.quizzes) ? history.quizzes : [];
  for (const quiz of quizzes) {
    const confidence = asPercent(quiz.confidence);
    if (confidence === null || confidence >= 60) continue;
    const prompt = String(quiz.question || '').trim();
    if (!prompt) continue;
    const why = String(quiz.why || '').trim();
    found.push({
      prompt,
      answer: [String(quiz.answer || '').trim(), why].filter(Boolean).join(' — '),
      source: 'quiz',
      note: `a quiz item you were ${Math.round(confidence)}% sure of`,
    });
  }

  const answers = Array.isArray(history.answers) ? history.answers : [];
  for (const answer of answers) {
    const confidence = asPercent(answer.confidence);
    if (confidence === null || confidence >= 60) continue;
    const prompt = String(answer.question || '').trim();
    const text = String(answer.answer || '').trim();
    if (!prompt || !text) continue;
    found.push({
      prompt,
      answer: text,
      source: 'answer',
      note: `an answer given at ${Math.round(confidence)}% confidence`,
    });
  }

  // One item per question, and the paper's version wins: it carries the fix.
  const order = { paper: 0, quiz: 1, answer: 2 };
  const seen = new Map();
  for (const candidate of found.sort((a, b) => order[a.source] - order[b.source])) {
    const key = itemKey(candidate.prompt);
    if (!key || seen.has(key)) continue;
    seen.set(key, { ...candidate, key });
  }
  return [...seen.values()];
}

/* ── the queue ─────────────────────────────────────────────────── */

export function enqueue(review, candidates, now = Date.now()) {
  const base = ensureReview(review);
  const items = { ...base.items };
  let added = 0;
  for (const candidate of candidates) {
    const key = itemKey(candidate.prompt);
    if (!key || items[key]) continue;
    items[key] = {
      key,
      prompt: candidate.prompt,
      answer: candidate.answer,
      source: candidate.source,
      note: candidate.note || '',
      step: 0,
      due: now + INTERVALS[0] * DAY,
      added: now,
    };
    added += 1;
  }
  return { review: { ...base, items }, added };
}

export function dueItems(review, now = Date.now()) {
  const base = ensureReview(review);
  return Object.values(base.items)
    .filter((item) => !item.retired && Number(item.due) <= now)
    .sort((a, b) => a.due - b.due || b.step - a.step);
}

export function session(review, now = Date.now(), limit = 12) {
  return dueItems(review, now).slice(0, Math.max(1, limit));
}

export function streakOf(days = {}, now = Date.now()) {
  let streak = 0;
  let cursor = now;
  // Today counts only if something was answered; otherwise the streak may still
  // be alive from yesterday, which is the point of a streak.
  const has = (at) => {
    const entry = days[dayKey(at)];
    return Boolean(entry && (Number(entry.right) || 0) + (Number(entry.wrong) || 0) > 0);
  };
  if (!has(cursor)) cursor -= DAY;
  while (has(cursor)) {
    streak += 1;
    cursor -= DAY;
  }
  return streak;
}

export function grade(review, key, correct, now = Date.now()) {
  const base = ensureReview(review);
  const item = base.items[key];
  if (!item) return base;
  const step = correct ? item.step + 1 : 0;
  const retired = step >= INTERVALS.length;
  const today = dayKey(now);
  const entry = base.days[today] || { right: 0, wrong: 0 };
  const days = {
    ...base.days,
    [today]: correct
      ? { ...entry, right: (Number(entry.right) || 0) + 1 }
      : { ...entry, wrong: (Number(entry.wrong) || 0) + 1 },
  };
  const items = {
    ...base.items,
    [key]: {
      ...item,
      step,
      retired,
      seen: now,
      lastCorrect: Boolean(correct),
      due: retired ? 0 : now + INTERVALS[Math.min(step, INTERVALS.length - 1)] * DAY,
    },
  };
  return { ...base, items, days, streak: streakOf(days, now), lastDone: today };
}

export function stats(review, now = Date.now()) {
  const base = ensureReview(review);
  const items = Object.values(base.items);
  const open = items.filter((item) => !item.retired);
  const due = open.filter((item) => Number(item.due) <= now);
  const upcoming = open
    .filter((item) => Number(item.due) > now)
    .sort((a, b) => a.due - b.due);
  const today = base.days[dayKey(now)] || { right: 0, wrong: 0 };
  const done = (Number(today.right) || 0) + (Number(today.wrong) || 0);
  return {
    due: due.length,
    waiting: upcoming.length,
    retired: items.length - open.length,
    total: items.length,
    streak: streakOf(base.days, now),
    doneToday: done,
    nextDue: upcoming[0] ? upcoming[0].due : 0,
    // Fifteen seconds an item, and a session is meant to fit in five minutes.
    minutes: Math.max(1, Math.ceil(Math.min(due.length || 1, 20) / 4)),
  };
}

/* ── one queue per course, on the device ───────────────────────── */
function allReviews() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

export function loadReview(courseId = 'default') {
  return ensureReview(allReviews()[courseId]);
}

export function saveReview(courseId = 'default', review) {
  try {
    const all = allReviews();
    all[courseId] = ensureReview(review);
    localStorage.setItem(STORE_KEY, JSON.stringify(all));
    return true;
  } catch {
    return false;
  }
}
