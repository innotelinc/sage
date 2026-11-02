/**
 * App Store screenshots from the live app, at Apple's 6.7-inch size.
 *
 * The preview panel draws its own badge over the page, so a panel capture always
 * carries something that is not the app. This drives the installed browser headless
 * through the DevTools protocol instead: 430x932 CSS at a device scale of 3 renders
 * 1290x2796 exactly, and each tab is a real click on the real UI.
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
const OUT_DIR = process.env.SHOT_OUT || 'deploy/ios/store';
const PORT = 9333;

const SHOTS = [
  { file: '01-live.png', tab: 'live' },
  { file: '02-answer.png', tab: 'answer' },
  { file: '03-quiz.png', tab: 'quiz' },
];


const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const browser = BROWSERS.find((path) => existsSync(path));
if (!browser) {
  console.error('No Edge or Chrome found in the standard install locations.');
  process.exit(1);
}

await mkdir(OUT_DIR, { recursive: true });
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
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
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
    new Promise((resolve, reject) => {
      const id = (nextId += 1);
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  const once = (method, timeout = 15000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeout);
      events.set(method, (params) => {
        clearTimeout(timer);
        resolve(params);
      });
    });

  await send('Page.enable');
  await send('Runtime.enable');
  // Apple's 6.7-inch portrait: 1290x2796 at scale 3 is 430x932 CSS.
  await send('Emulation.setDeviceMetricsOverride', {
    width: 430,
    height: 932,
    deviceScaleFactor: 3,
    mobile: true,
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
    const state = clicked.result?.value;
    if (state === 'no tab') throw new Error(`the ${shot.tab} tab is not on the page`);
    await sleep(700);
    const captured = await send('Page.captureScreenshot', { format: 'png' });
    const path = join(OUT_DIR, shot.file);
    await writeFile(path, Buffer.from(captured.data, 'base64'));
    console.log(`  ${shot.file} · ${state} tab`);
  }

  ws.close();
} finally {
  child.kill();
  await sleep(900);
  // The profile holds open handles for a moment after exit on Windows.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rm(profile, { recursive: true, force: true });
      break;
    } catch {
      await sleep(500);
    }
  }
}
