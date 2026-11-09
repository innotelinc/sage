/**
 * Puts the three session products into App Store Connect.
 *
 * Run from the `asc-iap` workflow, which is where the App Store Connect key
 * lives: GitHub never hands a secret back to a workstation, so the calls happen on
 * the runner instead. Every step is idempotent — a product that already exists is
 * reused, a localization or price that already exists is left alone — so re-running
 * it after fixing one thing does not create duplicates.
 *
 * Endpoints and payloads come from Apple's published OpenAPI specification, not
 * from memory: an in-app purchase is created through `app`, its display text hangs
 * off an `inAppPurchaseVersion`, and prices are referenced through
 * `inAppPurchaseV2`. Product ids cannot be edited once saved, so they are derived
 * from the same bundle id the server uses instead of being written down twice.
 */
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const API = 'https://api.appstoreconnect.apple.com';
const BUNDLE = (process.env.APPLE_BUNDLE_ID || 'us.innotel.sage').trim();
const TERRITORY = (process.env.ASC_BASE_TERRITORY || 'USA').trim();
const SUBMIT = /^(1|true|yes)$/i.test(String(process.env.SUBMIT || ''));
const SCREENSHOT = (process.env.IAP_SCREENSHOT || '').trim();

/** Only edits things when asked: it attaches a build and touches a submission. */
const ATTACH = /^(1|true|yes)$/i.test(String(process.env.ATTACH || ''));

/** The listing pass: copy, category, privacy URL, review contact, screenshots. */
const LISTING = /^(1|true|yes)$/i.test(String(process.env.LISTING || ''));
/** The last step, and the only one that puts the app in front of App Review. */
const PUBLISH = /^(1|true|yes)$/i.test(String(process.env.PUBLISH || ''));
const WITHDRAW = /^(1|true|yes)$/i.test(String(process.env.WITHDRAW || ''));
const SITE = (process.env.SAGE_SITE || 'https://sage.innotel.tech').replace(/\/+$/, '');
const SHOT_DIR = (process.env.APP_STORE_SHOTS || '').trim();
const PROBE = /^(1|true|yes)$/i.test(String(process.env.APP_STORE_PROBE || ''));
/** Read-only: print what the store holds for each session, then stop. */
const IAP_STATUS = /^(1|true|yes)$/i.test(String(process.env.IAP_STATUS || ''));
const RELEASE_CHECK = /^(1|true|yes)$/i.test(String(process.env.RELEASE_CHECK || ''));
const SHOT_DIR_DUO = (process.env.APP_STORE_SHOTS_DUO || '').trim();
/** Certificates are team-wide and capped, so they are handled before any app lookup. */
const CERTS = String(process.env.CERTS || '').trim().toLowerCase();
const CREATIVE = /^(1|true|yes)$/i.test(String(process.env.APP_STORE_CREATIVE || ''));
const HEADER_ASSET = (process.env.APP_STORE_HEADER || 'deploy/ios/store-header/header-universal.png').trim();
const CREATIVE_TYPES = ['PRODUCT_PAGE_HEADER_ASSET', 'APP_STORE_SEARCH_RESULTS_ASSET'];
const REPLACE_SHOTS = /^(1|true|yes)$/i.test(String(process.env.REPLACE_SHOTS || ''));
const SHOT_DIR_PHONE = (process.env.APP_STORE_SHOTS_PHONE || '').trim();
const SHOT_DIR_IPAD = (process.env.APP_STORE_SHOTS_IPAD || '').trim();
const CATEGORY = (process.env.APPLE_CATEGORY || 'EDUCATION').trim();

/* App Review's questionnaire, answered for what Sage is: a study tool with no chat
   between people, no ads, no shared content and no age gate. Types come from
   Apple's published schema — eleven booleans and thirteen rated scales. */
const AGE_RATING = {
  advertising: false,
  ageAssurance: false,
  alcoholTobaccoOrDrugUseOrReferences: 'NONE',
  contests: 'NONE',
  gambling: false,
  gamblingSimulated: 'NONE',
  gunsOrOtherWeapons: 'NONE',
  healthOrWellnessTopics: false,
  horrorOrFearThemes: 'NONE',
  lootBox: false,
  matureOrSuggestiveThemes: 'NONE',
  medicalOrTreatmentInformation: 'NONE',
  messagingAndChat: false,
  parentalControls: false,
  profanityOrCrudeHumor: 'NONE',
  sexualContentGraphicAndNudity: 'NONE',
  sexualContentOrNudity: 'NONE',
  socialMedia: false,
  socialMediaAgeRestricted: false,
  unrestrictedWebAccess: false,
  userGeneratedContent: false,
  violenceCartoonOrFantasy: 'NONE',
  violenceRealistic: 'NONE',
  violenceRealisticProlongedGraphicOrSadistic: 'NONE',
};

const REVIEW = {
  firstName: (process.env.APPLE_REVIEW_FIRST_NAME || 'Darnel').trim(),
  lastName: (process.env.APPLE_REVIEW_LAST_NAME || 'Hunter').trim(),
  email: (process.env.APPLE_REVIEW_EMAIL || 'admin@innotel.us').trim(),
  // App Review telephones this number before rejecting, so it has to be one that is
  // answered. It is a repository secret: never written into the repo.
  phone: (process.env.APPLE_REVIEW_PHONE || '').trim(),
};

/* Two of App Review's questions can only be answered from outside the repo: the
   screen recording of a physical device, and — when an instance gates on an
   account — an account to replay with. Both arrive as repository secrets so the
   notes can say what is actually true instead of promising a link that is not
   there. */
const RECORDING_URL = (process.env.APPLE_REVIEW_RECORDING_URL || '').trim();
const DEMO = {
  email: (process.env.APPLE_REVIEW_DEMO_EMAIL || '').trim(),
  password: (process.env.APPLE_REVIEW_DEMO_PASSWORD || '').trim(),
};
const HAS_DEMO = Boolean(DEMO.email && DEMO.password);

/* The store page, written from what the app actually does. Every claim here names
   a surface that exists in the build. */
const COPY = {
  description: [
    'Sage is a course-taking agent. It sits in your lecture, follows along, and answers when it matters.',
    'LISTEN — Sage transcribes the room as it happens, so a lecture becomes notes you can search instead of a recording you never go back to.',
    'WATCH — read the slides, the board, or a cast screen. On iPhone the broadcast extension keeps reading while you are in another app.',
    'AIM — point the camera at the board or the screen at the front; Sage reads what is written there.',
    'ANSWER — ask anything about the material. Every answer arrives with the reasoning behind it, so you can check it and explain it afterwards instead of trusting it.',
    'QUIZ — photograph a question and get the answer with why each of the other options was ruled out.',
    'ESSAY — a brief comes back as an argument, in the voice you set, with a note on how to defend it in your own words.',
    'MEMORY — Sage keeps a record per course: the corrections you gave it, the sources it used, what you have already covered. A study pack exports the lot so another device picks up where you left off.',
    'SESSIONS — access is sold in timed sessions: fifteen minutes for standard and intensive, five for the trial, which is offered once per person and once per connection. One price, no subscription, no auto-renewal. Buy in the app and the clock stops capture for you when the window closes.',
    'Sage does not replace your reading or your judgement. It is a study aid: check what it tells you.',
  ].join('\n\n'),
  // The subtitle is what a search result shows under the name; the promotional text
  // is the only listing field that can change without a new build.
  subtitle: 'Your course, answered live',
  promotionalText: 'It sits in your lecture, reads the slides and the board, and answers with the reasoning shown — then leaves you notes you can revise from.',
  keywords: 'study aid,lecture notes,quiz help,essay outline,transcript,tutor,exam prep',
  supportUrl: `${SITE}/support`,
  marketingUrl: `${SITE}/about`,
  privacyUrl: `${SITE}/privacy`,
  reviewNotes: reviewNotes(),
};

/**
 * The six things Guideline 2.1 asked for, answered from what this build does.
 *
 * Written as numbered sections because that is how the request arrived, and the
 * answers stay literal: what the recording shows, who the app is for, how to get
 * in, what it talks to, whether regions differ, and why no regulated-industry
 * paperwork applies.
 */
function reviewNotes() {
  const access = HAS_DEMO
    ? [
        'No account is needed to open the app. If you would rather not buy a session, use the review account below — it already holds an active session, so the model is reachable without a purchase:',
        `${DEMO.email}  /  ${DEMO.password}`,
      ].join('\n')
    : 'The build requires no account, login, password or access code. It opens straight into the workspace; courses, saved notes and settings live on the device. A session is the only thing behind the model, and it is bought inside the app.';

  const recording = RECORDING_URL
    ? `Recorded on a physical iPhone running the current iOS, starting with the app launching from the Home Screen: ${RECORDING_URL}`
    : 'A screen recording made on a physical iPhone running the current iOS accompanies this submission: it was attached to our reply in App Review \u2192 Messages. Tell us if it did not arrive and we will send it again.';

  return [
    '1 · SCREEN RECORDING (physical device, current iOS)',
    recording,
    'Flow shown end to end: launching from the Home Screen; naming a course on first run (＋ adds one, ✕ removes it); Listen; Watch over the system broadcast, so notes keep arriving while another app is in front; Aim at a handout; Answer; Quiz; Essay; Memory; Settings → Session, where all three sessions load at App Store prices and a sandbox purchase completes through StoreKit.',

    '2 · PURPOSE AND TARGET AUDIENCE',
    'Sage is a study aid for students in higher education aged 17 and over. A lecture moves faster than anyone can write, so notes are missed and revision starts from nothing. Sage follows the lecture as it happens — transcript, slides, board or camera — keeps the notes per course, and answers questions about that material with the reasoning shown, so the student can check the answer and explain it. It does not replace the reading, and it does not sit an assessment for anyone.',

    '3 · SETUP AND ACCESS',
    access,
    'Nothing is captured until a source is started, and each source asks once: Listen (microphone), Watch (screen broadcast), Aim (camera). Answer, Quiz and Essay need no capture — type a question, or pick a photo of a slide or handout.',
    'A session is bought in Settings (gear, top right) → Session → Buy with the App Store, with a sandbox Apple Account, so no card is charged. The consumable is USD 3.00 / 9.00 / 19.00 on the US storefront — five minutes for the trial, fifteen for the others — priced in Apple\u2019s local tiers elsewhere; no subscription, no auto-renewal. StoreKit returns a signed transaction, our server verifies it against Apple\u2019s root certificate, and the session installs the moment Apple confirms. There is no Stripe or external checkout in the iOS build.',
    'Until a session is bought the app still opens and keeps its courses, notes and settings on the device; the Live tab shows a card that points to Settings instead of starting a capture it could not answer.',

    '4 · EXTERNAL SERVICES',
    '· Innotel OmniRoute gateway (gateway.innotel.us) — the language and vision models that write notes and answers. Reached from our server, so no provider key is ever in the app.',
    '· Self-hosted Whisper (faster-whisper) transcription, with Apple\u2019s on-device speech recognition as the fallback.',
    '· Apple StoreKit 2 — the in-app purchase of sessions, with the signed transaction verified server-side against Apple\u2019s root certificate.',
    '· Self-hosted Kokoro text-to-speech, with Apple\u2019s built-in synthesis as the fallback, for read-aloud.',
    '· Stripe and the Magnate storefront — the web build only; iOS sells exclusively through StoreKit.',
    'No advertising, analytics or attribution SDK is included, and no data is sold or shared with a broker.',

    '5 · REGIONAL DIFFERENCES',
    'None. The same features and behaviour in every storefront. The only difference is price, which follows Apple\u2019s per-storefront tiers. The interface is English; answers follow the language of the material supplied.',

    '6 · REGULATED INDUSTRY AND THIRD-PARTY MATERIAL',
    'Sage is not in a regulated industry: it is a study aid, not a school or an accredited institution, and it gives no medical, legal or financial advice. No third-party protected material is bundled — the artwork, copy and code are ours, and the code is MIT licensed — and output is generated per request from material the student supplies.',
  ].join('\n\n');
  // App Store Connect refuses a notes field over 4000 characters, and it refuses it
  // late: the listing run is what discovers it. Failing here says so at the source.
  if (notes.length > 4000) throw new Error(`review notes are ${notes.length} characters; App Review takes 4000`);
}


