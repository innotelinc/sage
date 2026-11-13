/* Sage — course-taking agent client.
   Capture (mic / screen / camera / files), reasoning, and a memory that persists. */

import { enqueue, forget, queued, pendingLabel } from './pending.js';
import { putPhotos, getPhotos, dropPhotos } from './pending-images.js';
import { cacheNote, cacheOnly, describeCache, hashDoc, planCache, reconcileDocs, stampDoc } from './library.js';
import { describeCapture, describeReply, directionOf, languageTag, trapFocusIndex } from './a11y.js';

const $ = (id) => document.getElementById(id);
import { searchCourses } from './search.js';
import { gatherUnderstanding } from './understand.js';
import {
  captureConflict,
  describe,
  isLive as isLiveSession,
  mergeNotes,
  notesToAdopt,
  shouldOffer,
} from './handoff.js';
import {
  buildCandidates as reviewCandidates,
  dueItems as reviewDue,
  enqueue as reviewEnqueue,
  grade as reviewGrade,
  loadReview,
  saveReview,
  session as reviewSession,
  stats as reviewStats,
} from './review.js';

const LS_KEY = 'sage.course-agent.v1';
const IS_NATIVE = /^(capacitor|ionic):$/.test(location.protocol) || Boolean(window.__SAGE_NATIVE__);
// Capacitor's injected bridge has no registerPlugin(): that function belongs to the
// @capacitor/core module, which this page does not import. What the bridge does
// publish is window.Capacitor.Plugins[jsName], built from the plugin classes named
// in the app's capacitor.config.json. Asking for registerPlugin alone is how the
// App Store purchase went missing on iPhone while the web copy took its place, so
// the plugin is looked up the way the bridge actually provides it.
function pluginOn(name, platform) {
  const bridge = window.Capacitor;
  try {
    if (bridge?.getPlatform?.() !== platform) return null;
    if (typeof bridge.registerPlugin === 'function') {
      const registered = bridge.registerPlugin(name);
      if (registered) return registered;
    }
  } catch {
    /* fall through to the list the bridge published itself */
  }
  return bridge?.Plugins?.[name] || null;
}
// The platform is a fact about the app, not about a plugin loading: the web
// checkout has to stay hidden on iOS even when StoreKit cannot be reached.
const IOS_APP = (() => {
  try {
    return window.Capacitor?.getPlatform?.() === 'ios';
  } catch {
    return false;
  }
})();
// The Android shell carries its own capture (a foreground service holding a
// MediaProjection). A page's own getDisplayMedia ends the moment the browser
// loses the foreground, and the WebView does not offer it at all, which is why
// this exists: the exam is in the other app.
const NATIVE_SCREEN = pluginOn('SageScreen', 'android');
// iOS has no in-app capture at all: an RPScreenRecorder is suspended with the
// app. A ReplayKit broadcast extension runs in its own process instead, so Watch
// hands the recording to one and collects what it read.
const NATIVE_BROADCAST = pluginOn('SageBroadcast', 'ios');
// Apple requires digital goods sold inside an iOS app to go through StoreKit, so
// on this platform the purchase is an App Store transaction rather than a card
// form in a tab.
const NATIVE_STORE = pluginOn('SageStore', 'ios');
// iOS keeps one audio session for the whole app, and a WebView's microphone
// borrows it. Unless that session is mixable, opening the microphone interrupts
// whatever was playing, and leaving the app hands the session away: both end the
// lecture capture. The native side sets it once and takes it back.
const NATIVE_AUDIO = pluginOn('SageAudio', 'ios');

async function holdAudioSession() {
  if (!NATIVE_AUDIO?.begin) return;
  try {
    await NATIVE_AUDIO.begin({});
  } catch {
    /* the browser's own session still works; this is only the native repair */
  }
}

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
  foundation: [],
  pending: [],
  evolution: [],
  // The record a revision sheet and a study pack are built from.
  history: { answers: [], quizzes: [], essays: [], sources: [], papers: [] },
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
  // Reader edits live beside the capture, keyed by block id, so a rebuild keeps
  // them and removing one restores what was captured.
  readerEdits: [],
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
    foundation: Array.isArray(seed.foundation) ? seed.foundation : [],
    readerEdits: Array.isArray(seed.readerEdits) ? seed.readerEdits : [],
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
  course.foundation = state.foundation;
  course.readerEdits = state.readerEdits;
}

function hydrateActive() {
  const course = activeCourse();
  if (!course) return;
  state.persona = course.persona;
  state.memory = course.memory;
  state.evolution = course.evolution;
  state.history = course.history;
  state.session = course.session;
  state.foundation = course.foundation;
  state.readerEdits = course.readerEdits || [];
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
      state.pending = queued(state.pending).slice(-12);
      trimHistory();
      stashActive();
      state.savedAt = new Date().toISOString();
      localStorage.setItem(LS_KEY, JSON.stringify(state));
      queueWorkspacePush();
      queueLivePush();
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
  renderFoundation();
  reconcileLibrary();
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
    // Quiet: a device with no access code is the ordinary local-only case, and the
    // 401 it earns is already drawn as one in the sync line. A toast on launch
    // read as "your key is invalid" for a key that was never sent.
    const remote = await api('/api/workspace', { method: 'GET', noKey: true, quiet: true });
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

/* ── speaking to a screen reader, and the page's direction ───── */
const citeFocus = { on: false, was: null };

/* Re-announce the same words: a live region that already holds them is silent. */
function announce(text) {
  const el = $('liveAnnounce');
  if (!el || !text) return;
  el.textContent = '';
  setTimeout(() => {
    el.textContent = text;
  }, 30);
}

/* The course's language sets the document's direction, so punctuation, page
   labels and the reading order follow it rather than being right-aligned English. */
function applyDirection() {
  document.documentElement.lang = languageTag(state.language);
  document.documentElement.dir = directionOf(state.language);
}

function closeCiteViewer() {
  const viewer = $('citeViewer');
  if (!viewer || viewer.hidden) return;
  viewer.hidden = true;
  citeFocus.on = false;
  const back = citeFocus.was;
  citeFocus.was = null;
  if (back && typeof back.focus === 'function') back.focus({ preventScroll: true });
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
  // A call that cannot use the key does not send it: the workspace and the health
  // check answer on the server's own identity, so launching the app never asks
  // the gateway about a key the person did not just enter.
  const gatewayKey = String(state.settings.gatewayKey || '').trim();
  if (gatewayKey && !options.noKey) headers['x-ai-key'] = gatewayKey;
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
    const failure = new Error(data.message || `HTTP ${res.status}`);
    if (res.status === 401 && !options.quiet) {
      // A 401 can arrive from a background timer at the exact moment the app
      // comes back to the foreground. Opening Settings on the user's behalf made
      // every return look like the app had thrown them into a menu, so point at
      // the gear and let them decide.
      toast('That key was refused (401). Tap ⚙ if it needs replacing.', 'error');
      // The caller still wants to offer the way in, but not to say it twice.
      failure.notified = true;
      failure.credential = true;
    }
    throw failure;
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
    const ended = new Error('Your session ended. Buy another session in Settings → Session.');
    offerSession(ended);
    throw ended;
  }
  const turn = courseForTurn();
  if (turn && turn.id !== state.activeId) switchCourse(turn.id, { auto: true });
  const sent = foundationFor(mode);
  let res;
  try {
    res = await api('/api/chat', {
      body: {
        mode,
        text,
        images,
        maxTokens,
        history: recentContext(),
        memory: state.memory,
        language: state.language,
        persona: state.persona,
        sources: sent,
      },
    });
  } catch (error) {
    // The one thing a dropped connection must not do is lose the question.
    // A photographed question is still a question, so its photos go with it.
    const photos = (images || []).filter((entry) => typeof entry === 'string' && entry.startsWith('data:image/')).slice(0, 4);
    if (/Cannot reach the agent server/i.test(error.message) && (String(text || '').trim() || photos.length)) {
      const next = enqueue(state.pending, {
        mode,
        text,
        images: photos.length,
        maxTokens,
        tab: (state.ui || {}).tab,
        fromCache: sent.filter((doc) => doc.fromCache).map((doc) => doc.name),
      });
      const entry = next[next.length - 1];
      if (photos.length && entry) await putPhotos(entry.id, photos).catch(() => {});
      state.pending = next;
      persist();
      updateStatus();
      throw new Error(`Kept on this device — ${pendingLabel(state.pending)}. It answers as soon as the server is back.`);
    }
    // A turn refused for want of a credential is the moment the person needs the
    // two ways in, not a toast that sends them hunting through a menu.
    if (error.credential || /no model key|needs an API key|rejected this API key/i.test(error.message)) {
      offerSession(error);
    }
    throw error;
  }
  res.fromCache = sent.filter((doc) => doc.fromCache).map((doc) => doc.name);
  announce(describeReply(res, mode));
  if (res.notes?.length) addMemory(res.notes, 'learned');
  return res;
}

/* A turn that cannot reach a model ends where both ways in are described. The
   card on Live names the key and carries the App Store action when this device
   can sell a session, so it is shown and Live is opened: the answer tab keeps the
   question, and the way to answer it is one tap away rather than a menu away. */
function offerSession(error) {
  $('setupCard').classList.remove('hidden');
  if (!setupStoreAsked) {
    setupStoreAsked = true;
    loadStore();
  }
  syncSetupBuy();
  if ((state.ui || {}).tab !== 'live') openTab('live');
  if (!error.notified) toast(error.message, 'error');
}

/* ── health ────────────────────────────────────────────────── */
async function checkHealth() {
  try {
    health = await api('/api/health', { noKey: true });
    const ok = health.configured;
    $('statusDot').className = `dot ${ok ? 'ok' : 'warn'}`;
    $('statusDot').title = ok ? `connected to ${health.provider}` : 'no model key configured';
    $('modelTag').textContent = ok ? String(health.chatModel || 'auto').split('/').pop() : 'no key';
    $('setupCard').classList.toggle('hidden', ok);
    syncSetupBuy();
    // The card is where someone without a key lands, so it has to know whether a
    // session can be bought here. Asked once, and only while the card is showing.
    if (!ok && !setupStoreAsked) {
      setupStoreAsked = true;
      loadStore();
    }
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
  announced: '',
  micStream: null,
  recog: null,
  recorder: null,
  recTimer: null,
  screenStream: null,
  nativeFrames: null,
  broadcastPoll: null,
  broadcastSeen: false,
  broadcastDevice: null,
  // An audiobook on the iPhone is read through the broadcast extension rather than
  // a share, so the poll that drains it is playing the part the recorder plays here.
  broadcastAudio: false,
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
  // Which sound Listen reads: the room, or another app's audio. `captureStream`
  // is whichever stream is being transcribed, so one recorder serves both.
  listenMode: 'lecture',
  captureStream: null,
  deviceStream: null,
  keepRecordings: true,
  watchAudio: false,
  // A device share can be opened before the other app has made a sound, so the
  // run waits for the first audible window instead of giving up or transcribing
  // silence into notes that say nothing.
  heardSound: false,
  listenWait: false,
  soundWatch: null,
  soundContext: null,
  restarting: false,
  audioChunks: [],
  audioStart: 0,
  audioBytes: 0,
};

/* audio-only lectures: the recording stays on this device, so a note can be replayed */
const AUDIO_KEEP_BYTES = 90 * 1024 * 1024;

function hms(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const pad = (value) => String(value).padStart(2, '0');
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  const s = total % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function audioOffset(at) {
  return cap.audioStart ? Math.max(0, Math.round((at - cap.audioStart) / 1000)) : 0;
}

function dropAudio() {
  for (const chunk of cap.audioChunks) URL.revokeObjectURL(chunk.url);
  cap.audioChunks = [];
  cap.audioBytes = 0;
}

function keepAudio(blob, startedAt) {
  if (!blob || !blob.size) return;
  cap.audioChunks.push({ start: audioOffset(startedAt), blob, url: URL.createObjectURL(blob) });
  cap.audioBytes += blob.size;
  // An hour of lecture is worth keeping; a whole term is not.
  while (cap.audioBytes > AUDIO_KEEP_BYTES && cap.audioChunks.length > 1) {
    const old = cap.audioChunks.shift();
    cap.audioBytes -= old.blob.size;
    URL.revokeObjectURL(old.url);
  }
}

function stampSeconds(stamp) {
  const parts = String(stamp).split(':').map((part) => Number(part) || 0);
  return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + (parts[1] || 0);
}

function playNoteOffset(stamp, label = 'lecture') {
  const player = $('audioPlayer');
  const target = stampSeconds(stamp);
  const chunk = [...cap.audioChunks].reverse().find((entry) => entry.start <= target);
  if (!player || !chunk) {
    toast('That part of the recording is no longer on the device.', 'error');
    return;
  }
  player.src = chunk.url;
  player.hidden = false;
  player.title = `${label} ${stamp}`;
  const seek = Math.max(0, target - chunk.start);
  const start = () => {
    try {
      player.currentTime = seek;
    } catch {
      /* the blob is not seekable yet; it plays from its start */
    }
    player.play().catch(() => {});
  };
  if (player.readyState >= 1) start();
  else player.addEventListener('loadedmetadata', start, { once: true });
}

/* A note's [lecture M:SS] becomes a button, the way [file p.N] already does. */
function noteBody(text) {
  const pattern = /\[([^[\]\n]{1,60}?)[ ](\d{1,2}:\d{2}(?::\d{2})?)\]/g;
  let out = '';
  let last = 0;
  for (const match of String(text).matchAll(pattern)) {
    out += md(String(text).slice(last, match.index));
    out += `<button type="button" class="cite-chip note-offset" data-audio="${match[2]}" data-audio-label="${escapeHtml(match[1])}">${escapeHtml(match[1])} ${match[2]}</button>`;
    last = match.index + match[0].length;
  }
  return out + md(String(text).slice(last));
}

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
  if (cap.listenOn) bits.push(cap.keepRecordings ? 'listening' : 'reading the sound');
  if (cap.watchOn) bits.push('watching screen');
  if (cap.cameraOn) bits.push('camera on');
  $('captureStatus').textContent = bits.length
    ? `${bits.join(' · ')} — capture is live.`
    : 'Idle. Nothing is being recorded.';
  const waiting = pendingLabel(state.pending);
  $('counters').textContent = `${cap.words} words · ${cap.frames} frames · ${state.memory.length} notes held${
    waiting ? ` · ${waiting}` : ''
  }`;
  // A coloured pill is invisible to a screen reader, so the capture state is
  // spoken when it changes and not on every repaint.
  const captureKey = `${cap.listenOn}|${cap.watchOn}|${cap.cameraOn}`;
  if (captureKey !== cap.announced) {
    const first = !cap.announced;
    cap.announced = captureKey;
    announce(
      describeCapture({
        listening: cap.listenOn,
        watching: cap.watchOn,
        aiming: cap.cameraOn,
        intervalSec: state.settings.noteIntervalSec,
        stopped: !first,
      })
    );
  }
  $('btnListen').classList.toggle('on', cap.listenOn);
  $('btnScreen').classList.toggle('on', cap.watchOn);
  $('btnCamera').classList.toggle('on', cap.cameraOn);
  $('ttsToggle').checked = state.settings.tts;
  syncWatchButtons();
  persist();
}

/* transcript */
function pushTranscript(text, meta = {}) {
  const at = Date.now();
  const entry = { text, at, ...meta, offset: cap.audioStart ? audioOffset(at) : null };
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
    cap.queue.push({ text, offset: entry.offset });
    if (cap.queue.map((item) => item.text).join(' ').length > 700) flushTranscript();
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
  const stream = cap.captureStream || cap.micStream;
  if (!stream) return;
  const mime = typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : '';
  let rec;
  try {
    rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  } catch (error) {
    toast(`Recorder unavailable: ${error.message}`, 'error');
    return;
  }
  const chunks = [];
  const chunkStart = Date.now();
  rec.ondataavailable = (event) => {
    if (event.data && event.data.size) chunks.push(event.data);
  };
  rec.onstop = async () => {
    clearTimeout(cap.recTimer);
    const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
    // Only a lecture is kept. Another app's audio is read and then dropped: it is
    // not ours to store, and the point is the text, not a copy of the book.
    if (cap.keepRecordings) keepAudio(blob, chunkStart);
    // A device share opened before playback is a silent track: sending it would
    // spend a request to learn that nothing was said, once every twelve seconds.
    if (blob.size > 3000 && (cap.keepRecordings || cap.heardSound)) await transcribeBlob(blob);
    if (cap.listenOn && !transcribeBlocked) startRecorder();
  };
  rec.start();
  cap.recorder = rec;
  cap.recTimer = setTimeout(() => {
    if (rec.state === 'recording') rec.stop();
  }, 12000);
}

/* Listen reads one source at a time: the room, or another app's sound. */
function setListenMode(mode, options = {}) {
  const next = mode === 'audiobook' ? 'audiobook' : 'lecture';
  const changed = cap.listenMode !== next;
  cap.listenMode = next;
  const button = $('btnListenMode');
  if (button) button.textContent = `Listen: ${next}`;
  const note = $('listenNote');
  if (note) {
    note.textContent =
      next === 'audiobook'
        ? NATIVE_BROADCAST
          ? 'Press it, pick Sage in the broadcast sheet, then open the audiobook. It keeps reading while the book is in front, and nothing is kept as a recording.'
          : 'Press it first, then open the app and start the audio. Nothing is kept as a recording.'
        : 'Lecture: the microphone. Watch adds the screen and the sound that comes with it.';
  }
  if (changed && cap.listenOn && !options.quiet) {
    stopListening();
    setTimeout(() => startListening(), 250);
  }
}

/*
 * Listening to an audiobook rather than a room.
 *
 * A browser will only let a page hear another application through a share request, so
 * this asks for one and throws the picture away at once: the video track is stopped in
 * the same tick it arrives, which is what makes this "extract the audio without
 * recording" rather than a screen recording that happens to have sound.
 */
async function startDeviceAudio() {
  if (cap.listenOn) return stopListening();
  if (!navigator.mediaDevices?.getDisplayMedia) {
    // No share exists in a WebView, but this build carries a ReplayKit broadcast
    // extension that already captures the microphone and posts five-second chunks
    // to Sage. Telling an iPhone owner to install another browser was the wrong
    // answer to the button they pressed: hand the recording to the extension.
    if (NATIVE_BROADCAST?.start) return startBroadcastAudio();
    toast('This build has no way to hear another app. Use the lecture microphone.', 'error');
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
    });
  } catch (error) {
    if (error.name !== 'NotAllowedError') toast(`Could not open the audio share: ${error.message}`, 'error');
    return;
  }
  const audio = stream.getAudioTracks();
  if (!audio.length) {
    stream.getTracks().forEach((track) => track.stop());
    awaitNoteSound('That share carried no sound.');
    return;
  }
  // The picture was the price of the sound. Stop it before anything is drawn.
  stream.getVideoTracks().forEach((track) => track.stop());
  adoptDeviceAudio(audio);
  // The order matters, and it is the opposite of the obvious one: leaving SAGE to
  // start the audiobook takes the audiobook to the background, so the sound has to
  // begin after this run is already open and reading.
  toast('Listening. Now open the app and start the audio — SAGE reads the first sound it hears.');
}

