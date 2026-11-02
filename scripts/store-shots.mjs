/**
 * App Store screenshots from the live app, at Apple's required sizes.
 *
 * The preview panel draws its own badge over the page, so a panel capture always
 * carries something that is not the app. This drives the installed browser headless
 * through the DevTools protocol instead: each profile sets the exact CSS size and
 * device scale that renders Apple's pixel dimensions, and every tab is a real click.
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

// 430x932 at 3 is 1290x2796 (6.7 inch iPhone). 1032x1376 at 2 is 2064x2752
// (13 inch iPad), which App Review also requires for a universal app.
const PROFILES = [
  { dir: 'deploy/ios/store', width: 430, height: 932, scale: 3, label: '6.7 inch' },
  { dir: 'deploy/ios/store-ipad', width: 1032, height: 1376, scale: 2, label: '13 inch iPad' },
];

const SHOTS = [
  { file: '01-live.png', tab: 'live' },
  { file: '02-answer.png', tab: 'answer' },
  { file: '03-quiz.png', tab: 'quiz' },
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
    await mkdir(profile.dir, { recursive: true });
    await send('Emulation.setDeviceMetricsOverride', {
      width: profile.width,
      height: profile.height,
      deviceScaleFactor: profile.scale,
      mobile: profile === PROFILES[0],
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

    for (const shot of SHOTS) {
      const clicked = await send('Runtime.evaluate', {
        expression: `(() => {
          const tab = document.querySelector('.tab[data-tab="${shot.tab}"]');
          if (!tab) return 'no tab';
          tab.click();
          return tab.textContent.trim();
        })()`,
        returnByValue: true,
      });
      if (clicked.result?.value === 'no tab') throw new Error(`the ${shot.tab} tab is not on the page`);
      await sleep(700);
      const captured = await send('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(profile.dir, shot.file), Buffer.from(captured.data, 'base64'));
      console.log(`  ${profile.label} · ${shot.file} · ${shot.tab} tab`);
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
