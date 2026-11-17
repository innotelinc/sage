/**
 * App Store screenshots from the live app, at the sizes Apple currently asks for.
 *
 * The preview panel draws its own badge over the page, so a panel capture always
 * carries something that is not the app. This drives the installed browser headless
 * through the DevTools protocol, clicks real tabs and real dialogs, and sets the
 * exact CSS size and device scale that render Apple's pixel dimensions.
 *
 * Every state starts from a clean surface: any dialog left open by the previous shot
 * is closed first, because a modal that survives one capture silently turns the next
 * three into the same picture.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];

const URL_TO_LOAD = process.env.SAGE_URL || 'https://sage.innotel.tech/';
const PORT = 9333;

// 402x874 at 3 is 1206x2622 — the medium iPhone display (6.3 inch) the console asks
// for first. 1032x1376 at 2 is 2064x2752, the 13 inch iPad.
const PROFILES = [
  { dir: 'deploy/ios/store-phone', width: 402, height: 874, scale: 3, mobile: true, label: 'iPhone 6.3' },
  { dir: 'deploy/ios/store-ipad', width: 1032, height: 1376, scale: 2, mobile: false, label: 'iPad 13' },
  // 669x951 at 3 is 2007x2853 — the Duo's 7.6 inch inner display, the surface the app
  // actually runs on when the phone is open.
  { dir: 'deploy/ios/store-duo', width: 669, height: 951, scale: 3, mobile: true, label: 'iPhone Duo' },
];

const CLOSE_DIALOGS = `document.querySelectorAll('dialog[open]').forEach((d) => d.close());`;
const tab = (name) =>
  `${CLOSE_DIALOGS} document.querySelector('.tab[data-tab="${name}"]').click(); window.scrollTo(0, 0);`;

// Ten distinct surfaces, in the order someone would meet them.
const STATES = [
  { file: '01-live.png', label: 'Live · capture', run: tab('live') },
  {
    file: '02-answer.png',
    label: 'Answer',
    // A populated session puts the answer below the composer; a still of an empty
    // textarea sells nothing.
    run: `${tab('answer')} (() => { const el = document.getElementById('answerResult'); if (el) { const jump = () => { el.style.scrollMarginTop = '120px'; el.scrollIntoView({ block: 'start', behavior: 'instant' }); };
        jump(); setTimeout(jump, 350); } })();`,
  },
  { file: '03-quiz.png', label: 'Quiz', run: tab('quiz') },
  { file: '04-essay.png', label: 'Essay', run: tab('essay') },
  { file: '05-read.png', label: 'Read', run: tab('read') },
  {
    file: '06-memory.png',
    label: 'Memory',
    run: `${tab('memory')} (() => { const el = document.getElementById('traitsList'); if (el) { const jump = () => { el.style.scrollMarginTop = '72px'; el.scrollIntoView({ block: 'start', behavior: 'instant' }); };
        jump(); setTimeout(jump, 350); } })();`,
  },
  {
    file: '07-study-pack.png',
    label: 'Memory · study pack',
    run: `${tab('memory')} document.getElementById('btnPackExport').scrollIntoView({ block: 'center' });`,
  },
  {
    file: '08-settings-gateway.png',
    label: 'Settings · gateway',
    run: `${CLOSE_DIALOGS} document.getElementById('btnSettings').click(); const d = document.getElementById('settingsDialog'); d.scrollTop = 0; d.querySelector('form').scrollTop = 0;`,
  },
  {
    file: '09-watching.png',
    label: 'Watching the screen',
    run: `document.getElementById('screenDialog').showModal();`,
  },
  {
    // Scrolling the page slides content under the translucent header, which reads as a
    // glitch in a still. The dialog scrolls inside itself instead.
    file: '10-settings-you.png',
    label: 'Settings · you',
    run: `${CLOSE_DIALOGS} document.getElementById('btnSettings').click(); const d = document.getElementById('settingsDialog'); d.scrollTop = d.scrollHeight;`,
  },
];

// Optional population, so the listing shows the app working rather than its setup
// screens: a granted session code, redeemed through the first-run card, and the mock
// model (`node scripts/mock-model.mjs`) answering real coursework.
const SESSION_CODE = (process.env.SAGE_SESSION_CODE || '').trim();
const POPULATE = process.env.SAGE_POPULATE === '1';

const withInput = (id, value) => `
  const field = document.getElementById('${id}');
  if (!field) return false;
  field.value = ${JSON.stringify(value)};
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));`;

const SEED_STEPS = [
  {
    // Name the course first: everything generated below files itself under it.
    run: `
      const input = [...document.querySelectorAll('input')].find((i) => /BIO 101/.test(i.placeholder || ''));
      if (input) {
        input.value = 'BIO 101 — Cell biology';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Start')?.click();
      }`,
    wait: 2000,
  },
  {
    run: `${tab('answer')}
      ${withInput('answerText', 'A 3 kg block is pushed across a bench with 12 N. The coefficient of kinetic friction is 0.2 — what is its acceleration?')}
      document.getElementById('btnAnswer')?.click();`,
    wait: 4000,
  },
  {
    run: `${tab('quiz')}
      ${withInput('quizText', '1. Which organelle supplies most of the cell’s ATP?\n\n2. Explain why a plant cell does not burst in pure water.')}
      (document.getElementById('btnQuizSolve') || document.getElementById('btnQuiz'))?.click();`,
    wait: 6000,
  },
  {
    run: `${tab('essay')}
      ${withInput('essayTopic', 'The cost of forgetting: what ageing water infrastructure owes the next city')}
      document.getElementById('btnEssay')?.click();`,
    wait: 7000,
  },
  {
    run: `${tab('read')}
      ${withInput('readPaste', 'Osmosis is the net movement of water across a semi-permeable membrane, down its water potential gradient. Water potential is the sum of solute potential and pressure potential. Turgor pressure keeps a plant cell from bursting in pure water. ATP synthase is a rotary motor driven by the proton gradient across the inner mitochondrial membrane; the cristae increase its surface area.')}
      document.getElementById('btnRead')?.click();`,
    wait: 7000,
  },
  {
    // A durable memory the operator typed, and the mock's self-evolve pass. Notes come
    // from the microphone, so the Memory frame is set on what it learned rather than on
    // a counter that would read zero in a headless capture.
    run: `${tab('memory')}
      const add = document.getElementById('memoryAdd');
      const save = document.getElementById('btnMemoryAdd');
      const taught = [
        'This instructor wants the marking-scheme wording first, then the explanation.',
        'Midterm covers cristae, oxidative phosphorylation and water potential.',
        'Answer in the order the rubric lists, not the order I understand it.',
        'Cite the lecture slide number when a definition is asked for.',
      ];
      if (add && save) {
        for (const text of taught) {
          add.value = text;
          add.dispatchEvent(new Event('change', { bubbles: true }));
          save.click();
        }
      }
      document.getElementById('btnEvolve')?.click();`,
    wait: 6000,
  },
];

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const browser = BROWSERS.find((path) => existsSync(path));
if (!browser) {
  console.error('No Edge or Chrome found in the standard install locations.');
  process.exit(1);
}

const profile = resolve('.tmp-shots-profile');
const child = spawn(
  browser,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

async function target() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const pages = (await res.json()).filter((item) => item.type === 'page');
      if (pages.length) return pages[0].webSocketDebuggerUrl;
    } catch {
      /* not listening yet */
    }
    await sleep(250);
  }
  throw new Error('the browser never opened a debugging port');
}

