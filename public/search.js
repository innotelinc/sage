/**
 * One search across every course, on the device.
 *
 * Pure by design: given the courses it returns ranked hits, touches no DOM and
 * makes no request, so it works offline and can be tested in Node. The order is
 * deliberate — a hit that mentions the words more often, or in its title, beats
 * one that mentions them once in passing, and a newer record beats an older one
 * at the same score.
 */

const KINDS = [
  ['answers', 'answer', 'answer', 'Answer'],
  ['quizzes', 'quiz item', 'quiz', 'Quiz'],
  ['essays', 'essay', 'essay', 'Essay'],
  ['sources', 'material read', 'read', 'Read'],
];

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function day(value) {
  const stamp = value ? new Date(value) : null;
  if (!stamp || Number.isNaN(stamp.getTime())) return '';
  return stamp.toISOString().slice(0, 10);
}

export function buildIndex(courses) {
  const entries = [];
  for (const course of Array.isArray(courses) ? courses : []) {
    if (!course) continue;
    const courseId = clean(course.id);
    const courseName = clean(course.persona && course.persona.course) || 'Untitled course';
    const base = { courseId, course: courseName };

    for (const note of Array.isArray(course.memory) ? course.memory : []) {
      entries.push({ ...base, kind: 'note', kindLabel: 'note', tab: 'memory', tabLabel: 'Memory', text: clean(note) });
    }

    const history = course.history || {};
    for (const [key, kindLabel, tab, tabLabel] of KINDS) {
      for (const item of Array.isArray(history[key]) ? history[key] : []) {
        const question = clean(item && (item.question || item.prompt));
        const answer = clean(item && (item.answer || item.text));
        entries.push({
          ...base,
          kind: kindLabel,
          kindLabel,
          tab,
          tabLabel,
          title: question,
          when: day(item && (item.at || item.savedAt)),
          text: [question, answer].filter(Boolean).join(' — '),
        });
      }
    }

    for (const doc of Array.isArray(course.foundation) ? course.foundation : []) {
      const name = clean(doc && doc.name) || 'document';
      const segments = Array.isArray(doc && doc.segments) ? doc.segments : [];
      // A PDF with real page boundaries is searchable page by page; anything
      // else is one document, so a hit still opens somewhere honest.
      if (segments.length > 1) {
        for (const segment of segments) {
          if (!clean(segment && segment.text)) continue;
          entries.push({
            ...base,
            kind: 'document',
            kindLabel: 'document',
            tab: 'foundation',
            tabLabel: 'Foundation',
            title: name,
            locator: clean(segment && segment.locator),
            text: clean(segment && segment.text),
          });
        }
      } else {
        entries.push({
          ...base,
          kind: 'document',
          kindLabel: 'document',
          tab: 'foundation',
          tabLabel: 'Foundation',
          title: name,
          text: clean(doc && doc.text),
        });
      }
    }
  }
  return entries.filter((entry) => entry.text.length > 2);
}

function snippet(text, terms) {
  const lower = text.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const found = lower.indexOf(term);
    if (found !== -1 && (at === -1 || found < at)) at = found;
  }
  if (at === -1) return text.slice(0, 160);
  const start = Math.max(0, at - 60);
  const end = Math.min(text.length, at + 120);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

export function searchCourses(courses, query, limit = 60) {
  const terms = String(query == null ? '' : query)
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 1);
  if (!terms.length) return [];

  const hits = [];
  for (const entry of buildIndex(courses)) {
    const haystack = entry.text.toLowerCase();
    const title = String(entry.title || '').toLowerCase();
    if (!terms.every((term) => haystack.includes(term))) continue;
    let score = 0;
    for (const term of terms) {
      const count = haystack.split(term).length - 1;
      score += Math.min(count, 6);
      if (title.includes(term)) score += 4;
    }
    hits.push({ ...entry, score, snippet: snippet(entry.text, terms), query: String(query) });
  }

  hits.sort((a, b) => b.score - a.score || String(b.when || '').localeCompare(String(a.when || '')));
  return hits.slice(0, Math.max(1, Number(limit) || 60));
}
