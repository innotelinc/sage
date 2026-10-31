/**
 * Local mock of an OpenAI-compatible endpoint, for trying the UI without a key
 * or a bill. Returns canned but shape-correct responses.
 *
 *   node scripts/mock-model.mjs
 *   AI_BASE_URL=http://localhost:9099/v1 AI_API_KEY=mock npm run dev
 */
import http from 'node:http';

const port = Number(process.env.MOCK_PORT) || 9099;

function reply(messages) {
  const system = String(messages.find((m) => m.role === 'system')?.content || '');
  const user = messages.filter((m) => m.role === 'user').pop()?.content;
  const text = Array.isArray(user) ? String(user.find((p) => p.type === 'text')?.text || '') : String(user || '');
  const hasImage = Array.isArray(user) && user.some((p) => p.type === 'image_url');

  if (system.includes('Current task (Quiz / test mode)')) {
    return '{"choice":"B","answer":"The mitochondrion, because oxidative phosphorylation supplies most ATP.","points":["Inner membrane hosts the electron transport chain","Proton gradient drives ATP synthase"],"confidence":0.93,"why":"Standard cell biology; the distractors lack cristae."}';
  }
  if (system.includes('Current task (Self-evolve)')) {
    return '{"traits":["Lead with the marking-scheme wording before explaining","Keep spoken answers under 20 seconds"],"summary":"This instructor rewards precise terminology first and elaboration second, so I will name the concept before unpacking it."}';
  }
  if (system.includes('Current task (What do I say?)')) {
    return '1. It is the mitochondrion — ATP comes from the proton gradient across the inner membrane.\n2. Would you like me to connect that to the glycolysis numbers from last week?\n3. I would want to check the exact figure, but the mechanism is oxidative phosphorylation.';
  }
  if (system.includes('Current task (Answer a question)')) {
    return '{"answer":"The 3 kg block accelerates at 2.0 m/s² once friction is subtracted.","working":"F_net = 12 N − μmg = 12 − 0.2×3×9.81 ≈ 6.1 N; a = F_net/m ≈ 2.0 m/s².","confidence":0.88,"why":"Newton II with kinetic friction resolved along the surface.","sayThis":"Net force is about six newtons after friction, so it accelerates at roughly two metres per second squared."}';
  }
  if (system.includes('Current task (Write an essay)')) {
    return '# The cost of forgetting\n\nEvery argument about urban water begins with a map that is already out of date. ' +
      'The aqueducts that made the twentieth-century city possible were designed for a climate that no longer exists, ' +
      'and the institutions that maintain them were designed for a ratepayer base that has since moved away.\n\n' +
      'What follows from that is not decline but a different kind of arithmetic. A city that loses a quarter of its ' +
      'supply to leakage is not short of water; it is short of maintenance capacity, and the two are fixed by ' +
      'different budgets on different election cycles.\n\n' +
      'The objection is familiar: repairs are expensive and the benefits are invisible. That is true, and it is also ' +
      'why the cheapest litre is the one never lost. The map, in other words, is not the problem. Believing it is.\n\n' +
      'Word count: 168';
  }
  if (system.includes('Current task (Read & extract)')) {
    return '## Key concepts\n- Osmosis: net water movement across a semi-permeable membrane down its water potential gradient.\n- Water potential (Ψ) = solute potential + pressure potential.\n\n## Formulas\n- Ψ = Ψs + Ψp\n\n## Likely questions\n1. Predict the direction of water movement between two given Ψ values.\n2. Explain why a plant cell does not burst in pure water.\n\n## Gaps\n- The material references turgor pressure without defining the wall stress relationship.';
  }

  return `- ${hasImage ? 'Slide: ' : ''}The lecture defines ATP synthase as a rotary motor driven by the proton gradient.\n- EXAM: the instructor said the cristae diagram will be on the midterm.`;
}

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf8');

  if (req.url.endsWith('/chat/completions')) {
    let messages = [];
    try {
      messages = JSON.parse(body).messages || [];
    } catch {
      /* ignore */
    }
    const content = reply(messages);
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        id: 'mock',
        model: 'mock-model',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 500, completion_tokens: 120, total_tokens: 620 },
      })
    );
    return;
  }

  if (req.url.endsWith('/audio/transcriptions')) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({ text: 'The exam will cover chapters four through six, and the diagram question is worth ten marks.' })
    );
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not found' }));
});

server.listen(port, () => console.log(`mock model on http://localhost:${port}/v1`));
