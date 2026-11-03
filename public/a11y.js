/**
 * Speaking to a screen reader, and writing in the course's direction.
 *
 * Two things are easy to forget when a UI is built by eye. One is that a state
 * drawn as a coloured pill is invisible to someone hearing the page; the other is
 * that a language written right to left is not just right-aligned text, it is a
 * document direction, and a page number or a bracketed citation inside it must not
 * come out mirrored.
 *
 * The decisions live here — pure, DOM-free, testable in Node. The DOM wiring that
 * applies them is in app.js.
 */

/* Languages written right to left, by base subtag. */
export const RTL_LANGUAGES = ['ar', 'arc', 'ckb', 'dv', 'fa', 'he', 'iw', 'ks', 'ku', 'ps', 'sd', 'ug', 'ur', 'yi'];

/* A course says "Arabic" as often as it says "ar-EG". */
const LANGUAGE_NAMES = {
  arabic: 'ar',
  dari: 'fa',
  english: 'en',
  farsi: 'fa',
  french: 'fr',
  german: 'de',
  hebrew: 'he',
  hindi: 'hi',
  italian: 'it',
  japanese: 'ja',
  korean: 'ko',
  mandarin: 'zh',
  persian: 'fa',
  portuguese: 'pt',
  punjabi: 'pa',
  russian: 'ru',
  spanish: 'es',
  turkish: 'tr',
  urdu: 'ur',
  chinese: 'zh',
};

/**
 * A BCP-47 tag from whatever the settings hold. A tag-shaped value is kept (an
 * underscore is not a separator in a language tag, so it becomes a hyphen); a
 * language name is mapped; anything else falls back, because `<html lang>` with a
 * nonsense value tells a screen reader less than no value at all.
 */
export function languageTag(language, fallback = 'en') {
  const raw = String(language == null ? '' : language).trim();
  if (!raw) return fallback;
  const tag = raw.replace(/_/g, '-');
  if (/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(tag)) return tag;
  return LANGUAGE_NAMES[raw.toLowerCase()] || fallback;
}

/** Which way the document runs. Empty or unknown is left to right. */
export function directionOf(language) {
  const tag = languageTag(language, '');
  const base = String(tag).toLowerCase().split('-')[0];
  return RTL_LANGUAGES.includes(base) ? 'rtl' : 'ltr';
}

/**
 * What a capture start or stop sounds like. Only the live states are named: an
 * idle page has nothing to announce, and saying so on every repaint is noise.
 */
export function describeCapture(capture = {}) {
  const listening = Boolean(capture.listening);
  const watching = Boolean(capture.watching);
  const aiming = Boolean(capture.aiming);
  const interval = Math.max(1, Number(capture.intervalSec) || 20);
  const parts = [];
  if (listening) parts.push(`listening to the room, a note every ${interval} seconds`);
  if (watching) parts.push('watching the screen');
  if (aiming) parts.push('camera open');
  if (!parts.length) return capture.stopped ? 'Capture stopped. Nothing is being recorded.' : '';
  return `Capture is live: ${parts.join(', ')}.`;
}

/** What a finished reply sounds like, including where it came from. */
export function describeReply(res = {}, mode = 'answer') {
  const names = Array.isArray(res.grounded) ? res.grounded.filter(Boolean) : [];
  const cites = Array.isArray(res.citations) ? res.citations.filter((cite) => cite && cite.name) : [];
  const cached = Array.isArray(res.fromCache) ? res.fromCache.filter(Boolean) : [];
  const label =
    mode === 'quiz' ? 'Quiz answer' : mode === 'essay' ? 'Essay' : mode === 'read' ? 'Notes' : 'Answer';
  const where = cites.length
    ? ` Grounded in ${cites
        .map((cite) => (cite.locator && cite.locator !== 'whole document' ? `${cite.name} ${cite.locator}` : cite.name))
        .join(', ')}.`
    : names.length
      ? ` Grounded in ${names.join(', ')}.`
      : ' No grounding document was used.';
  const from = cached.length
    ? ` ${cached.length === 1 ? 'One document came' : `${cached.length} documents came`} from the copy cached on this device.`
    : '';
  return `${label} ready.${where}${from}`;
}

/**
 * Where Tab should send focus inside a modal. `null` means the browser's own move
 * is correct; a number means wrap to that item, because the modal owns the focus
 * while it is open and Tab must not walk out of it.
 */
export function trapFocusIndex(count, index, shift = false) {
  const total = Math.max(0, Number(count) || 0);
  if (!total) return -1;
  const at = Math.max(0, Math.min(total - 1, Math.trunc(Number(index) || 0)));
  if (shift && at === 0) return total - 1;
  if (!shift && at === total - 1) return 0;
  return null;
}