/*
 * Audiobook listening on the iPhone.
 *
 * iOS hands no app another app's output, so a share is not a possibility here and
 * pretending otherwise dead-ended on a message about other browsers. The broadcast
 * extension can keep recording while the book is in front, and it already posts the
 * microphone to the session the app opens — so this opens that session and starts
 * the sheet. The book is then heard through the air, the chunks come back as text,
 * and the app reads them as it would any other source.
 */
async function startBroadcastAudio() {
  let device;
  try {
    device = (await NATIVE_BROADCAST.device())?.device || '';
    if (!device) throw new Error('this build cannot identify the device');
    // The session is the credential: the extension carries no access code, and this
    // is the only place the two sides can meet. `audioOnly` is what stops it sending
    // screenshots of a book that is only being listened to.
    await api('/api/broadcast/session', { body: { device, audioOnly: true } });
    await NATIVE_BROADCAST.start();
  } catch (error) {
    toast(`Could not open the broadcast: ${error?.message || error}`, 'error');
    return;
  }
  cap.broadcastDevice = device;
  cap.broadcastAudio = true;
  cap.listenOn = true;
  cap.keepRecordings = false;
  cap.heardSound = false;
  cap.listenWait = false;
  cap.sourceLost = false;
  cap.audioStart = Date.now();
  cap.broadcastSeen = false;
  clearInterval(cap.broadcastPoll);
  cap.broadcastPoll = setInterval(drainBroadcast, 6000);
  ensureNoteTimer();
  setListenState('waiting for sound');
  updateStatus();
  toast('Pick Sage in the sheet and start the broadcast, then open the audiobook. It keeps reading while the book is in front.');
}

/* One adoption path for "the sound is now this stream", shared by reconnects. */
function adoptDeviceAudio(tracks) {
  cap.deviceStream = new MediaStream(tracks);
  cap.captureStream = cap.deviceStream;
  cap.keepRecordings = false;
  cap.listenOn = true;
  cap.heardSound = false;
  cap.listenWait = false;
  cap.sourceLost = false;
  cap.quietSince = 0;
  const retry = $('btnListenRetry');
  if (retry) retry.hidden = true;
  dropAudio();
  cap.audioStart = cap.audioStart || Date.now();
  // A system-audio share can lose one track and hand over another when the audio app
  // restarts, and it can hand over a fresh track on the same stream. Follow it rather
  // than ending the run, and stay armed when the whole stream dies so a returning
  // track is taken up on sight instead of needing a tap.
  cap.deviceStream.getAudioTracks().forEach((track) => {
    track.addEventListener('ended', onDeviceTrackEnded);
  });
  cap.deviceStream.addEventListener('addtrack', () => {
    const live = cap.deviceStream ? cap.deviceStream.getAudioTracks().filter((t) => t.readyState === 'live') : [];
    if (cap.listenOn && live.length) adoptDeviceAudio(live);
  });
  startRecorder();
  watchForSound();
  updateStatus();
}

/*
 * The first audible window is what turns a silent share into the source being read.
 * Until then nothing is sent for transcription, so opening this before playback costs
 * one open stream rather than a stream of empty transcriptions.
 */
function watchForSound() {
  clearInterval(cap.soundWatch);
  cap.soundWatch = null;
  try {
    cap.soundContext?.close?.();
  } catch {
    /* already closed */
  }
  if (!cap.deviceStream || !(window.AudioContext || window.webkitAudioContext)) return;
  let analyser;
  try {
    cap.soundContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = cap.soundContext.createMediaStreamSource(cap.deviceStream);
    analyser = cap.soundContext.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    cap.soundContext.resume?.();
  } catch {
    return;
  }
  const buffer = new Float32Array(analyser.fftSize);
  // The monitor stays for the whole run: sound arriving, stopping at the end of a
  // chapter and arriving again is one session, and only the first of those is a
  // decision the person made. Silence past QUIET_GRACE stops the requests; the next
  // sound starts them again without a tap.
  cap.soundWatch = setInterval(() => {
    if (!cap.listenOn || !cap.deviceStream) {
      clearInterval(cap.soundWatch);
      cap.soundWatch = null;
      return;
    }
    analyser.getFloatTimeDomainData(buffer);
    let peak = 0;
    for (const sample of buffer) {
      const value = Math.abs(sample);
      if (value > peak) peak = value;
    }
    if (peak >= AUDIBLE_PEAK) {
      cap.quietSince = 0;
      if (cap.heardSound) return;
      // The recorder has been running throughout, so its next chunk carries the
      // first words after the gap as well: nothing is lost by having waited.
      cap.heardSound = true;
      cap.listenWait = false;
      const retry = $('btnListenRetry');
      if (retry) retry.hidden = true;
      setListenState('reading the other app');
      ensureNoteTimer();
      if (!cap.heardOnce) {
        cap.heardOnce = true;
        toast('Heard it — reading that source now.');
      } else {
        toast('The sound is back — reading it again.');
      }
      return;
    }
    if (!cap.heardSound) return;
    cap.quietSince = cap.quietSince || Date.now();
    if (Date.now() - cap.quietSince < QUIET_GRACE) return;
    cap.heardSound = false;
    cap.quietSince = 0;
    setListenState('waiting for the sound to come back');
  }, 400);
}

// How loud a window has to be before it counts as the source playing rather than
// room noise. A share's silent track sits far below this.
const AUDIBLE_PEAK = 0.012;
// A chapter break is not the end of the book: this long below the threshold, then
// waiting, is what keeps an idle stream from spending a request every twelve seconds.
const QUIET_GRACE = 15000;

function ensureNoteTimer() {
  if (!cap.noteTimer) {
    cap.noteTimer = setInterval(flushTranscript, Math.max(8, state.settings.noteIntervalSec) * 1000);
  }
}

/* The stream outlived the track: follow whatever audio is still live. */
function onDeviceTrackEnded() {
  if (!cap.listenOn) return;
  const live = (cap.deviceStream?.getAudioTracks?.() || []).filter((track) => track.readyState === 'live');
  if (live.length) {
    adoptDeviceAudio(live);
    return;
  }
  markSourceLost();
}

/*
 * Nothing to read, but nothing to tear down either. The run stays on so the next
 * track — or the next sound on the same one — is taken up by itself; the button is
 * there for the case where the share itself is gone and only a new request can help.
 */
function markSourceLost() {
  if (!cap.listenOn || cap.sourceLost) return;
  cap.sourceLost = true;
  cap.heardSound = false;
  clearTimeout(cap.recTimer);
  try {
    if (cap.recorder?.state === 'recording') cap.recorder.stop();
  } catch {
    /* ignore */
  }
  cap.recorder = null;
  setListenState('the source stopped');
  const retry = $('btnListenRetry');
  if (retry) retry.hidden = false;
  toast('The other app stopped. Listening is still on — SAGE takes the sound up again when it returns.', 'error');
}

/* Waiting is a state, not a failure: the button that opens the share again is the way out. */
function awaitNoteSound(message) {
  cap.listenWait = true;
  const retry = $('btnListenRetry');
  if (retry) retry.hidden = false;
  setListenState('waiting for sound');
  toast(`${message} Press “Start listening again”, then start the audio in the other app.`, 'error');
}

function setListenState(text) {
  const note = $('listenNote');
  if (!note) return;
  note.textContent = text
    ? `${text} — ${cap.listenMode === 'audiobook' ? 'the other app’s audio' : 'the microphone'}.`
    : cap.listenMode === 'audiobook'
      ? NATIVE_BROADCAST
        ? 'Press it, pick Sage in the broadcast sheet, then open the audiobook. It keeps reading while the book is in front, and nothing is kept as a recording.'
        : 'Press it first, then open the app and start the audio. Nothing is kept as a recording.'
      : 'Lecture: the microphone. Watch adds the screen and the sound that comes with it.';
}

/*
 * Watch carries the sound of what it watches: a lecture recording, a video, an
 * audiobook playing in another window. It is read into the same transcript the
 * microphone feeds, once, and never kept as a recording.
 */
function attachWatchedAudio(tracks) {
  if (!tracks.length) return;
  if (cap.listenOn && cap.listenMode === 'lecture') stopListening();
  cap.deviceStream = new MediaStream(tracks);
  cap.captureStream = cap.deviceStream;
  cap.keepRecordings = false;
  // Watch already carries the sound it needs from the first frame, so it does not
  // wait for a level reading the way a share opened ahead of playback does.
  cap.heardSound = true;
  cap.watchAudio = true;
  cap.listenOn = true;
  cap.audioStart = cap.audioStart || Date.now();
  tracks[0].addEventListener('ended', () => {
    if (!cap.watchAudio) return;
    cap.watchAudio = false;
    stopListening();
  });
  startRecorder();
  if (!cap.noteTimer) {
    cap.noteTimer = setInterval(flushTranscript, Math.max(8, state.settings.noteIntervalSec) * 1000);
  }
  updateStatus();
  toast('Reading the sound with the picture — no audio is kept.');
}

