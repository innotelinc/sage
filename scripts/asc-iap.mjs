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
const SITE = (process.env.SAGE_SITE || 'https://sage.innotel.tech').replace(/\/+$/, '');
const SHOT_DIR = (process.env.APP_STORE_SHOTS || '').trim();
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
  email: (process.env.APPLE_REVIEW_EMAIL || 'dhunter@innotel.us').trim(),
  // App Review telephones this number before rejecting, so it has to be one that is
  // answered. It is a repository secret: never written into the repo.
  phone: (process.env.APPLE_REVIEW_PHONE || '').trim(),
};

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
    'SESSIONS — access is sold in fifteen-minute sessions. One price, no subscription, no auto-renewal. Buy in the app and the clock stops capture for you when the window closes.',
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
  reviewNotes: [
    'Sage answers using an AI model reached through a session key. Sessions are the in-app purchase: three consumable plans, fifteen minutes of access each, no subscription.',
    'No login or demo account is needed. Open Settings (the gear, top right) then Session, choose a plan and complete the purchase with a sandbox Apple Account; the key installs itself when Apple confirms.',
    'Capture is opt-in and each source asks for permission the first time it is used: Listen (microphone), Watch (screen broadcast) and Aim (camera). Nothing leaves the device until one of those is pressed.',
  ].join('\n\n'),
};


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
    description: 'A 15-minute study session.',
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
    const versions = await call('GET', `/v1/apps/${app}/appStoreVersions?limit=20&include=build&fields[appStoreVersions]=versionString,platform,appStoreState,createdDate,releaseType`);
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
    const builds = await call('GET', `/v1/apps/${app}/builds?limit=5&fields[builds]=version,processingState,uploadedDate,expired`);
    for (const build of builds?.data || []) {
      line('build', `${build.attributes?.version} · ${build.attributes?.processingState}${build.attributes?.expired ? ' · expired' : ''}`);
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
    console.log(`  version ${version.attributes?.versionString} · build already attached`);
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
    console.log('  no open iOS submission to add the version to');
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
async function ensureReviewContact(versionId) {
  const current = await optional(`/v1/appStoreVersions/${versionId}/appStoreReviewDetail`);
  if (current?.data?.attributes?.contactEmail) {
    console.log('  review contact · already there');
    return;
  }
  if (!REVIEW.phone) {
    console.log('  review contact · SKIPPED — APPLE_REVIEW_PHONE is not set, and Apple requires a number');
    return;
  }
  await call('POST', '/v1/appStoreReviewDetails', {
    data: {
      type: 'appStoreReviewDetails',
      attributes: {
        contactFirstName: REVIEW.firstName,
        contactLastName: REVIEW.lastName,
        contactEmail: REVIEW.email,
        contactPhone: REVIEW.phone,
        demoAccountRequired: false,
        notes: COPY.reviewNotes,
      },
      relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } } },
    },
  });
  console.log(`  review contact · ${REVIEW.firstName} ${REVIEW.lastName} <${REVIEW.email}>`);
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
  if (current.length === names.length) return `${displayType} · already uploaded (${current.length})`;
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
    try {
      await call('POST', '/v1/reviewSubmissionItems', item(draft.id, 'appStoreVersion', 'appStoreVersions', version.id));
      const items = await call('GET', `/v1/reviewSubmissions/${draft.id}/items?limit=50`);
      console.log(`  submission · version ${version.attributes?.versionString} in draft ${draft.id} · ${(items?.data || []).length} items`);
      return;
    } catch (error) {
      explain(error);
    }
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
  // The three products do not travel as reviewSubmissionItems: Apple has no
  // inAppPurchase relationship on that resource, and they were put in a draft through
  // /v1/inAppPurchaseSubmissions when they were created. That endpoint is what joins
  // them to the submission once the app version is reviewable.
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


/** Everything App Review needs, then the version joins the products in the draft. */
async function ensureListing(app) {
  const version = await iosVersion(app);
  const localization = await ensureListingText(version.id);
  await ensureReviewContact(version.id);
  await ensureCompliance(app, version);
  await ensureAgeRating(app);
  await ensureAppInfo(app);
  await ensureAppPrice(app);
  console.log(`  screenshots · ${await ensureShotSet(localization.id, 'APP_IPHONE_67', SHOT_DIR)}`);
  console.log(`  screenshots · ${await ensureShotSet(localization.id, 'APP_IPAD_PRO_3GEN_129', SHOT_DIR_IPAD)}`);
  await placeInSubmission(app, version);
}

const app = await resolveAppId();
console.log(`App ${BUNDLE} (${app}) · base territory ${TERRITORY}`);
await report(app);
if (ATTACH) await attachVersion(app);
if (LISTING) await ensureListing(app);
await readiness(app);
const iap = await existingProducts(app);

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
