/* Sage — course-taking agent client.
   Capture (mic / screen / camera / files), reasoning, and a memory that persists. */

const $ = (id) => document.getElementById(id);
const LS_KEY = 'sage.course-agent.v1';
const IS_NATIVE = /^(capacitor|ionic):$/.test(location.protocol) || Boolean(window.__SAGE_NATIVE__);
// The Android shell carries its own capture (a foreground service holding a
// MediaProjection). A page's own getDisplayMedia ends the moment the browser
// loses the foreground, and the WebView does not offer it at all, which is why
// this exists: the exam is in the other app.
const NATIVE_SCREEN = (() => {
  const bridge = window.Capacitor;
  if (!bridge?.isNativePlatform?.() || bridge.getPlatform?.() !== 'android') return null;
  try {
    return (bridge.registerPlugin ? bridge.registerPlugin('SageScreen') : bridge.Plugins?.SageScreen) || null;
  } catch {
    return null;
  }
})();
// iOS has no in-app capture at all: an RPScreenRecorder is suspended with the
// app. A ReplayKit broadcast extension runs in its own process instead, so Watch
// hands the recording to one and collects what it read.
const NATIVE_BROADCAST = (() => {
  const bridge = window.Capacitor;
  if (!bridge?.isNativePlatform?.() || bridge.getPlatform?.() !== 'ios') return null;
  try {
    return (bridge.registerPlugin ? bridge.registerPlugin('SageBroadcast') : bridge.Plugins?.SageBroadcast) || null;
  } catch {
    return null;
  }
})();
const GATEWAY_DEFAULT = 'https://gateway.innotel.us/v1';

/* ── state ─────────────────────────────────────────────────── */
const defaultState = () => ({
  persona: { name: 'Sage', course: '', tone: 'warm', depth: 'balanced', humour: 3, risk: 2, traits: [] },
  language: '',
  settings: {
    tts: true,
    autoNotes: true,
    noteIntervalSec: 20,
    snapSec: 6,
    accessCode: '',
    ttsVoice: '',
    gatewayKey: '',
    receiptEmail: '',
    gatewayBase: 'https://gateway.innotel.us/v1',
    // Set only for a key bought as a session: the moment its window closes.
    keyExpiresAt: '',
  },
  memory: [],
  evolution: [],
  // The record a revision sheet and a study pack are built from.
  history: { answers: [], quizzes: [], essays: [], sources: [] },
  session: { transcript: [], notes: [] },
  // A workspace holds several courses. The fields above are the active course's
  // own copy — the rest of the app already reads state.persona and state.memory,
  // so switching a course is a copy in and out rather than a rewrite of every
  // call site.
  courses: [],
  timetable: [],
  activeId: '',
  // The moment of the last save here, so a copy from the server can be judged
  // newer or older without a second table of revisions.
  savedAt: '',
  ui: { tab: 'live' },
});

const WEEKDAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function uid(prefix = 'c') {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function defaultCourse(seed = {}) {
  return {
    id: seed.id || uid('c'),
    persona: {
      name: 'Sage',
      course: '',
      tone: 'warm',
      depth: 'balanced',
      humour: 3,
      risk: 2,
      traits: [],
      ...(seed.persona || {}),
    },
    memory: Array.isArray(seed.memory) ? seed.memory : [],
    evolution: Array.isArray(seed.evolution) ? seed.evolution : [],
    history: normalizeHistory(seed.history),
    session: { transcript: [], notes: [], ...(seed.session || {}) },
  };
}

function normalizeTimetable(raw) {
  if (!Array.isArray(raw)) return [];
  const isClock = (value) => /^\d\d:\d\d$/.test(String(value || ''));
  return raw
    .filter((slot) => slot && typeof slot === 'object' && isClock(slot.start) && isClock(slot.end))
    .map((slot) => ({
      id: slot.id || uid('s'),
      courseId: String(slot.courseId || ''),
      days: (Array.isArray(slot.days) ? slot.days : []).map(Number).filter((day) => day >= 0 && day <= 6),
      start: String(slot.start),
      end: String(slot.end),
      label: String(slot.label || '').slice(0, 60),
    }))
    .filter((slot) => slot.courseId && slot.days.length);
}

function activeCourse() {
  return state.courses.find((course) => course.id === state.activeId) || state.courses[0] || null;
}

function courseById(id) {
  return state.courses.find((course) => course.id === id) || null;
}

function stashActive() {
  const course = activeCourse();
  if (!course) return;
  course.persona = state.persona;
  course.memory = state.memory;
  course.evolution = state.evolution;
  course.history = state.history;
  course.session = state.session;
}

function hydrateActive() {
  const course = activeCourse();
  if (!course) return;
  state.persona = course.persona;
  state.memory = course.memory;
  state.evolution = course.evolution;
  state.history = course.history;
  state.session = course.session;
}

let state = defaultState();
let health = null;

function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) {
      // A device with nothing saved still takes one course, so the switcher,
      // the timetable and every answer have somewhere to live from the first tap.
      state.courses = [defaultCourse()];
      state.activeId = state.courses[0].id;
      hydrateActive();
      return;
    }
    const saved = JSON.parse(raw);
    const base = defaultState();
    state = {
      ...base,
      ...saved,
      settings: { ...base.settings, ...(saved.settings || {}) },
      ui: { tab: 'live', ...(saved.ui || {}) },
    };
    // 2.4 turned one course into a workspace. A 2.3 save keeps its course,
    // memory and history at the top level, so it becomes course one instead of
    // a migration the user has to perform.
    let courses = Array.isArray(saved.courses)
      ? saved.courses.filter((course) => course && typeof course === 'object').map((course) => defaultCourse(course))
      : [];
    if (!courses.length) {
      courses = [
        defaultCourse({
          persona: saved.persona,
          memory: saved.memory,
          evolution: saved.evolution,
          history: saved.history,
          session: saved.session,
        }),
      ];
    }
    state.courses = courses;
    state.activeId = courses.some((course) => course.id === saved.activeId) ? saved.activeId : courses[0].id;
    state.timetable = normalizeTimetable(saved.timetable);
    hydrateActive();
  } catch {
    state = defaultState();
  }
}

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      state.session.transcript = state.session.transcript.slice(-300);
      state.session.notes = state.session.notes.slice(-120);
      state.memory = state.memory.slice(-400);
      trimHistory();
      stashActive();
      state.savedAt = new Date().toISOString();
      localStorage.setItem(LS_KEY, JSON.stringify(state));
      queueWorkspacePush();
    } catch {
      /* storage full — keep running */
    }
  }, 250);
}

/* ── across devices ────────────────────────────────────────── */
// The workspace can also live on the server, keyed to whoever is asking: a panel
// session names a person, otherwise the access code names this instance. Either
// way one copy follows the phone and the browser between them; with neither, it
// stays in localStorage exactly as it did before.
const SYNC_DEBOUNCE_MS = 3500;
const sync = { state: 'idle', rev: '', at: '', storedBy: '', message: '', timer: null, dirty: false };

