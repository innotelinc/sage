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
];

const CLOSE_DIALOGS = `document.querySelectorAll('dialog[open]').forEach((d) => d.close());`;
const tab = (name) =>
  `${CLOSE_DIALOGS} document.querySelector('.tab[data-tab="${name}"]').click(); window.scrollTo(0, 0);`;

// Ten distinct surfaces, in the order someone would meet them.
const STATES = [
  { file: '01-live.png', label: 'Live · capture', run: tab('live') },
  { file: '02-answer.png', label: 'Answer', run: tab('answer') },
  { file: '03-quiz.png', label: 'Quiz', run: tab('quiz') },
  { file: '04-essay.png', label: 'Essay', run: tab('essay') },
  { file: '05-read.png', label: 'Read', run: tab('read') },
  { file: '06-memory.png', label: 'Memory', run: tab('memory') },
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
    run: `${tab('live')} document.getElementById('btnScreen').click();`,
  },
  {
    file: '10-memory-notes.png',
    label: 'Memory · notes and timetable',
    run: `${tab('memory')} document.getElementById('memoryList').scrollIntoView({ block: 'center' });`,
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

  for (const profile of PROFILES) {
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
  child.kill();
  await sleep(900);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rm(profile, { recursive: true, force: true });
      break;
    } catch {
      await sleep(500);
    }
  }
}
