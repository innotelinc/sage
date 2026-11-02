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
import { readFile } from 'node:fs/promises';

const API = 'https://api.appstoreconnect.apple.com';
const BUNDLE = (process.env.APPLE_BUNDLE_ID || 'us.innotel.sage').trim();
const TERRITORY = (process.env.ASC_BASE_TERRITORY || 'USA').trim();
const SUBMIT = /^(1|true|yes)$/i.test(String(process.env.SUBMIT || ''));
const SCREENSHOT = (process.env.IAP_SCREENSHOT || '').trim();

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

const app = await resolveAppId();
console.log(`App ${BUNDLE} (${app}) · base territory ${TERRITORY}`);
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