function syncAge(iso) {
  const then = Date.parse(String(iso || ''));
  if (!then) return 'just now';
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function renderSyncUi() {
  const label = $('syncStatus');
  if (!label) return;
  if (sync.state === 'syncing') label.textContent = 'Syncing…';
  else if (sync.state === 'synced') label.textContent = `In step with the server · saved ${syncAge(sync.at)}${sync.storedBy ? ` as ${sync.storedBy}` : ''}.`;
  else if (sync.state === 'pulled') label.textContent = `Picked up a newer copy from the server · saved ${syncAge(sync.at)}.`;
  else if (sync.state === 'local') label.textContent = 'On this device only — set the access code in Settings, or sign in to the panel, to keep this workspace on the server.';
  else if (sync.state === 'error') label.textContent = sync.message || 'Could not reach the server; the workspace is safe on this device.';
  else label.textContent = 'Checking the server…';
}

function workspaceSnapshot() {
  stashActive();
  return {
    activeId: state.activeId,
    courses: state.courses,
    timetable: state.timetable,
    savedAt: new Date().toISOString(),
  };
}

// Adopting writes straight to storage rather than through persist(), because
// persist() schedules a push and a pull that pushes straight back would loop.
function adoptWorkspace(workspace, savedAt) {
  const courses = Array.isArray(workspace?.courses) ? workspace.courses : [];
  if (!courses.length) return false;
  state.courses = courses.map((course) => defaultCourse(course));
  state.timetable = normalizeTimetable(workspace.timetable);
  state.activeId = state.courses.some((course) => course.id === workspace.activeId) ? workspace.activeId : state.courses[0].id;
  state.savedAt = savedAt || workspace.savedAt || new Date().toISOString();
  hydrateActive();
  try {
    stashActive();
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  } catch {
    /* storage full — the adopted copy lives in memory at least */
  }
  renderCourseUi();
  renderMemory();
  hydrateFeeds();
  updateStatus();
  renderPackStatus();
  return true;
}

async function pushWorkspace(announce = false, depth = 0) {
  const snapshot = workspaceSnapshot();
  const headers = { 'content-type': 'application/json' };
  if (state.settings.accessCode) headers['x-access-code'] = state.settings.accessCode;
  const res = await fetch(apiUrl('/api/workspace'), {
    method: 'PUT',
    headers,
    body: JSON.stringify({ baseRev: sync.rev, workspace: snapshot }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 409 && data.workspace && depth < 2) {
    // Another device saved first. Its copy wins only when it is genuinely newer;
    // otherwise this device holds the newest work and goes again on top of it.
    if (String(data.savedAt || '') > String(state.savedAt || '')) {
      adoptWorkspace(data.workspace, data.savedAt);
      sync.rev = data.rev || '';
      sync.at = data.savedAt || '';
      sync.state = 'pulled';
      renderSyncUi();
      if (announce) toast('Kept the newer copy from the server.');
      return;
    }
    sync.rev = data.rev || '';
    return pushWorkspace(announce, depth + 1);
  }
  if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
  state.savedAt = snapshot.savedAt;
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  } catch {
    /* keep running */
  }
  sync.rev = data.rev || '';
  sync.at = data.savedAt || '';
  sync.storedBy = data.storedBy || sync.storedBy;
  sync.dirty = false;
  sync.state = 'synced';
  renderSyncUi();
  if (announce) toast('Workspace saved to the server.');
}

// A device with nothing of its own has nothing to protect, so it takes the copy
// on the server whatever the clocks say. That is what opening Sage on a second
// device has to mean; trusting timestamps alone let a fresh install push its one
// untitled course over a real workspace.
function isPristine() {
  if (state.courses.length !== 1 || state.timetable.length) return false;
  const [course] = state.courses;
  if (course.persona.course || (course.persona.traits || []).length) return false;
  if (course.memory.length || course.evolution.length) return false;
  const history = course.history || {};
  for (const key of ['answers', 'quizzes', 'essays', 'sources']) {
    if ((history[key] || []).length) return false;
  }
  const session = course.session || {};
  return !(session.notes || []).length && !(session.transcript || []).length;
}

async function syncWorkspace({ announce = false } = {}) {
  clearTimeout(sync.timer);
  sync.timer = null;
  // A code entered in Settings is a new identity for the server, so a device
  // that had given up on sync tries again rather than waiting for a reload.
  if (sync.state === 'local' && !announce && !state.settings.accessCode) return;
  sync.state = 'syncing';
  renderSyncUi();
  try {
    const remote = await api('/api/workspace', { method: 'GET' });
    sync.rev = remote.rev || '';
    sync.storedBy = remote.storedBy || '';
    const serverNewer = remote.workspace && String(remote.savedAt || '') > String(state.savedAt || '');
    if (remote.workspace && (serverNewer || isPristine())) {
      adoptWorkspace(remote.workspace, remote.savedAt);
      sync.state = 'pulled';
      sync.at = remote.savedAt || '';
      renderSyncUi();
      if (announce) toast('Workspace updated from the server.');
      return;
    }
    // Nothing has changed here since the last save, so there is nothing to save
    // again: a sync that always writes churns the revision for no reason.
    if (!sync.dirty && remote.workspace) {
      sync.state = 'synced';
      sync.at = remote.savedAt || sync.at;
      renderSyncUi();
      return;
    }
    await pushWorkspace(announce);
  } catch (error) {
    // 401 means this device has no identity the server will accept, which is the
    // ordinary local-only case and should read as one rather than as a failure.
    if (/sign_in_required|access code|401/i.test(String(error.message || ''))) {
      sync.state = 'local';
    } else {
      sync.state = 'error';
      sync.message = String(error.message || 'Sync failed.');
    }
    renderSyncUi();
  }
}

function queueWorkspacePush() {
  sync.dirty = true;
  if (sync.state === 'local' && !state.settings.accessCode) return;
  clearTimeout(sync.timer);
  sync.timer = setTimeout(() => {
    if (state.settings.accessCode || sync.rev) syncWorkspace();
  }, SYNC_DEBOUNCE_MS);
}

/* ── helpers ───────────────────────────────────────────────── */
function escapeHtml(str = '') {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function md(src = '') {
  const inline = (s) =>
    s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  const lines = escapeHtml(src).split(/\r?\n/);
  const out = [];
  let list = null;
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    const li = line.match(/^\s*([-*]|\d+[.)])\s+(.*)$/);
    const quote = line.match(/^>\s?(.*)$/);
    if (h) {
      closeList();
      const level = Math.min(h[1].length + 1, 4);
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
    } else if (li) {
      const tag = /^\d/.test(li[1]) ? 'ol' : 'ul';
      if (list !== tag) {
        closeList();
        out.push(`<${tag}>`);
        list = tag;
      }
      out.push(`<li>${inline(li[2])}</li>`);
    } else if (quote) {
      closeList();
      out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
    } else if (!line.trim()) {
      closeList();
    } else {
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  return out.join('\n');
}

function clock(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

let toastTimer = null;
function toast(message, kind = '') {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), kind === 'error' ? 6500 : 3200);
}

function busy(button, on) {
  if (!button) return;
  button.classList.toggle('loading', on);
  button.disabled = on;
}

function scrollFeed(el) {
  if (el) el.scrollTop = el.scrollHeight;
}

/* ── api ───────────────────────────────────────────────────── */
async function api(path, options = {}) {
  const headers = {};
  if (state.settings.accessCode) headers['x-access-code'] = state.settings.accessCode;
  const gatewayKey = String(state.settings.gatewayKey || '').trim();
  if (gatewayKey) headers['x-ai-key'] = gatewayKey;
  const gatewayUrl = String(state.settings.gatewayBase || '').trim();
  if (gatewayUrl && gatewayUrl !== GATEWAY_DEFAULT) headers['x-ai-base'] = gatewayUrl;
  let body;
  if (options.form) body = options.form;
  else if (options.body) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  let res;
  try {
    res = await fetch(apiUrl(path), { method: options.method || (body ? 'POST' : 'GET'), headers, body });
  } catch (error) {
    throw new Error(`Cannot reach the agent server (${error.message}).`);
  }
  const data = await res.json().catch(() => ({ error: 'bad_response', message: `HTTP ${res.status}` }));
  if (!res.ok) {
    if (res.status === 401) {
      // A 401 can arrive from a background timer at the exact moment the app
      // comes back to the foreground. Opening Settings on the user's behalf made
      // every return look like the app had thrown them into a menu, so point at
      // the gear and let them decide.
      toast('That key was refused (401). Tap ⚙ if it needs replacing.', 'error');
    }
    throw new Error(data.message || `HTTP ${res.status}`);
  }
  return data;
}

function recentContext() {
  return state.session.transcript.slice(-4).map((t) => t.text);
}

function clockMinutes(value) {
  return Number(String(value).slice(0, 2)) * 60 + Number(String(value).slice(3, 5));
}

function classNow(date = new Date()) {
  const minutes = date.getHours() * 60 + date.getMinutes();
  const day = date.getDay();
  return (
    state.timetable.find(
      (slot) => slot.days.includes(day) && minutes >= clockMinutes(slot.start) && minutes < clockMinutes(slot.end)
    ) || null
  );
}

/* The timetable outranks the last tab that was open: a class in session owns the
   next answer, because that is the course the question came from. Outside a
   timetabled window the course you picked stays picked. */
function courseForTurn() {
  const slot = classNow();
  const scheduled = slot ? courseById(slot.courseId) : null;
  return scheduled || activeCourse();
}

async function agent(mode, { text = '', images = [], maxTokens } = {}) {
  const left = sessionRemainingMs();
  if (left !== null && left <= 0) {
    throw new Error('Your session ended. Buy another session in Settings → Session.');
  }
  const turn = courseForTurn();
  if (turn && turn.id !== state.activeId) switchCourse(turn.id, { auto: true });
  const res = await api('/api/chat', {
    body: {
      mode,
      text,
      images,
      maxTokens,
      history: recentContext(),
      memory: state.memory,
      language: state.language,
      persona: state.persona,
    },
  });
  if (res.notes?.length) addMemory(res.notes, 'learned');
  return res;
}

/* ── health ────────────────────────────────────────────────── */
async function checkHealth() {
  try {
    health = await api('/api/health');
    const ok = health.configured;
    $('statusDot').className = `dot ${ok ? 'ok' : 'warn'}`;
    $('statusDot').title = ok ? `connected to ${health.provider}` : 'no model key configured';
    $('modelTag').textContent = ok ? String(health.chatModel || 'auto').split('/').pop() : 'no key';
    $('setupCard').classList.toggle('hidden', ok);
    if (health.authRequired && !state.settings.accessCode) {
      toast('This server is protected. Enter the access code in Settings.', 'error');
    }
  } catch (error) {
    $('statusDot').className = 'dot bad';
    $('modelTag').textContent = 'offline';
    toast(error.message, 'error');
  }
}

/* ── capture ───────────────────────────────────────────────── */
const cap = {
  micStream: null,
  recog: null,
  recorder: null,
  recTimer: null,
  screenStream: null,
  nativeFrames: null,
  broadcastPoll: null,
  broadcastSeen: false,
  broadcastDevice: null,
  cameraStream: null,
  screenVideo: null,
  cameraVideo: null,
  snapTimer: null,
  frame: null,
  frames: 0,
  words: 0,
  queue: [],
  flushing: false,
  noteTimer: null,
  lastAnalyse: 0,
  listenOn: false,
  watchOn: false,
  cameraOn: false,
  study: false,
  restarting: false,
};

function recLang() {
  return state.language && state.language.length <= 12 ? state.language : 'en-US';
}

function toJpeg(source, maxWidth = 1280, quality = 0.72) {
  const w = source.videoWidth || source.width || 0;
  const h = source.videoHeight || source.height || 0;
  if (!w || !h) return null;
  const scale = Math.min(1, maxWidth / w);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

function updateStatus() {
  const bits = [];
  if (cap.listenOn) bits.push('listening');
  if (cap.watchOn) bits.push('watching screen');
  if (cap.cameraOn) bits.push('camera on');
  $('captureStatus').textContent = bits.length
    ? `${bits.join(' · ')} — capture is live.`
    : 'Idle. Nothing is being recorded.';
  $('counters').textContent = `${cap.words} words · ${cap.frames} frames · ${state.memory.length} notes held`;
  $('btnListen').classList.toggle('on', cap.listenOn);
  $('btnScreen').classList.toggle('on', cap.watchOn);
  $('btnCamera').classList.toggle('on', cap.cameraOn);
  $('ttsToggle').checked = state.settings.tts;
  persist();
}

/* transcript */
function pushTranscript(text, meta = {}) {
  const entry = { text, at: Date.now(), ...meta };
  state.session.transcript.push(entry);
  cap.words += text.split(/\s+/).filter(Boolean).length;
  const feed = $('transcript');
  feed.querySelector('.empty')?.remove();
  const div = document.createElement('div');
  div.className = 'line';
  div.innerHTML = `<time>${clock(entry.at)}</time>${escapeHtml(text)}`;
  feed.appendChild(div);
  while (feed.children.length > 200) feed.firstElementChild.remove();
  scrollFeed(feed);
  maybeAutoAnswer(text);
  if (state.settings.autoNotes) {
    cap.queue.push(text);
    if (cap.queue.join(' ').length > 700) flushTranscript();
  }
  updateStatus();
}

function showInterim(text) {
  const feed = $('transcript');
  let el = feed.querySelector('.interim');
  if (!text) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement('div');
    el.className = 'interim';
    feed.appendChild(el);
  }
  el.textContent = text;
  scrollFeed(feed);
}

function startRecognition(SR) {
  const rec = new SR();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = recLang();
  rec.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const text = result[0].transcript.trim();
      if (!text) continue;
      if (result.isFinal) pushTranscript(text, { source: 'speech' });
      else interim += `${result[0].transcript} `;
    }
    showInterim(interim.trim());
  };
  rec.onerror = (event) => {
    if (event.error === 'not-allowed') {
      toast(micBlockedMessage({ name: 'NotAllowedError' }), 'error');
      stopListening();
    } else if (event.error === 'service-not-allowed') {
      // WKWebView ships no dictation service even when the mic grant is fine,
      // so this is not a permission failure and must not be reported as one.
      dictationOff = true;
      toast('On-device dictation is unavailable here — using server transcription.', 'error');
      stopListening();
      setTimeout(function () {
        if (!cap.listenOn) startListening();
      }, 400);
    } else if (event.error === 'audio-capture') {
      toast('No microphone found.', 'error');
      stopListening();
    } else if (event.error !== 'no-speech' && event.error !== 'aborted') {
      toast(`Speech recognition: ${event.error}`, 'error');
    }
  };
  rec.onend = () => {
    if (cap.listenOn && cap.recog === rec) {
      try {
        rec.start();
      } catch {
        /* already restarting */
      }
    }
  };
  cap.recog = rec;
  try {
    rec.start();
  } catch {
    /* start race */
  }
}

let transcribeBlocked = false;
let dictationOff = false;

async function transcribeBlob(blob) {
  if (transcribeBlocked) return;
  const form = new FormData();
  form.append('audio', blob, 'chunk.webm');
  if (state.language) form.append('language', state.language.split(/[-_]/)[0]);
  try {
    const res = await api('/api/transcribe', { form });
    if (res.text) pushTranscript(res.text, { source: 'whisper' });
  } catch (error) {
    const message = String(error.message || '');
    // A gateway key with no audio route should degrade once, not retry forever.
    if (/40[13]|50[23]|allowlist|not available|no_key|no key/i.test(message)) {
      transcribeBlocked = true;
      showInterim('');
      toast('No audio route on this key. Add STT_API_KEY on the server to transcribe here, or rely on Chrome’s dictation.', 'error');
    } else {
      toast(`Transcription failed: ${message}`, 'error');
    }
  }
}

function startRecorder() {
  if (!cap.micStream) return;
  const mime = typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : '';
  let rec;
  try {
    rec = new MediaRecorder(cap.micStream, mime ? { mimeType: mime } : undefined);
  } catch (error) {
    toast(`Recorder unavailable: ${error.message}`, 'error');
    return;
  }
  const chunks = [];
  rec.ondataavailable = (event) => {
    if (event.data && event.data.size) chunks.push(event.data);
  };
  rec.onstop = async () => {
    clearTimeout(cap.recTimer);
    const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
    if (blob.size > 3000) await transcribeBlob(blob);
    if (cap.listenOn && !transcribeBlocked) startRecorder();
  };
  rec.start();
  cap.recorder = rec;
  cap.recTimer = setTimeout(() => {
    if (rec.state === 'recording') rec.stop();
  }, 12000);
}

async function startListening() {
  if (cap.listenOn) return stopListening();
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('This browser has no microphone access. Use HTTPS or localhost.', 'error');
    return;
  }
  try {
    cap.micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (error) {
    toast(micBlockedMessage(error), 'error');
    return;
  }
  cap.listenOn = true;
  // iOS suspends the capture audio session the instant anything else claims it —
  // a lesson video with sound is enough — and the microphone track ends without
  // the page ever being told. Notice that and take the microphone back.
  cap.micStream.getAudioTracks().forEach((track) => {
    const recover = () => {
      if (!cap.listenOn || cap.restarting) return;
      cap.restarting = true;
      toast('Playback took the microphone — listening again.', 'error');
      stopListening();
      setTimeout(() => {
        cap.restarting = false;
        if (!cap.listenOn) startListening();
      }, 600);
    };
    track.addEventListener('ended', recover);
    track.addEventListener('mute', () => {
      setTimeout(() => {
        if (track.readyState === 'ended') recover();
      }, 1200);
    });
  });
  const SR = IS_NATIVE || dictationOff ? null : window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SR) startRecognition(SR);
  else if (transcribeBlocked) {
    toast('No on-device dictation here, and no audio route on the server yet. Set STT_API_KEY on the server — or open SAGE in Chrome on Android or a desktop browser.', 'error');
    stopListening();
    return;
  } else startRecorder();
  if (!cap.noteTimer) {
    cap.noteTimer = setInterval(flushTranscript, Math.max(8, state.settings.noteIntervalSec) * 1000);
  }
  updateStatus();
  toast(SR ? 'Listening — live transcript on.' : 'Listening — sending audio chunks for transcription.');
}

function stopListening() {
  cap.listenOn = false;
  try {
    cap.recog?.stop();
  } catch {
    /* ignore */
  }
  cap.recog = null;
  clearTimeout(cap.recTimer);
  try {
    if (cap.recorder?.state === 'recording') cap.recorder.stop();
  } catch {
    /* ignore */
  }
  cap.recorder = null;
  cap.micStream?.getTracks().forEach((t) => t.stop());
  cap.micStream = null;
  showInterim('');
  updateStatus();
}

async function toggleWatch() {
  if (cap.watchOn) return stopWatch();
  if (NATIVE_SCREEN) return startNativeWatch();
  if (NATIVE_BROADCAST) return startBroadcastWatch();
  if (!navigator.mediaDevices?.getDisplayMedia) {
    offerScreenFallback();
    return;
  }
  try {
    cap.screenStream = await navigator.mediaDevices.getDisplayMedia({
      // 'monitor' is a hint: sharing the desktop is the only pick that keeps
      // seeing the lecture after you switch to another application.
      video: { frameRate: 2, displaySurface: 'monitor' },
      audio: false,
      preferCurrentTab: false,
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
    });
  } catch (error) {
    if (error.name === 'NotAllowedError') return;
    if (error.name === 'NotSupportedError' || /not supported/i.test(String(error.message || ''))) {
      offerScreenFallback();
      return;
    }
    toast(`Screen capture failed (${error.name}): ${error.message}`, 'error');
    return;
  }
  const track = cap.screenStream.getVideoTracks()[0];
  const surface = track && track.getSettings ? track.getSettings().displaySurface : '';
  track?.addEventListener('ended', () => {
    // The browser's own "stop sharing" was pressed, or the shared tab closed.
    // Saying so beats looking silently broken.
    if (!cap.watchOn) return;
    stopWatch();
    toast('Sharing stopped. Tap Watch again to pick the screen back up.', 'error');
  });
  cap.watchOn = true;
  attachVideo(cap.screenStream, 'screen');
  startSnapLoop();
  updateStatus();
  if (surface === 'browser') {
    toast('You shared one tab — that ends the moment you leave it. Share the entire screen to keep watching another app.', 'error');
  } else if (surface === 'window') {
    toast('You shared one window — capture pauses the moment you leave it. Share the entire screen to keep watching another app.', 'error');
  } else {
    toast('Watching the shared screen.');
  }
}

