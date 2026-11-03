/* Sage shell — the platform layer.
   Navigation, command palette, theme, keyboard shortcuts and connection state.
   app.js owns capture and reasoning; this file owns the frame around it, so the
   two never fight over the same element. */

const $ = (id) => document.getElementById(id);
const SHELL_KEY = 'sage.shell.v1';
const TABS = [
  { id: 'live', label: 'Live' },
  { id: 'answer', label: 'Answer' },
  { id: 'quiz', label: 'Quiz' },
  { id: 'exam', label: 'Practice Exam' },
  { id: 'essay', label: 'Essay' },
  { id: 'read', label: 'Read' },
  { id: 'foundation', label: 'Foundation' },
  { id: 'memory', label: 'Memory' },
  { id: 'search', label: 'Search' },
  { id: 'review', label: 'Review' },
];
const THEME_ICON = { auto: '◐', dark: '☾', light: '☀' };

const shell = (() => {
  try {
    return { theme: 'auto', ...(JSON.parse(localStorage.getItem(SHELL_KEY) || '{}') || {}) };
  } catch {
    return { theme: 'auto' };
  }
})();

function saveShell() {
  try {
    localStorage.setItem(SHELL_KEY, JSON.stringify(shell));
  } catch {
    /* private mode: the choice just does not persist */
  }
}

/* ── theme ─────────────────────────────────────────────────────── */
function resolvedTheme() {
  if (shell.theme === 'auto') {
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return shell.theme;
}

function applyTheme() {
  const theme = resolvedTheme();
  document.documentElement.dataset.theme = theme;
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.remove();
  const meta = document.createElement('meta');
  meta.name = 'theme-color';
  meta.content = theme === 'dark' ? '#080b12' : '#f6f7fb';
  document.head.append(meta);
  const button = $('btnTheme');
  if (button) {
    button.textContent = THEME_ICON[shell.theme] || '◐';
    button.setAttribute('aria-label', `Theme: ${shell.theme}. Switch theme`);
    button.title = `Theme: ${shell.theme}`;
  }
}

function cycleTheme() {
  // Every click has to change something: leaving "auto" goes to the colour the
  // user is *not* looking at, rather than to a fixed next state that may match.
  if (shell.theme === 'auto') shell.theme = resolvedTheme() === 'dark' ? 'light' : 'dark';
  else if (shell.theme === 'dark') shell.theme = 'light';
  else shell.theme = 'auto';
  saveShell();
  applyTheme();
  notify(`Theme: ${shell.theme}`);
}

/* ── tab navigation ────────────────────────────────────────────── */
function activeTabButton() {
  return document.querySelector('.tab.active') || document.querySelector('.tab');
}

function syncTabUi() {
  const active = activeTabButton();
  if (!active) return;
  const name = active.dataset.tab;
  for (const tab of document.querySelectorAll('.tab')) {
    const on = tab === active;
    tab.classList.toggle('active', on);
    tab.setAttribute('aria-selected', String(on));
  }
  const crumb = $('crumbHere');
  if (crumb) crumb.textContent = TABS.find((t) => t.id === name)?.label || name;
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
}

function openTab(name) {
  const button = document.querySelector(`.tab[data-tab="${name}"]`);
  if (!button) return;
  if (button.classList.contains('active')) {
    syncTabUi();
  } else {
    button.click();
  }
  closeDrawer();
  const panel = document.getElementById(`tab-${name}`);
  panel?.focus({ preventScroll: true });
}

/* ── mobile drawer ─────────────────────────────────────────────── */
function setDrawer(open) {
  document.body.classList.toggle('nav-open', open);
  $('scrim')?.toggleAttribute('hidden', !open);
  $('btnSidebar')?.setAttribute('aria-expanded', String(open));
  if (open) document.querySelector('.tab')?.focus({ preventScroll: true });
}

function closeDrawer() {
  if (document.body.classList.contains('nav-open')) setDrawer(false);
}

/* ── command palette ───────────────────────────────────────────── */
const COMMANDS = [
  ...TABS.map((tab, i) => ({
    id: `tab-${tab.id}`,
    title: `Go to ${tab.label}`,
    hint: String(i + 1),
    run: () => openTab(tab.id),
  })),
  { id: 'study', title: 'Start or stop study mode', hint: 's', run: () => $('btnStudy')?.click() },
  { id: 'stop', title: 'Stop all capture', hint: '.', run: () => $('btnStopAll')?.click() },
  { id: 'ask', title: 'Ask about the session', run: () => { openTab('live'); $('liveAskInput')?.focus(); } },
  { id: 'answer', title: 'Answer a typed question', run: () => { openTab('answer'); $('answerText')?.focus(); } },
  { id: 'sync', title: 'Sync the workspace now', run: () => { openTab('memory'); $('btnSyncNow')?.click(); } },
  { id: 'evolve', title: 'Evolve the persona', run: () => { openTab('memory'); $('btnEvolve')?.click(); } },
  { id: 'pack', title: 'Export a study pack', run: () => { openTab('memory'); $('btnPackExport')?.click(); } },
  { id: 'revision', title: 'Build the revision sheet', run: () => { openTab('memory'); $('btnRevision')?.click(); } },
  { id: 'profile', title: 'Open your profile', hint: 'p', run: () => window.openProfile?.() },
  { id: 'settings', title: 'Open settings', run: () => $('btnSettings')?.click() },
  { id: 'theme', title: 'Switch theme', hint: 't', run: cycleTheme },
  { id: 'shortcuts', title: 'Keyboard shortcuts', hint: '?', run: openShortcuts },
];

let matches = COMMANDS;
let cursor = 0;

function renderPalette(query = '') {
  const q = query.trim().toLowerCase();
  matches = COMMANDS.filter((c) => !q || c.title.toLowerCase().includes(q));
  cursor = 0;
  const list = $('paletteList');
  if (!list) return;
  list.textContent = '';
  if (!matches.length) {
    const empty = document.createElement('li');
    empty.className = 'palette-empty';
    empty.textContent = 'Nothing matches that.';
    list.append(empty);
    return;
  }
  matches.forEach((command, index) => {
    const item = document.createElement('li');
    item.className = 'palette-item' + (index === 0 ? ' current' : '');
    item.id = `palette-${command.id}`;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(index === 0));
    const name = document.createElement('span');
    name.textContent = command.title;
    item.append(name);
    if (command.hint) {
      const kbd = document.createElement('kbd');
      kbd.textContent = command.hint;
      item.append(kbd);
    }
    item.addEventListener('click', () => runCommand(index));
    list.append(item);
  });
}

