/**
 * The course reader: the lecture, as a document.
 *
 * Milestone 6.0. Capture produces notes and answers; this assembles them into
 * something that can be studied from — per lecture, the outline, the definitions,
 * the worked examples and the exam hints, in the order they were taught.
 *
 * Two rules keep it a view of the material rather than a summary of it:
 *
 *  - every block keeps the anchors it came from. A citation naming a document the
 *    course does not hold is dropped instead of rendered as a page that cannot
 *    open, and a block with no citation of its own still carries the note it came
 *    from, so nothing is orphaned;
 *  - an edit is returned in its own field, beside the capture rather than over it.
 *    Nothing here ever writes `text`, which is why an edit can be undone and a
 *    rebuild can never destroy what was captured.
 *
 * Pure: no I/O and no clock of its own — the caller passes `now` — so the test
 * script can pin every output.
 */

const LECTURE_GAP_MS = 45 * 60 * 1000;
const MAX_BLOCKS = 400;
const MAX_BLOCK_CHARS = 2000;

const HINT = /\bEXAM\b|exam hint|likely exam|exam question|will be examined/i;
const EXAMPLE = /\b(?:e\.g\.|for example|for instance|worked example|worked through)\b/i;
// "X is Y" matches almost any sentence, so a definition has to name itself: the
// verb form that introduces a term, not any use of "is".
const DEFINITION =
  /\b(?:means|refers to|is defined as|are defined as|is called|are called)\b|^\W*(?:a|an|the)\s+[\w\s-]{2,40}\s+(?:is|are)\s+/i;