// Native capture arrives as finished JPEGs rather than a stream: the service
// decides when a frame is worth sending, so this only has to read it.
async function startNativeWatch() {
  try {
    cap.nativeFrames = await NATIVE_SCREEN.addListener('frame', (frame) => {
      if (!cap.watchOn || !frame?.data) return;
      const data = String(frame.data).startsWith('data:')
        ? frame.data
        : `data:image/jpeg;base64,${frame.data}`;
      cap.frame = data;
      cap.frames += 1;
      aimFrame(data);
      if (state.settings.autoNotes && Date.now() - cap.lastAnalyse > 16000) {
        cap.lastAnalyse = Date.now();
        analyseFrame(data);
      }
      aimLiveStatus();
      updateStatus();
    });
  } catch {
    cap.nativeFrames = null;
  }
  try {
    await NATIVE_SCREEN.start({ intervalMs: 1500 });
  } catch (error) {
    try {
      cap.nativeFrames?.remove?.();
    } catch {
      /* ignore */
    }
    cap.nativeFrames = null;
    const refused = /not allowed|not granted|cancel/i.test(String(error?.message || ''));
    toast(refused ? 'Screen capture was not allowed.' : `Screen capture failed: ${error?.message || error}`, 'error');
    return;
  }
  cap.watchOn = true;
  updateStatus();
  aimStatus('watching the screen');
  toast('Watching the screen — switch to the course app; the notification keeps it running.');
}

// The system sheet is the only way a broadcast can start, and the recording then
// belongs to the extension rather than to this app — which is why it survives the
// app going to the background. Notes are collected as they arrive.
async function startBroadcastWatch() {
  try {
    const found = await NATIVE_BROADCAST.device();
    cap.broadcastDevice = found?.device || '';
    if (!cap.broadcastDevice) {
      toast('This build cannot identify the device for a broadcast.', 'error');
      return;
    }
    // The server is the only place the extension and the app can meet: there is no
    // shared container, and the extension carries no access code.
    await api('/api/broadcast/session', { body: { device: cap.broadcastDevice } });
    await NATIVE_BROADCAST.start();
  } catch (error) {
    toast(`Could not open the broadcast sheet: ${error?.message || error}`, 'error');
    return;
  }
  cap.watchOn = true;
  cap.frames = 0;
  cap.broadcastSeen = false;
  clearInterval(cap.broadcastPoll);
  cap.broadcastPoll = setInterval(drainBroadcast, 6000);
  updateStatus();
  toast('Pick Sage in the sheet and start the broadcast, then switch apps — it keeps recording.');
}

async function drainBroadcast() {
  if (!cap.broadcastDevice) return;
  let out;
  try {
    out = await api(`/api/broadcast/notes?device=${encodeURIComponent(cap.broadcastDevice)}`);
  } catch {
    return;
  }
  for (const note of out?.notes || []) addNote(note.text, 'broadcast');
  if (Number.isFinite(out?.frames) && out.frames > cap.frames) cap.frames = out.frames;
  if (out?.running) cap.broadcastSeen = true;
  else if (cap.broadcastSeen) {
    // Nothing has arrived for the whole live window: the broadcast was stopped
    // from Control Center, so the page should stop claiming to watch.
    cap.broadcastSeen = false;
    stopWatch();
    toast('The screen broadcast stopped.');
    return;
  }
  updateStatus();
  aimLiveStatus();
}

function stopWatch() {
  cap.watchOn = false;
  if (cap.broadcastPoll) {
    clearInterval(cap.broadcastPoll);
    cap.broadcastPoll = null;
  }
  if (cap.broadcastDevice) {
    // Closing the session stops the server accepting frames for a broadcast that
    // is no longer anyone's.
    api(`/api/broadcast/session?device=${encodeURIComponent(cap.broadcastDevice)}`, { method: 'DELETE' }).catch(() => {});
  }
  if (cap.nativeFrames || NATIVE_SCREEN) {
    try {
      cap.nativeFrames?.remove?.();
    } catch {
      /* ignore */
    }
    cap.nativeFrames = null;
    try {
      NATIVE_SCREEN?.stop?.();
    } catch {
      /* ignore */
    }
  }
  cap.screenStream?.getTracks().forEach((t) => t.stop());
  cap.screenStream = null;
  cap.screenVideo = null;
  if (!cap.cameraOn) stopSnapLoop();
  updateStatus();
}

async function toggleCamera() {
  if (cap.cameraOn) return stopCamera();
  // The panel opens before the permission prompt, so the picture and the status
  // have somewhere to land the moment the camera is granted.
  openAimViewer();
  aimStatus('waiting for camera permission…');
  try {
    cap.cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 } },
      audio: false,
    });
  } catch (error) {
    aimStatus('camera blocked: ' + error.message);
    toast('Camera blocked: ' + error.message, 'error');
    return;
  }
  cap.cameraOn = true;
  attachVideo(cap.cameraStream, 'camera');
  if (!aimShowStream(cap.cameraStream)) {
    // The panel was not mounted yet; put it up and try the stream once more.
    openAimViewer();
    aimShowStream(cap.cameraStream);
  }
  startSnapLoop();
  aimLiveStatus();
  updateStatus();
  toast('Camera on — aim it at the board. The answer appears under the picture.');
}

function stopCamera() {
  cap.cameraOn = false;
  cap.cameraStream?.getTracks().forEach((t) => t.stop());
  cap.cameraStream = null;
  cap.cameraVideo = null;
  if (!cap.watchOn) stopSnapLoop();
  closeAimViewer();
  updateStatus();
}

/* ── aim viewer: the picture and the result that came from it ──
   Capture used to run invisibly — frames were scraped from a <video> that was
   never added to the page, so tapping Aim looked like nothing happened. The
   viewer is a panel in the Live tab — the same screen, under the thumb that
   tapped Aim — showing the live picture, the exact frame being sent, and the
   result underneath. */
const aim = {
  inPage: false,
  lastFrameAt: 0,
  lastReadAt: 0,
  reading: false,
};

function aimMarkup() {
  return [
    '<div class="aim-head"><span class="aim-dot"></span><strong>Aim</strong>',
    '<span class="aim-state" id="aimStatus">camera off</span>',
    '<button type="button" class="aim-stop" id="aimStop">stop</button></div>',
    '<div class="aim-stage" id="aimMount"><span class="aim-wait">Waiting for the camera…</span></div>',
    '<div class="aim-bar"><button type="button" class="aim-read" id="aimRead">Read what is on screen</button>',
    '<span class="aim-count" id="aimCount">0 frames</span></div>',
    '<div class="aim-result" id="aimResult" hidden><div class="aim-result-head">',
    '<span id="aimResultTag">result</span></div>',
    '<div class="aim-result-body" id="aimResultBody"></div></div>',
  ].join('');
}

function aimEl(id) {
  return document.getElementById(id);
}

function openAimInPage() {
  aim.inPage = true;
  const host = $('aimViewer');
  if (!host) return;
  if (!host.innerHTML.trim()) host.innerHTML = aimMarkup();
  host.hidden = false;
}

function openAimViewer() {
  // The viewer is part of the page, always. A second window looked reasonable
  // until it was used: it lands behind the browser, has no room on a phone, and
  // separates the picture from the answer that belongs underneath it.
  openAimInPage();
  aimWire();
  const host = $('aimViewer');
  if (host && host.scrollIntoView) host.scrollIntoView({ block: 'start', behavior: 'smooth' });
  return document;
}

function aimWire() {
  const read = aimEl('aimRead');
  if (read && !read.onclick) read.onclick = () => aimReadNow();
  const stop = aimEl('aimStop');
  if (stop && !stop.onclick) {
    stop.onclick = () => stopCamera();
  }
}

function closeAimViewer() {
  aim.inPage = false;
  const host = $('aimViewer');
  if (host) {
    host.innerHTML = '';
    host.hidden = true;
  }
}

function aimStatus(text) {
  const el = aimEl('aimStatus');
  if (el) el.textContent = text;
}

function aimLiveStatus() {
  if (!cap.cameraOn) return;
  const video = cap.cameraVideo;
  const size = video && video.videoWidth ? ' · ' + video.videoWidth + '×' + video.videoHeight : '';
  const ago = aim.lastFrameAt
    ? ' · last frame ' + Math.max(1, Math.round((Date.now() - aim.lastFrameAt) / 1000)) + 's ago'
    : ' · waiting for the first frame';
  aimStatus('live' + size + ago);
}

function aimShowStream(stream) {
  const mount = aimEl('aimMount');
  if (!mount) return false;
  const doc = mount.ownerDocument;
  let video;
  try {
    video = doc.createElement('video');
    video.srcObject = stream;
  } catch {
    return false;
  }
  video.className = 'aim-video';
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  mount.innerHTML = '';
  mount.appendChild(video);
  video.play().catch(() => {});
  return true;
}

function aimCount() {
  const el = aimEl('aimCount');
  if (el) el.textContent = cap.frames + (cap.frames === 1 ? ' frame' : ' frames');
}

function aimFrame(data) {
  aim.lastFrameAt = Date.now();
  aimCount();
  aimLiveStatus();
}

function aimResult(text, tag) {
  const box = aimEl('aimResult');
  const body = aimEl('aimResultBody');
  const label = aimEl('aimResultTag');
  if (!box || !body) return;
  if (label) label.textContent = tag || 'result';
  body.innerHTML = md(String(text || '').slice(0, 4000));
  box.hidden = false;
}

async function aimReadNow() {
  if (aim.reading) return;
  const video = cap.cameraVideo;
  const frame = video && video.videoWidth ? toJpeg(video, 1280, 0.72) : cap.frame;
  if (!frame) {
    aimStatus('no frame yet — the camera is still starting');
    return;
  }
  aim.reading = true;
  aim.lastReadAt = Date.now();
  const button = aimEl('aimRead');
  if (button) {
    button.disabled = true;
    button.textContent = 'Reading…';
  }
  aimStatus('reading the frame…');
  try {
    const res = await agent('answer', {
      text:
        'Answer the question visible in this frame from the board, slide or screen. ' +
        'If there is no question, say what matters for the class in two lines.',
      images: [frame],
    });
    const answer = res.structured?.answer || res.reply || '(nothing readable in that frame)';
    const working = res.structured?.working || '';
    aimResult([answer, working].filter(Boolean).join('\n\n'), res.mode || 'answer');
    aimStatus('read · result below');
    cap.frame = frame;
  } catch (error) {
    aimResult('Failed: ' + error.message, 'error');
    aimStatus('read failed');
  } finally {
    aim.reading = false;
    if (button) {
      button.disabled = false;
      button.textContent = 'Read what is on screen';
    }
  }
}

// Deliberately detached: this element exists only so toJpeg() can read frames.
// The one visible preview is the Aim panel; nothing else should show the camera.
function attachVideo(stream, which) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.srcObject = stream;
  video.play().catch(() => {});
  cap[`${which}Video`] = video;
  stream.getVideoTracks()[0]?.addEventListener('ended', () => {
    if (which === 'screen') stopWatch();
    else stopCamera();
  });
}

function startSnapLoop() {
  stopSnapLoop();
  const seconds = Math.max(3, Number(state.settings.snapSec) || 6);
  cap.snapTimer = setInterval(snapFrame, seconds * 1000);
  setTimeout(snapFrame, 700);
}

function stopSnapLoop() {
  clearInterval(cap.snapTimer);
  cap.snapTimer = null;
}

function snapFrame() {
  // A paused media element still reports videoWidth, so frames would stop
  // silently. Nudge the hidden element back if the compositor paused it.
  if (cap.screenVideo && cap.screenVideo.paused) cap.screenVideo.play().catch(() => {});
  const source = cap.screenVideo?.videoWidth
    ? cap.screenVideo
    : cap.cameraVideo?.videoWidth
      ? cap.cameraVideo
      : null;
  if (!source) return;
  const data = toJpeg(source, 1280, 0.72);
  if (!data) return;
  cap.frame = data;
  cap.frames += 1;
  aimFrame(data);
  if (state.settings.autoNotes && Date.now() - cap.lastAnalyse > 16000) {
    cap.lastAnalyse = Date.now();
    analyseFrame(data);
  }
  updateStatus();
  aimLiveStatus();
}

async function analyseFrame(frame) {
  try {
    const res = await agent('note', {
      text: 'Frame captured from a live class or the user’s screen. Note only what matters academically; mark exam hints with EXAM:.',
      images: [frame],
    });
    if (res.reply && res.reply.toLowerCase() !== 'nothing new') {
      addNote(res.reply, 'frame');
      // The viewer reports what the frame produced, unless the user just asked
      // for a specific read — that answer should stay on screen.
      if (Date.now() - aim.lastReadAt > 20000) aimResult(res.reply, res.mode || 'note');
    }
  } catch (error) {
    console.warn('frame analysis failed', error.message);
  }
}

async function flushTranscript() {
  if (cap.flushing) return;
  const pending = cap.queue.join('\n').trim();
  if (!pending) return;
  cap.queue = [];
  cap.flushing = true;
  try {
    const res = await agent('note', {
      text: `Live transcript chunk from class:\n\n${pending.slice(-6000)}`,
    });
    if (res.reply && res.reply.toLowerCase() !== 'nothing new') addNote(res.reply, 'transcript');
  } catch (error) {
    toast(`Note failed: ${error.message}`, 'error');
  } finally {
    cap.flushing = false;
  }
}