const issuer = (process.env.ASC_ISSUER_ID || '').trim();
const keyId = (process.env.ASC_KEY_ID || '').trim();
const pem = (process.env.ASC_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();
if (!issuer || !keyId || !pem) {
  console.error('ASC_ISSUER_ID / ASC_KEY_ID / ASC_PRIVATE_KEY are not all set.');
  process.exit(1);
}

/** The plans, priced to match what Magnate charges. */
const PLANS = [
  {
    productId: `${BUNDLE}.session.trial`,
    referenceName: 'Sage Trial Session',
    name: 'Sage Trial Session',
    description: 'A five-minute trial session, once per person.',
    price: '3.00',
  },
  {
    productId: `${BUNDLE}.session.standard`,
    referenceName: 'Sage Standard Session',
    name: 'Sage Standard Session',
    description: 'A 15-minute session, more messages.',
    price: '9.00',
  },
  {
    productId: `${BUNDLE}.session.intensive`,
    referenceName: 'Sage Intensive Session',
    name: 'Sage Intensive Session',
    description: 'A 15-minute session, most messages.',
    price: '19.00',
  },
];

const key = createPrivateKey({ key: pem, format: 'pem' });
let token = '';
let minted = 0;

function bearer() {
  const now = Math.floor(Date.now() / 1000);
  if (token && now - minted < 600) return token;
  const head = Buffer.from(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ iss: issuer, iat: now, exp: now + 900, aud: 'appstoreconnect-v1' })).toString('base64url');
  // JOSE wants the raw r||s pair; node's default DER encoding is rejected by Apple.
  const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  token = `${head}.${body}.${sig}`;
  minted = now;
  return token;
}

