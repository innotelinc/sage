/* Sage profile — the sheet that says who Sage is.
   Built on the reference profile pattern: cover, round avatar, identity row,
   tab-like stat strip, then panes. app.js owns the persona (it builds the
   system prompt from it); this file only presents it and hands edits back
   through window.sageProfile, so there is one copy of the truth.

   Billing is deliberately not wired: the card says so plainly, the button is
   disabled, and nothing here talks to Stripe. */

const $ = (id) => document.getElementById(id);

const TONE_WORD = {
  warm: 'warmly — contractions, the odd dry remark',
  plain: 'plainly, one student talking to another',
  formal: 'formally — precise and academic, still readable',
  blunt: 'bluntly — no filler, no throat-clearing',
};

const DEPTH_WORD = {
  concise: 'gives the fewest words that still earn the mark',
  balanced: 'gives the answer and the reasoning behind it',
  detailed: 'gives the answer, the reasoning, and the edge cases a marker tests',
};

function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'S';
  if (parts.length > 1) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return parts[0][0].toUpperCase();
}

function slugOf(name) {
  return String(name || 'sage')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'sage';
}

function values() {
  const read = (id) => $(id)?.value ?? '';
  return {
    name: read('setName').trim() || 'Sage',
    course: read('setCourse').trim(),
    tone: read('setTone') || 'warm',
    depth: read('setDepth') || 'balanced',
    humour: Number(read('setHumour') || 3),
    risk: Number(read('setRisk') || 2),
    language: read('setLanguage').trim(),
    interval: read('setInterval') || '20',
  };
}

function render() {
  const p = values();

  const avatar = $('profileAvatar');
  if (avatar) avatar.textContent = initialsOf(p.name);
  const badge = $('profileBadge');
  if (badge) badge.textContent = initialsOf(p.name);

  const title = $('profileTitle');
  if (title) title.textContent = p.name;

  const handle = $('profileHandle');
  if (handle) handle.textContent = `@${slugOf(p.name)} · study double`;

  const course = $('profileCourse');
  if (course) course.textContent = p.course || 'No course set yet — name the course Sage is taking.';

  const humourOut = $('humourOut');
  if (humourOut) humourOut.textContent = String(p.humour);
  const riskOut = $('riskOut');
  if (riskOut) riskOut.textContent = String(p.risk);

  const chips = $('profileChips');
  if (chips) {
    chips.textContent = '';
    const items = [
      `${p.tone} voice`,
      `${p.depth} depth`,
      `humour ${p.humour}/5`,
      `risk ${p.risk}/5`,
      p.language ? `answers in ${p.language}` : 'matches the material',
      `notes every ${p.interval}s`,
    ];
    for (const text of items) {
      const chip = document.createElement('span');
      chip.className = 'wp-chip';
      chip.textContent = text;
      chips.append(chip);
    }
  }

  const statCourse = $('statCourse');
  if (statCourse) statCourse.textContent = p.course || 'Not set';
  const statVoice = $('statVoice');
  if (statVoice) statVoice.textContent = `${p.tone} · ${p.depth}`;
  const statCadence = $('statCadence');
  if (statCadence) statCadence.textContent = `every ${p.interval}s`;

  const preview = $('voicePreview');
  if (preview) {
    const humour =
      p.humour <= 1
        ? 'keeps jokes out of it'
        : p.humour >= 4
          ? 'lets the humour show when the room allows'
          : 'keeps humour to a light touch';
    const risk =
      p.risk <= 2
        ? 'stays inside the material and says when it does not know'
        : 'commits to the best inference and marks it as inferred';
    preview.textContent = `In ${p.course || 'this course'}, ${p.name} answers ${TONE_WORD[p.tone] || TONE_WORD.warm}. It ${DEPTH_WORD[p.depth] || DEPTH_WORD.balanced}, ${humour}, and ${risk}.`;
  }
}

function openProfile() {
  const dialog = $('profileDialog');
  if (!dialog) return;
  // The controls are hydrated from app.js's state, never guessed from whatever
  // was last typed into a dialog that has since been closed.
  try {
    window.sageProfile?.hydrate?.();
  } catch {
    /* an older app.js: the controls keep the values they already had */
  }
  render();
  const status = $('profileStatus');
  if (status) status.textContent = '';
  // Whop-style pages open at the top rather than wherever the last visit ended.
  dialog.querySelector('.wp-body')?.scrollTo?.(0, 0);
  if (!dialog.open) dialog.showModal();
}

function save() {
  const bridge = window.sageProfile;
  if (typeof bridge?.save === 'function') bridge.save();
  else $('btnSaveSettings')?.click(); // the same path Settings uses
  $('profileDialog')?.close();
  const toast = $('toast');
  if (toast) {
    toast.textContent = 'Profile saved.';
    toast.className = 'toast';
    toast.hidden = false;
    clearTimeout(save.timer);
    save.timer = setTimeout(() => {
      toast.hidden = true;
    }, 2200);
  }
  render();
}

function bind() {
  $('btnProfile')?.addEventListener('click', openProfile);
  $('btnCloseProfile')?.addEventListener('click', () => $('profileDialog')?.close());
  $('btnProfileClose')?.addEventListener('click', () => $('profileDialog')?.close());
  $('btnProfileCloseFoot')?.addEventListener('click', () => $('profileDialog')?.close());
  $('btnSaveProfile')?.addEventListener('click', save);
  $('btnSaveProfileFoot')?.addEventListener('click', save);

  // Plumbing lives in Settings: the profile points at it rather than duplicating it.
  $('btnPlumbing')?.addEventListener('click', () => {
    $('profileDialog')?.close();
    $('btnSettings')?.click();
  });
  $('btnProfileFromSettings')?.addEventListener('click', () => {
    $('settingsDialog')?.close();
    openProfile();
  });

  for (const id of ['setName', 'setCourse', 'setTone', 'setDepth', 'setHumour', 'setRisk', 'setLanguage', 'setInterval']) {
    $(id)?.addEventListener('input', render);
    $(id)?.addEventListener('change', render);
  }

  // A saved name should reach the rail without a reload.
  const railName = $('agentName');
  if (railName) {
    new MutationObserver(() => {
      const badge = $('profileBadge');
      if (badge) badge.textContent = initialsOf(railName.textContent);
    }).observe(railName, { childList: true, characterData: true, subtree: true });
  }

  render();
}

window.openProfile = openProfile;
bind();