/* notes feed */
function addNote(text, source = 'note') {
  state.session.notes.push({ text, source, at: Date.now() });
  const feed = $('liveNotes');
  feed.querySelector('.empty')?.remove();
  const div = document.createElement('div');
  div.className = 'line';
  div.innerHTML = `<time>${clock()}</time>${md(text)}`;
  feed.appendChild(div);
  while (feed.children.length > 60) feed.firstElementChild.remove();
  scrollFeed(feed);
  updateStatus();
}

function hydrateFeeds() {
  const transcript = $('transcript');
  transcript.innerHTML = '';
  for (const entry of state.session.transcript.slice(-60)) {
    const div = document.createElement('div');
    div.className = 'line';
    div.innerHTML = `<time>${clock(entry.at)}</time>${escapeHtml(entry.text)}`;
    transcript.appendChild(div);
  }
  if (!state.session.transcript.length) transcript.innerHTML = '<p class="empty">No audio yet. Tap Listen.</p>';

  const notes = $('liveNotes');
  notes.innerHTML = '';
  for (const entry of state.session.notes.slice(-30)) {
    const div = document.createElement('div');
    div.className = 'line';
    div.innerHTML = `<time>${clock(entry.at)}</time>${md(entry.text)}`;
    notes.appendChild(div);
  }
  if (!state.session.notes.length) notes.innerHTML = '<p class="empty">Notes appear here as it understands.</p>';
  scrollFeed(transcript);
  scrollFeed(notes);
}

/* ── memory ────────────────────────────────────────────────── */
function addMemory(notes, source = 'manual') {
  const fresh = notes
    .map((n) => String(n).replace(/\s+/g, ' ').trim())
    .filter((n) => n.length > 6)
    .filter((n) => !state.memory.some((m) => m.toLowerCase() === n.toLowerCase()));
  if (!fresh.length) return 0;
  for (const note of fresh.slice(0, 8)) state.memory.push(note);
  renderMemory();
  updateStatus();
  return fresh.length;
}

function renderMemory() {
  const list = $('memoryList');
  list.innerHTML = '';
  const recent = [...state.memory].reverse();
  if (!recent.length) {
    list.innerHTML = '<p class="mini muted">Nothing learned yet. Notes marked durable during class land here.</p>';
  }
  recent.slice(0, 60).forEach((note) => {
    const index = state.memory.indexOf(note);
    const row = document.createElement('div');
    row.className = 'memory-item';
    row.innerHTML = `<span>${escapeHtml(note)}</span><button class="x" data-index="${index}" title="Forget">✕</button>`;
    list.appendChild(row);
  });
  $('memoryCount').textContent = state.memory.length ? `${state.memory.length}` : '';

  const traits = $('traitsList');
  traits.innerHTML = '';
  if (!state.persona.traits.length) {
    traits.innerHTML = '<p class="mini muted">Hit Evolve after a class — it rewrites how it behaves next time.</p>';
  }
  state.persona.traits.forEach((trait, index) => {
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.innerHTML = `<span>${escapeHtml(trait)}</span><button class="x" data-trait="${index}" title="Remove">✕</button>`;
    traits.appendChild(chip);
  });

  const log = $('evolutionLog');
  log.innerHTML = '';
  if (!state.evolution.length) {
    log.innerHTML = '<p class="mini muted">No evolutions yet.</p>';
  }
  [...state.evolution].reverse().slice(0, 12).forEach((entry) => {
    const div = document.createElement('div');
    div.className = 'evo-item';
    div.innerHTML = `${escapeHtml(entry.summary)}<time>${new Date(entry.at).toLocaleString()}</time>`;
    log.appendChild(div);
  });
}

async function evolve() {
  const button = $('btnEvolve');
  busy(button, true);
  try {
    const dossier = [
      `Course: ${state.persona.course || 'unspecified'}`,
      `Current behaviour traits: ${state.persona.traits.join('; ') || 'none yet'}`,
      `Durable notes:\n${state.memory.slice(-60).map((m) => `- ${m}`).join('\n') || '- none'}`,
      `Recent class notes:\n${state.session.notes.slice(-12).map((n) => `- ${n.text.slice(0, 300)}`).join('\n') || '- none'}`,
    ].join('\n\n');
    const res = await agent('evolve', { text: dossier });
    const traits = Array.isArray(res.structured?.traits) ? res.structured.traits.map(String) : [];
    const summary = String(res.structured?.summary || res.reply || '').trim();
    if (!traits.length && !summary) throw new Error('Nothing durable to learn yet.');
    for (const trait of traits) {
      const clean = trait.replace(/\s+/g, ' ').trim().slice(0, 220);
      if (clean && !state.persona.traits.some((t) => t.toLowerCase() === clean.toLowerCase())) {
        state.persona.traits.push(clean);
      }
    }
    state.persona.traits = state.persona.traits.slice(-12);
    if (summary) state.evolution.push({ summary, at: Date.now() });
    state.evolution = state.evolution.slice(-40);
    if (res.notes?.length) addMemory(res.notes, 'evolve');
    renderMemory();
    persist();
    toast('Evolved. Next class it behaves differently.');
  } catch (error) {
    toast(`Evolve failed: ${error.message}`, 'error');
  } finally {
    busy(button, false);
  }
}

/* ── courses and the timetable ─────────────────────────────── */
let courseTimer = null;

function switchCourse(id, options = {}) {
  const next = courseById(id);
  if (!next || next.id === state.activeId) return false;
  stashActive();
  state.activeId = next.id;
  hydrateActive();
  persist();
  renderCourseUi();
  renderMemory();
  hydrateFeeds();
  renderPackStatus();
  const name = $('agentName');
  if (name) name.textContent = state.persona.name || 'Sage';
  if (!options.silent) {
    const label = state.persona.course || 'this course';
    toast(options.auto ? `Class started — switched to ${label}.` : `Switched to ${label}.`);
  }
  return true;
}

function newCourse() {
  stashActive();
  const course = defaultCourse({});
  state.courses.push(course);
  state.activeId = course.id;
  hydrateActive();
  persist();
  renderCourseUi();
  renderMemory();
  hydrateFeeds();
  renderPackStatus();
  openSettings();
  toast('New course — name it, then Save.');
}

function renderCourseUi() {
  const select = $('courseSelect');
  if (select) {
    select.innerHTML = '';
    for (const course of state.courses) {
      const option = document.createElement('option');
      option.value = course.id;
      option.textContent = course.persona.course || 'Untitled course';
      option.selected = course.id === state.activeId;
      select.appendChild(option);
    }
    select.value = state.activeId;
  }
  const slotCourse = $('slotCourse');
  if (slotCourse) {
    const keep = slotCourse.value;
    slotCourse.innerHTML = '';
    for (const course of state.courses) {
      const option = document.createElement('option');
      option.value = course.id;
      option.textContent = course.persona.course || 'Untitled course';
      slotCourse.appendChild(option);
    }
    slotCourse.value = state.courses.some((course) => course.id === keep) ? keep : state.activeId;
  }
  renderTimetable();
}

function parseDays(text) {
  const found = new Set();
  for (const token of String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    const named = WEEKDAY_NAMES.indexOf(token.slice(0, 3));
    if (named >= 0) found.add(named);
    else if (/^[0-6]$/.test(token)) found.add(Number(token));
  }
  return [...found].sort((a, b) => a - b);
}

function renderTimetable() {
  const list = $('timetableList');
  if (!list) return;
  list.innerHTML = '';
  if (!state.timetable.length) {
    list.innerHTML = '<p class="mini muted">No classes yet. Add one and its course answers inside that window, whichever tab you are on.</p>';
    return;
  }
  const now = classNow();
  const labelled = (day) => WEEKDAY_NAMES[day].replace(/^./, (c) => c.toUpperCase());
  for (const slot of [...state.timetable].sort((a, b) => a.start.localeCompare(b.start))) {
    const course = courseById(slot.courseId);
    const row = document.createElement('div');
    row.className = 'memory-item';
    const label = slot.label ? ` · ${escapeHtml(slot.label)}` : '';
    row.innerHTML =
      `<span><strong>${escapeHtml(course ? course.persona.course || 'Untitled course' : 'Removed course')}</strong>` +
      ` · ${escapeHtml(slot.days.map(labelled).join(' '))} ${escapeHtml(slot.start)}–${escapeHtml(slot.end)}${label}` +
      `${now && now.id === slot.id ? ' · <em>in session</em>' : ''}</span>` +
      `<button class="x" data-slot="${escapeHtml(slot.id)}" title="Remove">✕</button>`;
    list.appendChild(row);
  }
}

function addSlot() {
  const courseId = $('slotCourse').value;
  const days = parseDays($('slotDays').value);
  const start = $('slotStart').value;
  const end = $('slotEnd').value;
  if (!courseId) {
    toast('Add a course before a class.', 'error');
    return;
  }
  if (!days.length) {
    toast('Which days? Try Mon, Wed.', 'error');
    return;
  }
  if (!/^\d\d:\d\d$/.test(start) || !/^\d\d:\d\d$/.test(end) || end <= start) {
    toast('Give a start and an end, with the end after the start.', 'error');
    return;
  }
  state.timetable.push({ id: uid('s'), courseId, days, start, end, label: '' });
  persist();
  renderTimetable();
  toast('Class added to the timetable.');
}

/* A scheduled class takes over when it starts, and only then: picking another
   course during a class is respected, but the next class still claims its own
   window. */
function timetableTick() {
  const slot = classNow();
  const key = slot ? `${slot.id}|${slot.start}` : '';
  const seen = state.ui ? state.ui.classKey || '' : '';
  if (key && key !== seen) {
    state.ui = { ...(state.ui || {}), classKey: key };
    if (slot.courseId !== state.activeId) switchCourse(slot.courseId, { auto: true });
    else renderTimetable();
    persist();
  } else if (!key && seen) {
    state.ui = { ...(state.ui || {}), classKey: '' };
    renderTimetable();
    persist();
  }
}

function startTimetableClock() {
  clearInterval(courseTimer);
  courseTimer = setInterval(timetableTick, 30000);
  timetableTick();
}