async function call(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      authorization: `Bearer ${bearer()}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const detail = (data?.errors || [])
      .map((e) => `${e.status} ${e.code}: ${e.title}${e.detail ? ` — ${e.detail}` : ''}`)
      .join('; ');
    const error = new Error(`${method} ${path} → HTTP ${res.status}${detail ? ` · ${detail}` : ` · ${text.slice(0, 300)}`}`);
    error.status = res.status;
    error.data = data;
    throw error;
  }
  return data;
}

/** 404 is an answer here ("none yet"), not a failure. */
async function optional(path) {
  try {
    return await call('GET', path);
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function resolveAppId() {
  const fixed = (process.env.ASC_APP_ID || '').trim();
  if (fixed) return fixed;
  const found = await call('GET', `/v1/apps?filter[bundleId]=${encodeURIComponent(BUNDLE)}&limit=5`);
  const app = found?.data?.[0];
  if (!app) throw new Error(`No app record for ${BUNDLE} in this account.`);
  return app.id;
}

async function existingProducts(app) {
  const list = await call('GET', `/v1/apps/${app}/inAppPurchasesV2?limit=200`);
  return new Map((list?.data || []).map((item) => [item.attributes?.productId, item]));
}

/**
 * Apple's only machine-readable word about agreements.
 *
 * The API cannot read Business → Agreements: the old `/v1/agreements` endpoint is gone,
 * and a lapsed Paid Apps agreement turns every otherwise valid request into
 * 403 REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED. That refusal is the signal, so it is worth
 * naming instead of printing as an anonymous HTTP error.
 */
function agreementRefusal(error) {
  if (error?.status !== 403) return false;
  const codes = (error?.data?.errors || []).map((item) => String(item.code || '')).join(' ');
  return /AGREEMENT/i.test(codes) || /AGREEMENT/i.test(String(error?.message || ''));
}

function explainAgreementRefusal() {
  console.error('  agreements · BLOCKED — Apple refused the call with 403 REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED.');
  console.error('  agreements · the Account Holder must open Business → Agreements, accept the Paid Apps row,');
  console.error('  agreements · and finish banking and tax. Nothing paid can be sold until it reads Active.');
}

/** How many prices a schedule holds, following Apple's pages. */
async function countPrices(schedule, kind) {
  let path = `/v1/inAppPurchasePriceSchedules/${schedule}/${kind}?limit=200`;
  let total = 0;
  for (let page = 0; page < 20 && path; page += 1) {
    const data = await call('GET', path);
    total += (data?.data || []).length;
    const next = data?.links?.next;
    path = next ? String(next).replace(API, '') : '';
  }
  return total;
}

/**
 * What the store sees, printed and nothing changed.
 *
 * StoreKit answers an empty list rather than an error, so a phone that cannot buy a
 * session cannot say why. These are the store-side facts that produce that answer:
 * each product's state, the state of its version, and whether it is on sale anywhere.
 */
async function reportProductStatus(app, iap) {
  console.log('\nSession products, as the store holds them:');
  if (!iap.size) console.log('  none — no in-app purchase is attached to this app');
  for (const plan of PLANS) {
    const found = iap.get(plan.productId);
    if (!found) {
      console.log(`  ${plan.productId} · MISSING — the id the app asks for does not exist on this app`);
      continue;
    }
    const versions = (await optional(`/v2/inAppPurchases/${found.id}/versions?limit=50`))?.data || [];
    const latest = versions.map((item) => String(item.attributes?.state || 'unknown')).join(', ') || 'no version';
    const availability = await optional(`/v2/inAppPurchases/${found.id}/inAppPurchaseAvailability`).catch(() => null);
    const territories = availability?.data?.relationships?.availableTerritories?.data?.length;
    const newTerritories = availability?.data?.attributes?.availableInNewTerritories;
    // A schedule with a base price and no automatic prices is priced in one storefront
    // only: a phone whose Apple Account is elsewhere is answered with no product at all.
    const schedule = await optional(
      `/v2/inAppPurchases/${found.id}/iapPriceSchedule?include=manualPrices,automaticPrices`
    ).catch(() => null);
    const base = schedule?.data?.relationships?.baseTerritory?.data?.id;
    // The include above is paged, so the counts come from the relationship endpoints:
    // a schedule that prices a handful of storefronts answers the others with nothing.
    const manual = schedule?.data?.id
      ? await countPrices(schedule.data.id, 'manualPrices').catch(() => null)
      : null;
    const automatic = schedule?.data?.id
      ? await countPrices(schedule.data.id, 'automaticPrices').catch(() => null)
      : null;
    const priced = schedule?.data
      ? `priced · ${manual ?? '?'} manual${base ? ` (base ${base})` : ''}, ${automatic ?? '?'} automatic`
      : 'priced · NO PRICE SCHEDULE';
    console.log(
      `  ${plan.productId.padEnd(38)} ${String(found.attributes?.state || 'unknown')} · version ${latest} · ` +
        (availability?.data
          ? `on sale in ${territories ?? 'an unknown number of'} territories${newTerritories ? ', new ones included' : ''}`
          : 'NOT ON SALE in any territory') +
        ` · ${priced}`
    );
  }
  const drafts = (await draftsFor(app).catch(() => null)) || [];
  const open = drafts.find((item) =>
    ['READY_FOR_REVIEW', 'WAITING_FOR_REVIEW', 'IN_REVIEW'].includes(String(item.attributes?.state || ''))
  );
  console.log(
    open
      ? `  submission · ${open.id} · ${open.attributes?.state}`
      : '  submission · none open — the products are not attached to a version Apple will review'
  );
}

async function ensureProduct(app, iap, plan) {
  const known = iap.get(plan.productId);
  if (known) {
    console.log(`  ${plan.productId} · already there (${known.attributes?.state || 'no state'})`);
    return known.id;
  }
  const made = await call('POST', '/v2/inAppPurchases', {
    data: {
      type: 'inAppPurchases',
      attributes: {
        name: plan.referenceName,
        productId: plan.productId,
        inAppPurchaseType: 'CONSUMABLE',
      },
      relationships: { app: { data: { type: 'apps', id: app } } },
    },
  });
  console.log(`  ${plan.productId} · created`);
  return made.data.id;
}

/** Display text lives on a version, and a new product may not have one yet. */
async function ensureVersion(id) {
  const list = await optional(`/v2/inAppPurchases/${id}/versions?limit=50`);
  const versions = list?.data || [];
  const editable = versions.find((item) => item.attributes?.state === 'PREPARE_FOR_SUBMISSION');
  if (editable) return editable.id;
  if (versions.length) {
    const newest = versions.slice().sort((a, b) => (b.attributes?.version || 0) - (a.attributes?.version || 0))[0];
    return newest.id;
  }
  const made = await call('POST', '/v1/inAppPurchaseVersions', {
    data: {
      type: 'inAppPurchaseVersions',
      relationships: { inAppPurchase: { data: { type: 'inAppPurchases', id } } },
    },
  });
  console.log('    version · draft created');
  return made.data.id;
}

async function ensureLocalization(id, plan) {
  const list = await optional(`/v2/inAppPurchases/${id}/inAppPurchaseLocalizations?limit=50`);
  const has = (list?.data || []).some((item) => String(item.attributes?.locale || '').toLowerCase() === 'en-us');
  if (has) {
    console.log('    localization · already there');
    return;
  }
  const version = await ensureVersion(id);
  await call('POST', '/v2/inAppPurchaseLocalizations', {
    data: {
      type: 'inAppPurchaseLocalizations',
      attributes: { name: plan.name, locale: 'en-US', description: plan.description },
      relationships: { version: { data: { type: 'inAppPurchaseVersions', id: version } } },
    },
  });
  console.log('    localization · en-US added');
}

/** Apple's price points are not every number, so the closest one is reported. */
async function pricePoint(id, target) {
  const list = await call('GET', `/v2/inAppPurchases/${id}/pricePoints?filter[territory]=${TERRITORY}&limit=8000`);
  const wanted = Number(target);
  const points = (list?.data || [])
    .map((item) => ({ id: item.id, price: Number(item.attributes?.customerPrice) }))
    .filter((item) => Number.isFinite(item.price));
  if (!points.length) throw new Error('Apple returned no price points for this product.');
  const exact = points.find((item) => Math.abs(item.price - wanted) < 0.005);
  if (exact) return { ...exact, exact: true };
  const nearest = points.reduce((best, item) => (Math.abs(item.price - wanted) < Math.abs(best.price - wanted) ? item : best));
  return { ...nearest, exact: false };
}

async function ensurePrice(id, plan) {
  const schedule = await optional(`/v2/inAppPurchases/${id}/iapPriceSchedule`);
  if (schedule?.data) {
    console.log('    price · a schedule already exists');
    return;
  }
  const point = await pricePoint(id, plan.price);
  await call('POST', '/v1/inAppPurchasePriceSchedules', {
    data: {
      type: 'inAppPurchasePriceSchedules',
      relationships: {
        inAppPurchase: { data: { type: 'inAppPurchases', id } },
        baseTerritory: { data: { type: 'territories', id: TERRITORY } },
        manualPrices: { data: [{ type: 'inAppPurchasePrices', id: '${price}' }] },
      },
    },
    included: [
      {
        type: 'inAppPurchasePrices',
        id: '${price}',
        relationships: {
          inAppPurchaseV2: { data: { type: 'inAppPurchases', id } },
          inAppPurchasePricePoint: { data: { type: 'inAppPurchasePricePoints', id: point.id } },
        },
      },
    ],
  });
  console.log(
    point.exact
      ? `    price · $${point.price.toFixed(2)} (exact match)`
      : `    price · $${point.price.toFixed(2)} — no $${plan.price} point exists, this is the closest`,
  );
}

async function ensureAvailability(id) {
  const current = await optional(`/v2/inAppPurchases/${id}/inAppPurchaseAvailability`);
  if (current?.data) {
    console.log('    availability · already set');
    return;
  }
  const territories = await call('GET', '/v1/territories?limit=200');
  const ids = (territories?.data || []).map((item) => item.id);
  if (!ids.length) throw new Error('Apple returned no territories.');
  await call('POST', '/v1/inAppPurchaseAvailabilities', {
    data: {
      type: 'inAppPurchaseAvailabilities',
      attributes: { availableInNewTerritories: true },
      relationships: {
        inAppPurchase: { data: { type: 'inAppPurchases', id } },
        availableTerritories: { data: ids.map((territory) => ({ type: 'territories', id: territory })) },
      },
    },
  });
  console.log(`    availability · all ${ids.length} territories`);
}

/**
 * The review screenshot takes two calls — reserve the record, then push the bytes
 * to the URLs Apple hands back — because App Store Connect never accepts an image
 * inline. It is only needed to submit, so a missing file must not undo the rest.
 */
async function ensureScreenshot(id) {
  if (!SCREENSHOT) return 'skipped (no IAP_SCREENSHOT supplied)';
  const current = await optional(`/v2/inAppPurchases/${id}/appStoreReviewScreenshot`);
  if (current?.data) return 'already uploaded';
  let bytes;
  try {
    bytes = await readFile(SCREENSHOT);
  } catch {
    return `missing (${SCREENSHOT} is not in the repository)`;
  }
  const reserved = await call('POST', '/v1/inAppPurchaseAppStoreReviewScreenshots', {
    data: {
      type: 'inAppPurchaseAppStoreReviewScreenshots',
      attributes: { fileName: SCREENSHOT.split(/[\\/]/).pop(), fileSize: bytes.length },
      relationships: { inAppPurchaseV2: { data: { type: 'inAppPurchases', id } } },
    },
  });
  const record = reserved.data;
  for (const op of record.attributes?.uploadOperations || []) {
    const chunk = bytes.subarray(op.offset, op.offset + op.length);
    const headers = {};
    for (const header of op.requestHeaders || []) headers[header.name] = header.value;
    const res = await fetch(op.url, { method: op.method, headers, body: chunk });
    if (!res.ok) throw new Error(`Screenshot upload failed (${res.status}).`);
  }
  await call('PATCH', `/v1/inAppPurchaseAppStoreReviewScreenshots/${record.id}`, {
    data: {
      type: 'inAppPurchaseAppStoreReviewScreenshots',
      id: record.id,
      attributes: { uploaded: true, sourceFileChecksum: createHash('md5').update(bytes).digest('hex') },
    },
  });
  return 'uploaded';
}

async function submitForReview(id, plan) {
  try {
    await call('POST', '/v1/inAppPurchaseSubmissions', {
      data: {
        type: 'inAppPurchaseSubmissions',
        relationships: { inAppPurchaseV2: { data: { type: 'inAppPurchases', id } } },
      },
    });
    console.log(`    review · ${plan.productId} submitted`);
  } catch (error) {
    console.log(`    review · not submitted: ${error.message}`);
  }
}

/**
 * Read-only: what App Store Connect already holds for this app. A first consumable
 * cannot be submitted without an app version in the same submission, so when the
 * web UI says "add an app version" this is how we see why none is on offer.
 */
/** Diagnostics must never fail the run: a refused read is itself the finding. */
async function soft(path) {
  try {
    return await call('GET', path);
  } catch {
    return null;
  }
}

/**
 * Apple answers a bad submission with "check associated errors to see why", and the
 * web UI only greys the button out. Every field App Review requires is read here so
 * the gap is named instead of hunted for.
 */
async function readiness(app) {
  const line = (label, value) => console.log(`  ${label} · ${value}`);
  const versions = await soft(`/v1/apps/${app}/appStoreVersions?limit=10&include=build`);
  const version = (versions?.data || []).find((item) => item.attributes?.platform === 'IOS');
  if (!version) {
    line('readiness', 'no iOS app version exists');
    return;
  }
  const attached = version.relationships?.build?.data?.id;
  line('build', attached ? 'attached' : 'MISSING — nothing to ship');
  const locs = await soft(`/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations?limit=10`);
  const loc = locs?.data?.[0];
  if (!loc) {
    line('listing text', 'MISSING — no localisation at all');
    line('screenshots', 'MISSING');
  } else {
    const attrs = loc.attributes || {};
    const gap = ['description', 'keywords', 'supportUrl'].filter((key) => !String(attrs[key] || '').trim());
    line('listing text', gap.length ? `MISSING ${gap.join(', ')}` : 'description, keywords, support URL present');
    line('promotional text', attrs.promotionalText ? `set (${attrs.promotionalText.length} chars)` : 'MISSING');
    const sets = await soft(`/v1/appStoreVersionLocalizations/${loc.id}/appScreenshotSets?limit=10`);
    const kinds = (sets?.data || []).map((item) => item.attributes?.screenshotDisplayType);
    line('screenshots', kinds.length ? `sets: ${kinds.join(', ')}` : 'MISSING — no screenshot set');
  }
  const detail = await soft(`/v1/appStoreVersions/${version.id}/appStoreReviewDetail`);
  const contact = detail?.data?.attributes;
  line('review contact', contact?.contactEmail ? 'present' : 'MISSING — App Review contact');
  const infos = await soft(`/v1/apps/${app}/appInfos?include=appInfoLocalizations,ageRatingDeclaration,primaryCategory&limit=5`);
  const info = infos?.data?.[0];
  const included = infos?.included || [];
  const infoLoc = included.find((item) => item.type === 'appInfoLocalizations')?.attributes || {};
  line('app info', !info ? 'MISSING' : [infoLoc.name || 'name MISSING', infoLoc.subtitle ? `subtitle "${infoLoc.subtitle}"` : 'subtitle MISSING', infoLoc.privacyPolicyUrl ? 'privacy policy' : 'privacy policy MISSING'].join(' · '));
  line('age rating', included.some((item) => item.type === 'ageRatingDeclarations') ? 'set' : 'MISSING');
  const declaration = included.find((item) => item.type === 'ageRatingDeclarations');
  if (declaration) {
    const rating = declaration.attributes || {};
    const unfilled = Object.keys(rating).filter((name) => rating[name] === null);
    line('age rating id', declaration.id);
    line('age rating blanks', unfilled.length ? unfilled.join(', ') : 'none');
    line('age rating sample', JSON.stringify(rating).slice(0, 700));
  }
  line('primary category', info?.relationships?.primaryCategory?.data?.id ? 'set' : 'MISSING');
  line('version state', version.attributes?.appStoreState || 'unknown');
  const full = await soft(`/v1/appStoreVersions/${version.id}?include=build`);
  const attrs = full?.data?.attributes || {};
  const blanks = Object.keys(attrs).filter((k) => attrs[k] === null || attrs[k] === '');
  line('version blanks', blanks.length ? blanks.join(', ') : 'none');
}

async function report(app) {
  const line = (label, value) => console.log(`  ${label} · ${value}`);
  try {
    const versions = await call('GET', `/v1/apps/${app}/appStoreVersions?limit=20&include=build&fields[appStoreVersions]=versionString,platform,appStoreState,createdDate,releaseType,build`);
    const rows = versions?.data || [];
    if (!rows.length) line('app versions', 'NONE — nothing to attach to a submission');
    for (const version of rows) {
      const id = version.relationships?.build?.data?.id;
      const build = (versions.included || []).find((item) => item.type === 'builds' && item.id === id);
      const state = version.attributes?.appStoreState || 'unknown';
      line('app version', `${version.attributes?.versionString} ${version.attributes?.platform} · ${state} · build ${build?.attributes?.version ?? 'none'}${build?.attributes?.processingState ? ` (${build.attributes.processingState})` : ''}`);
    }
  } catch (error) {
    line('app versions', `unreadable: ${error.message}`);
  }
  try {
    // limit=5 showed five arbitrary builds, so a fresh upload could be VALID and
    // invisible. Ask for all of them and sort, newest first.
    const builds = await call('GET', `/v1/apps/${app}/builds?limit=50&fields[builds]=version,processingState,uploadedDate,expired`);
    const rows = (builds?.data || []).sort((a, b) => Number(b.attributes?.version) - Number(a.attributes?.version));
    for (const build of rows) {
      line('build', `${build.attributes?.version} · ${build.attributes?.processingState}${build.attributes?.expired ? ' · expired' : ''}${build.attributes?.uploadedDate ? ` · ${build.attributes.uploadedDate}` : ''}`);
    }
  } catch (error) {
    line('builds', `unreadable: ${error.message}`);
  }
  try {
    const subs = await call('GET', `/v1/reviewSubmissions?filter[app]=${app}&limit=10&fields[reviewSubmissions]=state,platform,submittedDate`);
    const rows = subs?.data || [];
    if (!rows.length) line('submission', 'none open');
    for (const sub of rows) {
      line('submission', `${sub.attributes?.platform} · ${sub.attributes?.state}`);
      try {
        const items = await call('GET', `/v1/reviewSubmissions/${sub.id}/items?limit=50`);
        for (const item of items?.data || []) {
          const rel = item.relationships || {};
          const kinds = Object.keys(rel).filter((name) => rel[name]?.data);
          line('  item', `${kinds.join(' + ') || item.type} · ${item.attributes?.state || 'no state'}`);
        }
      } catch (error) {
        line('  items', `unreadable: ${error.message}`);
      }
    }
  } catch (error) {
    line('submissions', `unreadable: ${error.message}`);
  }
}


/** The newest build Apple will accept. */
async function newestBuild(app) {
  const list = await call('GET', `/v1/apps/${app}/builds?limit=50&fields[builds]=version,processingState,expired`);
  const builds = (list?.data || [])
    .map((build) => ({ id: build.id, version: Number(build.attributes?.version), state: build.attributes?.processingState, expired: Boolean(build.attributes?.expired) }))
    .filter((build) => build.state === 'VALID' && !build.expired && Number.isFinite(build.version))
    .sort((a, b) => b.version - a.version);
  console.log(`  valid builds: ${builds.map((build) => build.version).join(', ') || 'none'}`);
  return builds[0] || null;
}

/**
 * The check that keeps a stale binary out of a submission.
 *
 * A version keeps the build it was first given, so a fresh upload lands in TestFlight
 * and stays invisible to the App Store record until it is swapped in — which is how
 * build 55 could have gone to review while build 56 sat valid and unnoticed. This
 * compares what the version holds with the newest valid build for that same version
 * string and exits non-zero when they differ, so it can gate a release rather than
 * describe one.
 */
async function checkAttachedBuild(app) {
  const versions = await call(
    'GET',
    `/v1/apps/${app}/appStoreVersions?limit=20&include=build&fields[appStoreVersions]=versionString,platform,appStoreState,build`
  );
  const rows = versions?.data || [];
  const ios = rows.filter((row) => row.attributes?.platform === 'IOS');
  const version =
    ios.find((row) => row.attributes?.appStoreState === 'PREPARE_FOR_SUBMISSION') ||
    ios.find((row) => /REVIEW|WAITING|PENDING/.test(String(row.attributes?.appStoreState || ''))) ||
    ios[0];
  if (!version) {
    console.error('  release check · FAILED — there is no iOS version to submit');
    return false;
  }
  const label = version.attributes?.versionString;
  const attachedId = version.relationships?.build?.data?.id;
  const attached = attachedId
    ? (versions.included || []).find((item) => item.type === 'builds' && item.id === attachedId)
    : null;

  // No fields[] here: Apple answers 400 PARAMETER_ERROR.ILLEGAL when a sparse fieldset
  // is combined with include on this endpoint.
  const list = await call('GET', `/v1/apps/${app}/builds?limit=50&include=preReleaseVersion`);
  const releases = new Map(
    (list?.included || [])
      .filter((item) => item.type === 'preReleaseVersions')
      .map((item) => [item.id, item.attributes?.version])
  );
  // A 1.1 upload is not a candidate for a 1.0 version: the store refuses that pair, so
  // comparing across version strings would fail the check for something it cannot fix.
  const valid = (list?.data || [])
    .filter((build) => build.attributes?.processingState === 'VALID' && !build.attributes?.expired)
    .map((build) => ({
      id: build.id,
      version: Number(build.attributes?.version),
      release: releases.get(build.relationships?.preReleaseVersion?.data?.id),
    }))
    .filter(
      (build) => Number.isFinite(build.version) && (!build.release || build.release === label)
    )
    .sort((a, b) => b.version - a.version);

  const newest = valid[0];
  const held = Number(attached?.attributes?.version);
  console.log(`  release check · ${label} holds build ${Number.isFinite(held) ? held : 'none'}`);
  console.log(`  release check · newest valid build for ${label} is ${newest?.version ?? 'none'}`);
  if (!attached) {
    console.error(`  release check · FAILED — ${label} has no build, so a submission would be refused`);
    console.error('  release check · fix · gh workflow run asc-iap.yml -f attach=true');
    return false;
  }
  if (newest && newest.id !== attached.id && newest.version > held) {
    console.error(
      `  release check · FAILED — build ${held} would ship while build ${newest.version} is valid and unattached`
    );
    console.error('  release check · fix · gh workflow run asc-iap.yml -f attach=true');
    return false;
  }
  console.log('  release check · ok — the attached build is the newest valid one');
  return true;
}

/**
 * Version 1.0 was created but never given a build, and App Store Connect does not
 * offer a build-less version in the "add an app version" picker — which is why the
 * three products cannot be submitted. This attaches the newest valid build to the
 * version and adds that version to the open submission next to the products. It
 * leaves everything as a draft: submitting is still a deliberate, separate act.
 */
async function attachVersion(app) {
  const list = await call('GET', `/v1/apps/${app}/appStoreVersions?limit=10&include=build`);
  const version = (list?.data || []).find((item) => item.attributes?.platform === 'IOS');
  if (!version) throw new Error('no iOS app version exists');
  if (version.relationships?.build?.data?.id) {
    // A version holds on to the build it was first given, so a fresher upload
    // would never reach the App Store record unless it is swapped in. Only a build
    // Apple has finished validating can be attached, so this is worth re-running.
    const newest = await newestBuild(app);
    if (newest && newest.id !== version.relationships.build.data.id) {
      await call('PATCH', `/v1/appStoreVersions/${version.id}`, {
        data: {
          type: 'appStoreVersions',
          id: version.id,
          relationships: { build: { data: { type: 'builds', id: newest.id } } },
        },
      });
      console.log(`  version ${version.attributes?.versionString} · swapped to build ${newest.version}`);
    } else {
      console.log(`  version ${version.attributes?.versionString} · build already attached`);
    }
  } else {
    const build = await newestBuild(app);
    if (!build) throw new Error('no valid build to attach');
    await call('PATCH', `/v1/appStoreVersions/${version.id}`, {
      data: {
        type: 'appStoreVersions',
        id: version.id,
        relationships: { build: { data: { type: 'builds', id: build.id } } },
      },
    });
    console.log(`  version ${version.attributes?.versionString} · attached build ${build.version}`);
  }
  const subs = await call('GET', `/v1/reviewSubmissions?filter[app]=${app}&limit=10`);
  const open = (subs?.data || []).find((item) => item.attributes?.state === 'READY_FOR_REVIEW');
  if (!open) {
    // Withdrawing a version cancels the submission it was in, so after an update
    // there is no draft to fall into. One has to be made, with the version and the
    // products in it, or the resubmit has nothing to send.
    console.log('  no open iOS submission · making one');
    await placeInSubmission(app, version);
    return;
  }
  try {
    await call('POST', '/v1/reviewSubmissionItems', {
      data: {
        type: 'reviewSubmissionItems',
        relationships: {
          reviewSubmission: { data: { type: 'reviewSubmissions', id: open.id } },
          appStoreVersion: { data: { type: 'appStoreVersions', id: version.id } },
        },
      },
    });
    console.log(`  submission ${open.id} · app version ${version.attributes?.versionString} added`);
  } catch (error) {
    console.log(`  submission ${open.id} · version not added: ${error.message}`);
  }
  const after = await call('GET', `/v1/reviewSubmissions/${open.id}`);
  console.log(`  submission state · ${after?.data?.attributes?.state || 'unknown'}`);
}

/** The iOS version record the listing hangs off. */
async function iosVersion(app) {
  const list = await call('GET', `/v1/apps/${app}/appStoreVersions?limit=10&include=build`);
  const version = (list?.data || []).find((item) => item.attributes?.platform === 'IOS');
  if (!version) throw new Error('no iOS app version exists');
  return version;
}

/** The en-US listing text, created when the version has none yet. */
async function ensureListingText(versionId) {
  const list = await call('GET', `/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations?limit=10`);
  let localization = (list?.data || []).find((item) => String(item.attributes?.locale || '').toLowerCase() === 'en-us');
  if (!localization) {
    const made = await call('POST', '/v1/appStoreVersionLocalizations', {
      data: {
        type: 'appStoreVersionLocalizations',
        attributes: { locale: 'en-US' },
        relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } } },
      },
    });
    localization = made.data;
    console.log('  listing · en-US created');
  }
  await call('PATCH', `/v1/appStoreVersionLocalizations/${localization.id}`, {
    data: {
      type: 'appStoreVersionLocalizations',
      id: localization.id,
      attributes: {
        description: COPY.description,
        keywords: COPY.keywords,
        supportUrl: COPY.supportUrl,
        marketingUrl: COPY.marketingUrl,
        promotionalText: COPY.promotionalText,
      },
    },
  });
  console.log(`  listing · description, keywords, ${COPY.supportUrl}`);
  return localization;
}

/** Where App Review writes and telephones. Both are required before submitting. */
/** The review answers, plus the replay account when one is configured. */
function reviewAttributes() {
  const attributes = {
    contactFirstName: REVIEW.firstName,
    contactLastName: REVIEW.lastName,
    contactEmail: REVIEW.email,
    demoAccountRequired: HAS_DEMO,
    notes: COPY.reviewNotes,
  };
  if (HAS_DEMO) {
    attributes.demoAccountName = DEMO.email;
    attributes.demoAccountPassword = DEMO.password;
  }
  return attributes;
}

/**
 * Where App Review writes and telephones, and the answers they asked for.
 *
 * The notes are rewritten on every run rather than only at creation: the record
 * already existed, so a request for information can never be answered by a branch
 * that only fires the first time. `demoAccountRequired` follows whether an account
 * was actually supplied instead of being hardcoded false.
 */
async function ensureReviewContact(versionId) {
  if (!RECORDING_URL) {
    console.log('  review notes · WARNING — APPLE_REVIEW_RECORDING_URL is not set, and App Review requires a recording link');
  }
  const current = await optional(`/v1/appStoreVersions/${versionId}/appStoreReviewDetail`);
  if (current?.data?.id) {
    const existingPhone = current.data.attributes?.contactPhone;
    await call('PATCH', `/v1/appStoreReviewDetails/${current.data.id}`, {
      data: {
        type: 'appStoreReviewDetails',
        id: current.data.id,
        attributes: { ...reviewAttributes(), contactPhone: REVIEW.phone || existingPhone },
      },
    });
    console.log(`  review contact · ${REVIEW.firstName} ${REVIEW.lastName} <${REVIEW.email}>`);
    console.log(`  review notes · refreshed (${COPY.reviewNotes.length} chars) · demo account ${HAS_DEMO ? 'supplied' : 'not required'}`);
    return;
  }
  if (!REVIEW.phone) {
    console.log('  review contact · SKIPPED — APPLE_REVIEW_PHONE is not set, and Apple requires a number');
    return;
  }
  await call('POST', '/v1/appStoreReviewDetails', {
    data: {
      type: 'appStoreReviewDetails',
      attributes: { ...reviewAttributes(), contactPhone: REVIEW.phone },
      relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } } },
    },
  });
  console.log(`  review contact · ${REVIEW.firstName} ${REVIEW.lastName} <${REVIEW.email}>`);
  console.log(`  review notes · written (${COPY.reviewNotes.length} chars)`);
}

/** The privacy policy URL and the store category live on the app info, not the version. */
async function ensureAppInfo(app) {
  const infos = await call('GET', `/v1/apps/${app}/appInfos?include=appInfoLocalizations,primaryCategory&limit=5`);
  const info = infos?.data?.[0];
  if (!info) throw new Error('no app info record');
  const localization = (infos.included || []).find((item) => item.type === 'appInfoLocalizations');
  if (localization) {
    await call('PATCH', `/v1/appInfoLocalizations/${localization.id}`, {
      data: {
        type: 'appInfoLocalizations',
        id: localization.id,
        attributes: { privacyPolicyUrl: COPY.privacyUrl, subtitle: COPY.subtitle },
      },
    });
    console.log(`  privacy policy · ${COPY.privacyUrl}`);
  }
  if (info.relationships?.primaryCategory?.data?.id) {
    console.log('  category · already set');
  } else {
    await call('PATCH', `/v1/appInfos/${info.id}`, {
      data: {
        type: 'appInfos',
        id: info.id,
        relationships: { primaryCategory: { data: { type: 'appCategories', id: CATEGORY } } },
      },
    });
    console.log(`  category · ${CATEGORY}`);
  }
}

/**
 * Store screenshots take two calls each — reserve the record, push the bytes to the
 * URLs Apple hands back, then confirm the checksum — because App Store Connect never
 * takes an image inline.
 */
async function ensureShotSet(localizationId, displayType, directory) {
  if (!directory) return `${displayType} · skipped (no directory)`;
  const sets = await call('GET', `/v1/appStoreVersionLocalizations/${localizationId}/appScreenshotSets?limit=20`);
  let set = (sets?.data || []).find((item) => item.attributes?.screenshotDisplayType === displayType);
  if (!set) {
    const made = await call('POST', '/v1/appScreenshotSets', {
      data: {
        type: 'appScreenshotSets',
        attributes: { screenshotDisplayType: displayType },
        relationships: {
          appStoreVersionLocalization: { data: { type: 'appStoreVersionLocalizations', id: localizationId } },
        },
      },
    });
    set = made.data;
    console.log(`  ${displayType} · set created`);
  }
  let names = [];
  try {
    names = (await readdir(directory)).filter((name) => /\.(png|jpe?g)$/i.test(name)).sort();
  } catch {
    return `${displayType} · missing (${directory} is not in the repository)`;
  }
  if (!names.length) return `${displayType} · missing (${directory} holds no images)`;
  const existing = await call('GET', `/v1/appScreenshotSets/${set.id}/appScreenshots?limit=20`);
  const current = existing?.data || [];
  // App Store Connect appends, it never replaces: a different number of local images
  // means the set has changed, so the old ones are cleared first.
  if (current.length === names.length && !REPLACE_SHOTS) {
    return `${displayType} · already uploaded (${current.length})`;
  }
  for (const shot of current) await call('DELETE', `/v1/appScreenshots/${shot.id}`);
  if (current.length) console.log(`  ${displayType} · cleared ${current.length} old image(s)`);
  for (const name of names) {
    const bytes = await readFile(join(directory, name));
    const reserved = await call('POST', '/v1/appScreenshots', {
      data: {
        type: 'appScreenshots',
        attributes: { fileName: name, fileSize: bytes.length },
        relationships: { appScreenshotSet: { data: { type: 'appScreenshotSets', id: set.id } } },
      },
    });
    const record = reserved.data;
    for (const operation of record.attributes?.uploadOperations || []) {
      const chunk = bytes.subarray(operation.offset, operation.offset + operation.length);
      const headers = {};
      for (const header of operation.requestHeaders || []) headers[header.name] = header.value;
      const res = await fetch(operation.url, { method: operation.method, headers, body: chunk });
      if (!res.ok) throw new Error(`${name} upload failed (${res.status})`);
    }
    await call('PATCH', `/v1/appScreenshots/${record.id}`, {
      data: {
        type: 'appScreenshots',
        id: record.id,
        attributes: { uploaded: true, sourceFileChecksum: createHash('md5').update(bytes).digest('hex') },
      },
    });
    console.log(`  ${displayType} · ${name}`);
  }
  return `${displayType} · ${names.length} uploaded`;
}

/**
 * The app itself is free — the sessions are what cost money — but App Review refuses
 * a version until a price exists, and a price is a schedule even when it is zero.
 */
async function ensureAppPrice(app) {
  const schedule = await optional(`/v1/apps/${app}/appPriceSchedule`);
  if (schedule?.data) {
    const prices = await soft(`/v1/appPriceSchedules/${schedule.data.id}/manualPrices?limit=10`);
    if ((prices?.data || []).length) {
      console.log('  app price · a manual price is already set');
      return;
    }
    // App Review counts a schedule without a price as no pricing at all, so an empty
    // one has to be filled rather than trusted.
    console.log('  app price · the schedule exists but carries no price; filling it');
  }
  const points = await call(
    'GET',
    `/v1/apps/${app}/appPricePoints?filter[territory]=USA&limit=200&fields[appPricePoints]=customerPrice`,
  );
  const free = (points?.data || []).find((item) => Number(item.attributes?.customerPrice) === 0);
  if (!free) {
    console.log('  app price · Apple returned no zero price point; set it in the web UI');
    return;
  }
  try {
    await call('POST', '/v1/appPriceSchedules', {
      data: {
        type: 'appPriceSchedules',
        relationships: {
          app: { data: { type: 'apps', id: app } },
          baseTerritory: { data: { type: 'territories', id: 'USA' } },
          manualPrices: { data: [{ type: 'appPrices', id: '${price}' }] },
        },
      },
      included: [
        {
          type: 'appPrices',
          id: '${price}',
          relationships: { appPricePoint: { data: { type: 'appPricePoints', id: free.id } } },
        },
      ],
    });
  } catch (error) {
    console.log(`  app price · refused: ${error.message}`);
    return;
  }
  console.log('  app price · free');
}

/**
 * Three fields App Review will not accept a version without, and that nothing else
 * in this script sets. Apple only says "check associated errors", so each is read,
 * written when absent, and reported either way.
 */
async function ensureCompliance(app, version) {
  const fields = await soft(`/v1/appStoreVersions/${version.id}?fields[appStoreVersions]=versionString,copyright`);
  if (fields?.data?.attributes?.copyright) {
    console.log('  copyright · already set');
  } else {
    const year = new Date().getFullYear();
    await call('PATCH', `/v1/appStoreVersions/${version.id}`, {
      data: { type: 'appStoreVersions', id: version.id, attributes: { copyright: `${year} Innotel Labs` } },
    });
    console.log(`  copyright · ${year} Innotel Labs`);
  }

  const buildId = version.relationships?.build?.data?.id;
  if (buildId) {
    const build = await soft(`/v1/builds/${buildId}?fields[builds]=version,usesNonExemptEncryption`);
    if (build?.data?.attributes?.usesNonExemptEncryption == null) {
      try {
        await call('PATCH', `/v1/builds/${buildId}`, {
          data: { type: 'builds', id: buildId, attributes: { usesNonExemptEncryption: false } },
        });
        console.log('  export compliance · no non-exempt encryption');
      } catch (error) {
        console.log(`  export compliance · could not be set: ${error.message}`);
      }
    } else {
      console.log('  export compliance · already answered');
    }
  }

  const apps = await soft(`/v1/apps/${app}?fields[apps]=contentRightsDeclaration`);
  if (apps?.data?.attributes?.contentRightsDeclaration) {
    console.log('  content rights · already declared');
  } else {
    try {
      await call('PATCH', `/v1/apps/${app}`, {
        data: {
          type: 'apps',
          id: app,
          attributes: { contentRightsDeclaration: 'DOES_NOT_USE_THIRD_PARTY_CONTENT' },
        },
      });
      console.log('  content rights · does not use third-party content');
    } catch (error) {
      console.log(`  content rights · could not be set: ${error.message}`);
    }
  }
}

/**
 * A product joins a submission through its in-app purchase *version*, which is the
 * relationship name Apple's schema actually has — `inAppPurchase` is not one.
 */
async function addProducts(app, submissionId) {
  const products = await call('GET', `/v1/apps/${app}/inAppPurchasesV2?limit=200`);
  for (const product of products?.data || []) {
    const label = product.attributes?.productId || product.id;
    const versions = await call('GET', `/v2/inAppPurchases/${product.id}/versions?limit=10`).catch(() => null);
    const versionRecord = (versions?.data || [])[0];
    if (!versionRecord) {
      console.log(`  submission · ${label} has no version to submit`);
      continue;
    }
    try {
      await call('POST', '/v1/reviewSubmissionItems', {
        data: {
          type: 'reviewSubmissionItems',
          relationships: {
            reviewSubmission: { data: { type: 'reviewSubmissions', id: submissionId } },
            inAppPurchaseVersion: { data: { type: 'inAppPurchaseVersions', id: versionRecord.id } },
          },
        },
      });
      console.log(`  submission · ${label} added`);
    } catch (error) {
      console.log(`  submission · ${label} refused: ${error.message}`);
      if (error.data) console.log(`  submission · it said: ${JSON.stringify(error.data).slice(0, 600)}`);
    }
  }
}

/** One submission holding the version and the products, with any refusal spelled out. */
async function placeInSubmission(app, version) {
  const subs = await call('GET', `/v1/reviewSubmissions?filter[app]=${app}&limit=10`);
  const drafts = (subs?.data || []).filter((d) => d.attributes?.state === 'READY_FOR_REVIEW');
  for (const draft of [...drafts]) {
    const held = await call('GET', `/v1/reviewSubmissions/${draft.id}/items?limit=50`).catch(() => null);
    if ((held?.data || []).length) continue;
    try {
      await call('DELETE', `/v1/reviewSubmissions/${draft.id}`);
      drafts.splice(drafts.indexOf(draft), 1);
      console.log(`  submission · removed empty draft ${draft.id}`);
    } catch (error) {
      console.log(`  submission · kept empty draft ${draft.id}: ${error.message}`);
    }
  }
  const item = (id, rel, type, value) => ({
    data: {
      type: 'reviewSubmissionItems',
      relationships: {
        reviewSubmission: { data: { type: 'reviewSubmissions', id } },
        [rel]: { data: { type, id: value } },
      },
    },
  });
  const explain = (error) => {
    console.log(`  submission · ${error.message}`);
    if (error.data) console.log(`  submission · it said: ${JSON.stringify(error.data).slice(0, 6000)}`);
  };
  for (const draft of drafts) {
    let placed = false;
    // Freshly uploaded screenshots are post-processed for several minutes, and until
    // that finishes the version is refused for review. Waiting here keeps the draft
    // whole instead of leaving the version outside it until someone notices.
    for (let attempt = 1; attempt <= 11; attempt += 1) {
    try {
      await call('POST', '/v1/reviewSubmissionItems', item(draft.id, 'appStoreVersion', 'appStoreVersions', version.id));
      placed = true;
      console.log(`  submission · version ${version.attributes?.versionString} added to draft ${draft.id}`);
    } catch (error) {
      // Being in the draft already is the outcome we want, but a refusal is not proof of
      // it: a submission without the version looks complete and never goes to review.
      const check = await call('GET', `/v1/reviewSubmissions/${draft.id}/items?include=appStoreVersion&limit=50`).catch(() => null);
      const held = (check?.data || []).some(
        (row) => (row.relationships?.appStoreVersion?.data?.id || (check?.included || []).find((x) => x.type === 'appStoreVersions')?.id) === version.id,
      );
      if (held) {
        placed = true;
        console.log(`  submission · version ${version.attributes?.versionString} is already in draft ${draft.id}`);
        break;
      }
      if (/ASSET_IN_POST_PROCESSING/.test(JSON.stringify(error.data || error.message)) && attempt < 11) {
        console.log(`  submission · assets still processing, waiting (${attempt}/11)`);
        await new Promise((done) => setTimeout(done, attempt <= 3 ? 15000 : 25000));
        continue;
      }
      console.log('  submission · the draft does not hold the version');
      explain(error);
      break;
    }
    break;
    }
    if (!placed) continue;
    // Re-running must not stack duplicates: the draft holds the version plus one item
    // per product, so there is nothing to do once that count is reached.
    const before = await call('GET', `/v1/reviewSubmissions/${draft.id}/items?limit=50`).catch(() => null);
    const products = await call('GET', `/v1/apps/${app}/inAppPurchasesV2?limit=200`).catch(() => null);
    const expected = 1 + (products?.data || []).length;
    if ((before?.data || []).length >= expected) {
      console.log(`  submission · draft ${draft.id} already holds ${(before?.data || []).length} items`);
      return;
    }
    await addProducts(app, draft.id);
    const items = await call('GET', `/v1/reviewSubmissions/${draft.id}/items?limit=50`);
    console.log(`  submission · draft ${draft.id} holds ${(items?.data || []).length} items`);
    return;
  }
  if (drafts.length) {
    console.log('  submission · the existing drafts refused the version; not creating another');
    return;
  }
  let made;
  try {
    made = await call('POST', '/v1/reviewSubmissions', {
      data: { type: 'reviewSubmissions', attributes: { platform: 'IOS' }, relationships: { app: { data: { type: 'apps', id: app } } } },
    });
  } catch (error) {
    explain(error);
    return;
  }
  const id = made.data.id;
  console.log(`  submission · created draft ${id}`);
  try {
    await call('POST', '/v1/reviewSubmissionItems', item(id, 'appStoreVersion', 'appStoreVersions', version.id));
    console.log('  submission · the version went in');
  } catch (error) {
    explain(error);
  }
  // The version travels as a reviewSubmissionItem; a product joins through its
  // inAppPurchaseVersion relationship instead. Without this the draft holds the app
  // alone and the products are left READY_TO_SUBMIT — unreviewed, and unusable in
  // the shipped app.
  await addProducts(app, id);
  const items = await call('GET', `/v1/reviewSubmissions/${id}/items?limit=50`).catch(() => null);
  console.log(`  submission · ${(items?.data || []).length} items in draft ${id}`);
}

/**
 * The age rating has to be answered, not merely present: App Review refuses a version
 * whose declaration is empty, and says only "check associated errors" when it does.
 */
async function ensureAgeRating(app) {
  const infos = await call('GET', `/v1/apps/${app}/appInfos?include=ageRatingDeclaration&limit=5`);
  const declaration = (infos?.included || []).find((item) => item.type === 'ageRatingDeclarations');
  if (!declaration) {
    console.log('  age rating · no declaration to answer');
    return;
  }
  const blanks = Object.keys(AGE_RATING).filter((key) => declaration.attributes?.[key] == null);
  if (!blanks.length) {
    console.log('  age rating · already answered');
    return;
  }
  const attributes = Object.fromEntries(blanks.map((key) => [key, AGE_RATING[key]]));
  await call('PATCH', `/v1/ageRatingDeclarations/${declaration.id}`, {
    data: { type: 'ageRatingDeclarations', id: declaration.id, attributes },
  });
  console.log(`  age rating · answered ${blanks.length} fields, nothing above NONE`);
}


/**
 * Apple refuses to create or extend a screenshot set while the version is Ready for
 * Review inside a draft submission: "Can't Create Screenshot Set while Ready For
 * Review appScreenshotSets". The version therefore leaves the draft for the upload and
 * goes back in afterwards. Deleting an item is permitted; the submission is not.
 */
/**
 * The product page header and the search result creative are not screenshots: they live
 * in the app's asset library and reach the page through a placement. One 16:9 PNG of
 * 5244x2950 is what Apple's universal slot is for, so the same file fills both.
 */
async function ensureCreative(app, localizationId) {
  const library = await call('GET', `/v1/apps/${app}/assetLibrary`).catch(() => null);
  const libraryId = library?.data?.id;
  if (!libraryId) return 'no asset library on this app';
  const ref = await call('GET', `/v1/appAssetLibraryRefData?filter[placementTypes]=${CREATIVE_TYPES.join(',')}&limit=5`).catch(() => null);
  for (const datum of ref?.data || []) {
    for (const spec of datum.attributes?.imageSpecs || []) {
      if (!CREATIVE_TYPES.some((type) => (spec.compatiblePlacementTypes || []).includes(type))) continue;
      const size = spec.dimensions || {};
      console.log(`  header · ${spec.shortName || spec.specId} · ${size.minWidth}-${size.maxWidth}x${size.minHeight}-${size.maxHeight} · ${spec.aspectRatio} · alpha ${spec.alphaAllowed}`);
    }
  }
  let bytes;
  try {
    bytes = await readFile(HEADER_ASSET);
  } catch {
    return `missing (${HEADER_ASSET})`;
  }
  const name = HEADER_ASSET.split(/[\\/]/).pop();
  const listed = await call('GET', `/v1/appAssetLibraries/${libraryId}/images?limit=100`).catch(() => null);
  const stale = (listed?.data || []).filter((item) => item.attributes?.referenceName === 'Sage universal header');
  let image = stale.find((item) => Number(item.attributes?.fileSize) === bytes.length) || null;
  // The bytes cannot be replaced in place, so a changed file retires the old image and
  // takes over its two slots. Comparing size keeps this cheap and automatic.
  for (const old of stale) {
    if (old.id === image?.id) continue;
    // Two calls, never one: Apple refuses 'archived' together with any other attribute,
    // and an archived image keeps its reference name reserved until it is renamed.
    await call('PATCH', `/v1/appAssetLibraryImages/${old.id}`, {
      data: { type: 'appAssetLibraryImages', id: old.id, attributes: { archived: true } },
    }).catch(() => null);
    try {
      await call('PATCH', `/v1/appAssetLibraryImages/${old.id}`, {
        data: {
          type: 'appAssetLibraryImages',
          id: old.id,
          attributes: { referenceName: `Sage header retired ${Date.now()}` },
        },
      });
      console.log('  header · retired the previous image');
    } catch (error) {
      console.log(`  header · could not rename ${old.id}: ${error.message}`);
    }
  }
  if (!image) {
    const reserved = await call('POST', '/v1/appAssetLibraryImages', {
      data: {
        type: 'appAssetLibraryImages',
        attributes: { category: 'CREATIVE_ASSETS', fileName: name, fileSize: bytes.length, referenceName: 'Sage universal header' },
        relationships: { assetLibrary: { data: { type: 'appAssetLibraries', id: libraryId } } },
      },
    });
    image = reserved.data;
    for (const operation of image.attributes?.uploadOperations || []) {
      const headers = {};
      for (const header of operation.requestHeaders || []) headers[header.name] = header.value;
      const res = await fetch(operation.url, {
        method: operation.method,
        headers,
        body: bytes.subarray(operation.offset, operation.offset + operation.length),
      });
      if (!res.ok) throw new Error(`header upload failed (${res.status})`);
    }
    await call('PATCH', `/v1/appAssetLibraryImages/${image.id}`, {
      data: { type: 'appAssetLibraryImages', id: image.id, attributes: { uploaded: true } },
    });
    console.log('  header · uploaded to the asset library');
  } else {
    console.log('  header · already in the asset library');
  }
  // A placement on an image that Apple is still processing is refused, so the state is
  // watched until the file stops asking for an upload.
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const fresh = await call('GET', `/v1/appAssetLibraryImages/${image.id}`).catch(() => null);
    const state = fresh?.data?.attributes?.state || fresh?.data?.attributes?.assetState || '';
    if (!/UPLOAD|AWAITING/i.test(String(state))) break;
    await new Promise((done) => setTimeout(done, 2500));
  }
  const placed = await call('GET', `/v1/appAssetLibraryImages/${image.id}/placements?limit=20`).catch(() => null);
  const have = placed?.data || [];
  const missing = CREATIVE_TYPES.filter((type) => !have.some((item) => item.attributes?.placementType === type));
  if (!missing.length) return `both slots already carry it (${have.length} placement(s))`;
  // A group holds exactly one asset per placement type, so the slot is vacated before it
  // is refilled — an archived image keeps its placement until it is deleted.
  // Placements belong to the image that holds them, and an archived image keeps its
  // placement, so every image in the library is swept rather than just the current one.
  const everyImage = await call('GET', `/v1/appAssetLibraries/${libraryId}/images?limit=200`).catch(() => null);
  console.log(`  header · library holds ${(everyImage?.data || []).length} image(s)`);
  for (const held of everyImage?.data || []) {
    if (held.id === image.id) continue;
    const mine = await call('GET', `/v1/appAssetLibraryImages/${held.id}/placements?limit=10`).catch(() => null);
    for (const stale of mine?.data || []) {
      if (!CREATIVE_TYPES.includes(stale.attributes?.placementType)) continue;
      try {
        await call('DELETE', `/v1/appAssetLibraryPlacements/${stale.id}`);
        console.log(`  header · cleared ${stale.attributes.placementType} from ${held.attributes?.referenceName || held.id}`);
      } catch (error) {
        console.log(`  header · could not clear ${stale.id}: ${error.message}`);
      }
    }
  }
  const onVersion = await call('GET', `/v1/appStoreVersionLocalizations/${localizationId}/placements?limit=20`).catch(() => null);
  for (const existing of onVersion?.data || []) {
    if (!CREATIVE_TYPES.includes(existing.attributes?.placementType)) continue;
    await call('DELETE', `/v1/appAssetLibraryPlacements/${existing.id}`).catch(() => null);
    console.log(`  header · cleared the old ${existing.attributes.placementType} placement`);
  }
  for (const type of missing) {
    await call('POST', '/v1/appAssetLibraryPlacements', {
      data: {
        type: 'appAssetLibraryPlacements',
        attributes: { placementType: type },
        relationships: {
          image: { data: { type: 'appAssetLibraryImages', id: image.id } },
          appStoreVersionLocalization: { data: { type: 'appStoreVersionLocalizations', id: localizationId } },
        },
      },
    });
    console.log(`  header · placed as ${type}`);
  }
  return `${missing.length} slot(s) filled`;
}

/** Apple reports per-image delivery state, which is where processing failures surface. */
/**
 * Apple never publishes the pixel sizes for a slot in the API, but it does say them when
 * an image is wrong. A one-pixel upload therefore turns a guess into an answer: the
 * delivery errors name the exact dimensions the slot expects.
 */
async function probeDimensions(localizationId) {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
  for (const displayType of ['APP_IPHONE_DUO', 'APP_WATCH_ULTRA', 'APP_WATCH_SERIES_10']) {
    try {
      const sets = await call('GET', `/v1/appStoreVersionLocalizations/${localizationId}/appScreenshotSets?limit=30`);
      let set = (sets?.data || []).find((item) => item.attributes?.screenshotDisplayType === displayType);
      if (!set) {
        const made = await call('POST', '/v1/appScreenshotSets', {
          data: {
            type: 'appScreenshotSets',
            attributes: { screenshotDisplayType: displayType },
            relationships: { appStoreVersionLocalization: { data: { type: 'appStoreVersionLocalizations', id: localizationId } } },
          },
        });
        set = made.data;
      }
      const reserved = await call('POST', '/v1/appScreenshots', {
        data: {
          type: 'appScreenshots',
          attributes: { fileName: 'probe.png', fileSize: png.length },
          relationships: { appScreenshotSet: { data: { type: 'appScreenshotSets', id: set.id } } },
        },
      });
      const record = reserved.data;
      for (const operation of record.attributes?.uploadOperations || []) {
        const headers = {};
        for (const header of operation.requestHeaders || []) headers[header.name] = header.value;
        await fetch(operation.url, { method: operation.method, headers, body: png.subarray(operation.offset, operation.offset + operation.length) });
      }
      await call('PATCH', `/v1/appScreenshots/${record.id}`, {
        data: { type: 'appScreenshots', id: record.id, attributes: { uploaded: true } },
      });
      await new Promise((done) => setTimeout(done, 5000));
      const fresh = await call('GET', `/v1/appScreenshots/${record.id}`).catch(() => null);
      const errors = (fresh?.data?.attributes?.assetDeliveryState?.errors || []).map((e) => e.description || e.code);
      console.log(`  probe · ${displayType} · ${errors.join(' / ') || 'no complaint reported'}`);
      await call('DELETE', `/v1/appScreenshots/${record.id}`).catch(() => null);
      await call('DELETE', `/v1/appScreenshotSets/${set.id}`).catch(() => null);
    } catch (error) {
      console.log(`  probe · ${displayType} · ${error.message}`);
    }
  }
}

async function shotStates(localizationId) {
  const sets = await call('GET', `/v1/appStoreVersionLocalizations/${localizationId}/appScreenshotSets?limit=20`).catch(() => null);
  for (const set of sets?.data || []) {
    const shots = await call('GET', `/v1/appScreenshotSets/${set.id}/appScreenshots?limit=30`).catch(() => null);
    const counts = {};
    for (const shot of shots?.data || []) {
      const delivery = shot.attributes?.assetDeliveryState || {};
      const state = delivery.state || 'unknown';
      counts[state] = (counts[state] || 0) + 1;
      if (state !== 'COMPLETE') console.log(`  shots · ${set.attributes?.screenshotDisplayType} · ${shot.attributes?.fileName} · ${state}`);
      const errors = (delivery.errors || []).map((e) => e.description || e.code).slice(0, 2);
      if (errors.length) console.log(`  shots · ${set.attributes?.screenshotDisplayType} · ${shot.attributes?.fileName} · ${errors.join(' / ')}`);
    }
    console.log(`  shots · ${set.attributes?.screenshotDisplayType} · ${(shots?.data || []).length} image(s) · ${JSON.stringify(counts)}`);
  }
}

async function draftsFor(app) {
  const filtered = await call('GET', `/v1/reviewSubmissions?filter[app]=${app}&filter[platform]=IOS&limit=10`).catch(() => null);
  if (filtered?.data) return filtered.data;
  const all = await call('GET', `/v1/reviewSubmissions?filter[app]=${app}&limit=10`).catch(() => null);
  return all?.data || [];
}

/**
 * Screenshots are only editable while the version is outside a submission: Apple
 * answers a new screenshot set with "Can't Create Screenshot Set while Ready For
 * Review". A reshoot therefore releases the draft with PATCH canceled=true, which is
 * the documented way back, and the version rejoins a fresh draft with its products.
 */
/**
 * A screenshot set cannot be created for a version that is part of a review
 * submission ("Can't Create Screenshot Set while Ready For Review"), and cancelling the
 * submission is refused for a draft that was never submitted. The item that holds the
 * version is removed instead, which returns the version to an editable state, and the
 * version is put back into a draft after the images are up.
 */
async function releaseVersion(app, versionId) {
  const describe = async () => {
    const version = await call('GET', `/v1/appStoreVersions/${versionId}`).catch(() => null);
    return version?.data?.attributes?.state || 'unknown';
  };
  console.log(`  submission · version starts at ${await describe()}`);
  for (const draft of await draftsFor(app)) {
    const items = await call('GET', `/v1/reviewSubmissions/${draft.id}/items?include=appStoreVersion&limit=50`).catch(() => null);
    const rows = items?.data || [];
    console.log(`  submission · draft ${draft.id} · ${draft.attributes?.state} · ${rows.length} item(s)`);
    for (const row of rows) {
      const held = row.relationships?.appStoreVersion?.data?.id || (items?.included || []).find((x) => x.type === 'appStoreVersions')?.id;
      console.log(`  submission · item ${row.id} · ${row.type} · holds ${held || 'something else'}`);
      if (held !== versionId) continue;
      try {
        await call('DELETE', `/v1/reviewSubmissionItems/${row.id}`);
        console.log('  submission · item removed');
      } catch (error) {
        console.log(`  submission · item refused: ${error.message}`);
      }
    }
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const state = await describe();
    if (state !== 'READY_FOR_REVIEW') {
      console.log(`  submission · version is now ${state}`);
      return;
    }
    await new Promise((done) => setTimeout(done, 1500));
  }
  throw new Error('the version stayed Ready for Review, so its screenshots cannot change');
}

/** Everything App Review needs, then the version joins the products in the draft. */
async function ensureListing(app) {
  const version = await iosVersion(app);
  const localization = await ensureListingText(version.id);
  await ensureReviewContact(version.id);
  await ensureCompliance(app, version);
  await ensureAgeRating(app);
  await ensureAppInfo(app);
  await ensureAppPrice(app);
  // A screenshot set can only be created while the version is outside a submission, so
  // a slot that does not exist yet releases the draft just like a reshoot does.
  const wanted = [
    ['APP_IPHONE_61', SHOT_DIR_PHONE],
    ['APP_IPHONE_67', SHOT_DIR],
    ['APP_IPAD_PRO_3GEN_129', SHOT_DIR_IPAD],
    ['APP_IPHONE_DUO', SHOT_DIR_DUO],
  ].filter(([, directory]) => directory);
  const present = new Set(
    ((await call('GET', `/v1/appStoreVersionLocalizations/${localization.id}/appScreenshotSets?limit=30`).catch(() => null))?.data || [])
      .map((item) => item.attributes?.screenshotDisplayType),
  );
  const absent = wanted.map(([type]) => type).filter((type) => !present.has(type));
  if (REPLACE_SHOTS || PROBE || absent.length) await releaseVersion(app, version.id);
  console.log(`  screenshots · ${await ensureShotSet(localization.id, 'APP_IPHONE_61', SHOT_DIR_PHONE)}`);
  if (SHOT_DIR) console.log(`  screenshots · ${await ensureShotSet(localization.id, 'APP_IPHONE_67', SHOT_DIR)}`);
  console.log(`  screenshots · ${await ensureShotSet(localization.id, 'APP_IPAD_PRO_3GEN_129', SHOT_DIR_IPAD)}`);
  console.log(`  screenshots · ${await ensureShotSet(localization.id, 'APP_IPHONE_DUO', SHOT_DIR_DUO)}`);
  if (CREATIVE) console.log(`  header · ${await ensureCreative(app, localization.id)}`);
  if (PROBE) await probeDimensions(localization.id);
  await shotStates(localization.id);
  await placeInSubmission(app, version);
}

/**
 * Submit the draft itself.
 *
 * Everything else in this script edits a draft: products, listing, screenshots, the
 * build. None of it reaches App Review until the review submission is submitted, and
 * an empty one is refused by Apple anyway. This checks there is something to send
 * before sending it, then says what state came back.
 */
/**
 * Taking a version out of review is PATCH { canceled: true } on its submission.
 * DELETE is not offered on reviewSubmissions at all (403: allowed operations are
 * CREATE, GET_COLLECTION, GET_INSTANCE, UPDATE), and submitted:false is refused
 * because only one of (platform, canceled, submitted) may appear per request.
 * Canceling hands the version back editable — build, listing and review contact
 * intact — so a newer build can be swapped in and resubmitted.
 */
async function withdrawReview(app) {
  const drafts = await draftsFor(app);
  const live = (drafts || []).find((item) => ['WAITING_FOR_REVIEW', 'IN_REVIEW'].includes(item.attributes?.state));
  if (!live) {
    console.log('  withdraw · nothing is in review');
    return false;
  }
  const version = await iosVersion(app).catch(() => null);
  console.log(
    `  withdraw · submission ${live.id} · ${live.attributes?.state} · version ` +
      `${version?.attributes?.versionString} ${version?.attributes?.appStoreState}`
  );
  const result = await call('PATCH', `/v1/reviewSubmissions/${live.id}`, {
    data: { type: 'reviewSubmissions', id: live.id, attributes: { canceled: true } },
  });
  console.log(`  withdraw · submission now ${result?.data?.attributes?.state || 'unknown'}`);
  // Cancellation is a transition, not a switch. The version stays WAITING_FOR_REVIEW
  // for a few seconds and refuses a new build until it settles, which is how the
  // first attempt failed with INVALID_STATE on the build relationship.
  const settle = async () => (await iosVersion(app).catch(() => null))?.attributes?.appStoreState || 'unknown';
  let state = await settle();
  console.log(`  withdraw · version now ${state}`);
  for (let waited = 0; waited < 120000 && ['WAITING_FOR_REVIEW', 'IN_REVIEW'].includes(state); waited += 10000) {
    await new Promise((done) => setTimeout(done, 10000));
    state = await settle();
    console.log(`  withdraw · version ${state} after ${(waited + 10000) / 1000}s`);
  }
  return true;
}

async function publishForReview(app) {
  const drafts = await draftsFor(app);
  const open = (drafts || []).find((item) => item.attributes?.state === 'READY_FOR_REVIEW');
  if (!open) {
    console.log('  publish · no draft in READY_FOR_REVIEW — nothing was submitted');
    return false;
  }
  const items = await call('GET', `/v1/reviewSubmissions/${open.id}/items?limit=50`).catch(() => null);
  const count = (items?.data || []).length;
  console.log(`  publish · draft ${open.id} · ${count} item(s)`);
  if (!count) {
    console.log('  publish · refused: a submission with nothing in it');
    return false;
  }
  const version = await iosVersion(app);
  console.log(`  publish · version ${version.attributes?.versionString} · ${version.attributes?.appStoreState}`);
  const productCount = (await existingProducts(app)).size;
  if (count < 1 + productCount) {
    console.log(`  publish · refused: ${count} item(s) but expected ${1 + productCount} (the version plus every product)`);
    console.log('  publish · the products would go to the store unreviewed');
    return false;
  }
  // Apple allows exactly one of (platform, canceled, submitted) per request:
  // sending platform alongside submitted answers 409
  // ENTITY_ERROR.ATTRIBUTE.INVALID, which is how the first attempt failed.
  const result = await call('PATCH', `/v1/reviewSubmissions/${open.id}`, {
    data: {
      type: 'reviewSubmissions',
      id: open.id,
      attributes: { submitted: true },
    },
  });
  console.log(`  publish · submitted · state ${result?.data?.attributes?.state || 'unknown'}`);
  return true;
}

/**
 * Certificates belong to the team, not to the app, and Apple caps them: two
 * development and three distribution certificates per team. A development
 * certificate left behind by an old run holds one of those slots, and the next
 * archive is answered with "Choose a certificate to revoke" — which is exactly
 * how build 52 failed.
 *
 *   CERTS=list       print every certificate with its type and expiry
 *   CERTS=purge-dev  delete the development ones; distribution is never touched
 */
async function listCertificates() {
  const all = [];
  let path = '/v1/certificates?limit=200';
  while (path) {
    const page = await call('GET', path);
    all.push(...(page?.data || []));
    const next = page?.links?.next;
    path = next ? String(next).replace(API, '') : '';
  }
  return all;
}

function certLine(cert) {
  const a = cert.attributes || {};
  return `${String(a.certificateType || 'unknown').padEnd(20)} ${String(a.name || '').padEnd(44)} expires ${String(
    a.expirationDate || ''
  ).slice(0, 10)} · ${cert.id}`;
}

async function handleCertificates(mode) {
  const certs = await listCertificates();
  console.log(`  certificates · ${certs.length} on this team`);
  for (const cert of certs) console.log(`  ${certLine(cert)}`);
  if (!['purge-dev', 'purge-development', 'purge'].includes(mode)) return;

  // Only the iOS development certificates: a macOS development certificate belongs to
  // some other product on this team and deleting it would break that one instead.
  const dev = certs.filter((cert) => ['IOS_DEVELOPMENT', 'DEVELOPMENT'].includes(String(cert.attributes?.certificateType || '')));
  if (!dev.length) {
    console.log('  purge · no development certificates to remove');
    return;
  }
  for (const cert of dev) {
    try {
      await call('DELETE', `/v1/certificates/${cert.id}`);
      console.log(`  removed · ${certLine(cert)}`);
    } catch (error) {
      console.log(`  FAILED · ${certLine(cert)} · ${error.message}`);
      process.exitCode = 1;
    }
  }
  const after = await listCertificates();
  console.log(`  certificates · ${after.length} left on this team`);
  for (const cert of after) console.log(`  ${certLine(cert)}`);
}

if (CERTS) {
  await handleCertificates(CERTS);
  process.exit(process.exitCode || 0);
}

const app = await resolveAppId().catch((error) => {
  if (!agreementRefusal(error)) throw error;
  explainAgreementRefusal();
  process.exit(1);
});
console.log(`App ${BUNDLE} (${app}) · base territory ${TERRITORY}`);
await report(app);
if (RELEASE_CHECK) process.exit((await checkAttachedBuild(app)) ? 0 : 1);
if (WITHDRAW) await withdrawReview(app);
if (ATTACH) await attachVersion(app);
if (LISTING) await ensureListing(app);
if (PUBLISH) await publishForReview(app);
await readiness(app);
const iap = await existingProducts(app);

if (IAP_STATUS) {
  await reportProductStatus(app, iap);
  console.log(
    '  agreements · Apple did not refuse these calls, but a 200 here is not proof the Paid Apps row is signed:' +
      ' App Store Connect still reads metadata while it is unsigned and only refuses at the point of sale.'
  );
  console.log(
    '  agreements · an unsigned row is the usual reason StoreKit answers with no products at all.' +
      ' The Account Holder signs it at Business → Agreements → Paid Apps → View and Agree to Terms.'
  );
  process.exit(0);
}

const failed = [];
for (const plan of PLANS) {
  console.log(`- ${plan.productId}`);
  try {
    const product = await ensureProduct(app, iap, plan);
    await ensureLocalization(product, plan);
    await ensurePrice(product, plan);
    await ensureAvailability(product);
    console.log(`    screenshot · ${await ensureScreenshot(product)}`);
    if (SUBMIT) await submitForReview(product, plan);
  } catch (error) {
    failed.push(`${plan.productId}: ${error.message}`);
    console.log(`    FAILED · ${error.message}`);
  }
}

const after = await existingProducts(app);
console.log('\nState now:');
for (const plan of PLANS) {
  const found = after.get(plan.productId);
  console.log(`  ${plan.productId.padEnd(38)} ${found ? found.attributes?.state || 'unknown' : 'MISSING'}`);
}

if (failed.length) {
  console.error(`\n${failed.length} step failed:\n${failed.join('\n')}`);
  process.exit(1);
}
console.log('\nAll three products exist with display text, a price and availability.');