function highlight(next) {
  if (!matches.length) return;
  cursor = (next + matches.length) % matches.length;
  for (const [index, item] of [...document.querySelectorAll('.palette-item')].entries()) {
    item.classList.toggle('current', index === cursor);
    item.setAttribute('aria-selected', String(index === cursor));
    if (index === cursor) item.scrollIntoView({ block: 'nearest' });
  }
}

function runCommand(index) {
  const command = matches[index];
  closePalette();
  if (command) command.run();
}

function openPalette() {
  const dialog = $('palette');
  if (!dialog) return;
  if (!dialog.open) dialog.showModal();
  const input = $('paletteInput');
  input.value = '';
  renderPalette('');
  input.focus();
}

function closePalette() {
  const dialog = $('palette');
  if (dialog?.open) dialog.close();
}

/* ── shortcuts ─────────────────────────────────────────────────── */
function openShortcuts() {
  const dialog = $('shortcutsDialog');
  if (dialog && !dialog.open) dialog.showModal();
}

function focusCurrentField() {
  const active = activeTabButton()?.dataset.tab || 'live';
  const box =
    document.querySelector(`#tab-${active} textarea`) || document.querySelector(`#tab-${active} input[type="text"]`);
  box?.focus();
}

const typingIn = (el) =>
  !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