function exportMemory() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `sage-memory-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 2000);
}

/* ── study packs ───────────────────────────────────────────── */
/* A course is one file. Everything that makes the next class easier travels in
   it: what was said, what it learned and got wrong, what it answered and why,
   and the material it was told to rely on — so the same course carries from the
   phone to the browser and back, and prints as a revision sheet.
   The server keeps no state, so a pack is written and read in the browser. */
const PACK_KIND = 'sage.study-pack';
const PACK_VERSION = 1;
const HISTORY_LIMITS = { answers: 200, quizzes: 200, essays: 40, sources: 40 };
const HISTORY_KEYS = Object.keys(HISTORY_LIMITS);

function normalizeHistory(raw) {
  const out = { answers: [], quizzes: [], essays: [], sources: [] };
  if (!raw || typeof raw !== 'object') return out;
  for (const key of HISTORY_KEYS) {
    out[key] = Array.isArray(raw[key])
      ? raw[key].filter((entry) => entry && typeof entry === 'object').slice(-HISTORY_LIMITS[key])
      : [];
  }
  return out;
}

function trimHistory() {
  state.history = normalizeHistory(state.history);
}

function recordHistory(kind, entry) {
  if (!Array.isArray(state.history?.[kind])) return;
  state.history[kind].push({ ...entry, at: Date.now() });
  trimHistory();
  persist();
  renderPackStatus();
}

/* Merge, never replace: the device being imported into may already know things
   this pack does not, and losing a class of notes to a stale pack is worse than
   keeping a duplicate. */
function mergeList(existing, incoming, { key = (v) => String(v).toLowerCase().trim(), limit = 400 } = {}) {
  const seen = new Set(existing.map((v) => key(v)));
  for (const item of incoming) {
    const k = key(item);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    existing.push(item);
  }
  return existing.slice(-limit);
}

function packCounts(pack) {
  const history = pack.history || {};
  const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return [
    count((pack.corrections || []).length, 'note'),
    count((history.answers || []).length, 'answer'),
    count((history.quizzes || []).length, 'quiz answer'),
    count((history.essays || []).length, 'essay'),
    count((history.sources || []).length, 'source'),
  ].join(' · ');
}

function buildPack() {
  return {
    kind: PACK_KIND,
    version: PACK_VERSION,
    app: 'sage',
    exportedAt: new Date().toISOString(),
    course: (state.persona.course || '').trim(),
    persona: state.persona,
    notes: state.session.notes,
    corrections: state.memory,
    evolution: state.evolution,
    history: state.history,
  };
}

function slugFile(text, fallback) {
  const clean = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return clean || fallback;
}

function downloadText(name, text, type) {
  const blob = new Blob([text], { type });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 2000);
}

function exportPack() {
  const pack = buildPack();
  const day = new Date().toISOString().slice(0, 10);
  downloadText(`sage-${slugFile(pack.course, 'course')}-${day}.sagepack.json`, JSON.stringify(pack, null, 2), 'application/json');
  toast(`Study pack saved · ${packCounts(pack)}`);
}

function importPack(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onerror = () => toast('Could not read that file.', 'error');
  reader.onload = () => {
    let pack;
    try {
      pack = JSON.parse(String(reader.result || ''));
    } catch {
      toast('That file is not a study pack.', 'error');
      return;
    }
    if (pack?.kind !== PACK_KIND) {
      toast('Not a Sage study pack.', 'error');
      return;
    }
    if (Number(pack.version) > PACK_VERSION) {
      toast('That pack was made by a newer Sage — update this device first.', 'error');
      return;
    }
    // A workspace holds several courses: a pack lands in the course of the same
    // name, and a course this device has never seen becomes a new one rather
    // than overwriting whichever course happened to be open.
    const wanted = String(pack.course || '').trim().toLowerCase();
    let target = wanted
      ? state.courses.find((course) => String(course.persona.course || '').trim().toLowerCase() === wanted)
      : null;
    const created = !target;
    if (!target) {
      stashActive();
      target = defaultCourse({
        persona: { ...(pack.persona || {}), course: String(pack.course || '').slice(0, 120) },
      });
      state.courses.push(target);
      state.activeId = target.id;
      hydrateActive();
    } else if (target.id !== state.activeId) {
      switchCourse(target.id, { silent: true });
    }
    const incomingHistory = normalizeHistory(pack.history);
    const historyKey = (entry) => `${entry.at || ''}|${String(entry.question || '').toLowerCase().trim()}`;

    state.session.notes = mergeList(
      state.session.notes,
      (Array.isArray(pack.notes) ? pack.notes : []).filter((n) => n && typeof n.text === 'string'),
      { key: (n) => `${n.at || ''}|${String(n.text || '').toLowerCase().trim()}`, limit: 400 }
    );
    state.memory = mergeList(state.memory, (Array.isArray(pack.corrections) ? pack.corrections : []).map(String), { limit: 400 });
    for (const entry of Array.isArray(pack.evolution) ? pack.evolution : []) {
      if (entry?.summary && !state.evolution.some((seen) => String(seen.summary) === String(entry.summary))) state.evolution.push(entry);
    }
    state.evolution = state.evolution.slice(-40);
    state.persona.traits = mergeList(
      state.persona.traits,
      (Array.isArray(pack.persona?.traits) ? pack.persona.traits : []).map(String),
      { limit: 12 }
    );
    if (!state.persona.course && pack.course) state.persona.course = String(pack.course).slice(0, 120);
    for (const kind of HISTORY_KEYS) {
      state.history[kind] = mergeList(state.history[kind], incomingHistory[kind], { key: historyKey, limit: HISTORY_LIMITS[kind] });
    }

    trimHistory();
    persist();
    hydrateFeeds();
    renderMemory();
    updateStatus();
    renderCourseUi();
    renderPackStatus(`Last import: ${packCounts(pack)}.`);
    toast(
      `Imported ${packCounts(pack)}${pack.course ? ` into ${pack.course}` : ''}${created ? ' — as a new course' : ''}.`
    );
  };
  reader.readAsText(file);
}

function renderPackStatus(extra = '') {
  const el = $('packStatus');
  if (!el) return;
  const pack = buildPack();
  el.textContent = `${pack.course || 'No course set'} · ${packCounts(pack)} — one file for another device, or a sheet to print.${extra ? ' ' + extra : ''}`;
}

/* A sheet is for the night before, not for scrolling: reasoning first, no
   buttons, page breaks that keep a question and its answer together. */
function revisionSheet() {
  const pack = buildPack();
  const esc = escapeHtml;
  const bullets = (items) => items.map((item) => `<li>${esc(String(item))}</li>`).join('');
  const notes = pack.notes.slice(-40).map((n) => `<li>${esc(String(n.text || ''))}</li>`).join('');
  const corrections = pack.corrections.slice(-40).map((m) => `<li>${esc(String(m))}</li>`).join('');
  const quizzes = pack.history.quizzes.slice(-25).map((q) => `
    <div class="q">
      <p class="qt">${esc(String(q.question || ''))}</p>
      <p class="qa"><strong>${q.choice ? `${esc(String(q.choice))} — ` : ''}${esc(String(q.answer || ''))}</strong></p>
      ${Array.isArray(q.points) && q.points.length ? `<ul class="why">${bullets(q.points)}</ul>` : ''}
    </div>`).join('');
  const answers = pack.history.answers.slice(-20).map((a) => `
    <div class="q">
      <p class="qt">${esc(String(a.question || ''))}</p>
      <p class="qa"><strong>${esc(String(a.answer || ''))}</strong></p>
      ${a.working ? `<p class="work">${esc(String(a.working))}</p>` : ''}
    </div>`).join('');
  const essays = pack.history.essays.slice(-10).map((e) => {
    const body = String(e.answer || '').replace(/\s+/g, ' ').trim();
    return `<li><strong>${esc(String(e.question || 'Essay'))}</strong> — ${esc(body.slice(0, 220))}${body.length > 220 ? '…' : ''}</li>`;
  }).join('');
  const sources = pack.history.sources.slice(-10).map((s) => `<li>${esc(String(s.question || 'Material read'))}</li>`).join('');
  const traits = pack.persona.traits.length ? `<ul>${bullets(pack.persona.traits)}</ul>` : '<p class="muted">Nothing learned yet.</p>';

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>${esc(pack.course || 'Sage')} — revision sheet</title>
<style>
  @page { margin: 16mm; }
  :root { color-scheme: light; }
  body { margin: 0; font: 12pt/1.45 -apple-system, "Segoe UI", Roboto, sans-serif; color: #111; background: #fff; }
  h1 { font-size: 21pt; margin: 0 0 2px; }
  h2 { font-size: 11pt; text-transform: uppercase; letter-spacing: .08em; margin: 22px 0 8px; border-bottom: 1px solid #ccc; padding-bottom: 4px; }
  .meta { color: #555; font-size: 10pt; margin: 0 0 6px; }
  .muted { color: #777; }
  ul { margin: 0; padding-left: 18px; }
  li { margin: 0 0 6px; break-inside: avoid; }
  .q { break-inside: avoid; margin: 0 0 12px; }
  .qt { margin: 0 0 3px; color: #444; }
  .qa { margin: 0 0 4px; }
  .work { margin: 0 0 0 10px; padding-left: 8px; border-left: 2px solid #ddd; color: #333; }
  .why { margin: 4px 0 0; color: #333; }
  .foot { margin-top: 26px; color: #666; font-size: 9pt; }
  @media screen { body { max-width: 720px; margin: 24px auto; padding: 0 16px 48px; } .bar { margin: 18px 0; } .bar button { font: inherit; padding: 7px 14px; } }
  @media print { .bar { display: none; } }
</style></head><body>
<div class="bar"><button onclick="window.print()">Print, or save as PDF</button></div>
<h1>${esc(pack.course || 'Course')} — revision sheet</h1>
<p class="meta">${esc(new Date().toLocaleDateString())} · made by Sage</p>
<h2>How it behaves for you</h2>${traits}
${notes ? `<h2>What was said in class</h2><ul>${notes}</ul>` : ''}
${corrections ? `<h2>What it learned and corrected</h2><ul>${corrections}</ul>` : ''}
${quizzes ? `<h2>Quiz, with the reasoning</h2>${quizzes}` : ''}
${answers ? `<h2>Answers, with the reasoning</h2>${answers}` : ''}
${essays ? `<h2>Essays written</h2><ul>${essays}</ul>` : ''}
${sources ? `<h2>Material relied on</h2><ul>${sources}</ul>` : ''}
<p class="foot">SAGE — Innotel Labs · innotel.us</p>
</body></html>`;

  const sheet = window.open('', '_blank');
  if (!sheet) {
    toast('The browser blocked the sheet — allow pop-ups for this site.', 'error');
    return;
  }
  sheet.document.write(html);
  sheet.document.close();
}

/* Native shell has no same-origin server, so absolute calls go to the API host. */
function apiUrl(pathname) {
  return (window.__SAGE_API__ || "") + pathname;
}

/* ── speech ────────────────────────────────────────────────── */
let voices = [];
function loadVoices() {
  voices = window.speechSynthesis?.getVoices?.() || [];
}
let currentAudio = null;

async function speakLocal(text) {
  try {
    const headers = { 'content-type': 'application/json' };
    if (state.settings.accessCode) headers['x-access-code'] = state.settings.accessCode;
    const res = await fetch(apiUrl('/api/tts'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: text.slice(0, 1500), voice: state.settings.ttsVoice || '' }),
    });
    if (!res.ok) return false;
    const blob = await res.blob();
    if (!blob.size) return false;
    const url = URL.createObjectURL(blob);
    if (currentAudio) currentAudio.pause();
    currentAudio = new Audio(url);
    currentAudio.onended = () => URL.revokeObjectURL(url);
    await currentAudio.play();
    return true;
  } catch {
    return false;
  }
}

function cleanForSpeech(text) {
  return String(text)
    .replace(/[`*_#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function speak(text) {
  if (!text) return;
  const clean = cleanForSpeech(text);
  if (!clean) return;

  // A local Kokoro voice first: smoother than any system voice and identical on
  // every device. Falls back to the browser when it is not configured.
  if (await speakLocal(clean)) return;

  if (!('speechSynthesis' in window)) {
    toast('This browser has no speech output.', 'error');
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(clean.slice(0, 900));
  const want = (state.language || 'en').slice(0, 2).toLowerCase();
  const match = voices.find((voice) => voice.lang.toLowerCase().startsWith(want));
  if (match) utterance.voice = match;
  utterance.rate = 1.02;
  utterance.pitch = 1;
  window.speechSynthesis.speak(utterance);
}

/* ── answer rendering ──────────────────────────────────────── */
function renderAnswer(res, container, question = '') {
  const structured = res.structured;
  const confidence = structured && typeof structured.confidence === 'number'
    ? Math.max(0, Math.min(1, structured.confidence))
    : null;
  const choice = structured?.choice ? String(structured.choice).toUpperCase().slice(0, 3) : '';
  const answer = structured?.answer || res.reply || '(no answer)';
  const working = structured?.working || (Array.isArray(structured?.points) ? structured.points.join('\n') : '');
  const why = structured?.why || '';
  const say = structured?.sayThis || '';

  container.hidden = false;
  container.innerHTML = `
    <div class="result-head">
      <span class="result-tag">${escapeHtml(res.mode || 'answer')}</span>
      <span class="result-tools">
        <button class="mini" data-copy="${escapeHtml(container.id)}">copy</button>
        <button class="mini" data-speak="${escapeHtml(container.id)}">speak</button>
      </span>
    </div>
    <div class="answer-main">${choice ? `<span class="choice">${escapeHtml(choice)}</span>` : ''}${md(answer)}</div>
    ${working ? `<div class="answer-work">${md(working)}</div>` : ''}
    ${why ? `<div class="answer-why">${escapeHtml(why)}</div>` : ''}
    ${say ? `<div class="say-row"><span class="say-text"><span class="say-label">say this</span>${escapeHtml(say)}</span><button class="mini" data-saytext="${escapeHtml(say)}">▶</button></div>` : ''}
    ${confidence !== null ? `<div class="conf"><span>confidence</span><div class="conf-bar"><div class="conf-fill" style="width:${Math.round(confidence * 100)}%"></div></div><span>${Math.round(confidence * 100)}%</span></div>` : ''}
  `;
  container.dataset.plain = [answer, working, why].filter(Boolean).join('\n');
  recordHistory('answers', { question: question || 'Answer given in class', answer, working, why });
  if (state.settings.tts && say) speak(say);
}

/* ── live actions ──────────────────────────────────────────── */
async function answerNow() {
  const button = $('btnAnswerNow');
  busy(button, true);
  try {
    const transcript = state.session.transcript.slice(-12).map((t) => t.text).join(' ');
    const latestNotes = state.session.notes.slice(-4).map((n) => n.text).join('\n');
    const text = [
      'The class has just asked a question, or the user needs the answer to what is currently on screen. Answer it.',
      transcript ? `What was said recently:\n${transcript.slice(-3500)}` : '',
      latestNotes ? `Notes so far:\n${latestNotes.slice(-1200)}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const images = cap.frame ? [cap.frame] : [];
    const res = await agent('answer', { text, images });
    renderAnswer(res, $('liveAnswer'), state.session.transcript.slice(-1)[0]?.text || 'Question asked in class');
  } catch (error) {
    toast(`Answer failed: ${error.message}`, 'error');
  } finally {
    busy(button, false);
  }
}

async function whatDoISay() {
  const button = $('btnSay');
  busy(button, true);
  try {
    const transcript = state.session.transcript.slice(-10).map((t) => t.text).join(' ');
    const res = await agent('phrase', {
      text: `The user has to speak out loud right now. Here is what was just said:\n${transcript.slice(-3000)}`,
      images: cap.frame ? [cap.frame] : [],
    });
    const box = $('liveAnswer');
    box.hidden = false;
    box.innerHTML = `<div class="result-head"><span class="result-tag">say this</span></div><div class="prose">${md(res.reply)}</div>`;
    box.dataset.plain = res.reply;
    if (state.settings.tts) speak(res.reply);
  } catch (error) {
    toast(`Failed: ${error.message}`, 'error');
  } finally {
    busy(button, false);
  }
}

/* ── study mode: listen + watch, answer without being asked ── */
let studyTimer = null;
let lastAutoAnswer = 0;
const QUESTION_HINT = /(\?\s*$)|(\b(what|why|how|which|who|when|where|define|explain|describe|calculate|solve|state|name|list|compare|true or false|fill in the blank)\b)/i;

function setStudyUi(on) {
  cap.study = on;
  const button = $('btnStudy');
  if (!button) return;
  button.textContent = on ? 'Stop study mode' : 'Start study mode';
  button.classList.toggle('danger', on);
  $('studyNote').textContent = on
    ? 'Listening and watching. Answers arrive on their own when a question appears.'
    : 'Listens and watches at the same time, answers when a question appears.';
}

async function toggleStudyMode() {
  if (cap.study) return stopStudyMode();
  setStudyUi(true);
  if (!cap.listenOn) await startListening();
  if (!cap.watchOn && !cap.cameraOn) {
    if (!IS_NATIVE && navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) await toggleWatch();
    else await toggleCamera();
  }
  stopStudyTimer();
  studyTimer = setInterval(studyTick, 20000);
  toast('Study mode on. It will answer questions as they appear.');
}

function stopStudyTimer() {
  if (studyTimer) {
    clearInterval(studyTimer);
    studyTimer = null;
  }
}

function stopStudyMode() {
  stopStudyTimer();
  setStudyUi(false);
  stopListening();
  stopWatch();
  stopCamera();
  toast('Study mode off.');
}

async function studyTick() {
  if (!cap.study) return;
  await flushTranscript();
  if (cap.frame) await analyseFrame(cap.frame);
}

function maybeAutoAnswer(text) {
  if (!cap.study) return;
  if (!QUESTION_HINT.test(text)) return;
  if (Date.now() - lastAutoAnswer < 45000) return;
  lastAutoAnswer = Date.now();
  autoAnswer(text);
}

async function autoAnswer(trigger) {
  try {
    const transcript = state.session.transcript.slice(-8).map(function (t) { return t.text; }).join(' ');
    const notes = state.session.notes.slice(-3).map(function (n) { return n.text; }).join('\n');
    const res = await agent('answer', {
      text:
        'A question was just asked in class. Answer it before the pause ends.\n\n' +
        'Just said:\n' + transcript.slice(-2500) +
        '\n\nNotes so far:\n' + notes.slice(-900) +
        '\n\nTrigger: ' + String(trigger).slice(0, 200),
      images: cap.frame ? [cap.frame] : [],
    });
    renderAnswer(res, $('liveAnswer'));
  } catch (error) {
    console.warn('auto answer failed', error.message);
  }
}

/* ── relay: another device captures, this one thinks ── */
const relay = { code: '', timer: null, lastAt: 0 };

async function joinRelay() {
  const input = $('relayCode');
  const code = (input.value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!/^[a-z0-9]{4,12}$/.test(code)) {
    toast('Enter the code shown on the relay page.');
    return;
  }
  stopRelay();
  relay.code = code;
  relay.lastAt = 0;
  $('relayStatus').hidden = false;
  $('relayStatus').textContent = 'Waiting for frames from ' + code + '…';
  try {
    const first = await api('/api/relay/' + code + '/latest?since=0');
    relay.lastAt = first.at || 0;
    if (first.image) {
      cap.frame = first.image;
      cap.frames += 1;
    }
  } catch (error) {
    $('relayStatus').textContent = error.message;
  }
  relay.timer = setInterval(relayTick, 4000);
  input.readOnly = true;
  $('btnRelayJoin').textContent = 'Leave';
}

function stopRelay() {
  if (relay.timer) {
    clearInterval(relay.timer);
    relay.timer = null;
  }
  relay.code = '';
  relay.lastAt = 0;
  const input = $('relayCode');
  const status = $('relayStatus');
  if (input) input.readOnly = false;
  if (input) input.value = '';
  if (status) status.hidden = true;
  const button = $('btnRelayJoin');
  if (button) button.textContent = 'Join';
}

async function relayTick() {
  if (!relay.code) return;
  try {
    const res = await api('/api/relay/' + relay.code + '/latest?since=' + relay.lastAt);
    if (res.at) relay.lastAt = res.at;
    if (!res.image) return;
    cap.frame = res.image;
    cap.frames += 1;
    $('relayStatus').textContent = 'Relay ' + relay.code + ' · ' + res.frames + ' frames received · live';
    updateStatus();
    if (state.settings.autoNotes) analyseFrame(res.image);
  } catch (error) {
    const message = String(error.message || '');
    if (message.indexOf('Nothing is sharing') !== -1) {
      $('relayStatus').textContent = 'Relay ' + relay.code + ' is not sharing yet.';
    }
  }
}

function toggleRelay() {
  if (relay.timer) stopRelay();
  else joinRelay();
}

/* ── image/file utilities ──────────────────────────────────── */
function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function shrinkImage(file, maxWidth = 1400) {
  const url = await readAsDataUrl(file);
  const image = new Image();
  image.src = url;
  await image.decode().catch(() => {});
  if (!image.width) return url;
  return toJpeg(image, maxWidth, 0.75) || url;
}

async function sampleVideo(file, count = 6) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  await new Promise((resolve, reject) => {
    video.onloadeddata = resolve;
    video.onerror = () => reject(new Error('Could not decode that video.'));
    setTimeout(resolve, 8000);
  });
  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
  const frames = [];
  if (!duration) {
    frames.push(toJpeg(video, 1280, 0.72));
  } else {
    const picks = Math.min(count, Math.max(2, Math.round(duration / 30)));
    for (let i = 0; i < picks; i += 1) {
      const at = (duration * (i + 0.5)) / picks;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => {
        video.onseeked = resolve;
        video.currentTime = Math.min(at, Math.max(0, duration - 0.2));
        setTimeout(resolve, 2500);
      });
      const frame = toJpeg(video, 1280, 0.7);
      if (frame) frames.push(frame);
    }
  }
  URL.revokeObjectURL(url);
  return frames.filter(Boolean);
}

