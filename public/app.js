/* Sage — course-taking agent client.
   Capture (mic / screen / camera / files), reasoning, and a memory that persists. */

const $ = (id) => document.getElementById(id);
const LS_KEY = 'sage.course-agent.v1';

/* ── state ─────────────────────────────────────────────────── */
const defaultState = () => ({
  persona: { name: 'Sage', course: '', tone: 'warm', depth: 'balanced', humour: 3, risk: 2, traits: [] },
  language: '',
  settings: { tts: true, autoNotes: true, noteIntervalSec: 20, snapSec: 6, accessCode: '' },
  memory: [],
  evolution: [],
  session: { transcript: [], notes: [] },
});

let state = defaultState();
let health = null;

function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    state = {
      ...defaultState(),
      ...saved,
      persona: { ...defaultState().persona, ...(saved.persona || {}) },
      settings: { ...defaultState().settings, ...(saved.settings || {}) },
      session: { transcript: [], notes: [], ...(saved.session || {}) },
      memory: Array.isArray(saved.memory) ? saved.memory : [],
      evolution: Array.isArray(saved.evolution) ? saved.evolution : [],
    };
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
      localStorage.setItem(LS_KEY, JSON.stringify(state));
    } catch {
      /* storage full — keep running */
    }
  }, 250);
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
  let body;
  if (options.form) body = options.form;
  else if (options.body) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  let res;
  try {
    res = await fetch(path, { method: options.method || (body ? 'POST' : 'GET'), headers, body });
  } catch (error) {
    throw new Error(`Cannot reach the agent server (${error.message}).`);
  }
  const data = await res.json().catch(() => ({ error: 'bad_response', message: `HTTP ${res.status}` }));
  if (!res.ok) {
    if (res.status === 401) {
      toast('Access code needed. Set it in Settings.', 'error');
      openSettings();
    }
    throw new Error(data.message || `HTTP ${res.status}`);
  }
  return data;
}

function recentContext() {
  return state.session.transcript.slice(-4).map((t) => t.text);
}

async function agent(mode, { text = '', images = [], maxTokens } = {}) {
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
    $('modelTag').textContent = ok ? health.chatModel : 'no key';
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
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      toast('Microphone permission denied.', 'error');
      stopListening();
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
      toast('This gateway key cannot transcribe audio server-side. Relying on the browser’s on-device speech recognition.', 'error');
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
    toast(`Microphone blocked: ${error.message}`, 'error');
    return;
  }
  cap.listenOn = true;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SR) startRecognition(SR);
  else if (transcribeBlocked) {
    toast('No on-device speech recognition in this browser, and this gateway key cannot transcribe. Try Chrome on Android or a desktop browser.', 'error');
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
  if (!navigator.mediaDevices?.getDisplayMedia) {
    toast('This browser cannot capture the screen. iPhone: record with Control Center, then upload the video in Read.', 'error');
    return;
  }
  try {
    cap.screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 2 },
      audio: false,
    });
  } catch (error) {
    if (error.name !== 'NotAllowedError') toast(`Screen capture failed: ${error.message}`, 'error');
    return;
  }
  cap.watchOn = true;
  attachVideo(cap.screenStream, 'screen');
  startSnapLoop();
  updateStatus();
  toast('Watching the shared screen.');
}

function stopWatch() {
  cap.watchOn = false;
  cap.screenStream?.getTracks().forEach((t) => t.stop());
  cap.screenStream = null;
  cap.screenVideo = null;
  if (!cap.cameraOn) stopSnapLoop();
  updateStatus();
}

async function toggleCamera() {
  if (cap.cameraOn) return stopCamera();
  try {
    cap.cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 } },
      audio: false,
    });
  } catch (error) {
    toast(`Camera blocked: ${error.message}`, 'error');
    return;
  }
  cap.cameraOn = true;
  attachVideo(cap.cameraStream, 'camera');
  startSnapLoop();
  updateStatus();
  toast('Camera on — aim it at the board or TV.');
}

function stopCamera() {
  cap.cameraOn = false;
  cap.cameraStream?.getTracks().forEach((t) => t.stop());
  cap.cameraStream = null;
  cap.cameraVideo = null;
  if (!cap.watchOn) stopSnapLoop();
  updateStatus();
}

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
  if (state.settings.autoNotes && Date.now() - cap.lastAnalyse > 16000) {
    cap.lastAnalyse = Date.now();
    analyseFrame(data);
  }
  updateStatus();
}