const DOC_ANCHOR = /\[([^\]\n]{1,80}?)\s+p\.(\d+)\]/g;
const MOMENT_ANCHOR = /\[lecture\s+(\d{1,2}(?::\d{2}){1,2})\]/gi;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "12:30" or "1:02:03" as seconds, or null when it is not a clock. */
export function clockSeconds(clock) {
  const parts = String(clock || '').split(':').map(Number);
  if (parts.length < 2 || parts.length > 3) return null;
  if (parts.some((part) => !Number.isFinite(part) || part < 0)) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

/** The kind a line is, from what the line says rather than from where it sits. */
export function kindOf(text) {
  if (HINT.test(text)) return 'hint';
  if (EXAMPLE.test(text)) return 'example';
  if (DEFINITION.test(text)) return 'definition';
  return 'outline';
}

function dateLabel(at) {
  if (!at) return '';
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

function timeLabel(at) {
  if (!at) return '';
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '';
  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
}

/** The bullet markers capture leaves behind, removed once the line is its own block. */
function linesOf(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim())
    .filter((line) => line.length >= 3)
    .map((line) => line.slice(0, MAX_BLOCK_CHARS));
}

/**
 * The anchors a line carries, in the order they appear.
 *
 * A document anchor survives only if the course holds that document — an anchor
 * that cannot open the page it names is worse than none, and the app would offer a
 * chip that answers "that document is no longer part of this course".
 */
function anchorsFor(text, docs) {
  const anchors = [];
  const seen = new Set();
  for (const match of String(text).matchAll(DOC_ANCHOR)) {
    const name = String(match[1]).trim();
    const known = docs.get(name.toLowerCase());
    if (!known) continue;
    const locator = `p.${Number(match[2])}`;
    const key = `${known}|${locator}`;
    if (seen.has(key)) continue;
    seen.add(key);
    anchors.push({ kind: 'page', doc: known, locator });
  }
  for (const match of String(text).matchAll(MOMENT_ANCHOR)) {
    const clock = match[1];
    const at = clockSeconds(clock);
    if (at === null) continue;
    const key = `moment|${clock}`;
    if (seen.has(key)) continue;
    seen.add(key);
    anchors.push({ kind: 'moment', clock, at });
  }
  return anchors;
}

/**
 * A lecture, from the notes alone.
 *
 * Nothing records where one lecture ends and the next begins, so this reads the
 * two signals there are: a gap of more than forty-five minutes between notes, and
 * a lecture clock that goes backwards, which means a new recording started.
 */
function lecturesOf(notes) {
  const groups = [];
  let current = null;
  let previousAt = 0;
  let previousMoment = null;
  for (const note of notes) {
    const at = Number(note.at) || 0;
    const moment = momentOf(note.text);
    const gap = previousAt && at ? at - previousAt : 0;
    const restarted = previousMoment !== null && moment !== null && moment < previousMoment;
    if (!current || gap > LECTURE_GAP_MS || restarted) {
      current = [];
      groups.push(current);
      previousMoment = null;
    }
    current.push(note);
    if (at) previousAt = at;
    if (moment !== null) previousMoment = moment;
  }
  return groups;
}

/**
 * The first lecture clock in a note, as seconds, or null.
 *
 * A separate non-global pattern on purpose: `exec` on the shared global one would
 * leave its lastIndex past the first match, and the `matchAll` in anchorsFor reads
 * that index — which silently dropped every moment anchor.
 */
function momentOf(text) {
  const match = String(text || '').match(/\[lecture\s+(\d{1,2}(?::\d{2}){1,2})\]/i);
  return match ? clockSeconds(match[1]) : null;
}

const STOP = new Set(
  'the a an of and or to in on for is are was were what where when which how why did do does we it that this with about from at as be by i you me my our there has have had than then so but if not'.split(' ')
);

/** Words worth matching on: lower case, punctuation gone, stopwords dropped. */
export function tokenise(text) {
  const words = String(text || '')
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9'-]+/g);
  return (words || []).filter((word) => !STOP.has(word));
}

/**
 * Which sections answer a question about the course (6.1).
 *
 * Lexical on purpose: every token in the question that the section actually contains
 * counts one, and nothing is invented. Two sections within sixty percent of the best
 * score mean the answer spans lectures, and saying so is better than silently picking
 * one — that is the milestone's promise, and the caller renders both.
 */
export function findSections(sections, question, limit = 2) {
  const words = [...new Set(tokenise(question))];
  if (!words.length) return { question: String(question || ''), matches: [], spans: false };
  // One shared word out of two is a coincidence, not a match: "the Krebs cycle"
  // would otherwise land on any lecture that mentions a cycle. A question has to
  // carry at least half its words into the section, and two when it has more than one.
  const needed = words.length === 1 ? 1 : Math.max(2, Math.ceil(words.length / 2));
  const scored = [];
  for (const section of Array.isArray(sections) ? sections : []) {
    const words_there = new Set(tokenise([section.title, ...(section.blocks || []).map((block) => block.text)].join(' ')));
    const hits = words.filter((word) => words_there.has(word));
    if (hits.length < needed) continue;
    const seen = new Set();
    const anchors = [];
    for (const block of section.blocks || []) {
      for (const anchor of block.anchors || []) {
        if (anchor.kind === 'note') continue;
        const key = `${anchor.kind}|${anchor.doc || ''}|${anchor.locator || ''}|${anchor.clock || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        anchors.push(anchor);
        if (anchors.length >= 12) break;
      }
    }
    scored.push({
      sectionId: section.id,
      title: section.title,
      captured: section.captured || '',
      score: hits.length,
      hits,
      anchors,
    });
  }
  scored.sort((a, b) => b.score - a.score);
  const matches = scored.slice(0, Math.max(1, limit));
  const spans = matches.length === 2 && matches[1].score >= matches[0].score * 0.6;
  return { question: String(question || ''), matches, spans };
}

/**
 * Build the reader for one course.
 *
 * `course` is the workspace's course object: notes under `session.notes`, the
 * material under `foundation`. `edits` are `{ blockId, text, at }` records kept by
 * the client — apart from the capture, and merged here only into `edited`.
 */
export function buildReader({ course = {}, edits = [], now = new Date() } = {}) {
  const id = String(course.id || 'course');
  const name = String(course.name || course.persona?.course || 'This course');
  const docs = new Map(
    (course.foundation || [])
      .filter((doc) => doc && doc.name)
      .map((doc) => [String(doc.name).toLowerCase(), String(doc.name)])
  );
  const notes = (course.session?.notes || []).filter((note) => note && String(note.text || '').trim());

  // The newest edit per block wins; an older one is what it replaced.
  const latest = new Map();
  for (const edit of Array.isArray(edits) ? edits : []) {
    if (!edit || !edit.blockId) continue;
    const previous = latest.get(edit.blockId);
    if (!previous || Number(edit.at) >= Number(previous.at)) latest.set(edit.blockId, edit);
  }

  const sections = [];
  const counts = { sections: 0, blocks: 0, outline: 0, definition: 0, example: 0, hint: 0, pages: 0, moments: 0, notes: 0, edited: 0 };
  let total = 0;

  outer: for (const group of lecturesOf(notes)) {
    const blocks = [];
    for (const note of group) {
      const at = Number(note.at) || 0;
      for (const [line, text] of linesOf(note.text).entries()) {
        if (total >= MAX_BLOCKS) break outer;
        const anchors = anchorsFor(text, docs);
        if (!anchors.length && at) anchors.push({ kind: 'note', at, label: timeLabel(at) });
        const blockId = `r:${at || 'x'}:${line}`;
        const edit = latest.get(blockId);
        const kind = kindOf(text);
        blocks.push({
          id: blockId,
          kind,
          text,
          // The edit is beside the capture, never over it: `text` stays what was
          // captured so an edit can be removed and the original read again.
          edited: edit ? { text: String(edit.text || ''), at: Number(edit.at) || 0 } : null,
          anchors,
        });
        total += 1;
        counts[kind] += 1;
        for (const anchor of anchors) counts[anchor.kind === 'page' ? 'pages' : anchor.kind === 'moment' ? 'moments' : 'notes'] += 1;
        if (edit) counts.edited += 1;
      }
    }
    if (!blocks.length) continue;
    sections.push({
      id: `${id}-lecture-${sections.length + 1}`,
      title: `Lecture ${sections.length + 1}`,
      captured: dateLabel(Number(group[0]?.at) || 0),
      blocks,
    });
  }

  counts.sections = sections.length;
  counts.blocks = total;

  return {
    courseId: id,
    course: name,
    builtAt: now instanceof Date && !Number.isNaN(now.getTime()) ? now.toISOString() : '',
    sections,
    counts,
    note: sections.length
      ? ''
      : 'Nothing captured yet. Notes taken in Live become the reader, one lecture at a time.',
  };
}