function renderThumbs(container, items) {
  container.innerHTML = '';
  items.forEach((item, index) => {
    const div = document.createElement('div');
    div.className = 'thumb';
    div.innerHTML = `<img src="${item.preview}" alt="${escapeHtml(item.name || 'attached photo')}" />
      <button type="button" class="thumb-x" data-remove="${index}" aria-label="Remove this photo" title="Remove">✕</button>`;
    container.appendChild(div);
  });
  // One delegated listener: the ✕ is a real 30px button, and closest() finds it
  // even when the tap lands on its edge.
  container.onclick = (event) => {
    const button = event.target.closest('[data-remove]');
    if (!button) return;
    items.splice(Number(button.dataset.remove), 1);
    renderThumbs(container, items);
  };
}

async function collectFiles(fileList, { max = 6 } = {}) {
  const images = [];
  const texts = [];
  const videos = [];
  for (const file of [...fileList].slice(0, max)) {
    if (file.type.startsWith('image/')) images.push(file);
    else if (file.type.startsWith('video/')) videos.push(file);
    else texts.push(file);
  }
  const frames = [];
  for (const file of images.slice(0, 6)) frames.push(await shrinkImage(file));
  for (const file of videos.slice(0, 2)) frames.push(...(await sampleVideo(file)));
  const transcripts = [];
  for (const file of texts.slice(0, 3)) transcripts.push((await file.text()).slice(0, 20000));
  return { frames: frames.filter(Boolean).slice(0, 6), texts: transcripts };
}

/* ── answer tab ────────────────────────────────────────────── */
const answerFiles = [];
function clearAnswerFiles() {
  answerFiles.length = 0;
  renderThumbs($('answerThumbs'), answerFiles);
  $('answerFileCount').textContent = '';
  $('btnClearAnswerFiles').hidden = true;
}
async function onAnswerFiles(event) {
  const files = [...event.target.files];
  for (const file of files.slice(0, 4)) {
    const preview = await shrinkImage(file, 1100);
    answerFiles.push({ preview });
  }
  renderThumbs($('answerThumbs'), answerFiles);
  $('answerFileCount').textContent = answerFiles.length ? `${answerFiles.length} attached` : '';
  $('btnClearAnswerFiles').hidden = !answerFiles.length;
  event.target.value = '';
}

async function answerQuestion() {
  const text = $('answerText').value.trim();
  if (!text && !answerFiles.length) {
    toast('Type the question or attach a photo of it.');
    return;
  }
  const button = $('btnAnswer');
  busy(button, true);
  try {
    const res = await agent('answer', { text: text || 'Answer the question shown in the image.', images: answerFiles.map((f) => f.preview) });
    renderAnswer(res, $('answerResult'), text || 'Question shown in a photo');
  } catch (error) {
    toast(`Answer failed: ${error.message}`, 'error');
  } finally {
    busy(button, false);
    // The photo existed only to be read. Caching it past the answer meant the
    // next question silently inherited the previous one's page.
    clearAnswerFiles();
  }
}

/* ── quiz tab ──────────────────────────────────────────────── */
const quizFiles = [];
let quizAbort = false;

function splitQuestions(raw) {
  const text = raw.trim();
  if (!text) return [];
  let blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  if (blocks.length === 1) {
    const numbered = text.split(/\n(?=\s*\d{1,2}[.)]\s)/).map((b) => b.trim()).filter(Boolean);
    if (numbered.length > 1) blocks = numbered;
  }
  return blocks;
}

async function onQuizFiles(event) {
  for (const file of [...event.target.files].slice(0, 4)) {
    quizFiles.push({ preview: await shrinkImage(file, 1400) });
  }
  renderThumbs($('quizThumbs'), quizFiles);
  $('quizFileCount').textContent = quizFiles.length ? `${quizFiles.length} attached` : '';
  event.target.value = '';
}

function quizCard(question, res, index) {
  const card = document.createElement('div');
  card.className = 'result';
  const structured = res.structured || {};
  const choice = structured.choice ? String(structured.choice).toUpperCase() : '';
  const answer = structured.answer || res.reply || '';
  const points = Array.isArray(structured.points) ? structured.points : [];
  const confidence = typeof structured.confidence === 'number' ? Math.round(structured.confidence * 100) : null;
  card.innerHTML = `
    <div class="result-head">
      <span class="result-tag">Q${index + 1}</span>
      ${confidence !== null ? `<span class="mini muted">${confidence}% sure</span>` : ''}
    </div>
    <div class="mini muted" style="margin-bottom:8px">${escapeHtml(question.slice(0, 180))}${question.length > 180 ? '…' : ''}</div>
    <div class="answer-main">${choice ? `<span class="choice">${escapeHtml(choice)}</span>` : ''}${md(answer)}</div>
    ${points.length ? `<div class="answer-work">${md(points.map((p) => `- ${p}`).join('\n'))}</div>` : ''}
    ${structured.why ? `<div class="answer-why">${escapeHtml(structured.why)}</div>` : ''}
  `;
  recordHistory('quizzes', { question, choice, answer, points, why: structured.why || '', confidence });
  return card;
}

async function solveQuiz() {
  const questions = splitQuestions($('quizText').value);
  if (!questions.length && !quizFiles.length) {
    toast('Paste the quiz or attach a photo of it.');
    return;
  }
  const list = questions.length ? questions : ['Answer every question on the attached quiz page, in order.'];
  quizAbort = false;
  $('quizResults').innerHTML = '';
  $('btnQuizStop').disabled = false;
  busy($('btnQuizSolve'), true);
  for (let i = 0; i < list.length; i += 1) {
    if (quizAbort) break;
    $('quizProgress').textContent = `Question ${i + 1} of ${list.length}…`;
    try {
      const res = await agent('quiz', {
        text: list[i],
        images: i === 0 ? quizFiles.map((f) => f.preview) : [],
      });
      $('quizResults').appendChild(quizCard(list[i], res, i));
    } catch (error) {
      $('quizProgress').textContent = '';
      toast(`Question ${i + 1} failed: ${error.message}`, 'error');
      break;
    }
  }
  $('quizProgress').textContent = quizAbort ? 'Stopped.' : 'Done.';
  $('btnQuizStop').disabled = true;
  busy($('btnQuizSolve'), false);
}

