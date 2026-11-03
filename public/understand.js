/**
 * What you understand.
 *
 * The base an essay is written from: the notes, answers, quiz items and papers
 * this course has already gathered, plus the register the user writes in. Pure
 * and DOM-free so it runs in Node, and so the essay brief can quote it verbatim
 * rather than the browser assembling the same digest twice.
 *
 * Nothing here invents material. It selects, clips and labels what is already on
 * the device, and says so in its first line.
 */

const MAX_LINE = 300;

function clip(value, max = MAX_LINE) {
  const text = String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  return text.slice(0, Math.max(1, max - 1)).trimEnd() + '…';
}

function listOf(value) {
  return Array.isArray(value) ? value : [];
}

function section(label, lines) {
  const kept = lines.filter(Boolean);
  return kept.length ? { label, lines: kept } : null;
}

function line(entry, fallback = '') {
  if (typeof entry === 'string') return clip(entry);
  if (!entry || typeof entry !== 'object') return fallback;
  return clip(entry.text || entry.note || entry.body || fallback);
}

/**
 * @param {object} course  { persona, memory, history, session } for one course
 * @param {object} options { limit } how many items per section (default 8)
 * @returns {{text:string, sections:object[], voice:string[], counts:object, empty:boolean, course:string}}
 */
export function gatherUnderstanding(course = {}, options = {}) {
  const limit = Math.max(1, Math.min(40, Number(options.limit) || 8));
  const persona = course.persona || {};
  const history = course.history || {};
  const session = course.session || {};

  // The lecture, twice over: the notes the user kept and the lines the agent
  // learned while sitting in it. Deduped, because those two overlap by design.
  const seen = new Set();
  const lecture = [];
  for (const item of [...listOf(session.notes), ...listOf(course.memory)]) {
    const text = line(item);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    lecture.push(text);
  }

  const answers = listOf(history.answers)
    .slice(-limit)
    .map((entry) => {
      const question = clip(entry && entry.question, 160);
      const answer = clip(entry && entry.answer);
      const working = clip(entry && entry.working, 240);
      if (!question && !answer) return '';
      return `${question || 'A question in class'} → ${answer}${working ? ` (${working})` : ''}`;
    });

  const quizzes = listOf(history.quizzes)
    .slice(-limit)
    .map((entry) => {
      const question = clip(entry && entry.question, 160);
      const answer = clip(entry && entry.answer, 200);
      const choice = clip(entry && entry.choice, 8);
      if (!question) return '';
      return `${question} → ${choice ? `${choice}. ` : ''}${answer}`;
    });

  const papers = listOf(history.papers)
    .slice(-Math.min(4, limit))
    .flatMap((paper) => {
      const head = paper && (paper.question || paper.title) ? `${clip(paper.question || paper.title, 140)} — ${clip(paper.answer, 40)}` : '';
      const fixes = listOf(paper && paper.fixes)
        .slice(0, 4)
        .map((fix) => {
          const text = clip(fix && fix.fix, 200);
          const prompt = clip(fix && fix.prompt, 120);
          return text ? `the mark left on the table: ${text}${prompt ? ` (${prompt})` : ''}` : '';
        });
      return [head, ...fixes];
    });

  const sections = [
    section('From the lectures', lecture.slice(-Math.max(limit, 10))),
    section('What you answered', answers),
    section('What the quizzes asked', quizzes),
    section('What the papers said', papers),
  ].filter(Boolean);

  // The register to write in: what this course has produced in the user's name.
  const voice = [
    ...listOf(history.answers).slice(-2).map((entry) => clip(entry && entry.answer, 400)),
    ...listOf(history.essays).slice(-1).map((entry) => clip(entry && entry.answer, 400)),
  ].filter(Boolean);

  const counts = {
    notes: lecture.length,
    answers: listOf(history.answers).length,
    quizzes: listOf(history.quizzes).length,
    papers: listOf(history.papers).length,
  };

  const text = [
    persona.course ? `Course: ${persona.course}` : '',
    'Gathered from what this course has already collected — lecture notes, your answers, the quiz items and the papers you sat. Edit it into your own words: the draft is written from this, not from the headings.',
    ...sections.map(({ label, lines }) => `## ${label}\n${lines.map((item) => `- ${item}`).join('\n')}`),
  ]
    .filter(Boolean)
    .join('\n\n');

  return {
    text,
    sections,
    voice,
    counts,
    empty: sections.length === 0,
    course: String(persona.course || ''),
  };
}