async function startListening() {
  if (cap.listenMode === 'audiobook') return startDeviceAudio();
  // Before the microphone opens, so the session is mixable rather than taking
  // the audiobook the person is listening to with it.
  await holdAudioSession();
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
  // A listen run is one recording: its offsets start at zero, and the last
  // one is dropped rather than mixed into this one.
  dropAudio();
  cap.audioStart = Date.now();
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
  if (cap.broadcastAudio) {
    cap.broadcastAudio = false;
    clearInterval(cap.broadcastPoll);
    cap.broadcastPoll = null;
    // The extension keeps posting under its device until the session is closed, so
    // closing it is what stops those chunks becoming notes nobody asked for.
    if (cap.broadcastDevice && !cap.watchOn) {
      api(`/api/broadcast/session?device=${encodeURIComponent(cap.broadcastDevice)}`, { method: 'DELETE' }).catch(() => {});
      cap.broadcastDevice = null;
    }
  }
  clearInterval(cap.soundWatch);
  cap.soundWatch = null;
  cap.heardSound = false;
  cap.listenWait = false;
  cap.sourceLost = false;
  cap.quietSince = 0;
  cap.heardOnce = false;
  try {
    cap.soundContext?.close?.();
  } catch {
    /* already closed */
  }
  cap.soundContext = null;
  const retry = $('btnListenRetry');
  if (retry) retry.hidden = true;
  cap.audioStart = 0;
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
  cap.deviceStream?.getTracks().forEach((t) => t.stop());
  cap.deviceStream = null;
  cap.captureStream = null;
  cap.keepRecordings = true;
  cap.watchAudio = false;
  // The note describes a state that has just ended; put back the line that says how
  // to start again rather than leaving "waiting for sound" under a stopped button.
  setListenState('');
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
      // The sound that comes with the screen, so a lecture recording or an
      // audiobook in another window is read as text as well as watched.
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      systemAudio: 'include',
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
  // A share may carry sound; when it does, it is read here rather than played.
  const watchedAudio = cap.screenStream.getAudioTracks();
  if (watchedAudio.length) attachWatchedAudio(watchedAudio);
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
    await api('/api/broadcast/session', { body: { device: cap.broadcastDevice, audioOnly: false } });
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
  for (const note of out?.notes || []) {
    // A broadcast watching the screen is describing a picture, so its text is a note;
    // an audiobook is speech, and speech belongs in the transcript it would occupy
    // if the microphone had heard it.
    if (cap.broadcastAudio) {
      pushTranscript(note.text, { source: 'broadcast' });
      // The label said it was waiting until the first chunk came back with words;
      // a transcript filling up under a line that claims to be waiting is a lie.
      if (!cap.heardSound) {
        cap.heardSound = true;
        setListenState('reading it');
      }
    } else addNote(note.text, 'broadcast');
  }
  if (Number.isFinite(out?.frames) && out.frames > cap.frames) cap.frames = out.frames;
  if (out?.running) cap.broadcastSeen = true;
  else if (cap.broadcastSeen) {
    // Nothing has arrived for the whole live window: the broadcast was stopped
    // from Control Center, so the page should stop claiming to listen or watch.
    cap.broadcastSeen = false;
    if (cap.broadcastAudio) {
      stopListening();
      toast('The broadcast stopped — audiobook listening is off.', 'error');
    } else {
      stopWatch();
      toast('The screen broadcast stopped.');
    }
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
  const queued = cap.queue.splice(0, cap.queue.length);
  const pending = queued.map((item) => item.text).join('\n').trim();
  if (!pending) return;
  cap.flushing = true;
  try {
    // The offsets travel with the fragment so the note can cite the moment it
    // came from; the audio itself never leaves the device.
    const stamps = queued.map((item) => item.offset).filter((value) => typeof value === 'number');
    const range = stamps.length
      ? `Recording offsets in this fragment: ${hms(Math.min(...stamps))} to ${hms(Math.max(...stamps))} of the lecture recording. Cite a moment as [lecture M:SS] using an offset inside that range; never invent one.`
      : '';
    const res = await agent('note', {
      text: ['Live transcript chunk from class:', range, pending.slice(-6000)].filter(Boolean).join('\n\n'),
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
  div.innerHTML = `<time>${clock()}</time>${noteBody(text)}`;
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
    div.innerHTML = `<time>${clock(entry.at)}</time>${noteBody(entry.text)}`;
    notes.appendChild(div);
  }
  if (!state.session.notes.length) notes.innerHTML = '<p class="empty">Notes appear here as it understands.</p>';
  scrollFeed(transcript);
  scrollFeed(notes);
}

/* ── memory ────────────────────────────────────────────────── */
/* the saved key: loaded and tested on open, and forgotten from here */
function syncKeyReset() {
  const button = $('btnResetKey');
  const source = $('keySource');
  const saved = Boolean(String(state.settings.gatewayKey || '').trim());
  if (button) button.hidden = !saved;
  if (source) {
    source.textContent = saved ? 'Stored on this device; Reset forgets it here.' : '';
  }
}

function resetSavedKey() {
  if (!String(state.settings.gatewayKey || '').trim()) return;
  if (!confirm('Forget the gateway key saved on this device? A bought session cannot be restored after this.')) return;
  state.settings.gatewayKey = '';
  state.settings.keyExpiresAt = '';
  persist();
  if ($('setGatewayKey')) $('setGatewayKey').value = '';
  renderGatewayChips([]);
  if ($('gatewayStatus')) $('gatewayStatus').textContent = 'Saved key cleared. The server key is used if it has one.';
  syncKeyReset();
  checkHealth();
  toast('Saved key cleared.');
}

/* one search across every course */
let searchHits = [];

function searchableCourses() {
  const active = state.courses.find((course) => course.id === state.activeId);
  const courses = state.courses.map((course) =>
    course === active
      ? {
          ...course,
          persona: { ...course.persona, ...state.persona },
          memory: state.memory,
          history: state.history,
          foundation: state.foundation,
        }
      : course
  );
  if (!courses.length) {
    courses.push({
      id: state.activeId || 'active',
      persona: state.persona,
      memory: state.memory,
      history: state.history,
      foundation: state.foundation,
    });
  }
  return courses;
}

function highlightTerms(text, query) {
  const safe = escapeHtml(text);
  const terms = String(query || '')
    .split(/\s+/)
    .filter((term) => term.length > 1)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!terms.length) return safe;
  try {
    return safe.replace(new RegExp('(' + terms.join('|') + ')', 'gi'), '<mark>$1</mark>');
  } catch {
    return safe;
  }
}

function renderSearch() {
  const box = $('searchBox');
  const list = $('searchResults');
  const meta = $('searchMeta');
  if (!box || !list || !meta) return;
  const query = box.value.trim();
  list.innerHTML = '';
  searchHits = [];
  if (query.length < 2) {
    meta.textContent = 'Type at least two letters.';
    return;
  }
  searchHits = searchCourses(searchableCourses(), query, 60);
  const courses = new Set(searchHits.map((hit) => hit.courseId));
  meta.textContent = searchHits.length
    ? `${searchHits.length} hit${searchHits.length === 1 ? '' : 's'} in ${courses.size} course${courses.size === 1 ? '' : 's'}.`
    : 'Nothing in this workspace matches every word.';
  searchHits.forEach((hit, position) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'search-hit';
    row.dataset.index = String(position);
    row.innerHTML = `<span class="hit-kind">${escapeHtml(hit.kindLabel)}</span>
      <span class="hit-where">${escapeHtml(hit.course)}${hit.locator ? ' \u00b7 ' + escapeHtml(hit.locator) : ''}${hit.when ? ' \u00b7 ' + escapeHtml(hit.when) : ''}</span>
      <p class="hit-text">${highlightTerms(hit.snippet, query)}</p>`;
    list.appendChild(row);
  });
}

function openSearchHit(hit) {
  const viewer = $('citeViewer');
  if (!viewer || !hit) return;
  if (hit.courseId && hit.courseId !== state.activeId) switchCourse(hit.courseId, { silent: true });
  $('citeTitle').textContent = [hit.course, hit.kindLabel, hit.locator, hit.when].filter(Boolean).join(' \u00b7 ');
  $('citeBody').innerHTML = `<div class="cite-seg"><pre>${highlightTerms(hit.text.slice(0, 4000), $('searchBox').value)}</pre></div>
    <button type="button" class="link-btn" data-goto="${escapeHtml(hit.tab)}">open the ${escapeHtml(hit.tabLabel)} tab</button>`;
  viewer.hidden = false;
  // A div modal does not get <dialog>'s focus behaviour, so it takes and gives
  // back focus itself; the keydown listener below keeps Tab inside it.
  citeFocus.was = document.activeElement;
  citeFocus.on = true;
  setTimeout(() => document.getElementById('citeClose')?.focus({ preventScroll: true }), 20);
}

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
  renderFoundation();
  const name = $('agentName');
  if (name) name.textContent = state.persona.name || 'Sage';
  if (!options.silent) {
    const label = state.persona.course || 'this course';
    toast(options.auto ? `Class started — switched to ${label}.` : `Switched to ${label}.`);
  }
  return true;
}

/* A first run has one unnamed course, and nothing else says that the course's name is
   what every note, memory and answer is filed under. The card is asked once on the
   screen someone lands on, rather than buried in Settings → You. */
function syncNameCourse() {
  const card = $('nameCourse');
  if (!card) return;
  const named = String(state.persona?.course || '').trim();
  card.classList.toggle('hidden', Boolean(named) || !isPristine());
}

function nameCourse() {
  const input = $('nameCourseInput');
  const value = String(input?.value || '').trim().slice(0, 80);
  if (!value) {
    input?.focus();
    toast('Give the course a name — it is what the notes are filed under.', 'error');
    return;
  }
  state.persona.course = value;
  persist();
  renderCourseUi();
  syncNameCourse();
  toast(`Course named ${value}.`);
}

/* Renaming was only reachable from Settings → You, which is not where anyone looks
   for it. The name is what every note is filed under, so it gets its own field
   beside the course picker. */
function renameCourse() {
  const field = $('courseRename');
  const value = String(field?.value || '').trim().slice(0, 80);
  if (!activeCourse()) return;
  if (!value) {
    field?.focus();
    toast('A course needs a name — it is what the notes are filed under.', 'error');
    return;
  }
  if ((state.persona?.course || '') === value) {
    toast('That is already the name.');
    return;
  }
  state.persona.course = value;
  persist();
  renderCourseUi();
  syncNameCourse();
  toast(`Renamed to ${value}.`);
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
  renderFoundation();
  openSettings();
  const field = $('setCourse');
  if (field) {
    field.focus();
    field.select();
  }
  toast('New course — name it, then Save.');
}

/* Removing a course takes its notes, history and timetable slots with it, so it
   asks first and never leaves the workspace with no course to be in. */
function removeCourse() {
  const course = activeCourse();
  if (!course) return;
  const label = course.persona.course || 'this course';
  if (state.courses.length < 2) {
    toast('One course has to stay — rename this one instead, or add another first.', 'error');
    return;
  }
  if (!confirm(`Remove ${label}? Its notes, answers and timetable slots go with it.`)) return;
  state.courses = state.courses.filter((entry) => entry.id !== course.id);
  state.timetable = state.timetable.filter((slot) => slot.courseId !== course.id);
  state.activeId = state.courses[0].id;
  hydrateActive();
  persist();
  renderCourseUi();
  renderMemory();
  hydrateFeeds();
  renderPackStatus();
  renderFoundation();
  const name = $('agentName');
  if (name) name.textContent = state.persona.name || 'Sage';
  toast(`Removed ${label}.`);
}