/* ── essay tab ─────────────────────────────────────────────── */
let lastEssay = '';
async function writeEssay() {
  const topic = $('essayTopic').value.trim();
  if (!topic) {
    toast('Give it the essay question first.');
    $('essayTopic').focus();
    return;
  }
  const words = Math.max(150, Math.min(4000, Number($('essayWords').value) || 800));
  const tone = $('essayTone').value;
  const rubric = $('essayRubric').value.trim();
  const sources = $('essaySources').value.trim();
  const button = $('btnEssay');
  busy(button, true);
  $('essayResult').hidden = true;
  try {
    const brief = [
      `Essay question: ${topic}`,
      `Target length: about ${words} words.`,
      tone ? `Required register: ${tone}.` : '',
      rubric ? `Rubric / what earns marks:\n${rubric}` : '',
      sources
        ? `Material you may rely on (do not cite anything outside it):\n${sources}`
        : 'No material supplied: rely on well-established knowledge only, and cite nothing.',
      state.persona.course ? `Course context: ${state.persona.course}.` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const res = await agent('essay', { text: brief, maxTokens: Math.min(3800, Math.round(words * 2.2)) });
    lastEssay = res.reply;
    recordHistory('essays', { question: topic, answer: res.reply });
    $('essayOutput').innerHTML = md(res.reply);
    $('essayResult').hidden = false;
    $('essayResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    toast(`Essay failed: ${error.message}`, 'error');
  } finally {
    busy(button, false);
  }
}

/* ── read tab ──────────────────────────────────────────────── */
const readFiles = [];
let autoProcessRead = false;
async function onReadFiles(event) {
  const files = [...event.target.files];
  for (const file of files.slice(0, 6)) {
    if (file.type.startsWith('image/')) {
      readFiles.push({ preview: await shrinkImage(file, 1400), name: file.name });
    } else if (file.type.startsWith('video/')) {
      const frames = await sampleVideo(file, 6);
      frames.slice(0, 4).forEach((preview, i) => readFiles.push({ preview, name: `${file.name} · frame ${i + 1}` }));
    } else {
      const text = (await file.text()).slice(0, 20000);
      readFiles.push({ preview: '', name: file.name, text });
    }
  }
  renderThumbs($('readThumbs'), readFiles.filter((f) => f.preview));
  $('readFilesLabel').textContent = readFiles.length ? `${readFiles.length} thing(s) loaded` : '＋ files, photos, screen recording';
  event.target.value = '';
  // An Apple screen recording was imported through the Watch button: read it
  // straight away instead of making the user find the second button.
  if (autoProcessRead) {
    autoProcessRead = false;
    runRead();
  }
}

async function runRead() {
  const pasted = $('readPaste').value.trim();
  const images = readFiles.map((f) => f.preview).filter(Boolean).slice(0, 6);
  const texts = readFiles.map((f) => f.text).filter(Boolean);
  if (!pasted && !images.length && !texts.length) {
    toast('Attach something or paste text.');
    return;
  }
  const button = $('btnRead');
  busy(button, true);
  try {
    const res = await agent('read', {
      text: [texts.join('\n\n').slice(0, 12000), pasted].filter(Boolean).join('\n\n') || 'Read the attached material and produce study notes.',
      images,
      maxTokens: 2000,
    });
    $('readOutput').innerHTML = md(res.reply);
    recordHistory('sources', {
      question: readFiles.map((f) => f.name).filter(Boolean).join(', ') || pasted.slice(0, 120) || 'Material read',
      answer: res.reply,
    });
    $('readResult').hidden = false;
    $('readResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    toast(`Read failed: ${error.message}`, 'error');
  } finally {
    busy(button, false);
  }
}

/* ── settings ──────────────────────────────────────────────── */
/* ── gateway admin ─────────────────────────────────────────── */
/* ── the session clock ─────────────────────────────────────── */
/* A bought key stops working when its window closes. The clock is read from the
   expiry the claim returned rather than from a guess, and when it runs out the
   capture loops stop with it — otherwise every note interval and frame keeps
   firing at the gateway and every one comes back 401. */
function parseUtcStamp(stamp) {
  if (!stamp) return null;
  const raw = String(stamp).trim();
  const iso = /(Z|[+-]\d\d:?\d\d)$/.test(raw) ? raw : raw.replace(' ', 'T') + 'Z';
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** Milliseconds left on a bought session, or null when the key is not one. */
function sessionRemainingMs() {
  const ends = parseUtcStamp(state.settings.keyExpiresAt);
  return ends === null ? null : ends - Date.now();
}

function renderSessionClock() {
  const el = $('sessionClock');
  if (!el) return;
  const left = sessionRemainingMs();
  if (left === null) {
    el.textContent = '';
    el.removeAttribute('data-state');
    return;
  }
  if (left <= 0) {
    el.textContent = 'Session ended — capture is paused. Buy another in Settings → Session.';
    el.setAttribute('data-state', 'over');
    return;
  }
  const mins = Math.floor(left / 60000);
  const secs = Math.floor((left % 60000) / 1000);
  el.textContent = 'Session key: ' + mins + ':' + String(secs).padStart(2, '0') + ' left on this device.';
  el.setAttribute('data-state', 'live');
}

let sessionEndedHandled = false;

function checkSessionClock() {
  renderSessionClock();
  const left = sessionRemainingMs();
  if (left === null) return;
  if (left > 0) {
    sessionEndedHandled = false;
    return;
  }
  if (sessionEndedHandled) return;
  sessionEndedHandled = true;
  try { stopListening(); } catch { /* already stopped */ }
  try { stopWatch(); } catch { /* already stopped */ }
  try { stopCamera(); } catch { /* already stopped */ }
  if (cap.study) {
    try { stopStudyMode(); } catch { /* already stopped */ }
  }
  toast('Your session ended — capture paused. Buy another in Settings → Session.', 'error');
  updateStatus();
  checkHealth();
}

/* ── keys bought at Magnate ────────────────────────────────── */
/* The receipt page opens this app at /#claim=<code>. The code is traded for the
   key on our own server, so the browser never needs CORS access to billing, and
   the key is checked with the gateway before it replaces anything stored. */
async function claimGatewayKey(token, options) {
  const code = String(token || '').trim();
  if (!code) return { ok: false, message: 'No claim code was given.' };
  let data;
  try {
    data = await api('/api/claim', { body: { token: code } });
  } catch (error) {
    return { ok: false, message: error.message };
  }
  const base = (data.baseUrl || GATEWAY_DEFAULT).replace(/\/+$/, '');
  const check = await verifyGatewayKey(data.key, base);
  if (!check.ok) {
    return { ok: false, message: 'The gateway refused the key Magnate issued: ' + check.message };
  }
  state.settings.gatewayKey = data.key;
  state.settings.gatewayBase = base;
  state.settings.keyExpiresAt = data.expiresAt
    ? String(data.expiresAt)
    : Number(data.secondsLeft)
      ? new Date(Date.now() + Number(data.secondsLeft) * 1000).toISOString()
      : '';
  sessionEndedHandled = false;
  persist();
  renderSessionClock();
  renderGatewayChips(check.models);
  showAutoModel();
  if ($('setGatewayKey')) $('setGatewayKey').value = data.key;
  if ($('setGatewayBase')) $('setGatewayBase').value = base;
  if ($('gatewayStatus')) {
    $('gatewayStatus').textContent = (data.planName || 'Purchased session') + ' · ' + check.message;
  }
  const minutes = Math.floor((Number(data.secondsLeft) || 0) / 60);
  if (!options || !options.silent) {
    toast('Session key added' + (minutes ? ' — ' + minutes + ' minutes left.' : '.'));
  }
  checkHealth();
  return { ok: true, session: data };
}

async function claimFromSettings() {
  const input = $('setClaimCode');
  const status = $('claimStatus');
  const button = $('btnClaim');
  if (!input || !status) return;
  busy(button, true);
  status.textContent = 'Claiming…';
  try {
    const result = await claimGatewayKey(input.value, { silent: true });
    status.textContent = result.ok
      ? 'Claimed · ' + (result.session.planName || 'session') + ' key installed.'
      : result.message;
    if (result.ok) input.value = '';
  } finally {
    busy(button, false);
  }
}

/* Read the claim out of the address bar once, then strip it: a screenshot or a
   reload should not replay a code that is only good for the minutes left. */
function takeClaimFromUrl() {
  const pattern = /(?:^|[#&?])claim=([A-Za-z0-9_-]{8,64})/;
  const found = pattern.exec(location.hash || '') || pattern.exec(location.search || '');
  if (!found) return '';
  try {
    const clean = (location.pathname + location.search + location.hash)
      .replace(/([#&?])claim=[A-Za-z0-9_-]{8,64}&?/, '$1')
      .replace(/[#&?]$/, '');
    history.replaceState(null, '', clean);
  } catch {
    /* a native shell may refuse history changes; the code is read once a load */
  }
  return found[1];
}

/* One ticker for the whole app: it redraws the clock and stops capture the
   moment a session runs out. */
(function startSessionClock() {
  renderSessionClock();
  setInterval(checkSessionClock, 1000);
})();

(function claimOnLoad() {
  const token = takeClaimFromUrl();
  if (!token) return;
  const run = () => claimGatewayKey(token);
  if (document.readyState === 'complete') setTimeout(run, 500);
  else window.addEventListener('load', () => setTimeout(run, 500));
})();

function gatewayBase() {
  return (state.settings.gatewayBase || GATEWAY_DEFAULT).replace(/\/+$/, '');
}

function gatewayError(body) {
  const err = body && body.error;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') return err.message || err.code || 'rejected';
  return '';
}

/* A key only counts as an OmniRoute key if the gateway itself accepts it. */
async function verifyGatewayKey(key, base) {
  let res;
  try {
    res = await fetch(base + '/models', {
      headers: { authorization: 'Bearer ' + key, accept: 'application/json' },
    });
  } catch (error) {
    return { ok: false, message: 'Cannot reach ' + base + ' (' + error.message + ').' };
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = gatewayError(body);
    return { ok: false, message: detail ? res.status + ': ' + detail : 'Gateway rejected the key (' + res.status + ').' };
  }
  const list = Array.isArray(body && body.data) ? body.data : Array.isArray(body && body.models) ? body.models : [];
  const models = list.map(function (m) { return String((m && (m.id || m.name)) || m); }).filter(Boolean).slice(0, 24);
  return { ok: true, models: models, message: 'Accepted · ' + (models.length || 'all') + ' routes available.' };
}

function renderGatewayChips(models) {
  const chips = $('gatewayModels');
  chips.innerHTML = '';
  for (const model of models) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = model;
    chips.appendChild(chip);
  }
}

/* Nothing to choose: the server ranks the models this key can call and uses the
   best one. This line just says which, so a weak answer is explainable. */
async function showAutoModel() {
  const status = $('modelStatus');
  if (!status) return;
  status.textContent = 'Choosing the best model this key can call…';
  try {
    const data = await api('/api/models');
    const count = (data.models || []).length;
    const best = data.best ? String(data.best).split('/').pop() : '';
    const fast = data.fast ? String(data.fast).split('/').pop() : '';
    if (best && fast && best !== fast) {
      status.textContent = data.verified
        ? best + ' for answers, ' + fast + ' for running notes — chosen automatically from ' + count + ' models this key can call.'
        : 'Trying ' + best + ' for answers and ' + fast + ' for notes, out of ' + count + ' models this key can call.';
    } else if (best) {
      status.textContent = 'Using ' + best + ' — chosen automatically from ' + count + ' models this key can call.';
    } else {
      status.textContent = 'Using the gateway default' + (data.model ? ' (' + data.model + ')' : '') + '.';
    }
  } catch (error) {
    status.textContent = error.message;
  }
}

async function saveGatewayKey() {
  const button = $('btnVerifyKey');
  const status = $('gatewayStatus');
  const key = $('setGatewayKey').value.trim();
  const base = ($('setGatewayBase').value.trim() || GATEWAY_DEFAULT).replace(/\/+$/, '');

  if (!key) {
    state.settings.gatewayKey = '';
    state.settings.gatewayBase = base;
    persist();
    renderGatewayChips([]);
    status.textContent = 'No gateway key stored — falling back to the server key, if it has one.';
    checkHealth();
    return;
  }
  if (base !== GATEWAY_DEFAULT) {
    status.textContent = 'Base URL must be ' + GATEWAY_DEFAULT + '.';
    return;
  }

  busy(button, true);
  status.textContent = 'Checking the key with the gateway…';
  try {
    const result = await verifyGatewayKey(key, base);
    if (!result.ok) {
      renderGatewayChips([]);
      status.textContent = 'Rejected — ' + result.message;
      toast('That key was not accepted by the gateway.', 'error');
      return;
    }
    state.settings.gatewayKey = key;
    state.settings.gatewayBase = base;
    // A key pasted by hand carries no window; only a claim knows one.
    state.settings.keyExpiresAt = '';
    sessionEndedHandled = false;
    persist();
    renderSessionClock();
    status.textContent = result.message;
    renderGatewayChips(result.models);
    showAutoModel();
    $('modelTag').textContent = 'gateway';
    toast('Gateway key accepted.');
    checkHealth();
  } finally {
    busy(button, false);
  }
}

/* A named DOMException reads far better than one blanket "denied" message. */
function micBlockedMessage(error) {
  const name = String((error && error.name) || 'Error');
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return IS_NATIVE
      ? 'iOS has the microphone switched off for Sage. Settings → Sage → Microphone → on, then reopen the app.'
      : 'Microphone blocked. Allow it, or open this page over HTTPS.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone is available.';
  if (name === 'NotReadableError') return 'Another app is holding the microphone.';
  return 'Microphone blocked (' + name + '): ' + ((error && error.message) || 'unknown error');
}

async function micCheck() {
  const out = $('micStatus');
  const bits = [
    IS_NATIVE ? 'native shell' : location.protocol.replace(':', ''),
    window.isSecureContext ? 'secure context' : 'NOT a secure context',
    navigator.mediaDevices && navigator.mediaDevices.getUserMedia ? 'getUserMedia' : 'no getUserMedia',
    IS_NATIVE || dictationOff ? 'server transcription' : window.SpeechRecognition || window.webkitSpeechRecognition ? 'on-device dictation' : 'no dictation',
  ];
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const track = stream.getAudioTracks()[0];
    bits.push('mic: ' + ((track && track.label) || 'unnamed'));
    stream.getTracks().forEach(function (t) { t.stop(); });
  } catch (error) {
    bits.push('mic error: ' + ((error && error.name) || 'unknown'));
  }
  out.textContent = bits.join(' · ');
}

/* ── buying a session ──────────────────────────────────────── */
/* Magnate prices the session and runs the payment; this app is where the
   decision is made. The checkout is started by our own server so the browser
   never needs CORS access to a billing origin, and the receipt page opens this
   app at #claim=<code>, which installs the key with no copying. */
const store = { plans: [], slug: '', page: '', minutes: 15 };

function chosenPlan() {
  return store.plans.find((plan) => plan.slug === store.slug) || store.plans[0] || null;
}

function planLabel(plan) {
  const label = String(plan?.name || plan?.slug || 'session').replace(/^sage-session-/, '').replace(/-/g, ' ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function money(cents) {
  return '$' + (Number(cents || 0) / 100).toFixed(2);
}

async function loadStore() {
  try {
    const data = await api('/api/store');
    store.plans = Array.isArray(data.plans) ? data.plans : [];
    store.page = data.page || '';
    store.minutes = Number(data.minutes) || 15;
    if (!store.plans.some((plan) => plan.slug === store.slug)) store.slug = store.plans[0]?.slug || '';
  } catch {
    // An unreachable store is not a broken app: the page link still works.
    store.plans = [];
  }
  renderStore();
}

function renderStore() {
  const host = $('storePlans');
  if (!host) return;
  host.innerHTML = '';
  const note = $('storeNote');
  const buy = $('btnBuy');
  const page = $('btnStorePage');
  const plan = chosenPlan();

  if (!plan) {
    if (note) {
      note.textContent = 'Sessions are priced on Magnate, which runs the payment; the receipt carries a claim code that installs the key here.';
    }
    if (buy) buy.hidden = true;
    if (page) page.hidden = false;
    return;
  }
  if (buy) buy.hidden = false;
  if (page) page.hidden = true;
  for (const option of store.plans) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn ' + (option.slug === plan.slug ? 'primary' : 'ghost');
    button.textContent = planLabel(option) + ' · ' + money(option.priceCents);
    button.onclick = () => {
      store.slug = option.slug;
      renderStore();
    };
    host.appendChild(button);
  }
  if (note) {
    note.textContent =
      planLabel(plan) + ' — ' + store.minutes + ' minutes of the gateway, ' + money(plan.priceCents) +
      ' each. One key, usable as often as you like until the window closes.';
  }
}

async function startPurchase() {
  const status = $('buyStatus');
  const button = $('btnBuy');
  const email = String($('setReceiptEmail')?.value || '').trim();
  const sessions = Math.max(1, Math.min(10, Math.floor(Number($('setSessions')?.value) || 1)));
  const plan = chosenPlan();
  if (!plan) return openStorePage();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    if (status) status.textContent = 'An email is needed for the receipt — that is where the key appears.';
    $('setReceiptEmail')?.focus();
    return;
  }
  state.settings.receiptEmail = email;
  persist();
  busy(button, true);
  if (status) status.textContent = 'Starting the checkout…';
  try {
    const data = await api('/api/store/checkout', { body: { planSlug: plan.slug, email, sessions } });
    if (!data.url) throw new Error('The store did not return a checkout link.');
    if (status) status.textContent = 'Opening the payment page. Leave it open until it confirms — the key installs itself.';
    openStoreUrl(data.url);
  } catch (error) {
    if (status) status.textContent = error.message;
  } finally {
    busy(button, false);
  }
}

function openStorePage() {
  openStoreUrl(store.page || 'https://magnate.innotel.us/sage');
}

/* A tab is the honest place for a payment page: it keeps its own back button and
   the receipt can reopen this app. A shell with no tabs sends the page to its
   browser instead, and says so if even that is refused. */
function openStoreUrl(url) {
  let opened = null;
  try {
    opened = window.open(url, '_blank', 'noopener');
  } catch {
    opened = null;
  }
  if (opened) return;
  try {
    location.href = url;
    return;
  } catch {
    /* fall through to the link */
  }
  const status = $('buyStatus');
  if (!status) return;
  status.textContent = '';
  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = 'Open the payment page';
  status.appendChild(link);
}

function openSettings() {
  const p = state.persona;
  $('setName').value = p.name;
  $('setCourse').value = p.course;
  $('setTone').value = p.tone;
  $('setDepth').value = p.depth;
  $('setHumour').value = String(p.humour);
  $('setRisk').value = String(p.risk);
  $('setLanguage').value = state.language;
  $('setInterval').value = String(state.settings.noteIntervalSec);
  $('setAccess').value = state.settings.accessCode;
  $('setAutoNotes').checked = state.settings.autoNotes;
  $('setTts').checked = state.settings.tts;
  $('settingsStatus').textContent = health
    ? `${health.provider} · ${health.chatModel} · vision ${health.visionModel}`
    : '';
  $('setGatewayKey').value = state.settings.gatewayKey || '';
  $('setGatewayBase').value = state.settings.gatewayBase || GATEWAY_DEFAULT;
  showAutoModel();
  $('gatewayStatus').textContent = state.settings.gatewayKey
    ? 'Key stored on this device. Use the mic check if capture is refusing.'
    : '';
  $('micStatus').textContent = '';
  if ($('setReceiptEmail')) $('setReceiptEmail').value = state.settings.receiptEmail || '';
  if ($('setSessions')) $('setSessions').value = '1';
  if ($('buyStatus')) $('buyStatus').textContent = '';
  loadStore();
  $('settingsDialog').showModal();
}

function saveSettings() {
  const previousCode = state.settings.accessCode;
  state.persona.name = $('setName').value.trim().slice(0, 30) || 'Sage';
  state.persona.course = $('setCourse').value.trim().slice(0, 120);
  state.persona.tone = $('setTone').value;
  state.persona.depth = $('setDepth').value;
  state.persona.humour = Number($('setHumour').value);
  state.persona.risk = Number($('setRisk').value);
  state.language = $('setLanguage').value.trim().slice(0, 40);
  state.settings.noteIntervalSec = Math.max(8, Math.min(120, Number($('setInterval').value) || 20));
  state.settings.accessCode = $('setAccess').value.trim();
  state.settings.receiptEmail = String($('setReceiptEmail')?.value || '').trim();
  state.settings.autoNotes = $('setAutoNotes').checked;
  state.settings.tts = $('setTts').checked;
  clearInterval(cap.noteTimer);
  cap.noteTimer = cap.listenOn ? setInterval(flushTranscript, state.settings.noteIntervalSec * 1000) : null;
  $('agentName').textContent = state.persona.name;
  renderCourseUi();
  persist();
  updateStatus();
  renderMemory();
  toast('Saved.');
  // A code that has just been entered or cleared changes who the server thinks is
  // asking, so the workspace is offered to it (or given up) right away.
  if (state.settings.accessCode !== previousCode) syncWorkspace();
}

async function testConnection() {
  const button = $('btnTestConn');
  busy(button, true);
  $('settingsStatus').textContent = 'Testing…';
  try {
    const res = await api('/api/chat', { body: { mode: 'note', text: 'Reply with the single word: ready', maxTokens: 12 } });
    $('settingsStatus').textContent = `Working: ${res.model} replied "${res.reply.slice(0, 40)}"`;
  } catch (error) {
    $('settingsStatus').textContent = `Failed: ${error.message}`;
  } finally {
    busy(button, false);
  }
}

/* Screen capture is unavailable on iOS in every browser and app shell, so the
   Watch button offers the routes that do work rather than failing. */
function openTab(name) {
  state.ui = { ...(state.ui || {}), tab: name };
  persist();
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function offerScreenFallback() {
  const dialog = $('screenDialog');
  if (!dialog) {
    toast('This device cannot capture the screen. Mirror it to a computer and use a relay code, or upload a recording in Read.', 'error');
    return;
  }
  if (!dialog.open) dialog.showModal();
}

/* ── wiring ────────────────────────────────────────────────── */
function bind() {
  $('tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('.tab');
    if (!tab) return;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.panel').forEach((panel) => {
      panel.classList.toggle('active', panel.id === `tab-${tab.dataset.tab}`);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
    state.ui = { ...(state.ui || {}), tab: tab.dataset.tab };
    persist();
  });

  $('btnSettings').onclick = openSettings;
  $('btnRetryHealth').onclick = checkHealth;
  $('btnSaveSettings').onclick = () => setTimeout(saveSettings, 0);
  $('btnTestConn').onclick = testConnection;
  $('btnVerifyKey').onclick = saveGatewayKey;
  $('btnMicCheck').onclick = micCheck;
  $('btnBuy').onclick = startPurchase;
  $('btnStorePage').onclick = openStorePage;
  $('btnScreenRelay').onclick = () => {
    $('screenDialog').close();
    openTab('live');
    $('relayCode').focus();
    toast('Open /relay.html on the computer showing the class, share the window there, then enter its code.');
  };
  $('btnScreenRecord').onclick = () => {
    $('screenDialog').close();
    openTab('read');
    autoProcessRead = true;
    toast('Pick the screen recording from Photos — it is read into frames and notes automatically.');
    setTimeout(() => $('readFiles').click(), 250);
  };
  $('btnScreenCamera').onclick = () => {
    $('screenDialog').close();
    toggleCamera();
  };
  $('btnScreenClose').onclick = () => $('screenDialog').close();
  $('btnCloseSettings').onclick = () => $('settingsDialog').close();
  $('btnClearAnswerFiles').onclick = clearAnswerFiles;

  $('btnListen').onclick = startListening;
  $('btnScreen').onclick = toggleWatch;
  $('btnCamera').onclick = toggleCamera;
  $('btnStopAll').onclick = () => {
    stopStudyTimer();
    setStudyUi(false);
    stopRelay();
    stopListening();
    stopWatch();
    stopCamera();
    showInterim('');
    toast('All capture stopped.');
  };

  $('btnStudy').onclick = toggleStudyMode;
  $('btnRelayJoin').onclick = toggleRelay;

  $('ttsToggle').onchange = (event) => {
    state.settings.tts = event.target.checked;
    $('setTts').checked = event.target.checked;
    persist();
  };

  $('btnClearTranscript').onclick = () => {
    state.session.transcript = [];
    cap.words = 0;
    hydrateFeeds();
    updateStatus();
  };
  $('btnClearNotes').onclick = () => {
    state.session.notes = [];
    hydrateFeeds();
    updateStatus();
  };

  $('btnAnswerNow').onclick = answerNow;
  $('btnSay').onclick = whatDoISay;
  $('btnLiveAsk').onclick = async () => {
    const input = $('liveAskInput');
    const question = input.value.trim();
    if (!question) return;
    input.value = '';
    const button = $('btnLiveAsk');
    busy(button, true);
    try {
      const res = await agent('answer', { text: question, images: cap.frame ? [cap.frame] : [] });
      renderAnswer(res, $('liveAnswer'));
    } catch (error) {
      toast(`Failed: ${error.message}`, 'error');
    } finally {
      busy(button, false);
    }
  };
  $('liveAskInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') $('btnLiveAsk').click();
  });

  $('answerFiles').onchange = onAnswerFiles;
  $('btnAnswer').onclick = answerQuestion;

  $('quizFiles').onchange = onQuizFiles;
  $('btnQuizSolve').onclick = solveQuiz;
  $('btnQuizStop').onclick = () => {
    quizAbort = true;
    $('quizProgress').textContent = 'Stopping…';
  };

  $('btnEssay').onclick = writeEssay;
  $('btnEssayCopy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(lastEssay);
      toast('Copied.');
    } catch {
      toast('Copy blocked by the browser.', 'error');
    }
  };
  $('btnEssayDownload').onclick = () => {
    const blob = new Blob([lastEssay], { type: 'text/markdown' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `essay-${new Date().toISOString().slice(0, 10)}.md`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
  };

  $('readFiles').onchange = onReadFiles;
  $('btnRead').onclick = runRead;

  $('btnEvolve').onclick = evolve;
  $('btnExport').onclick = exportMemory;
  $('btnPackExport').onclick = exportPack;
  $('btnPackImport').onclick = () => $('packFile').click();
  $('packFile').onchange = (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    importPack(file);
  };
  $('btnRevision').onclick = revisionSheet;
  $('courseSelect').onchange = (event) => switchCourse(event.target.value);
  $('btnNewCourse').onclick = newCourse;
  $('btnSlotAdd').onclick = addSlot;
  $('btnSyncNow').onclick = () => syncWorkspace({ announce: true });
  $('timetableList').addEventListener('click', (event) => {
    const id = event.target.dataset?.slot;
    if (!id) return;
    state.timetable = state.timetable.filter((slot) => slot.id !== id);
    persist();
    renderTimetable();
  });
  $('btnClearMemory').onclick = () => {
    if (!confirm('Forget every note and evolved trait?')) return;
    state.memory = [];
    state.persona.traits = [];
    state.evolution = [];
    renderMemory();
    updateStatus();
    toast('Memory wiped.');
  };
  $('btnMemoryAdd').onclick = () => {
    const input = $('memoryAdd');
    const value = input.value.trim();
    if (!value) return;
    addMemory([value], 'manual');
    input.value = '';
  };
  $('memoryAdd').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') $('btnMemoryAdd').click();
  });
  $('memoryList').addEventListener('click', (event) => {
    const index = event.target.dataset?.index;
    if (index === undefined) return;
    state.memory.splice(Number(index), 1);
    renderMemory();
    updateStatus();
  });
  $('traitsList').addEventListener('click', (event) => {
    if (event.target.dataset?.trait === undefined) return;
    state.persona.traits.splice(Number(event.target.dataset.trait), 1);
    renderMemory();
  });

  document.addEventListener('click', (event) => {
    const say = event.target.dataset?.saytext;
    if (say) return speak(say);
    const speakTarget = event.target.dataset?.speak;
    if (speakTarget) {
      const box = document.getElementById(speakTarget);
      if (box) speak(box.dataset.plain || box.textContent);
      return;
    }
    const copyTarget = event.target.dataset?.copy;
    if (copyTarget) {
      const box = document.getElementById(copyTarget);
      navigator.clipboard?.writeText(box?.dataset.plain || box?.textContent || '').then(
        () => toast('Copied.'),
        () => toast('Copy blocked.', 'error')
      );
    }
  });

  window.addEventListener('beforeunload', () => {
    stopListening();
    stopWatch();
    stopCamera();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && cap.listenOn && cap.recog) {
      try {
        cap.recog.start();
      } catch {
        /* already running */
      }
    }
  });
}

/* ── boot ──────────────────────────────────────────────────── */
loadState();
bind();
$('agentName').textContent = state.persona.name;
renderCourseUi();
$('ttsToggle').checked = state.settings.tts;
renderMemory();
hydrateFeeds();
updateStatus();
renderPackStatus();
startTimetableClock();
renderSyncUi();
syncWorkspace();
// Come back to the tab the user left, not to whatever boot defaults to.
if (state.ui?.tab && state.ui.tab !== 'live') openTab(state.ui.tab);
checkHealth();
loadVoices();
if ('speechSynthesis' in window) window.speechSynthesis.onvoiceschanged = loadVoices;

if ('serviceWorker' in navigator) {
  // Only register when served over a secure context, and never cache the API.
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
