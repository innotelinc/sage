/**
 * Sage for Windows: the same app, on the desktop, with nothing to host.
 *
 * The renderer is the normal SAGE page served by the normal Node server — the
 * main process picks a free loopback port, imports server.mjs, waits for it to
 * answer, then points a window at it. No remote origin, no CORS, and the
 * gateway key lives in the same localStorage the browser build uses.
 */
import { app, BrowserWindow, desktopCapturer, session, shell } from 'electron';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
let serverPort = 0;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitForServer(port, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch {
      /* still starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function startServer() {
  serverPort = await freePort();
  // server.mjs reads PORT at import time; .env is absent in the packaged app, so
  // this stays a plain-HTTP loopback server with no certificate to find.
  process.env.PORT = String(serverPort);
  process.env.SAGE_DESKTOP = '1';
  await import(pathToFileURL(path.join(root, 'server.mjs')).href);
  const ready = await waitForServer(serverPort);
  if (!ready) throw new Error(`SAGE server did not answer on ${serverPort}`);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#080b12',
    title: 'Sage',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Chromium throttles timers in an occluded or minimised window. The frame
      // sampler is a timer, so without this the lecture stops being captured the
      // moment another application takes the screen.
      backgroundThrottling: false,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`http://127.0.0.1:${serverPort}`)) return { action: 'allow' };
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  win.loadURL(`http://127.0.0.1:${serverPort}/`);
  return win;
}

app.whenReady().then(async () => {
  // Watch captures the screen. Chromium would otherwise show a picker that only
  // exists in a browser; on the desktop app, share the primary screen directly so
  // the lecture keeps being sampled after you switch to another window.
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => {
          const primary = sources.find((source) => source.id.startsWith('screen:')) || sources[0];
          if (primary) callback({ video: primary });
          else callback({});
        })
        .catch(() => callback({}));
    },
    // The OS picker lets you choose a single window, and a window capture pauses
    // as soon as that window is not in front — which is exactly when a lecture
    // needs watching. Answering the request ourselves always shares the desktop.
    { useSystemPicker: false },
  );

  try {
    await startServer();
  } catch (error) {
    // A window with the error beats a silent exit with no explanation.
    const win = new BrowserWindow({ width: 720, height: 320, backgroundColor: '#080b12' });
    win.loadURL(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(
          `<body style="font:14px system-ui;background:#080b12;color:#e8eef8;padding:24px">
             <h2 style="margin:0 0 8px">Sage could not start</h2>
             <p style="color:#8b9ab3">${String(error && error.message ? error.message : error)}</p>
           </body>`,
        ),
    );
    return;
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