document.addEventListener('keydown', (event) => {
  const key = event.key;

  // Palette: the one shortcut that also works mid-typing.
  if ((event.metaKey || event.ctrlKey) && key.toLowerCase() === 'k') {
    event.preventDefault();
    return openPalette();
  }
  if (event.key === 'Escape') {
    closePalette();
    closeDrawer();
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (typingIn(event.target) || document.querySelector('dialog[open]:not(#palette)')) return;

  const index = Number(key);
  if (index >= 1 && index <= TABS.length) {
    event.preventDefault();
    return openTab(TABS[index - 1].id);
  }
  // A tenth tab has no digit left, so it takes the one under the nine.
  if (key === '0' && TABS.length >= 10) {
    event.preventDefault();
    return openTab(TABS[9].id);
  }
  if (key === '/') {
    event.preventDefault();
    return focusCurrentField();
  }
  if (key === 's') { event.preventDefault(); return $('btnStudy')?.click(); }
  if (key === '.') { event.preventDefault(); return $('btnStopAll')?.click(); }
  if (key === 't') { event.preventDefault(); return cycleTheme(); }
  if (key === 'p') { event.preventDefault(); return window.openProfile?.(); }
  if (key === '?') { event.preventDefault(); return openShortcuts(); }
});

/* ── connection state ──────────────────────────────────────────── */
function notify(message) {
  const toast = $('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className = 'toast';
  toast.hidden = false;
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => {
    toast.hidden = true;
  }, 2200);
}

function showNet(show, text) {
  const banner = $('netBanner');
  if (!banner) return;
  if (text) {
    const label = $('netText');
    if (label) label.textContent = text;
  }
  banner.hidden = !show;
}

async function probe() {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    showNet(!res.ok, res.ok ? '' : 'The Sage server answered oddly. Retry in a moment.');
    return res.ok;
  } catch {
    showNet(true, 'Cannot reach the Sage server. Retrying when the network returns.');
    return false;
  }
}

window.addEventListener('offline', () => showNet(true, 'This device is offline. Sage keeps what it has until the network returns.'));
window.addEventListener('online', () => probe());

/* ── capture pill: mirror app.js's own state ───────────────────── */
function syncCapturePill() {
  const pill = $('capturePill');
  if (!pill) return;
  const live = Boolean(document.querySelector('#btnListen.on, #btnScreen.on, #btnCamera.on'));
  pill.hidden = !live;
  document.title = live ? '● Sage · capturing' : 'Sage · course agent';
}

function syncStudyLabel() {
  const source = $('btnStudy');
  const mirror = $('btnQuickStudy');
  if (!source || !mirror) return;
  mirror.textContent = source.textContent.trim() || 'Study mode';
  mirror.classList.toggle('primary', source.classList.contains('primary'));
}

/* ── wire ──────────────────────────────────────────────────────── */
function bindShell() {
  $('btnTheme')?.addEventListener('click', cycleTheme);
  $('btnShortcuts')?.addEventListener('click', openShortcuts);
  $('btnCloseShortcuts')?.addEventListener('click', () => $('shortcutsDialog')?.close());
  $('btnPalette')?.addEventListener('click', openPalette);
  $('btnSidebar')?.addEventListener('click', () =>
    setDrawer(!document.body.classList.contains('nav-open'))
  );
  $('btnSidebarClose')?.addEventListener('click', () => setDrawer(false));
  $('scrim')?.addEventListener('click', () => setDrawer(false));
  $('netRetry')?.addEventListener('click', () => probe());
  $('btnQuickStudy')?.addEventListener('click', () => $('btnStudy')?.click());

  $('tabs')?.addEventListener('click', () => setTimeout(syncTabUi, 0));
  window.addEventListener('hashchange', () => {
    const name = location.hash.replace('#', '');
    if (TABS.some((t) => t.id === name) && activeTabButton()?.dataset.tab !== name) openTab(name);
  });

  const input = $('paletteInput');
  input?.addEventListener('input', () => renderPalette(input.value));
  input?.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); highlight(cursor + 1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); highlight(cursor - 1); }
    else if (event.key === 'Enter') { event.preventDefault(); runCommand(cursor); }
  });
  $('palette')?.addEventListener('click', (event) => {
    if (event.target === $('palette')) closePalette();
  });

  // PWA install, offered only when the browser says it is available.
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    shell.install = event;
    $('btnInstall')?.removeAttribute('hidden');
  });
  $('btnInstall')?.addEventListener('click', async () => {
    if (!shell.install) return;
    shell.install.prompt();
    await shell.install.userChoice;
    shell.install = null;
    $('btnInstall')?.setAttribute('hidden', '');
  });

  // app.js owns the .on classes; mirror them rather than guess.
  const observer = new MutationObserver(() => {
    syncCapturePill();
    syncStudyLabel();
  });
  for (const id of ['btnListen', 'btnScreen', 'btnCamera', 'btnStudy']) {
    const el = $(id);
    if (el) observer.observe(el, { attributes: true, attributeFilter: ['class', 'disabled'] });
  }
  $('btnStudy') && observer.observe($('btnStudy'), { childList: true, characterData: true, subtree: true });
}

applyTheme();
bindShell();
syncTabUi();
syncCapturePill();
syncStudyLabel();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (shell.theme === 'auto') applyTheme();
});