async function analyseFrame(frame) {
  try {
    const res = await agent('note', {
      text: 'Frame captured from a live class or the user’s screen. Note only what matters academically; mark exam hints with EXAM:.',
      images: [frame],
    });
    if (res.reply && res.reply.toLowerCase() !== 'nothing new') addNote(res.reply, 'frame');
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

function exportMemory() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `sage-memory-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 2000);
}

/* ── speech ────────────────────────────────────────────────── */
let voices = [];
function loadVoices() {
  voices = window.speechSynthesis?.getVoices?.() || [];
}
function speak(text) {
  if (!text) return;
  if (!('speechSynthesis' in window)) {
    toast('This browser has no speech output.', 'error');
    return;
  }
  const clean = String(text)
    .replace(/\*\*|__|\*|_|`|#/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return;
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
function renderAnswer(res, container) {
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
    renderAnswer(res, $('liveAnswer'));
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
    div.innerHTML = `<img src="${item.preview}" alt="" /><span data-remove="${index}">✕</span>`;
    container.appendChild(div);
  });
  container.onclick = (event) => {
    const index = event.target.dataset?.remove;
    if (index === undefined) return;
    items.splice(Number(index), 1);
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
async function onAnswerFiles(event) {
  const files = [...event.target.files];
  for (const file of files.slice(0, 4)) {
    const preview = await shrinkImage(file, 1100);
    answerFiles.push({ preview });
  }
  renderThumbs($('answerThumbs'), answerFiles);
  $('answerFileCount').textContent = answerFiles.length ? `${answerFiles.length} attached` : '';
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
    renderAnswer(res, $('answerResult'));
  } catch (error) {
    toast(`Answer failed: ${error.message}`, 'error');
  } finally {
    busy(button, false);
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
    $('readResult').hidden = false;
    $('readResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    toast(`Read failed: ${error.message}`, 'error');
  } finally {
    busy(button, false);
  }
}

/* ── settings ──────────────────────────────────────────────── */
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
  $('settingsDialog').showModal();
}

function saveSettings() {
  state.persona.name = $('setName').value.trim().slice(0, 30) || 'Sage';
  state.persona.course = $('setCourse').value.trim().slice(0, 120);
  state.persona.tone = $('setTone').value;
  state.persona.depth = $('setDepth').value;
  state.persona.humour = Number($('setHumour').value);
  state.persona.risk = Number($('setRisk').value);
  state.language = $('setLanguage').value.trim().slice(0, 40);
  state.settings.noteIntervalSec = Math.max(8, Math.min(120, Number($('setInterval').value) || 20));
  state.settings.accessCode = $('setAccess').value.trim();
  state.settings.autoNotes = $('setAutoNotes').checked;
  state.settings.tts = $('setTts').checked;
  clearInterval(cap.noteTimer);
  cap.noteTimer = cap.listenOn ? setInterval(flushTranscript, state.settings.noteIntervalSec * 1000) : null;
  $('agentName').textContent = state.persona.name;
  persist();
  updateStatus();
  renderMemory();
  toast('Saved.');
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
  });

  $('btnSettings').onclick = openSettings;
  $('btnRetryHealth').onclick = checkHealth;
  $('btnSaveSettings').onclick = () => setTimeout(saveSettings, 0);
  $('btnTestConn').onclick = testConnection;

  $('btnListen').onclick = startListening;
  $('btnScreen').onclick = toggleWatch;
  $('btnCamera').onclick = toggleCamera;
  $('btnStopAll').onclick = () => {
    stopListening();
    stopWatch();
    stopCamera();
    showInterim('');
    toast('All capture stopped.');
  };

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
$('ttsToggle').checked = state.settings.tts;
renderMemory();
hydrateFeeds();
updateStatus();
checkHealth();
loadVoices();
if ('speechSynthesis' in window) window.speechSynthesis.onvoiceschanged = loadVoices;

if ('serviceWorker' in navigator) {
  // Only register when served over a secure context, and never cache the API.
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