function renderCourseUi() {
  syncNameCourse();
  const rename = $('courseRename');
  // Not while it is being typed into: re-rendering on every keystroke would fight
  // the person renaming the course.
  if (rename && document.activeElement !== rename) rename.value = state.persona?.course || '';
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
const HISTORY_LIMITS = { answers: 200, quizzes: 200, essays: 40, sources: 40, papers: 40 };
const HISTORY_KEYS = Object.keys(HISTORY_LIMITS);

function normalizeHistory(raw) {
  const out = { answers: [], quizzes: [], essays: [], sources: [], papers: [] };
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
  if (!state.history || typeof state.history !== 'object') return;
  if (!Array.isArray(state.history[kind])) state.history[kind] = [];
  state.history[kind].push({ ...entry, at: Date.now() });
  trimHistory();
  persist();
  renderPackStatus();
  renderFoundation();
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
    ${why ? `<div class="answer-why">${escapeHtml(why)}</div>` : ''}${groundedNote(res)}
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
  // Study mode is listening and watching. Falling back to the camera made this
  // button open the Aim viewfinder instead — a different feature, aimed at a board,
  // with no picture of the slides at all. Watch is the thing that matches the label,
  // and when it cannot start it says so rather than quietly aiming.
  // An audiobook run is already a broadcast: starting Watch as well would open a
  // second sheet for the same recording.
  if (!cap.watchOn && !cap.cameraOn && !cap.broadcastAudio) await toggleWatch();
  stopStudyTimer();
  studyTimer = setInterval(studyTick, 20000);
  toast(
    cap.watchOn
      ? 'Study mode on — listening and watching. It answers questions as they appear.'
      : 'Study mode is listening. For the picture, press Watch: screen, or Watch: camera for the board.',
    cap.watchOn ? undefined : 'error'
  );
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

/* Watch, chosen from the study bar: the screen/video, or the camera. Study mode
   used to start the screen share and leave it there, so a lecture with no screen —
   a board, a printed handout — had no way in without leaving study mode. Only one
   source runs at a time: both write cap.frame, so two of them would build a note
   from two different pictures. */
function syncWatchButtons() {
  const screen = $('btnStudyWatch');
  if (screen) {
    screen.textContent = cap.watchOn ? 'Watch: screen · on' : 'Watch: screen';
    screen.classList.toggle('on', cap.watchOn);
  }
  const camera = $('btnStudyCamera');
  if (camera) {
    camera.textContent = cap.cameraOn ? 'Watch: camera · on' : 'Watch: camera';
    camera.classList.toggle('on', cap.cameraOn);
  }
  const note = $('watchNote');
  if (note) {
    note.textContent = cap.watchOn
      ? 'Watching the screen. Press it again to stop watching.'
      : cap.cameraOn
        ? 'Aiming the camera. Press it again to put it away.'
        : 'Watch the slides on screen, or point the camera at the board. One at a time.';
  }
}

async function chooseStudyWatch(kind) {
  if (kind === 'camera') {
    if (cap.cameraOn) {
      stopCamera();
      toast('Camera off.');
      return;
    }
    if (cap.watchOn) stopWatch();
    await toggleCamera();
  } else {
    if (cap.watchOn) {
      stopWatch();
      toast('Stopped watching the screen.');
      return;
    }
    if (cap.cameraOn) stopCamera();
    await toggleWatch();
  }
  syncWatchButtons();
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
  // decode() settles or rejects quickly in a browser, but a WebView can leave it
  // pending forever: the dimensions are known before it resolves, so a timeout here
  // is what keeps an attached photo from going nowhere.
  await Promise.race([
    image.decode().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 1500)),
  ]);
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

function renderThumbs(container, items, after = null) {
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
    const [removed] = items.splice(Number(button.dataset.remove), 1);
    renderThumbs(container, items, after);
    // The ✕ is the delete button, so it has to leave the count and the clear button
    // saying what is actually attached — and, for a filtered list, remove the item
    // from the list it was filtered out of.
    after?.(removed, items);
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
function syncAnswerCount() {
  $('answerFileCount').textContent = answerFiles.length ? `${answerFiles.length} attached` : '';
  $('btnClearAnswerFiles').hidden = !answerFiles.length;
}
function clearAnswerFiles() {
  answerFiles.length = 0;
  renderThumbs($('answerThumbs'), answerFiles, syncAnswerCount);
  syncAnswerCount();
}
async function onAnswerFiles(event) {
  const files = [...event.target.files];
  for (const file of files.slice(0, 4)) {
    const preview = await shrinkImage(file, 1100);
    answerFiles.push({ preview });
  }
  renderThumbs($('answerThumbs'), answerFiles, syncAnswerCount);
  syncAnswerCount();
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

function syncQuizCount() {
  $('quizFileCount').textContent = quizFiles.length ? `${quizFiles.length} attached` : '';
  $('btnClearQuizFiles').hidden = !quizFiles.length;
}
function clearQuizFiles() {
  quizFiles.length = 0;
  renderThumbs($('quizThumbs'), quizFiles, syncQuizCount);
  syncQuizCount();
}
async function onQuizFiles(event) {
  for (const file of [...event.target.files].slice(0, 4)) {
    quizFiles.push({ preview: await shrinkImage(file, 1400) });
  }
  renderThumbs($('quizThumbs'), quizFiles, syncQuizCount);
  syncQuizCount();
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
    ${structured.why ? `<div class="answer-why">${escapeHtml(structured.why)}</div>` : ''}${groundedNote(res)}
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

/* exam tab: a timed paper that is marked only once it has been submitted */
let paper = null;
let paperTimer = null;
let paperDeadline = 0;

function paperLeft() {
  return Math.max(0, paperDeadline - Date.now());
}

function renderPaperClock() {
  const clock = $('paperClock');
  if (!clock) return;
  if (!paper) {
    clock.textContent = '';
    return;
  }
  const left = paperLeft();
  const mins = Math.floor(left / 60000);
  const secs = Math.floor((left % 60000) / 1000);
  clock.textContent = `Time left ${mins}:${String(secs).padStart(2, '0')} - ${paper.questions.length} questions - ${paper.total} marks`;
}

function stopPaperTimer() {
  if (paperTimer) clearInterval(paperTimer);
  paperTimer = null;
}

function renderPaper() {
  const list = $('paperQuestions');
  if (!list) return;
  list.innerHTML = '';
  if (!paper) return;
  for (const question of paper.questions) {
    const card = document.createElement('div');
    card.className = 'card paper-q';
    card.innerHTML = `<div class="paper-q-head"><span class="paper-q-n">Q${question.n}</span><span class="mini muted">${question.marks} mark${question.marks === 1 ? '' : 's'}</span></div>
      <p class="paper-q-text">${escapeHtml(question.prompt)}</p>
      <textarea class="paper-answer" data-n="${question.n}" rows="4" placeholder="Your answer"></textarea>`;
    list.appendChild(card);
  }
}

async function startPaper() {
  const count = Math.max(3, Math.min(20, Number($('paperCount').value) || 8));
  const minutes = Math.max(5, Math.min(180, Number($('paperMinutes').value) || 40));
  const button = $('btnPaperStart');
  busy(button, true);
  try {
    const course = (state.persona && state.persona.course) || '';
    const brief = [
      `Set a ${count}-question paper for this course, worth about ${count * 5} marks in total.`,
      course ? `Course: ${course}.` : '',
      'No answers, hints or marking notes anywhere in the paper.',
    ].filter(Boolean).join('\n');
    const res = await agent('paper', { text: brief, maxTokens: 2400 });
    const questions = ((res.structured && res.structured.questions) || [])
      .filter((question) => question && String(question.prompt || '').trim())
      .slice(0, count)
      .map((question, index) => ({
        n: index + 1,
        marks: Math.max(1, Number(question.marks) || 5),
        prompt: String(question.prompt),
      }));
    if (!questions.length) throw new Error('the model returned no questions');
    paper = {
      title: String((res.structured && res.structured.title) || 'Paper'),
      questions,
      total: questions.reduce((sum, question) => sum + question.marks, 0),
    };
    paperDeadline = Date.now() + minutes * 60000;
    $('paperResult').hidden = true;
    $('btnPaperSubmit').disabled = false;
    renderPaper();
    stopPaperTimer();
    // The clock runs on the deadline, not on the last tick, so a sleeping tab
    // cannot buy extra time.
    paperTimer = setInterval(() => {
      renderPaperClock();
      if (paperLeft() <= 0) {
        stopPaperTimer();
        submitPaper(true);
      }
    }, 1000);
    renderPaperClock();
    toast(`${questions.length} questions, ${minutes} minutes. Nothing is marked until you submit.`);
  } catch (error) {
    toast(`Could not set the paper: ${error.message}`, 'error');
  } finally {
    busy(button, false);
  }
}

async function submitPaper(auto = false) {
  if (!paper) return;
  const sitting = paper;
  const button = $('btnPaperSubmit');
  const answers = sitting.questions.map((question) => {
    const field = document.querySelector(`.paper-answer[data-n="${question.n}"]`);
    return {
      n: question.n,
      marks: question.marks,
      prompt: question.prompt,
      answer: String((field && field.value) || '').trim(),
    };
  });
  busy(button, true);
  stopPaperTimer();
  try {
    const brief = [
      sitting.title,
      ...answers.map(
        (item) =>
          `Question ${item.n} (${item.marks} marks): ${item.prompt}\nAnswer: ${item.answer || '(left blank)'}`
      ),
    ].join('\n\n');
    const res = await agent('mark', { text: brief, maxTokens: 2600 });
    const marked = Array.isArray(res.structured && res.structured.items) ? res.structured.items : [];
    const markOf = (item) => marked.find((entry) => Number(entry.n) === item.n) || {};
    const score = (item) => Math.max(0, Math.min(item.marks, Number(markOf(item).awarded) || 0));
    const rows = answers.map((item) => `<div class="paper-mark">
        <div class="paper-mark-head"><strong>Q${item.n}</strong><span class="mini muted">${score(item)}/${item.marks}</span></div>
        <p class="mini">${escapeHtml(markOf(item).fix || '')}</p>
        ${item.answer ? `<p class="mini muted">${escapeHtml(item.answer)}</p>` : '<p class="mini muted">left blank</p>'}
      </div>`);
    const outOf = answers.reduce((sum, item) => sum + item.marks, 0);
    const awarded = answers.reduce((sum, item) => sum + score(item), 0);
    $('paperMarked').innerHTML = `<h3>${escapeHtml(sitting.title)} - ${awarded}/${outOf}</h3>
      <p>${escapeHtml((res.structured && res.structured.summary) || '')}</p>${rows.join('')}`;
    $('paperResult').hidden = false;
    $('paperResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('btnPaperSubmit').disabled = true;
    // A paper that was sat is material the essay can build on: what was
    // solid, and the mark each answer left on the table.
    recordHistory('papers', {
      question: sitting.title,
      answer: `${awarded}/${outOf}`,
      awarded,
      outOf,
      summary: String((res.structured && res.structured.summary) || ''),
      fixes: answers
        .map((item) => ({ prompt: item.prompt, fix: String(markOf(item).fix || '') }))
        .filter((item) => item.fix),
    });
    if (auto) toast('Time is up: the paper was submitted as it stood.');
  } catch (error) {
    toast(`Could not mark the paper: ${error.message}`, 'error');
  } finally {
    busy(button, false);
  }
}

/* ── essay tab ─────────────────────────────────────────────── */
/* An item is either a photograph still to be read, or notes already in text. */
const essayFiles = [];
let understandEdited = false;

function syncEssayCount() {
  $('essayFileCount').textContent = essayFiles.length ? `${essayFiles.length} attached` : '';
  $('btnClearEssayFiles').hidden = !essayFiles.length;
}
function clearEssayFiles() {
  essayFiles.length = 0;
  renderThumbs($('essayThumbs'), essayFiles, syncEssayCount);
  syncEssayCount();
}

function updateUnderstandCount() {
  const field = $('essayUnderstand');
  const label = $('understandCount');
  if (!field || !label) return;
  const words = field.value.trim() ? field.value.trim().split(/\s+/).length : 0;
  label.textContent = words ? `${words} word${words === 1 ? '' : 's'} to build on` : 'nothing gathered yet';
}

/* The course's own material, gathered as the base of the draft. The user's
   sentences are never overwritten without being asked. */
function renderUnderstanding({ force = false } = {}) {
  const field = $('essayUnderstand');
  if (!field) return null;
  const gathered = gatherUnderstanding({
    persona: state.persona,
    memory: state.memory,
    history: state.history,
    session: state.session,
  });
  const hasOwn = Boolean(field.value.trim()) && understandEdited;
  if (force && hasOwn && !confirm('Replace what you have written with a fresh gathering from this course? Your own sentences will be lost.')) {
    updateUnderstandCount();
    return gathered;
  }
  if (force || !field.value.trim()) {
    field.value = gathered.text;
    understandEdited = false;
  }
  updateUnderstandCount();
  return gathered;
}

/* The brief: the question and the rubric, read off the page that was handed
   over, instead of typed in by hand. */
async function readBrief() {
  const images = essayFiles.map((file) => file.preview).filter(Boolean);
  const notes = essayFiles.map((file) => file.text).filter(Boolean).join('\n\n');
  if (!images.length && !notes) return;
  const status = $('briefStatus');
  const button = $('btnEssay');
  if (status) status.textContent = 'Reading the brief…';
  busy(button, true);
  try {
    const res = await agent('brief', {
      text: [
        'Read this essay brief and fill the form in from it.',
        images.length ? `${images.length} photograph(s) attached. Read every word on them.` : '',
        notes ? `Notes supplied as text:\n${notes.slice(0, 6000)}` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
      images,
      maxTokens: 1600,
    });
    const brief = res.structured || {};
    const filled = [];
    const question = String(brief.question || '').trim();
    if (question && !$('essayTopic').value.trim()) {
      $('essayTopic').value = question.slice(0, 300);
      filled.push('the question');
    }
    const requirements = Array.isArray(brief.requirements) ? brief.requirements : [];
    const rubric = [String(brief.rubric || '').trim(), ...requirements.map((item) => String(item).trim())]
      .filter(Boolean)
      .join('\n');
    if (rubric && !$('essayRubric').value.trim()) {
      $('essayRubric').value = rubric.slice(0, 1200);
      filled.push('the rubric');
    }
    const matter = String(brief.matter || '').trim();
    if (matter) {
      const field = $('essayUnderstand');
      if (field && !field.value.includes('From the brief you uploaded')) {
        const bullets = matter
          .split(/\n+/)
          .map((item) => item.replace(/^[-*]\s*/, '').trim())
          .filter(Boolean)
          .map((item) => `- ${item}`)
          .join('\n');
        field.value = `${field.value.trim() ? field.value.trim() + '\n\n' : ''}## From the brief you uploaded\n${bullets}`;
        understandEdited = false;
        updateUnderstandCount();
        filled.push('the material');
      }
    }
    const note = String(brief.note || '').trim();
    if (status) {
      status.textContent = filled.length
        ? `Filled in ${filled.join(', ')} from the upload. Everything is editable.${note ? ` ${note}` : ''}`
        : `Nothing to fill in: ${note || 'the upload did not read as a brief'}`;
    }
    if (!filled.length && !matter) toast(status ? status.textContent : 'Nothing to fill in.');
  } catch (error) {
    if (status) status.textContent = `Could not read the brief: ${error.message}`;
    toast(`Brief not read: ${error.message}`, 'error');
  } finally {
    busy(button, false);
  }
}

async function onEssayFiles(event) {
  const files = [...event.target.files];
  let added = 0;
  for (const file of files.slice(0, 4)) {
    if (file.type.startsWith('image/')) {
      essayFiles.push({ preview: await shrinkImage(file, 1100), name: file.name });
      added += 1;
    } else {
      const text = (await file.text()).slice(0, 12000);
      if (text.trim()) {
        essayFiles.push({ text, name: file.name });
        added += 1;
      }
    }
  }
  renderThumbs($('essayThumbs'), essayFiles, syncEssayCount);
  syncEssayCount();
  event.target.value = '';
  // The upload is the brief: it is read straight away so the question and the
  // rubric arrive filled in, not as a photograph to retype.
  if (added) await readBrief();
}

let lastEssay = '';
async function writeEssay() {
  const topic = $('essayTopic').value.trim();
  if (!topic && !essayFiles.length) {
    toast('Give it the essay question, or attach a photo of it.');
    $('essayTopic').focus();
    return;
  }
  const words = Math.max(150, Math.min(4000, Number($('essayWords').value) || 800));
  const tone = $('essayTone').value;
  const rubric = $('essayRubric').value.trim();
  // What they understand is the base of the draft. The gathered material stands
  // in only when they have not written it themselves.
  const gathered = gatherUnderstanding({
    persona: state.persona,
    memory: state.memory,
    history: state.history,
    session: state.session,
  });
  const understand = $('essayUnderstand').value.trim() || gathered.text;
  const style = gathered.voice.join(' ');
  const button = $('btnEssay');
  busy(button, true);
  $('essayResult').hidden = true;
  try {
    const brief = [
      topic ? `Essay question: ${topic}` : 'Essay question: read it from the attached photo.',
      essayFiles.length
        ? `Attached to the brief: ${essayFiles.length} item(s). Read every word, label and figure in them, and treat what they say as material you may rely on.`
        : '',
      `Target length: about ${words} words.`,
      tone ? `Required register: ${tone}.` : '',
      rubric ? `Rubric / what earns marks:\n${rubric}` : '',
      understand
        ? `What your user understands of this subject, in their own words. The draft stands on this - argue from it, keep its shape, and make it better rather than replacing it:\n${understand}`
        : 'They have not written what they understand yet: rely on the course material and well-established knowledge, and cite nothing outside it.',
      style
        ? `How they have written in this course before. Match the register; never quote it:\n${style}`
        : '',
      state.persona.course ? `Course context: ${state.persona.course}.` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const res = await agent('essay', {
      text: brief,
      images: essayFiles.map((f) => f.preview),
      maxTokens: Math.min(3800, Math.round(words * 2.2)),
    });
    lastEssay = res.reply;
    recordHistory('essays', { question: topic, answer: res.reply });
    $('essayOutput').innerHTML = md(res.reply) + groundedNote(res);
    $('essayResult').hidden = false;
    $('essayResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
    // The photos were read into this draft; the next essay must not inherit them.
    clearEssayFiles();
  } catch (error) {
    toast(`Essay failed: ${error.message}`, 'error');
  } finally {
    busy(button, false);
  }
}

/* ── read tab ──────────────────────────────────────────────── */
const readFiles = [];
let autoProcessRead = false;

function syncReadLabel() {
  $('readFilesLabel').textContent = readFiles.length
    ? `${readFiles.length} thing(s) loaded`
    : '＋ PDF, Word, photos, screen recording';
}

/** A PDF or a Word file is compressed binary: read here it would arrive as noise,
    so it goes through the same server-side unpacking the course material uses. */
function isDocumentFile(file) {
  if (/\.(pdf|doc|docx)$/i.test(String(file.name || ''))) return true;
  return [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ].includes(String(file.type || '').toLowerCase());
}

async function onReadFiles(event) {
  const files = [...event.target.files];
  for (const file of files.slice(0, 6)) {
    if (file.type.startsWith('image/')) {
      readFiles.push({ preview: await shrinkImage(file, 1400), name: file.name });
    } else if (file.type.startsWith('video/')) {
      const frames = await sampleVideo(file, 6);
      frames.slice(0, 4).forEach((preview, i) => readFiles.push({ preview, name: `${file.name} · frame ${i + 1}` }));
    } else if (isDocumentFile(file)) {
      $('readFilesLabel').textContent = `reading ${file.name}…`;
      try {
        const form = new FormData();
        form.append('file', file, file.name);
        const res = await api('/api/sources', { form });
        const doc = (res.docs || [])[0];
        if (!doc) throw new Error('nothing came back for that file');
        if (doc.error) throw new Error(doc.error);
        if (!doc.text || !doc.text.trim()) {
          toast(`${file.name}: ${doc.note || 'no text found — photograph the pages instead.'}`, 'error');
          continue;
        }
        readFiles.push({ preview: '', name: file.name, text: doc.text.slice(0, 20000), note: doc.note || '' });
        if (doc.note) toast(`${file.name}: ${doc.note}`);
      } catch (error) {
        toast(`${file.name}: ${error.message}`, 'error');
      }
    } else {
      const text = (await file.text()).slice(0, 20000);
      readFiles.push({ preview: '', name: file.name, text });
    }
  }
  // The thumbnails are a filtered view, so deleting one has to take the file out of
  // readFiles rather than out of the copy that was drawn.
  renderThumbs($('readThumbs'), readFiles.filter((f) => f.preview), (removed) => {
    const at = readFiles.indexOf(removed);
    if (at >= 0) readFiles.splice(at, 1);
    syncReadLabel();
  });
  syncReadLabel();
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
    $('readOutput').innerHTML = md(res.reply) + groundedNote(res);
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
  return applySessionKey(data, options);
}

/* One installation path for both stores: a key is a key once it is issued, and
   writing the state twice is how two devices end up disagreeing about which key
   is stored. */
async function applySessionKey(data, options) {
  const base = (data.baseUrl || GATEWAY_DEFAULT).replace(/\/+$/, '');
  const check = await verifyGatewayKey(data.key, base);
  if (!check.ok) {
    return { ok: false, message: 'The gateway refused the issued key: ' + check.message };
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
const store = { plans: [], slug: '', page: '', minutes: 15, iap: null, applePrices: {}, iapAsked: [], iapError: '' };

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

/* On iOS a session is priced by the App Store, in the currency of the account
   signed in on the phone. Falling back to Magnate's number keeps the web and
   Android lists unchanged. */
function planPrice(plan) {
  const entry = store.iap?.products?.find((product) => product.planSlug === plan.slug);
  return (entry && store.applePrices[entry.productId]) || money(plan.priceCents);
}

async function loadStore() {
  try {
    const data = await api('/api/store');
    store.plans = Array.isArray(data.plans) ? data.plans : [];
    store.page = data.page || '';
    store.minutes = Number(data.minutes) || 15;
    // In-app purchase is offered only when the server can verify a transaction
    // and mint a key for it; otherwise the store page stays the way to buy.
    const iap = await api('/api/iap/config').catch(() => null);
    store.iap = iap && iap.enabled ? iap : null;
    // The App Store is the price list the phone is charged against, so on iOS
    // the numbers above the buttons are StoreKit's own, never Magnate's.
    store.applePrices = {};
    store.iapAsked = [];
    store.iapError = '';
    store.iapPhone = null;
    if (store.iap && NATIVE_STORE) {
      const ids = store.iap.products.map((product) => product.productId);
      store.iapAsked = ids;
      const priced = await NATIVE_STORE.products({ ids }).catch((error) => {
        store.iapError = 'The plugin answered with an error: ' + (error?.message || error) + '.';
        return null;
      });
      if (!priced && !store.iapError) store.iapError = 'The plugin answered with nothing at all.';
      for (const product of priced?.products || []) {
        if (product?.productId && product?.price) store.applePrices[product.productId] = product.price;
      }
      // What the phone itself can say about selling: whether this Apple ID may pay at
      // all, and which storefront it is signed into. A build whose plugin predates
      // the call answers nothing, and the panel says so rather than guessing.
      if (typeof NATIVE_STORE.diagnostics === 'function') {
        store.iapPhone = await NATIVE_STORE.diagnostics().catch(() => null);
      }
    }
    if (!store.plans.some((plan) => plan.slug === store.slug)) store.slug = store.plans[0]?.slug || '';
  } catch {
    // An unreachable store is not a broken app: the page link still works.
    store.plans = [];
  }
  renderStore();
}

/* What StoreKit actually answered, named on the device. An empty list is StoreKit's
   quiet answer for a product it will not sell, and it looks like a dead button: the
   ids asked for and the count that came back belong in the panel, not only in the
   moment a purchase is attempted. */
function renderIapDiag() {
  const host = $('iapDiag');
  if (!host) return;
  if (!IOS_APP) {
    host.hidden = true;
    host.textContent = '';
    return;
  }
  const offered = store.iap?.products?.length || 0;
  const asked = store.iapAsked || [];
  const answered = Object.entries(store.applePrices || {});
  const phone = store.iapPhone || null;
  const rows = [
    store.iap
      ? `server · ${offered} product${offered === 1 ? '' : 's'} offered`
      : 'server · nothing offered, so StoreKit was asked for nothing',
  ];
  if (!NATIVE_STORE) {
    rows.push('plugin · the App Store plugin did not load in this build');
  } else if (asked.length) {
    rows.push(
      `StoreKit · answered ${answered.length} of ${asked.length}` +
        (answered.length ? ` (${answered.map(([id, price]) => `${id} ${price}`).join(', ')})` : '') +
        (store.iapError ? ` — ${store.iapError}` : ''),
    );
  }
  rows.push(
    phone
      ? `payments · ${phone.canMakePayments ? 'allowed' : 'this Apple ID may not pay'} · storefront ${phone.storefront || 'unknown'}`
      : 'payments · not reported by this build',
  );
  const ready = Boolean(
    store.iap && NATIVE_STORE && asked.length && answered.length === asked.length && phone?.canMakePayments !== false,
  );
  if (!ready) {
    rows.push(
      answered.length
        ? 'Selling stops here: the store cannot charge for a product it did not return.'
        : 'When StoreKit returns nothing, Apple is declining to sell: the Paid Apps Agreement is not active for this account, the products are not approved yet, or this Apple ID is in a storefront that does not carry them.',
    );
  }
  host.hidden = false;
  host.textContent = ['Selling · ' + (ready ? 'ready — the App Store will charge' : 'blocked'), ...rows].join('\n');
}

function renderStore() {
  const host = $('storePlans');
  if (!host) return;
  host.innerHTML = '';
  syncSetupBuy();
  renderIapDiag();
  const note = $('storeNote');
  const buy = $('btnBuy');
  const page = $('btnStorePage');
  // Apple's rule for a digital good is absolute: on iOS the App Store is the only
  // way to pay, so the web storefront appears there in no form at all — not as a
  // button, not as a link, not as a line of copy pointing at one. When the server
  // cannot mint a key yet, the phone says so rather than selling something it
  // cannot deliver and calling it a fallback.
  const ios = IOS_APP;
  if ($('stripeNote')) $('stripeNote').hidden = ios;
  // A plugin that did not load is as unsellable as a server that cannot mint: on
  // iOS both cases say so, and neither falls back to the card form.
  if (ios && !(store.iap && NATIVE_STORE)) {
    if (note) {
      note.textContent = 'Sessions cannot be bought on this device right now. Nothing has been charged — please try again later.';
    }
    if (buy) buy.hidden = true;
    if (page) page.hidden = true;
    return;
  }
  const plan = chosenPlan();

  if (!plan) {
    if (note) {
      note.textContent = 'Sessions are priced on Magnate, which runs the payment; the receipt carries a claim code that installs the key here.';
    }
    if (buy) buy.hidden = true;
    if (page) page.hidden = ios;
    return;
  }
  if (buy) {
    buy.hidden = false;
    buy.textContent = NATIVE_STORE ? 'Buy with the App Store' : 'Buy a session';
  }
  if (page) page.hidden = true;
  if ($('iapNote')) $('iapNote').hidden = !(store.iap && NATIVE_STORE);
  for (const option of store.plans) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn ' + (option.slug === plan.slug ? 'primary' : 'ghost');
    button.textContent =
      planLabel(option) + ' · ' + planPrice(option) + (option.minutes ? ` · ${option.minutes} min` : '');
    button.onclick = () => {
      store.slug = option.slug;
      renderStore();
    };
    host.appendChild(button);
  }
  if (note) {
    note.textContent =
      planLabel(plan) + ' — ' + (plan.minutes || store.minutes) + ' minutes of the gateway, ' + planPrice(plan) +
      ' each. One key, usable as often as you like until the window closes.';
  }
}

/* Whether the card has already asked whether a session can be sold here. */
let setupStoreAsked = false;

function syncSetupBuy() {
  const button = $('btnSetupBuy');
  if (!button) return;
  const sellable = Boolean(store.iap && (NATIVE_STORE || !IOS_APP));
  button.hidden = !sellable;
  button.textContent = NATIVE_STORE ? 'Buy with the App Store' : 'Buy a session';
}

/* Settings already holds the plans at the App Store's own prices, so the card opens
   it there rather than duplicating a second, unpriced checkout on the live page.
   Opening it charges nothing: Apple's own sheet is the confirmation. */
function buyFromSetup() {
  openSettings();
  const block = $('storePlans')?.closest?.('.admin-block');
  if (block?.scrollIntoView) block.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const buy = $('btnBuy');
  if (buy && !buy.hidden) buy.focus();
  else $('storePlans')?.focus?.();
}

async function startPurchase() {
  // Guard as well as hide: a web checkout opened on iOS is the rejection, and the
  // button is not the only way in here.
  if (NATIVE_STORE) return buyWithApple(chosenPlan());
  if (IOS_APP) {
    const status = $('buyStatus');
    if (status) {
      status.textContent =
        'Sessions on this device are bought through the App Store, which is not reachable right now. Nothing has been charged.';
    }
    return;
  }
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

/* The App Store takes the money and the server mints the key: the plugin stops
   at a verified transaction id, which is the only part worth trusting here. */
async function buyWithApple(plan) {
  const status = $('buyStatus');
  const button = $('btnBuy');
  if (!plan) return;
  const entry =
    store.iap?.products?.find((product) => product.planSlug === plan.slug) || store.iap?.products?.[0] || null;
  if (!entry) {
    if (status) status.textContent = 'That session is not set up in the App Store yet.';
    return;
  }
  // StoreKit answers an empty list, not an error, for a product it will not sell from
  // this build, so the plugin's refusal reads like a fault in the app. Approval is not
  // the gate — a sandbox purchase works before review — so name the id that came back
  // empty and the store-side reasons for an empty answer instead.
  if (NATIVE_STORE && store.iap && !Object.keys(store.applePrices || {}).length) {
    if (status) {
      status.textContent =
        'The App Store returned no product for ' +
        entry.productId +
        ', so nothing can be bought yet — and nothing has been charged. Approval is not the gate: a sandbox purchase works before review. The usual reason is that the sales agreement is unsigned — App Store Connect answers "To offer apps or other in-app purchases, you must sign the Paid Apps Agreement" until the Account Holder signs it under Business → Agreements. It can also mean the product is not Ready to Submit, or this build did not come from App Store Connect (TestFlight or App Review).';
    }
    return;
  }
  const email = String($('setReceiptEmail')?.value || '').trim();
  busy(button, true);
  try {
    if (status) status.textContent = 'Waiting for the App Store…';
    const bought = await NATIVE_STORE.buy({ productId: entry.productId });
    // What goes to the server is Apple's signature over the transaction, not the
    // ids read out of it: only the server can say whether that signature holds.
    if (!bought || !bought.signedTransaction) throw new Error('The App Store did not sign that purchase.');
    if (status) status.textContent = 'Purchase confirmed — installing the key…';
    const data = await api('/api/iap/purchase', {
      body: { signedTransaction: bought.signedTransaction, email },
    });
    const installed = await applySessionKey(data, { silent: true });
    if (status) {
      status.textContent = installed.ok
        ? 'Paid · ' + (data.planName || 'session') + ' key installed.'
        : installed.message;
    }
    if (!installed.ok) throw new Error(installed.message);
  } catch (error) {
    if (status) status.textContent = error.message;
  } finally {
    busy(button, false);
  }
}

function openStorePage() {
  if (IOS_APP) {
    const status = $('buyStatus');
    if (status) status.textContent = 'Sessions on this device are bought through the App Store.';
    return;
  }
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
  syncKeyReset();
  renderCaptureNote();
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
  // The list is drawn from the course record, so the active course has to hold
  // this name before it is redrawn: otherwise a new or renamed course kept its
  // old label in the picker until the next launch.
  stashActive();
  renderCourseUi();
  applyDirection();
  persist();
  updateStatus();
  renderMemory();
  toast('Saved.');
  // A code that has just been entered or cleared changes who the server thinks is
  // asking, so the workspace is offered to it (or given up) right away.
  if (state.settings.accessCode !== previousCode) syncWorkspace();
}

/* ── foundation documents ──────────────────────────────────── */
/* The material a course answers from. It is read once, on the server — a PDF's
   text layer, a Word document's paragraphs, a screenshot through the vision
   model, a recording through transcription — and kept with the course, so
   Answer, Quiz and Read are grounded without uploading anything again. */
const FOUNDATION_TOTAL_CHARS = 400000;

function normalizeFoundation(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((doc) => doc && typeof doc.text === 'string' && doc.text.trim())
    .map((doc) => ({
      id: String(doc.id || uid('f')),
      name: String(doc.name || 'document').slice(0, 120),
      kind: String(doc.kind || 'text').slice(0, 24),
      chars: Number(doc.chars) || doc.text.length,
      // Where the document says each passage sits, when extraction knew. Kept with
      // the course so a citation opens without re-reading the file.
      segments: (Array.isArray(doc.segments) ? doc.segments : [])
        .filter((segment) => segment && String(segment.text || '').trim())
        .slice(0, 120)
        .map((segment) => ({
          locator: String(segment.locator || 'whole document').slice(0, 40),
          text: String(segment.text),
        })),
      note: String(doc.note || '').slice(0, 200),
      on: doc.on !== false,
      text: doc.text,
    }))
    .slice(0, 12);
}

/* Only the turns that are grounded: a live note is about the room, not the
   handout, and an essay carries its own material in the brief. */
function foundationFor(mode) {
  if (!['answer', 'quiz', 'read', 'essay', 'paper', 'mark'].includes(mode)) return [];
  const docs = (state.foundation || []).filter((doc) => doc.on !== false && doc.text);
  // The course's own documents first, then anything this device still holds that
  // the course has since let go — read before the workspace moved, still citable.
  const extra = cacheOnly(library.rows || [], docs);
  return [...docs, ...extra].slice(0, 8).map((doc) => ({
    name: doc.name,
    kind: doc.kind,
    text: doc.text,
    segments: doc.segments || [],
    ...(extra.includes(doc) ? { fromCache: true } : {}),
  }));
}

function foundationSummary() {
  const live = (state.foundation || []).filter((doc) => doc.on !== false);
  if (!live.length) return '';
  return `Answering from ${live.length} foundation document${live.length === 1 ? '' : 's'} · manage in Foundation`;
}

function groundedNote(res) {
  const names = Array.isArray(res?.grounded) ? res.grounded.filter(Boolean) : [];
  const cites = Array.isArray(res?.citations) ? res.citations.filter((cite) => cite && cite.name) : [];
  // Which of those came from this device rather than the server. A turn asked
  // with no connection is answered from the cached copy, and the reply says so.
  const cachedNames = Array.isArray(res?.fromCache)
    ? res.fromCache.filter(Boolean)
    : names.filter((name) => cacheOnly(library.rows || []).some((row) => row.name === name));
  const cachedSuffix = cachedNames.length ? ` · ${cacheNote(cachedNames)}` : '';
  if (!names.length && !cites.length) return '';
  if (!cites.length) return `<div class="mini muted grounded">grounded in ${escapeHtml(names.join(', '))}${cachedSuffix}</div>`;
  // A page is only worth a chip if the app can open it, which is why the server
  // drops any citation that does not match a document it was given.
  const chips = cites
    .map((cite) => {
      const where = cite.locator && cite.locator !== 'whole document' ? ` · ${cite.locator}` : '';
      return `<button type="button" class="cite-chip" data-cite="${escapeHtml(cite.name)}" data-locator="${escapeHtml(cite.locator || '')}">${escapeHtml(cite.name)}${escapeHtml(where)}</button>`;
    })
    .join(' ');
  return `<div class="mini muted grounded">grounded in ${chips}${cachedSuffix}</div>`;
}

/* Turning to the page: the cited passage, from the copy this course already holds. */
function openCitation(name, locator) {
  const viewer = $('citeViewer');
  if (!viewer) return;
  const doc =
    (state.foundation || []).find((entry) => entry.name === name) ||
    (library.rows || []).find((entry) => entry.name === name);
  $('citeTitle').textContent = locator && locator !== 'whole document' ? `${name} · ${locator}` : name;
  const segments = Array.isArray(doc?.segments) && doc.segments.length
    ? doc.segments
    : [{ locator: 'whole document', text: doc?.text || 'That document is no longer part of this course.' }];
  const shown = locator && locator !== 'whole document'
    ? segments.filter((segment) => segment.locator === locator)
    : segments;
  $('citeBody').innerHTML = (shown.length ? shown : segments)
    .map((segment) => `<div class="cite-seg"><span class="cite-loc">${escapeHtml(segment.locator)}</span><pre>${escapeHtml(String(segment.text || '').slice(0, 8000))}</pre></div>`)
    .join('');
  viewer.hidden = false;
  // A div modal does not get <dialog>'s focus behaviour, so it takes and gives
  // back focus itself; the keydown listener below keeps Tab inside it.
  citeFocus.was = document.activeElement;
  citeFocus.on = true;
  setTimeout(() => document.getElementById('citeClose')?.focus({ preventScroll: true }), 20);
}

document.addEventListener('click', (event) => {
  const shareBtn = event.target.closest?.('[data-share-doc]');
  if (shareBtn) {
    const doc = (state.foundation || []).find((entry) => entry.id === shareBtn.dataset.shareDoc);
    if (doc) shareCourse('document', doc.name);
    return;
  }
  if (event.target.closest?.('#btnShareCourse')) {
    shareCourse('course');
    return;
  }
  const copyLink = event.target.closest?.('[data-copy-link]');
  if (copyLink) {
    navigator.clipboard?.writeText(copyLink.dataset.copyLink || '').then(
      () => toast('Link copied.'),
      () => toast('Copy it from the line above.')
    );
    return;
  }
  const chip = event.target.closest?.('[data-cite]');
  if (chip) {
    openCitation(chip.dataset.cite, chip.dataset.locator || '');
    return;
  }
  const stamp = event.target.closest?.('[data-audio]');
  if (stamp) {
    playNoteOffset(stamp.dataset.audio, stamp.dataset.audioLabel || 'lecture');
    return;
  }
  const go = event.target.closest?.('[data-goto]');
  if (go) {
    const viewer = $('citeViewer');
    if (viewer) viewer.hidden = true;
    openTab(go.dataset.goto);
    return;
  }
  if (event.target.closest?.('#citeClose') || event.target.id === 'citeViewer') closeCiteViewer();
});

/* A div modal does not get <dialog>'s focus behaviour, so it is done here: Tab
   cycles inside, Escape closes, and focus returns to what opened it. */
document.addEventListener('keydown', (event) => {
  if (!citeFocus.on) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeCiteViewer();
    return;
  }
  if (event.key !== 'Tab') return;
  const viewer = $('citeViewer');
  const items = [
    ...(viewer?.querySelectorAll('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])') || []),
  ].filter((el) => !el.disabled && el.getClientRects().length);
  const index = items.indexOf(document.activeElement);
  const target = trapFocusIndex(items.length, index < 0 ? items.length - 1 : index, event.shiftKey);
  if (target === null) return;
  event.preventDefault();
  items[target]?.focus({ preventScroll: true });
});

function renderFoundation() {
  const list = $('foundationList');
  if (!list) return;
  ensureLibrary();
  const docs = normalizeFoundation(state.foundation);
  state.foundation = docs;
  list.innerHTML = '';
  if (!docs.length) {
    const empty = document.createElement('p');
    empty.className = 'mini muted';
    empty.textContent = 'Nothing yet. Add the PDF, handout, notes, screenshots or recording this course answers from.';
    list.appendChild(empty);
  }
  for (const doc of docs) {
    const row = document.createElement('div');
    row.className = 'doc-row';
    row.innerHTML = `
      <label class="check"><input type="checkbox" data-doc="${doc.id}" ${doc.on ? 'checked' : ''} /> use</label>
      <div class="doc-body">
        <strong>${escapeHtml(doc.name)}</strong>
        <span class="mini muted">${escapeHtml(doc.kind)} · ${Number(doc.chars || 0).toLocaleString()} characters${doc.note ? ` · ${escapeHtml(doc.note)}` : ''}</span>
        ${docFlag(doc)}
      </div>
      <button type="button" class="mini" data-share-doc="${doc.id}">share</button>
      <button type="button" class="mini" data-drop="${doc.id}">remove</button>
    `;
    list.appendChild(row);
  }
  const status = $('foundationStatus');
  if (status) status.textContent = docs.length ? `${docs.filter((doc) => doc.on !== false).length} of ${docs.length} in use` : 'Nothing added yet.';
  const clear = $('btnFoundationClear');
  if (clear) clear.hidden = !docs.length;
  for (const id of ['answerFoundationHint', 'quizFoundationHint', 'readFoundationHint']) {
    const hint = $(id);
    if (hint) hint.textContent = foundationSummary();
  }
}

async function onFoundationFiles(event) {
  const files = [...event.target.files].slice(0, 6);
  event.target.value = '';
  if (!files.length) return;
  const status = $('foundationStatus');
  const label = $('foundationFilesLabel');
  label.textContent = 'reading…';
  for (const file of files) {
    status.textContent = `Reading ${file.name}…`;
    try {
      const form = new FormData();
      form.append('file', file, file.name);
      const res = await api('/api/sources', { form });
      const doc = (res.docs || [])[0];
      if (!doc) throw new Error('nothing came back for that file');
      if (doc.error) throw new Error(doc.error);
      if (!doc.text || !doc.text.trim()) {
        toast(`${file.name}: ${doc.note || 'no text found — add screenshots of the pages instead.'}`, 'error');
        continue;
      }
      state.foundation = normalizeFoundation([...(state.foundation || []), { ...doc, id: uid('f'), on: true }]);
      let total = state.foundation.reduce((sum, entry) => sum + entry.text.length, 0);
      while (total > FOUNDATION_TOTAL_CHARS && state.foundation.length > 1) {
        total -= state.foundation[0].text.length;
        state.foundation = state.foundation.slice(1);
      }
      persist();
      renderFoundation();
      cacheFoundation(state.activeId, state.foundation);
      toast(`${doc.name || file.name} added — ${Number(doc.chars || 0).toLocaleString()} characters${doc.note ? `. ${doc.note}` : ''}`);
    } catch (error) {
      toast(`${file.name}: ${error.message}`, 'error');
    }
  }
  label.textContent = '＋ PDF, text, doc, screenshot or audio';
  renderFoundation();
}

/* ── sharing a course ──────────────────────────────────────── */
/* A link a classmate can open: the notes and the documents, read-only, with no
   memory, no answers and no settings. The server keeps one copy of each document
   by content hash, so the same handout shared twice is stored once. */
async function shareCourse(scope = 'course', docName = '') {
  const docs = (scope === 'document'
    ? (state.foundation || []).filter((doc) => doc.name === docName)
    : (state.foundation || []).filter((doc) => doc.on !== false)
  ).filter((doc) => doc.text);
  const notes = scope === 'document' ? [] : (state.session.notes || []).slice(-60).map((note) => note.text);
  if (!docs.length && !notes.length) {
    toast('Nothing to share yet — add a document or write a note first.');
    return;
  }
  const out = $('shareOut');
  if (out) out.textContent = 'Making a link…';
  try {
    const res = await api('/api/share', {
      body: {
        name: state.persona.name === 'Sage' ? '' : state.persona.name,
        courseName: state.persona.course || 'A course',
        kind: scope === 'document' ? 'document' : 'course',
        notes,
        docs: docs.map((doc) => ({ name: doc.name, kind: doc.kind, text: doc.text, segments: doc.segments || [] })),
        // A shared reader is the sections with their anchors, so a classmate can
        // open the page or moment a claim came from without any live state.
        reader:
          scope === 'document'
            ? []
            : (readerDoc?.sections || []).map((section) => ({
                title: section.title,
                captured: section.captured,
                blocks: section.blocks.map((block) => ({
                  kind: block.kind,
                  text: block.edited ? block.edited.text : block.text,
                  anchors: block.anchors,
                })),
              })),
      },
    });
    const link = res.url || `${location.origin}${res.path}`;
    if (out) {
      out.innerHTML = `Read-only link, expires ${escapeHtml(String(res.expiresAt || '').slice(0, 10))}:
        <a href="${escapeHtml(link)}" target="_blank" rel="noreferrer">${escapeHtml(link)}</a>
        <button type="button" class="mini" data-copy-link="${escapeHtml(link)}">copy</button>`;
    }
    toast(`Link ready — ${res.docs} document${res.docs === 1 ? '' : 's'}, ${res.notes} note${res.notes === 1 ? '' : 's'}.`);
  } catch (error) {
    if (out) out.textContent = '';
    toast(`Could not share: ${error.message}`, 'error');
  }
}

function clearFoundation() {
  if (!(state.foundation || []).length) return;
  if (!confirm('Remove every foundation document from this course?')) return;
  state.foundation = [];
  persist();
  renderFoundation();
  forgetLibrary();
  toast('Foundation documents cleared.');
}

/* ── the copy on this device ───────────────────────────────── */
/* Every foundation document is kept in IndexedDB as well as the workspace, under
   its own budget rather than localStorage's. The workspace is what the server
   knows; this is what survives a basement tutorial, and what a reply is grounded
   on when the connection is gone. */
const LIBRARY_DB = 'sage-library';
const LIBRARY_STORE = 'docs';
const library = { rows: [], loadedFor: '', loadingFor: '', restoring: false };

function libraryId(courseId, name) {
  return `${courseId || 'general'}::${name}`;
}

function libraryDb() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    let request;
    try {
      request = indexedDB.open(LIBRARY_DB, 1);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(LIBRARY_STORE)) {
        const store = db.createObjectStore(LIBRARY_STORE, { keyPath: 'id' });
        store.createIndex('course', 'course', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

function libraryOnce(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function libraryRun(mode, run) {
  const db = await libraryDb();
  if (!db) return null;
  try {
    const tx = db.transaction(LIBRARY_STORE, mode);
    const result = await run(tx.objectStore(LIBRARY_STORE));
    await new Promise((resolve) => {
      tx.oncomplete = resolve;
      tx.onerror = resolve;
      tx.onabort = resolve;
    });
    return result;
  } catch {
    return null;
  } finally {
    db.close?.();
  }
}

async function libraryEntries(courseId) {
  const rows = await libraryRun('readonly', (store) => libraryOnce(store.index('course').getAll(String(courseId || 'general'))));
  return (rows || []).filter((row) => row && row.text);
}

function renderCacheLine(rows = library.rows) {
  const el = $('foundationCache');
  if (el) el.textContent = describeCache(rows || []);
}

/* Keep the course's documents on the device, least recently used leaving first. */
async function cacheFoundation(courseId = state.activeId || 'general', docs = state.foundation) {
  const list = normalizeFoundation(docs).filter((doc) => String(doc.text || '').trim());
  if (!list.length) return null;
  const now = Date.now();
  const rows = list.map((doc) => ({ ...stampDoc(doc, now), id: libraryId(courseId, doc.name), course: String(courseId || 'general') }));
  const plan = await libraryRun('readwrite', async (store) => {
    for (const row of rows) {
      const was = await libraryOnce(store.get(row.id));
      await libraryOnce(store.put({ ...row, cachedAt: Number(was?.cachedAt) || now }));
    }
    const all = (await libraryOnce(store.getAll())) || [];
    const planned = planCache(
      all.map((row) => ({ id: row.id, chars: Number(row.chars) || String(row.text || '').length, at: Number(row.usedAt) || Number(row.cachedAt) || 0 }))
    );
    for (const id of planned.dropped) await libraryOnce(store.delete(id));
    return planned;
  });
  library.rows = await libraryEntries(courseId);
  library.loadedFor = courseId;
  renderCacheLine(library.rows);
  return plan;
}

async function forgetLibrary(courseId = state.activeId || 'general') {
  await libraryRun('readwrite', async (store) => {
    const keys = await libraryOnce(store.index('course').getAllKeys(String(courseId || 'general')));
    for (const key of keys || []) await libraryOnce(store.delete(key));
  });
  library.rows = [];
  renderCacheLine([]);
}

/* Loaded lazily, from renderFoundation, so every path that shows the panel — boot,
   a course switch, a workspace pull — has the copy this course can ground on. */
function ensureLibrary() {
  const courseId = state.activeId || 'general';
  if (library.loadingFor === courseId) return;
  if (library.loadedFor === courseId && library.rows.length) return;
  library.loadingFor = courseId;
  libraryEntries(courseId)
    .then((rows) => {
      if (library.loadingFor === courseId) library.loadingFor = '';
      if (state.activeId && state.activeId !== courseId) return;
      library.rows = rows;
      library.loadedFor = courseId;
      if (!rows.length) {
        cacheFoundation(courseId, state.foundation);
        return;
      }
      renderFoundation();
      renderCacheLine(rows);
    })
    .catch(() => {
      if (library.loadingFor === courseId) library.loadingFor = '';
    });
}

/* The server answered, so its copy is the one that counts: take the words it has,
   refresh what changed, and let go of what the course no longer holds. Never
   called after a failed pull, which is what keeps the cache alive offline. */
async function reconcileLibrary() {
  const courseId = state.activeId || 'general';
  const rows = await libraryEntries(courseId);
  const live = normalizeFoundation(state.foundation);
  const plan = reconcileDocs(rows, live);
  if (plan.drop.length) {
    await libraryRun('readwrite', async (store) => {
      for (const row of rows) if (plan.drop.includes(row.name)) await libraryOnce(store.delete(row.id));
    });
  }
  await cacheFoundation(courseId, live);
  if (plan.refresh.length) {
    toast(`${plan.refresh.length} document${plan.refresh.length === 1 ? '' : 's'} refreshed from the server.`);
  }
}

/* What the panel says per document: whether this device can ground on it, and
   whether the copy here is the one the course has. */
function docFlag(doc) {
  const held = (library.rows || []).find((row) => row && row.name === doc.name);
  if (!held) return '<span class="mini muted">not on this device</span>';
  if (held.hash !== hashDoc(doc)) return '<span class="mini muted">cached copy is older — re-add to refresh</span>';
  return '<span class="mini muted">cached on this device</span>';
}

let flushingQueue = false;

/* Replay what the device kept. Each turn goes back to the tab that asked for it,
   so an answer arrives where the user will look rather than in a toast that has
   already gone. A turn that still cannot reach the server stays queued. */
async function flushPending() {
  if (flushingQueue || !queued(state.pending).length) return;
  flushingQueue = true;
  const before = queued(state.pending).length;
  for (const turn of queued(state.pending)) {
    const sent = foundationFor(turn.mode);
    let res;
    // The photos kept beside this turn, if the store still has them. An evicted or
    // refused store turns the replay back into the words alone.
    let photos = [];
    if (turn.images) {
      try {
        photos = await getPhotos(turn.id);
      } catch {
        photos = [];
      }
    }
    try {
      res = await api('/api/chat', {
        body: {
          mode: turn.mode,
          text: turn.text,
          images: photos,
          maxTokens: turn.maxTokens || undefined,
          history: recentContext(),
          memory: state.memory,
          language: state.language,
          persona: state.persona,
          sources: sent,
        },
      });
    } catch {
      break;
    }
    state.pending = forget(state.pending, turn.id);
    res.fromCache = (turn.fromCache || []).length ? turn.fromCache : sent.filter((doc) => doc.fromCache).map((doc) => doc.name);
    if (photos.length) await dropPhotos(turn.id).catch(() => {});
    persist();
    deliverQueued(turn, res);
  }
  flushingQueue = false;
  updateStatus();
  const done = before - queued(state.pending).length;
  if (done > 0) toast(`${done} kept turn${done === 1 ? '' : 's'} answered.`);
}

function deliverQueued(turn, res) {
  if (res.notes?.length) addMemory(res.notes, 'learned');
  if (turn.mode === 'answer') {
    renderAnswer(res, $('answerResult'), turn.text);
    return;
  }
  if (turn.mode === 'quiz') {
    $('quizResults').appendChild(quizCard(turn.text, res, $('quizResults').children.length));
    return;
  }
  if (turn.mode === 'read') {
    $('readOutput').innerHTML = md(res.reply) + groundedNote(res);
    $('readResult').hidden = false;
    return;
  }
  if (turn.mode === 'essay') {
    $('essayOutput').innerHTML = md(res.reply) + groundedNote(res);
    $('essayResult').hidden = false;
    return;
  }
  addNote(`Q: ${turn.text}
A: ${res.reply}`.slice(0, 1400), 'queued');
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
  // `aria-selected` is what a screen reader announces; the class alone left it
  // saying "Live" whatever tab was actually open.
  document.querySelectorAll('.tab').forEach((t) => {
    const on = t.dataset.tab === name;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
  });
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
  // A tab is a button that opens a panel: pressing it should land in the panel,
  // not leave focus on the rail for the next Tab to walk from.
  if (document.activeElement?.classList?.contains('tab')) {
    document.getElementById(`tab-${name}`)?.focus({ preventScroll: true });
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/*
 * The capture test is the only place a device can be asked what it can hear — the
 * microphone, another app's audio, neither — so Settings reports its last answer
 * instead of guessing, and links to the page that can produce a new one.
 */
function renderCaptureNote() {
  const note = $('captureNote');
  if (!note) return;
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem('sage.capture') || 'null');
  } catch {
    saved = null;
  }
  if (!saved?.verdicts) {
    note.textContent =
      'Not run on this device yet. The test asks the microphone and another app’s audio, and says which one this shell actually allows.';
    return;
  }
  const names = { lecture: 'the microphone', audiobook: 'another app’s audio' };
  const blocked = Object.entries(saved.verdicts)
    .filter(([, value]) => value?.status !== 'allowed')
    .map(([key, value]) => `${names[key] || key} (${value?.status || 'unknown'})`);
  const at = new Date(saved.at || Date.now());
  const stamp = Number.isNaN(at.getTime()) ? 'earlier' : at.toLocaleString();
  note.textContent = blocked.length
    ? `Last tested ${stamp}: ${blocked.join(', ')} unavailable on this device. Run it again after changing shell or phone.`
    : `Last tested ${stamp}: both sources opened — the microphone and another app’s audio.`;
}

function offerScreenFallback() {
  const dialog = $('screenDialog');
  if (!dialog) {
    toast('This device cannot capture the screen. Mirror it to a computer and use a relay code, or upload a recording in Read.', 'error');
    return;
  }
  if (!dialog.open) dialog.showModal();
}

/* review tab: spaced revision */
let reviewRun = null;

function reviewCourseId() {
  return state.activeId || 'general';
}

function refreshReview() {
  const { review } = reviewEnqueue(loadReview(reviewCourseId()), reviewCandidates(state.history || {}), Date.now());
  saveReview(reviewCourseId(), review);
  return review;
}

function reviewWhen(due, now) {
  const days = Math.ceil((due - now) / 86400000);
  if (days <= 0) return 'due now';
  return days === 1 ? 'tomorrow' : `in ${days} days`;
}

function renderReview() {
  const meta = $('reviewMeta');
  const status = $('reviewStatus');
  const list = $('reviewQueue');
  if (!meta || !status || !list) return;
  const now = Date.now();
  const review = loadReview(reviewCourseId());
  const counts = reviewStats(review, now);
  meta.textContent = counts.due
    ? `${counts.due} due - about ${counts.minutes} minute${counts.minutes === 1 ? '' : 's'}`
    : 'nothing due today';
  status.textContent = [
    `${counts.due} due now, ${counts.waiting} waiting, ${counts.retired} learnt`,
    `streak ${counts.streak} day${counts.streak === 1 ? '' : 's'}`,
    counts.doneToday ? `${counts.doneToday} answered today` : '',
    counts.nextDue ? `next ${reviewWhen(counts.nextDue, now)}` : '',
  ]
    .filter(Boolean)
    .join(' - ') + '.';

  const items = reviewDue(review, now).concat(
    Object.values(review.items).filter((item) => !item.retired && Number(item.due) > now)
  );
  list.innerHTML = '';
  if (!items.length) {
    list.innerHTML =
      '<p class="mini muted">Nothing has been missed yet. Sit a practice exam, or answer something the model is unsure of, and it appears here the next day.</p>';
    return;
  }
  for (const item of items.slice(0, 12)) {
    const row = document.createElement('div');
    row.className = 'mini';
    row.innerHTML = `<strong>${escapeHtml(String(item.prompt).slice(0, 140))}</strong><br><span class="muted">${escapeHtml(item.note || item.source)} - ${reviewWhen(Number(item.due), now)}</span>`;
    list.appendChild(row);
  }
}

function renderReviewCard() {
  const stage = $('reviewStage');
  if (!stage || !reviewRun) return;
  if (reviewRun.index >= reviewRun.queue.length) {
    const counts = reviewStats(loadReview(reviewCourseId()), Date.now());
    stage.innerHTML = `<div class="card">
        <h3>Done for today</h3>
        <p class="mini">${reviewRun.right} of ${reviewRun.queue.length} came back to you without the answer. ${
          counts.due ? `${counts.due} still due.` : 'Nothing else is due.'
        } Streak ${counts.streak} day${counts.streak === 1 ? '' : 's'}.</p>
      </div>`;
    reviewRun = null;
    $('btnReviewStart').textContent = 'Start';
    renderReview();
    return;
  }
  const item = loadReview(reviewCourseId()).items[reviewRun.queue[reviewRun.index]];
  if (!item) {
    reviewRun.index += 1;
    renderReviewCard();
    return;
  }
  stage.innerHTML = `<div class="card">
      <div class="card-head">
        <h2 class="card-title">${escapeHtml(String(item.prompt).slice(0, 200))}</h2>
        <span class="mini muted">${reviewRun.index + 1} of ${reviewRun.queue.length}</span>
      </div>
      <p class="mini muted">${escapeHtml(item.note || 'from your own record')}</p>
      ${
        reviewRun.revealed
          ? `<p class="mini">${escapeHtml(item.answer)}</p>
      <div class="actions">
        <button class="btn primary" data-review="yes">I had it</button>
        <button class="btn ghost" data-review="no">Not yet</button>
      </div>`
          : '<div class="actions"><button class="btn" data-review="reveal">Show what was missed</button></div>'
      }
    </div>`;
}

function startReview() {
  const review = refreshReview();
  const queue = reviewSession(review, Date.now(), 12).map((item) => item.key);
  if (!queue.length) {
    const counts = reviewStats(review, Date.now());
    $('reviewStage').innerHTML = `<p class="mini muted">Nothing is due.${
      counts.nextDue ? ` The next question comes back ${reviewWhen(counts.nextDue, Date.now())}.` : ''
    }</p>`;
    renderReview();
    return;
  }
  reviewRun = { queue, index: 0, revealed: false, right: 0 };
  $('btnReviewStart').textContent = 'Stop';
  renderReview();
  renderReviewCard();
}

function gradeReview(correct) {
  if (!reviewRun) return;
  const key = reviewRun.queue[reviewRun.index];
  saveReview(reviewCourseId(), reviewGrade(loadReview(reviewCourseId()), key, correct, Date.now()));
  if (correct) reviewRun.right += 1;
  reviewRun.index += 1;
  reviewRun.revealed = false;
  renderReviewCard();
  renderReview();
}

/* handoff: a session in progress, on the server */
const DEVICE_KEY = 'sage.device.v1';
const handoff = { state: 'idle', record: null, lastPush: 0, pushTimer: null, dismissed: '' };

function deviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = 'd' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return 'device';
  }
}

function deviceLabel() {
  const ua = navigator.userAgent || '';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  return 'this browser';
}

function capturingNow() {
  return ['btnListen', 'btnScreen', 'btnCamera'].some((id) => $(id) && $(id).classList.contains('on'));
}

function liveHeaders() {
  const headers = { 'content-type': 'application/json' };
  if (state.settings.accessCode) headers['x-access-code'] = state.settings.accessCode;
  return headers;
}

function liveSnapshot() {
  return {
    device: deviceId(),
    label: deviceLabel(),
    courseId: state.activeId || '',
    courseName: (state.persona && state.persona.course) || '',
    capturing: capturingNow(),
    notes: (state.session.notes || []).slice(-30).map((note) => ({
      text: String(note.text || '').slice(0, 1200),
      at: String(note.at || ''),
      kind: String(note.kind || 'note'),
    })),
    at: new Date().toISOString(),
  };
}

async function pushLiveSession() {
  if (handoff.state === 'local') return;
  handoff.lastPush = Date.now();
  try {
    const res = await fetch(apiUrl('/api/live'), {
      method: 'PUT',
      headers: liveHeaders(),
      body: JSON.stringify({ session: liveSnapshot() }),
    });
    if (res.status === 401 || res.status === 501) {
      // No identity, or no filesystem: the session stays on this device and the
      // banner simply never appears. That is the local-only case, not an error.
      handoff.state = 'local';
      return;
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 409 && data.session) {
      handoff.record = data.session;
      handoff.state = 'live';
      renderHandoff();
      return;
    }
    if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
    handoff.state = 'live';
    handoff.record = data.session || liveSnapshot();
  } catch {
    handoff.state = 'error';
  }
}

function queueLivePush() {
  clearTimeout(handoff.pushTimer);
  handoff.pushTimer = setTimeout(pushLiveSession, 1500);
}

async function pollLiveSession() {
  if (handoff.state === 'local') return;
  try {
    const res = await fetch(apiUrl('/api/live'), { headers: liveHeaders() });
    if (res.status === 401 || res.status === 501) {
      handoff.state = 'local';
      renderHandoff();
      return;
    }
    const data = await res.json().catch(() => ({}));
    const record = data.session || null;
    handoff.record = record;
    handoff.state = 'live';
    // One microphone: if another device holds it, this one lets go rather than
    // recording the same lecture twice into two places.
    if (captureConflict(record, deviceId()) && capturingNow()) {
      $('btnStopAll')?.click();
      toast(`Capture moved to ${record.label || 'another device'} - it stopped here.`);
      renderHandoff();
      return;
    }
    renderHandoff();
  } catch {
    handoff.state = 'error';
  }
}

function renderHandoff() {
  const bar = $('handoffBar');
  const text = $('handoffText');
  const take = $('btnHandoffTake');
  if (!bar || !text || !take) return;
  const record = handoff.record;
  const me = deviceId();
  if (record && shouldOffer(record, me) && record.device !== handoff.dismissed) {
    const line = describe(record, state.session.notes || []);
    text.textContent = line.text;
    take.textContent = line.adopt
      ? `Continue here (${line.adopt} note${line.adopt === 1 ? '' : 's'})`
      : 'Continue here';
    bar.hidden = false;
    return;
  }
  if (record && record.device !== me && isLiveSession(record) && record.capturing) {
    text.textContent = `${record.label || 'Another device'} is capturing this lecture now. Sage will not open the microphone here until it stops.`;
    take.textContent = 'Not now';
    bar.hidden = false;
    return;
  }
  bar.hidden = true;
}

function takeHandoff() {
  const record = handoff.record;
  if (!record || record.device === deviceId()) {
    handoff.dismissed = record ? record.device : '';
    $('handoffBar').hidden = true;
    return;
  }
  const incoming = notesToAdopt(state.session.notes || [], record);
  handoff.dismissed = record.device;
  $('handoffBar').hidden = true;
  if (!incoming.length) return;
  // Nothing is thrown away: both sets of notes are kept, deduplicated by what
  // they say, oldest first.
  state.session.notes = mergeNotes(state.session.notes || [], record.notes);
  persist();
  if (typeof hydrateFeeds === 'function') hydrateFeeds();
  toast(`${incoming.length} note${incoming.length === 1 ? '' : 's'} carried over from ${record.label || 'the other device'}.`);
}

/* ── the reader: the lecture, as a document ─────────────────── */

const READER_KINDS = { outline: 'Outline', definition: 'Definition', example: 'Worked example', hint: 'Exam hint' };
let readerDoc = null;

function readerCourse() {
  return {
    id: state.activeId || 'general',
    name: state.persona?.course || 'This course',
    foundation: (state.foundation || [])
      .filter((doc) => doc.on !== false)
      .map((doc) => ({ name: doc.name, segments: doc.segments || [] })),
    session: state.session,
  };
}

async function renderReader() {
  const body = $('readerBody');
  const meta = $('readerMeta');
  if (!body) return;
  body.innerHTML = '<p class="mini muted">Assembling the reader…</p>';
  try {
    const res = await api('/api/reader', { body: { course: readerCourse(), edits: state.readerEdits || [] } });
    readerDoc = res;
    drawReader(meta, body, res);
  } catch (error) {
    body.innerHTML = `<p class="mini">The reader could not be assembled: ${escapeHtml(error.message)}</p>`;
    if (meta) meta.textContent = '';
  }
}

function readerBlock(blockId) {
  for (const section of readerDoc?.sections || []) {
    const found = section.blocks.find((block) => block.id === blockId);
    if (found) return found;
  }
  return null;
}

function readerNode(blockId) {
  return [...document.querySelectorAll('.reader-block')].find((node) => node.dataset.block === blockId) || null;
}

function anchorChip(anchor) {
  if (anchor.kind === 'page') {
    return `<button type="button" class="cite-chip" data-cite="${escapeHtml(anchor.doc)}" data-locator="${escapeHtml(anchor.locator)}">${escapeHtml(anchor.doc)} · ${escapeHtml(anchor.locator)}</button>`;
  }
  if (anchor.kind === 'moment') {
    return `<button type="button" class="cite-chip" data-moment="${Number(anchor.at) || 0}" data-clock="${escapeHtml(anchor.clock)}">lecture ${escapeHtml(anchor.clock)}</button>`;
  }
  return `<span class="reader-anchor">note · ${escapeHtml(anchor.label || '')}</span>`;
}

function drawReader(meta, body, doc) {
  const counts = doc.counts || {};
  if (meta) {
    meta.textContent = doc.sections.length
      ? `${counts.blocks} block${counts.blocks === 1 ? '' : 's'} · ${counts.definition} definition${counts.definition === 1 ? '' : 's'} · ${counts.example} worked example${counts.example === 1 ? '' : 's'} · ${counts.hint} exam hint${counts.hint === 1 ? '' : 's'}${counts.edited ? ` · ${counts.edited} edited` : ''}`
      : '';
  }
  if (!doc.sections.length) {
    body.innerHTML = `<p class="empty">${escapeHtml(doc.note || 'Nothing captured yet.')}</p>
      <p><button type="button" class="mini" data-reader-example="1">see an example</button></p>`;
    return;
  }
  body.innerHTML = doc.sections
    .map(
      (section) => `<article class="reader-sec">
        <h3>${escapeHtml(section.title)}${section.captured ? ` <span class="mini muted">${escapeHtml(section.captured)}</span>` : ''}</h3>
        ${section.blocks
          .map(
            (block) => `<div class="reader-block" data-block="${escapeHtml(block.id)}">
              <span class="reader-kind">${escapeHtml(READER_KINDS[block.kind] || 'Outline')}</span>
              ${block.edited ? '<span class="readonly-badge">edited</span>' : ''}
              <p class="reader-text" dir="auto">${escapeHtml(block.edited ? block.edited.text : block.text)}</p>
              <div class="reader-anchors">${block.anchors.map(anchorChip).join(' ')}</div>
              <div class="reader-tools">
                <button type="button" class="mini" data-reader-edit="${escapeHtml(block.id)}">edit</button>
                ${block.edited ? `<button type="button" class="mini" data-reader-reset="${escapeHtml(block.id)}">undo</button>` : ''}
              </div>
            </div>`
          )
          .join('')}
      </article>`
    )
    .join('');
}

function beginReaderEdit(blockId) {
  const node = readerNode(blockId);
  const block = readerBlock(blockId);
  if (!node || !block) return;
  const text = block.edited ? block.edited.text : block.text;
  node.querySelector('.reader-text').outerHTML = `<textarea class="reader-edit" rows="3" dir="auto" aria-label="Edit this block">${escapeHtml(text)}</textarea>`;
  node.querySelector('.reader-tools').innerHTML = `<button type="button" class="mini" data-reader-save="${escapeHtml(blockId)}">save</button><button type="button" class="mini" data-reader-cancel="${escapeHtml(blockId)}">cancel</button>`;
  node.querySelector('.reader-edit')?.focus();
}

/* An example, so the feature can be seen before a lecture has been captured. It is
   drawn from nothing and saved nowhere: the reader of a real course comes from its
   own notes. */
function readerExample() {
  return {
    courseId: 'example',
    course: 'Example lecture',
    builtAt: '',
    note: '',
    counts: { sections: 1, blocks: 4, outline: 1, definition: 1, example: 1, hint: 1, pages: 1, moments: 1, notes: 1, edited: 0 },
    sections: [
      {
        id: 'example-lecture-1',
        title: 'Lecture 1',
        captured: 'example',
        blocks: [
          {
            id: 'r:example:0',
            kind: 'definition',
            text: 'Osmosis is defined as the movement of water across a semi-permeable membrane, from the dilute side to the concentrated side.',
            edited: null,
            anchors: [{ kind: 'page', doc: 'week-3.pdf', locator: 'p.4' }],
          },
          {
            id: 'r:example:1',
            kind: 'outline',
            text: 'Water potential decides the direction: pure water has the highest potential, so it moves towards the solute.',
            edited: null,
            anchors: [{ kind: 'moment', clock: '12:30', at: 750 }],
          },
          {
            id: 'r:example:2',
            kind: 'example',
            text: 'For example, a red blood cell in pure water takes in water until it bursts; in salt water it shrivels.',
            edited: null,
            anchors: [{ kind: 'page', doc: 'week-3.pdf', locator: 'p.5' }],
          },
          {
            id: 'r:example:3',
            kind: 'hint',
            text: 'EXAM: they almost always ask for the direction of flow and the reason, not the definition.',
            edited: null,
            anchors: [{ kind: 'note', at: 0, label: 'example' }],
          },
        ],
      },
    ],
  };
}

function showReaderExample() {
  const body = $('readerBody');
  if (!body) return;
  drawReader($('readerMeta'), body, readerExample());
  const answer = $('readerAnswer');
  if (answer) answer.innerHTML = '<p class="mini muted">An example, drawn from nothing of yours. Start Live and your own lecture replaces it.</p>';
}

async function askReader() {
  const field = $('readerAsk');
  const out = $('readerAnswer');
  if (!out) return;
  const question = String(field?.value || '').trim();
  if (!question) {
    field?.focus();
    return;
  }
  out.innerHTML = '<p class="mini muted">Looking through the reader…</p>';
  try {
    const res = await api('/api/reader', { body: { course: readerCourse(), edits: state.readerEdits || [], question } });
    readerDoc = res;
    drawReader($('readerMeta'), $('readerBody'), res);
    const found = res.question || { matches: [], spans: false };
    if (!found.matches.length) {
      out.innerHTML = '<p class="mini">Nothing captured answers that yet.</p>';
      return;
    }
    const label = found.spans
      ? `This spans ${found.matches.map((match) => match.title).join(' and ')}.`
      : `${found.matches[0].title} answers this.`;
    out.innerHTML = `<p class="mini">${escapeHtml(label)}</p>${found.matches
      .map(
        (match) => `<div class="reader-hit"><strong>${escapeHtml(match.title)}</strong> <span class="mini muted">${escapeHtml(
          match.hits.join(', ')
        )}</span> ${match.anchors.map(anchorChip).join(' ')}</div>`
      )
      .join('')}`;
  } catch (error) {
    out.innerHTML = `<p class="mini">${escapeHtml(error.message)}</p>`;
  }
}

/* The first-run card asks for a code as well as offering a purchase: someone handed a
   session should not have to find Settings before the app will answer a question. */
async function redeemSetupCode() {
  const field = $('setupCode');
  const out = $('setupCodeStatus');
  const code = String(field?.value || '').trim();
  if (!code) {
    field?.focus();
    return;
  }
  if (out) out.textContent = 'Checking the code…';
  try {
    const res = await api('/api/iap/grant', { body: { code } });
    const applied = await applySessionKey(res, {});
    if (out) {
      out.textContent = applied?.ok === false
        ? applied.message
        : `Session installed — ${Number(res.minutes) || 0} minutes.`;
    }
    if (applied?.ok !== false && field) field.value = '';
  } catch (error) {
    if (out) out.textContent = '';
    toast(`That code was not accepted: ${error.message}`, 'error');
  }
}

/* A session without the App Store: an operator's signed code, redeemed here, which
   mints a real session through the same route a purchase uses. */
async function redeemGrantCode() {
  const field = $('setGrantCode');
  const out = $('buyStatus');
  const code = String(field?.value || '').trim();
  if (!code) {
    field?.focus();
    return;
  }
  if (out) out.textContent = 'Checking the code…';
  try {
    const res = await api('/api/iap/grant', { body: { code } });
    await applySessionKey(res, {});
    if (out) out.textContent = `Session installed — ${Number(res.minutes) || 0} minutes.`;
    if (field) field.value = '';
    saveSettings();
  } catch (error) {
    if (out) out.textContent = '';
    toast(`That code was not accepted: ${error.message}`, 'error');
  }
}

function saveReaderEdit(blockId) {
  const node = readerNode(blockId);
  const text = String(node?.querySelector('.reader-edit')?.value || '').trim();
  if (!text) {
    toast('An edit cannot be empty — undo the block instead.', 'error');
    return;
  }
  state.readerEdits = (state.readerEdits || []).filter((edit) => edit.blockId !== blockId);
  state.readerEdits.push({ blockId, text, at: Date.now() });
  persist();
  renderReader();
}

function resetReaderEdit(blockId) {
  state.readerEdits = (state.readerEdits || []).filter((edit) => edit.blockId !== blockId);
  persist();
  renderReader();
}

/* A moment plays from the recording held on this device, if this is the device that
   made it. The anchor is kept either way: the reader never pretends to have audio. */
function playMoment(seconds, clock) {
  const chunk = [...(cap.audioChunks || [])].reverse().find((item) => item.start <= seconds);
  if (!chunk) {
    toast(`Lecture ${clock} — that recording is on the device that made it, so this one cannot play it.`, 'error');
    return;
  }
  const audio = new Audio(chunk.url);
  audio.currentTime = Math.max(0, seconds - chunk.start);
  audio.play().then(() => toast(`Playing from ${clock}.`)).catch(() => toast('The recording could not be played.', 'error'));
}

document.addEventListener('click', (event) => {
  const target = event.target.closest?.('[data-reader-edit], [data-reader-save], [data-reader-cancel], [data-reader-reset], [data-moment], [data-reader-example]');
  if (!target) return;
  const data = target.dataset;
  if (data.readerEdit) beginReaderEdit(data.readerEdit);
  else if (data.readerSave) saveReaderEdit(data.readerSave);
  else if (data.readerCancel) renderReader();
  else if (data.readerReset) resetReaderEdit(data.readerReset);
  else if (data.moment) playMoment(Number(data.moment) || 0, data.clock || '');
  else if (data.readerExample) showReaderExample();
});

/* ── wiring ────────────────────────────────────────────────── */
function bind() {
  applyDirection();
  $('tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('.tab');
    if (!tab) return;
    document.querySelectorAll('.tab').forEach((t) => {
      t.classList.toggle('active', t === tab);
      t.setAttribute('aria-selected', String(t === tab));
    });
    document.querySelectorAll('.panel').forEach((panel) => {
      panel.classList.toggle('active', panel.id === `tab-${tab.dataset.tab}`);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
    state.ui = { ...(state.ui || {}), tab: tab.dataset.tab };
    persist();
  });

  $('btnPaperStart').onclick = startPaper;
  $('btnPaperSubmit').onclick = () => submitPaper(false);

  $('btnSettings').onclick = openSettings;
  $('btnRetryHealth').onclick = checkHealth;
  $('btnSetupBuy').onclick = buyFromSetup;
  $('btnSaveSettings').onclick = () => setTimeout(saveSettings, 0);
  $('btnTestConn').onclick = testConnection;
  $('btnVerifyKey').onclick = async () => {
    await saveGatewayKey();
    syncKeyReset();
  };
  $('btnResetKey').onclick = resetSavedKey;
  $('nav-review')?.addEventListener('click', renderReview);
  $('nav-reader')?.addEventListener('click', renderReader);

  // Two shortcuts, one keystroke each: 7 opens the reader — the tab where the material
  // turns into something readable — and R opens Review, the queue of what is due. A
  // field or an open dialog keeps the keystroke: typing either is not a command.
  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    const tag = String(target?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable) return;
    if (document.querySelector('dialog[open]')) return;
    const key = String(event.key || '').toLowerCase();
    if (key === '7') {
      event.preventDefault();
      openTab('reader');
      renderReader();
      // The address is how a tab is remembered across a reload, so opening one from the
      // keyboard has to say so there too, not just in the panel.
      if (location.hash !== '#reader') history.replaceState(null, '', '#reader');
      toast('Reader — sections, definitions and the lecture moment each one came from.');
      return;
    }
    // R is the reader, which is the key the hand goes to for it; Review moves to V,
    // where the letter is still the first thing in the word and nothing else wants it.
    if (key === 'r') {
      event.preventDefault();
      openTab('reader');
      renderReader();
      if (location.hash !== '#reader') history.replaceState(null, '', '#reader');
      toast('Reader — sections, definitions and the lecture moment each one came from.');
      return;
    }
    if (key === 'v') {
      event.preventDefault();
      openTab('review');
      renderReview();
      if (location.hash !== '#review') history.replaceState(null, '', '#review');
      toast('Review — what is due, and what you have already answered.');
    }
  });
  $('btnReaderBuild').onclick = renderReader;
  $('btnRenameCourse').onclick = renameCourse;
  $('btnRedeemGrant').onclick = redeemGrantCode;
  $('btnSetupCode').onclick = redeemSetupCode;
  $('setupCode')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      redeemSetupCode();
    }
  });
  $('btnListenMode').onclick = () =>
    setListenMode(cap.listenMode === 'lecture' ? 'audiobook' : 'lecture');
  $('btnStudyWatch')?.addEventListener('click', () => chooseStudyWatch('screen'));
  $('btnStudyCamera')?.addEventListener('click', () => chooseStudyWatch('camera'));
  $('btnListenRetry').onclick = () => {
    cap.listenWait = false;
    stopListening();
    setTimeout(() => startListening(), 200);
  };

  // iOS and Android both freeze a page the moment another app is in front, and a
  // capture that died while hidden must come back without the person hunting for
  // the button again: on return, restart the recorder, or say the source is gone.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !cap.listenOn) return;
    if (!cap.deviceStream) return;
    const live = (cap.deviceStream.getAudioTracks?.() || []).filter((track) => track.readyState === 'live');
    if (live.length) {
      // The track survived the background trip, or came back with one: adopt it
      // without asking, which is what makes leaving the app harmless.
      if (cap.sourceLost) adoptDeviceAudio(live);
      else if (cap.recorder?.state !== 'recording') startRecorder();
      return;
    }
    markSourceLost();
  });
  setListenMode(cap.listenMode, { quiet: true });
  $('courseRename')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      renameCourse();
    }
  });
  $('btnReaderAsk').onclick = askReader;
  $('readerAsk')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      askReader();
    }
  });
  $('btnReviewStart').onclick = () => {
    if (reviewRun) {
      reviewRun = null;
      $('btnReviewStart').textContent = 'Start';
      $('reviewStage').innerHTML = '<p class="mini muted">Stopped. What you answered is already rescheduled.</p>';
      renderReview();
      return;
    }
    startReview();
  };
  $('btnReviewBuild').onclick = () => {
    const before = Object.keys(loadReview(reviewCourseId()).items).length;
    const review = refreshReview();
    renderReview();
    const added = Object.keys(review.items).length - before;
    toast(added ? `${added} question${added === 1 ? '' : 's'} added to the queue.` : 'The queue already holds everything marked so far.');
  };
  $('reviewStage')?.addEventListener('click', (event) => {
    const action = event.target.closest?.('[data-review]')?.dataset.review;
    if (!action || !reviewRun) return;
    if (action === 'reveal') {
      reviewRun.revealed = true;
      renderReviewCard();
      return;
    }
    gradeReview(action === 'yes');
  });
  $('btnHandoffTake')?.addEventListener('click', takeHandoff);
  $('btnHandoffDismiss')?.addEventListener('click', () => {
    handoff.dismissed = handoff.record ? handoff.record.device : '';
    $('handoffBar').hidden = true;
  });
  // A heartbeat while a microphone is open, and a poll for what the other device
  // is doing. Neither runs in a hidden tab: a background page cannot record, so
  // it has nothing to say about the session.
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (capturingNow() && Date.now() - handoff.lastPush > 6000) pushLiveSession();
  }, 8000);
  setInterval(() => {
    if (document.visibilityState === 'visible') pollLiveSession();
  }, 12000);
  setTimeout(() => pollLiveSession(), 2500);
  $('searchBox')?.addEventListener('input', renderSearch);
  $('searchResults')?.addEventListener('click', (event) => {
    const row = event.target.closest?.('[data-index]');
    if (row) openSearchHit(searchHits[Number(row.dataset.index)]);
  });
  $('btnMicCheck').onclick = micCheck;
  $('btnBuy').onclick = () => (store.iap && NATIVE_STORE ? buyWithApple(chosenPlan()) : startPurchase());
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
  $('btnClearQuizFiles').onclick = clearQuizFiles;

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

  $('essayFiles').onchange = onEssayFiles;
  $('btnGatherUnderstand').onclick = () => renderUnderstanding({ force: true });
  $('essayUnderstand').addEventListener('input', () => {
    understandEdited = true;
    updateUnderstandCount();
  });
  // Opening the tab gathers the course into an empty field, so the base is
  // there before the first word of the brief.
  $('nav-essay').addEventListener('click', () => renderUnderstanding());
  $('btnClearEssayFiles').onclick = clearEssayFiles;
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

  $('foundationFiles').onchange = onFoundationFiles;
  $('btnFoundationClear').onclick = clearFoundation;
  $('foundationList').addEventListener('click', (event) => {
    const drop = event.target.dataset?.drop;
    if (!drop) return;
    state.foundation = (state.foundation || []).filter((doc) => doc.id !== drop);
    persist();
    renderFoundation();
  });
  $('foundationList').addEventListener('change', (event) => {
    const id = event.target.dataset?.doc;
    if (!id) return;
    state.foundation = (state.foundation || []).map((doc) => (doc.id === id ? { ...doc, on: event.target.checked } : doc));
    persist();
    renderFoundation();
  });
  renderFoundation();

  window.addEventListener('online', () => {
    if (queued(state.pending).length) toast('Back online — replaying what was kept.');
    flushPending();
  });
  if ($('netRetry')) $('netRetry').addEventListener('click', () => flushPending());
  if (queued(state.pending).length) flushPending();

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
  if ($('btnNameCourse')) $('btnNameCourse').onclick = nameCourse;
  if ($('nameCourseInput')) {
    $('nameCourseInput').onkeydown = (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        nameCourse();
      }
    };
  }
  $('btnDeleteCourse').onclick = removeCourse;
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

/* ── profile bridge ──────────────────────────────────────────────
   The profile sheet lives in the shell, but the persona belongs to this
   module's state. Hydrating, saving and counting traits through these calls
   keeps one copy of the truth: no second name field to go stale, and the same
   saveSettings() path the Settings dialog has always used. */
window.sageProfile = {
  hydrate() {
    const p = state.persona;
    $('setName').value = p.name;
    $('setCourse').value = p.course;
    $('setTone').value = p.tone;
    $('setDepth').value = p.depth;
    $('setHumour').value = String(p.humour);
    $('setRisk').value = String(p.risk);
    $('setLanguage').value = state.language;
    $('setInterval').value = String(state.settings.noteIntervalSec);
    $('setAutoNotes').checked = state.settings.autoNotes;
    $('setTts').checked = state.settings.tts;
  },
  save: () => saveSettings(),
  traits: () => (Array.isArray(state.persona.traits) ? state.persona.traits.length : 0),
};