try {
  const ws = new WebSocket(await target());
  await new Promise((done, fail) => {
    ws.addEventListener('open', done, { once: true });
    ws.addEventListener('error', fail, { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  const events = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const handlers = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) handlers.reject(new Error(JSON.stringify(message.error)));
      else handlers.resolve(message.result);
      return;
    }
    const waiter = events.get(message.method);
    if (waiter) {
      events.delete(message.method);
      waiter(message.params);
    }
  });

  const send = (method, params = {}) =>
    new Promise((done, fail) => {
      const id = (nextId += 1);
      pending.set(id, { resolve: done, reject: fail });
      ws.send(JSON.stringify({ id, method, params }));
    });

  const once = (method, timeout = 20000) =>
    new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`${method} timed out`)), timeout);
      events.set(method, (params) => {
        clearTimeout(timer);
        done(params);
      });
    });

  await send('Page.enable');
  await send('Runtime.enable');

  const only = (process.env.SAGE_PROFILES || '').split(',').map((item) => item.trim()).filter(Boolean);
  for (const profile of PROFILES) {
    // The filter takes the slot name (`store-phone`), not the path it lives under.
    if (only.length && !only.some((name) => profile.dir.endsWith(name))) continue;
    // Start from an empty directory so a renamed state can never leave a stale image
    // behind and inflate the set Apple receives.
    await rm(profile.dir, { recursive: true, force: true });
    await mkdir(profile.dir, { recursive: true });

    await send('Emulation.setDeviceMetricsOverride', {
      width: profile.width,
      height: profile.height,
      deviceScaleFactor: profile.scale,
      mobile: profile.mobile,
    });

    // The listing is the dark surface, and so is the header art beside it. A headless
    // browser reports prefers-color-scheme: light, which the app honours, so without
    // this line every capture comes back in the light theme.
    await send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'dark' }],
    });

    const loaded = once('Page.loadEventFired');
    await send('Page.navigate', { url: URL_TO_LOAD });
    await loaded;
    await sleep(1200);

    // Without a session key the app raises a fixed error toast. It is a runtime
    // condition, not part of the interface, and it must not be in a store screenshot.
    await send('Runtime.evaluate', {
      expression: `(() => {
        const style = document.createElement('style');
        style.textContent = '#toast { display: none !important; }';
        document.head.appendChild(style);
        return true;
      })()`,
    });

    // An empty app photographs as a setup screen, which is not what a listing should
    // sell, but half of what a populated session shows — an answer, a quiz result —
    // lives in the page rather than in storage, so each slot is populated from a
    // cleared workspace: every slot then shows the same session instead of the first
    // slot showing results and the rest showing empty composers.
    if (POPULATE) {
      await send('Runtime.evaluate', { expression: '(() => { try { localStorage.clear(); } catch {} return true; })()' });
      const fresh = once('Page.loadEventFired');
      await send('Page.navigate', { url: URL_TO_LOAD });
      await fresh;
      await sleep(1200);
      await send('Runtime.evaluate', {
        expression: `(() => {
          const style = document.createElement('style');
          style.textContent = '#toast { display: none !important; }';
          document.head.appendChild(style);
          return true;
        })()`,
      });
    }

    if (SESSION_CODE) {
      await send('Runtime.evaluate', {
        expression: `(() => {
          const field = document.getElementById('setupCode') || document.getElementById('setGrantCode');
          const button = document.getElementById('btnSetupCode') || document.getElementById('btnRedeemGrant');
          if (!field || !button) return 'no redeem control';
          field.value = ${JSON.stringify(SESSION_CODE)};
          button.click();
          return 'redeeming';
        })()`,
      });
      await sleep(2000);
    }

    if (POPULATE) {
      for (const step of SEED_STEPS) {
        await send('Runtime.evaluate', { expression: `(() => { ${step.run} return true; })()` });
        await sleep(step.wait || 2500);
      }
    }

    for (const state of STATES) {
      await send('Runtime.evaluate', { expression: `(() => { ${state.run} return true; })()` });
      await sleep(650);
      const captured = await send('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(profile.dir, state.file), Buffer.from(captured.data, 'base64'));
      console.log(`  ${profile.label} · ${state.file} · ${state.label}`);
    }
  }

  ws.close();
} finally {
  // `child.kill()` leaves Edge's renderer and GPU processes behind, and the next run
  // then finds the profile locked. Kill the tree, not just the launcher.
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      child.kill();
    }
  } else {
    child.kill();
  }
  await sleep(1200);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rm(profile, { recursive: true, force: true });
      break;
    } catch {
      await sleep(500);
    }
  }
}
