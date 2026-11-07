/**
 * Measured grounding (5.1).
 *
 * Every release says a reply is grounded; this is the thing that measures it.
 * A golden set lives per course under docs/golden/: documents with their pages,
 * questions with the page that answers them, and questions the material does not
 * answer at all. Each case is run through the real /api/chat path, so the prompt,
 * the citation parser and the grounding report are all under test — not a mock of
 * them.
 *
 *   node scripts/golden.mjs              # the stub model, no key, no bill
 *   node scripts/golden.mjs --live       # the gateway, on a budget
 *   node scripts/golden.mjs --update     # record today's scores as the baseline
 *
 * Three scores come out, and a release that drops any of them fails:
 *
 *   grounding   — of the answerable questions, how many cited a page at all
 *   citation    — of the pages cited, how many exist in the material and are the
 *                 page that actually answers the question (invented pages count
 *                 here, which is the point: 4.2 promises they never appear)
 *   refusal     — of the questions the material cannot answer, how many said so
 *                 instead of inventing an answer
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { handleRequest } from '../src/app.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
export const GOLDEN_DIR = join(HERE, '..', 'docs', 'golden');
export const BASELINE_FILE = join(GOLDEN_DIR, 'baseline.json');

/** A reply that admits the gap. Deliberately broad: the wording is not the point. */
export const REFUSAL = /\b(not in the (material|handout|sources?|documents?)|isn'?t in|is not in|no (mention|record|page|mark)|cannot (find|say|answer)|can'?t (find|say|answer)|do not have|don'?t have|not covered|nothing (in|about))\b/i;

/** The page labels a document actually offers to a citation. */
export function pagesOf(doc) {
  return (doc.segments || []).map((segment) => String(segment.locator || '')).filter(Boolean);
}

/**
 * One case, scored against what the server actually returned.
 *
 * The server drops a citation to a document it was never given, so what arrives
 * here is already narrowed; what it cannot know is whether the page exists, and
 * whether it was the page that answers the question. Both are checked here.
 */
export function scoreCase(golden, kase, body) {
  const cited = Array.isArray(body.citations) ? body.citations : [];
  const docs = golden.documents || [];
  const expected = kase.expect?.citations || [];
  const reply = String(body.reply || '');

  const real = cited.filter((citation) => {
    const doc = docs.find((entry) => entry.name === citation.name);
    return Boolean(doc && pagesOf(doc).includes(String(citation.locator)));
  });
  const invented = cited.filter((citation) => !real.includes(citation));

  const wanted = expected.every((want) =>
    cited.some((got) => got.name === want.name && String(got.locator) === String(want.locator))
  );

  if (kase.expect?.refuse) {
    const ok = cited.length === 0 && REFUSAL.test(reply);
    return {
      id: kase.id,
      kind: 'refusal',
      ok,
      detail: ok ? 'admitted the gap' : cited.length ? `cited ${cited.length} page(s) for material it does not have` : 'answered anyway',
      invented: invented.length,
    };
  }

  const ok = wanted && invented.length === 0 && cited.length > 0;
  return {
    id: kase.id,
    kind: 'answer',
    ok,
    detail: ok
      ? `cited ${expected.map((c) => `${c.name} ${c.locator}`).join(', ')}`
      : !cited.length
      ? 'answered without citing a page'
      : invented.length
      ? `cited ${invented.map((c) => `${c.name} ${c.locator}`).join(', ')}, which is not a page it was given`
      : `cited ${cited.map((c) => `${c.name} ${c.locator}`).join(', ')} instead of ${expected.map((c) => `${c.name} ${c.locator}`).join(', ')}`,
    invented: invented.length,
    cited: cited.length,
  };
}

/** Totals over every scored case, which is what the baseline compares. */
export function summarise(results) {
  const answers = results.filter((r) => r.kind === 'answer');
  const refusals = results.filter((r) => r.kind === 'refusal');
  const citedTotal = answers.reduce((sum, r) => sum + (r.cited || 0), 0);
  const inventedTotal = answers.reduce((sum, r) => sum + (r.invented || 0), 0);
  return {
    cases: results.length,
    grounding: answers.length ? answers.filter((r) => r.cited > 0).length / answers.length : 1,
    citation: citedTotal ? 1 - inventedTotal / citedTotal : 1,
    refusal: refusals.length ? refusals.filter((r) => r.ok).length / refusals.length : 1,
  };
}

/** Every course set in docs/golden, baseline excluded. */
export function loadGolden() {
  if (!existsSync(GOLDEN_DIR)) throw new Error(`no golden sets in ${GOLDEN_DIR}`);
  const files = readdirSync(GOLDEN_DIR).filter((name) => name.endsWith('.json') && name !== 'baseline.json');
  if (!files.length) throw new Error('docs/golden holds a baseline but no course sets');
  return files.map((file) => {
    const golden = JSON.parse(readFileSync(join(GOLDEN_DIR, file), 'utf8'));
    if (!golden.course || !Array.isArray(golden.documents) || !Array.isArray(golden.cases)) {
      throw new Error(`${file} needs course, documents and cases`);
    }
    for (const kase of golden.cases) {
      if (!kase.id || !kase.question) throw new Error(`${file} has a case without an id or a question`);
      if (!kase.expect?.refuse && !kase.expect?.citations?.length) {
        throw new Error(`${file} case ${kase.id} says nothing about what a right answer is`);
      }
    }
    return { file, golden };
  });
}

/** The documents as the app sends them: text for the prompt, pages for the citation. */
export function sourcesOf(golden) {
  return (golden.documents || []).map((doc) => ({
    name: doc.name,
    kind: doc.kind || 'text',
    text: (doc.segments || [{ locator: '', text: doc.text || '' }]).map((s) => s.text).join('\n\n'),
    segments: (doc.segments || []).map((s) => ({ locator: s.locator, text: s.text })),
  }));
}

/**
 * Run one case through the real chat handler. In stub mode the model is replaced
 * by the case's own scripted reply, which is what lets CI score the plumbing with
 * no key and no bill; --live lets the gateway answer instead.
 */
export async function runCase(golden, kase, { live = false, scripted = null } = {}) {
  const realFetch = globalThis.fetch;
  if (!live) {
    globalThis.fetch = async (url, init = {}) => {
      if (String(url).endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'stub/chat' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      const body = JSON.parse(init.body || '{}');
      return new Response(JSON.stringify({ choices: [{ message: { content: scripted } }], usage: { total_tokens: 10 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
  }
  try {
    const runtime = { accessRequired: () => false, accessAccepted: () => false };
    const res = await handleRequest(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: kase.mode || 'answer', text: kase.question, sources: sourcesOf(golden) }),
      }),
      { AI_API_KEY: live ? process.env.AI_API_KEY : 'stub', AI_CHAT_MODEL: live ? process.env.AI_CHAT_MODEL || '' : 'stub/chat' },
      runtime
    );
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${res.status} ${body.message || body.error || ''}`.trim());
    return body;
  } finally {
    globalThis.fetch = realFetch;
  }
}

function pct(value) {
  return `${(value * 100).toFixed(0)}%`;
}

async function main(argv) {
  const live = argv.includes('--live');
  const update = argv.includes('--update');
  const limitAt = argv.indexOf('--limit');
  const limit = limitAt >= 0 ? Number(argv[limitAt + 1]) || 12 : 12;

  if (live && !process.env.AI_API_KEY) {
    console.error('\n--live needs AI_API_KEY. Without a key, run the stub: node scripts/golden.mjs\n');
    process.exit(2);
  }

  const sets = loadGolden();
  const results = [];
  console.log(`\nmeasured grounding — ${live ? 'gateway' : 'stub model'}${live ? `, ${limit} cases at most` : ''}`);

  for (const { golden } of sets) {
    console.log(`\n  ${golden.course}`);
    for (const kase of golden.cases.slice(0, live ? limit : golden.cases.length)) {
      let body;
      try {
        body = await runCase(golden, kase, { live, scripted: kase.reply });
      } catch (error) {
        results.push({ id: kase.id, kind: kase.expect?.refuse ? 'refusal' : 'answer', ok: false, detail: `request failed: ${error.message}` });
        console.log(`  FAIL ${kase.id} — request failed: ${error.message}`);
        continue;
      }
      const scored = scoreCase(golden, kase, body);
      results.push(scored);
      console.log(`  ${scored.ok ? 'ok  ' : 'FAIL'} ${kase.id} — ${scored.detail}`);
    }
  }

  const totals = summarise(results);
  console.log(
    `\n  ${totals.cases} case(s): grounding ${pct(totals.grounding)}, citation accuracy ${pct(totals.citation)}, refusal ${pct(totals.refusal)}\n`
  );

  if (update) {
    writeFileSync(
      BASELINE_FILE,
      `${JSON.stringify({ provider: live ? 'gateway' : 'stub', ...totals, recordedAt: new Date().toISOString().slice(0, 10) }, null, 2)}\n`
    );
    console.log(`  baseline recorded in docs/golden/baseline.json\n`);
  }

  if (!live && existsSync(BASELINE_FILE)) {
    const baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));
    const regressions = ['grounding', 'citation', 'refusal'].filter((metric) => totals[metric] < Number(baseline[metric] || 0) - 1e-9);
    if (regressions.length) {
      console.error(
        `  regression against the ${baseline.recordedAt || 'recorded'} baseline: ${regressions
          .map((metric) => `${metric} ${pct(Number(baseline[metric]))} → ${pct(totals[metric])}`)
          .join(', ')}\n`
      );
      process.exitCode = 1;
      return;
    }
    console.log(`  no regression against the ${baseline.recordedAt || 'recorded'} baseline\n`);
  }

  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
