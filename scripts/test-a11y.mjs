/**
 * Direction, announcements and the focus trap: the rules 4.9 is built on.
 * Pure, so they can be checked without a browser; app.js is what applies them.
 */
import assert from 'node:assert/strict';
import {
  describeCapture,
  describeReply,
  directionOf,
  languageTag,
  RTL_LANGUAGES,
  trapFocusIndex,
} from '../public/a11y.js';

let checks = 0;
function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}
function equal(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks += 1;
}

/* ── direction ─────────────────────────────────────────────── */
equal(directionOf('ar'), 'rtl', 'Arabic runs right to left');
equal(directionOf('ar-EG'), 'rtl', 'and a regional tag is still Arabic');
equal(directionOf('AR'), 'rtl', 'case does not change the script');
equal(directionOf('Arabic'), 'rtl', 'a language name is as good as a tag');
equal(directionOf('he'), 'rtl', 'Hebrew too');
equal(directionOf('fa-IR'), 'rtl', 'and Persian');
equal(directionOf('ur'), 'rtl', 'and Urdu');
equal(directionOf('ckb'), 'rtl', 'and Sorani');
equal(directionOf('en'), 'ltr', 'English runs left to right');
equal(directionOf(''), 'ltr', 'with nothing set, the document is left to right');
equal(directionOf('de-CH'), 'ltr', 'a regional tag is not guessed wrong');
equal(directionOf('zh-Hant'), 'ltr', 'nor is a script subtag mistaken for a script direction');
equal(directionOf('English'), 'ltr', 'a name in the wrong language is still left to right');
check(RTL_LANGUAGES.includes('ar'), 'the list of right-to-left languages is exported for the settings copy');

/* ── tags ──────────────────────────────────────────────────── */
equal(languageTag('ar_EG'), 'ar-EG', 'an underscore becomes a hyphen');
equal(languageTag(''), 'en', 'nothing set falls back to English');
equal(languageTag('Arabic'), 'ar', 'a name is mapped to its tag');
equal(languageTag('Klingon'), 'en', 'a name nobody knows falls back rather than lying');
equal(languageTag('fr', 'en'), 'fr', 'a real tag survives');
equal(languageTag('  '), 'en', 'whitespace is nothing');

/* ── what capture sounds like ──────────────────────────────── */
equal(describeCapture({}), '', 'an idle page announces nothing');
check(/Capture stopped/.test(describeCapture({ stopped: true })), 'a stop is announced');
check(/listening to the room/.test(describeCapture({ listening: true })), 'listening is announced');
check(/a note every 45 seconds/.test(describeCapture({ listening: true, intervalSec: 45 })), 'with the cadence');
check(
  /watching the screen/.test(describeCapture({ listening: true, watching: true })) &&
    /listening/.test(describeCapture({ listening: true, watching: true })),
  'two channels are both named'
);
check(/camera open/.test(describeCapture({ aiming: true })), 'the camera is named too');

/* ── what a reply sounds like ──────────────────────────────── */
const reply = { grounded: ['handout.pdf'], citations: [{ name: 'handout.pdf', locator: 'p.3' }] };
equal(describeReply(reply, 'answer'), 'Answer ready. Grounded in handout.pdf p.3.', 'a cited page is spoken with its name');
check(
  !/No grounding document/.test(describeReply(reply, 'answer')),
  'a grounded reply does not claim otherwise'
);
equal(
  describeReply({ grounded: [] }, 'answer'),
  'Answer ready. No grounding document was used.',
  'an ungrounded reply admits it'
);
check(/2 documents came from the copy cached on this device/.test(describeReply({ ...reply, fromCache: ['a.pdf', 'b.pdf'] }, 'answer')), 'cached grounding is named');
check(/Essay ready/.test(describeReply(reply, 'essay')), 'an essay is announced as one');
check(/Quiz answer ready/.test(describeReply(reply, 'quiz')), 'so is a quiz answer');
check(/Notes ready/.test(describeReply(reply, 'read')), 'and the notes Read produces');

/* ── the focus trap ────────────────────────────────────────── */
equal(trapFocusIndex(3, 2, false), 0, 'Tab on the last item wraps to the first');
equal(trapFocusIndex(3, 0, true), 2, 'Shift+Tab on the first wraps to the last');
equal(trapFocusIndex(3, 1, false), null, 'in the middle the browser moves as usual');
equal(trapFocusIndex(3, 1, true), null, 'backwards in the middle too');
equal(trapFocusIndex(1, 0, false), 0, 'one item in the dialog keeps focus on itself');
equal(trapFocusIndex(1, 0, true), 0, 'from either direction');
equal(trapFocusIndex(0, 0, false), -1, 'an empty dialog has nowhere to go');
equal(trapFocusIndex(3, 99, false), 0, 'a stale index still wraps rather than escaping');

console.log(`\n${checks} checks passed\n`);
