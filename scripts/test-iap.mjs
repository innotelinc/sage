#!/usr/bin/env node
/**
 * Tests for the purchase path.
 *
 * The interesting part of a StoreKit purchase is the signature, and a real one is
 * signed by Apple, so the chain here is built locally: an anchor of our own, an
 * intermediate, and a leaf, each genuinely signing the one below it. That exercises
 * the same code production runs — chain to a pinned anchor, ES256 over the payload —
 * without needing Apple's private key or a device.
 *
 * Run: node scripts/test-iap.mjs
 */
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleIap, iapConfig, verifySignedTransaction } from '../src/iap.mjs';

const dir = mkdtempSync(join(tmpdir(), 'sage-iap-'));
const file = (name) => join(dir, name);
const BUNDLE = 'us.innotel.sage';
// The consumables are registered under this prefix, which is not the bundle id.
const PRODUCT = 'us.inotnel.sage.session.trial';

let passed = 0;
const failures = [];

async function check(label, run) {
  try {
    const problem = await run();
    if (problem) throw new Error(problem);
    passed += 1;
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
    console.log(`  FAIL ${label} — ${error.message}`);
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

/* ---------------------------------------------------------------- the test chain */

function makeKey(name) {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  writeFileSync(file(`${name}.key`), privateKey.export({ type: 'pkcs8', format: 'pem' }));
  return file(`${name}.key`);
}

function selfSign(name, subject) {
  execFileSync('openssl', [
    'req', '-new', '-x509', '-sha256', '-days', '3650',
    '-key', file(`${name}.key`), '-subj', subject, '-out', file(`${name}.crt`),
  ]);
}

function issue(name, subject, issuer) {
  execFileSync('openssl', [
    'req', '-new', '-sha256',
    '-key', file(`${name}.key`), '-subj', subject, '-out', file(`${name}.csr`),
  ]);
  execFileSync('openssl', [
    'x509', '-req', '-sha256', '-days', '3650',
    '-in', file(`${name}.csr`),
    '-CA', file(`${issuer}.crt`), '-CAkey', file(`${issuer}.key`),
    '-CAcreateserial', '-CAserial', file('ca.srl'),
    '-out', file(`${name}.crt`),
  ]);
}

makeKey('root');
makeKey('intermediate');
makeKey('leaf');
selfSign('root', '/CN=Sage Test Root/O=Sage Test');
issue('intermediate', '/CN=Sage Test Intermediate/O=Sage Test', 'root');
issue('leaf', '/CN=Sage Test Leaf/O=Sage Test', 'intermediate');

const anchor = execFileSync('openssl', ['x509', '-in', file('root.crt'), '-noout', '-fingerprint', '-sha256'])
  .toString()
  .split('=')
  .pop()
  .replace(/[^0-9a-fA-F]/g, '')
  .toUpperCase();
const chain = ['leaf', 'intermediate', 'root'].map((name) => readFileSync(file(`${name}.crt`)).toString('base64'));

function jws(payload, { signedWith = 'leaf', x5c = chain } = {}) {
  const head = Buffer.from(JSON.stringify({ alg: 'ES256', x5c })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = sign('sha256', Buffer.from(`${head}.${body}`), {
    key: readFileSync(file(`${signedWith}.key`)),
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return `${head}.${body}.${signature}`;
}

function transaction(overrides = {}) {
  return {
    bundleId: BUNDLE,
    productId: PRODUCT,
    transactionId: '2000000000000001',
    quantity: 1,
    type: 'Consumable',
    environment: 'Sandbox',
    purchaseDate: Date.now(),
    inAppOwnershipType: 'PURCHASED',
    ...overrides,
  };
}

const options = { anchors: [anchor] };
const reason = (result) => result.error || (result.payload ? '' : 'accepted nothing and said why not');

/* -------------------------------------------------------------------- the checks */

console.log('verification');

await check('a genuine chain is accepted and the payload is returned', () => {
  const result = verifySignedTransaction(jws(transaction()), options);
  expect(result.payload, reason(result));
  expect(result.payload.transactionId === '2000000000000001', 'wrong transaction came back');
  expect(result.entry?.planSlug === 'sage-session-trial', 'the product did not map to a session plan');
});

await check('a chain that does not end at the anchor is refused', () => {
  const result = verifySignedTransaction(jws(transaction()), { anchors: ['00'.repeat(32)] });
  expect(result.error, 'a stranger root was accepted');
});

await check('a tampered payload is refused', () => {
  const signed = jws(transaction());
  const [head, , signature] = signed.split('.');
  const swapped = Buffer.from(JSON.stringify(transaction({ productId: `${BUNDLE}.session.intensive` }))).toString('base64url');
  const result = verifySignedTransaction(`${head}.${swapped}.${signature}`, options);
  expect(result.error, 'an edited payload kept its signature');
});

await check('a signature from a different key is refused', () => {
  makeKey('impostor');
  selfSign('impostor', '/CN=Sage Test Leaf/O=Sage Test');
  const result = verifySignedTransaction(jws(transaction(), { signedWith: 'impostor' }), options);
  expect(result.error, 'a signature from another leaf was accepted');
});

await check('a broken chain is refused', () => {
  const result = verifySignedTransaction(jws(transaction(), { x5c: [chain[0], chain[2]] }), options);
  expect(result.error, 'a chain with a missing intermediate was accepted');
});

await check('another app bundle is refused', () => {
  const result = verifySignedTransaction(jws(transaction({ bundleId: 'us.inotnel.other' })), options);
  expect(result.error, 'a transaction for another app was accepted');
});

await check('a refunded transaction is refused', () => {
  const result = verifySignedTransaction(jws(transaction({ revocationDate: Date.now() })), options);
  expect(/revoked|refund/i.test(result.error || ''), 'a revoked purchase was accepted');
});

await check('a non-consumable is refused', () => {
  const result = verifySignedTransaction(jws(transaction({ type: 'Auto-Renewable Subscription' })), options);
  expect(result.error, 'a subscription was accepted as a session');
});

await check('an unknown product is refused', () => {
  const result = verifySignedTransaction(jws(transaction({ productId: `${BUNDLE}.session.free` })), options);
  expect(result.error, 'a product this server does not sell was accepted');
});

await check('a local Xcode purchase is refused', () => {
  const result = verifySignedTransaction(jws(transaction({ environment: 'Xcode' })), options);
  expect(result.error, 'a local test transaction was accepted as a real purchase');
});

await check('a two-quantity purchase is refused', () => {
  const result = verifySignedTransaction(jws(transaction({ quantity: 2 })), options);
  expect(result.error, 'a multi-quantity purchase was accepted as one session');
});

await check('junk is refused without throwing', () => {
  for (const value of ['', 'not-a-jws', 'a.b.c', null, undefined, `${'a'.repeat(20000)}`]) {
    expect(verifySignedTransaction(value, options).error, `accepted ${String(value).slice(0, 20)}`);
  }
});

/* ---------------------------------------------------------------- the whole route */

console.log('purchase route');

const minted = [];
const server = createServer((request, response) => {
  let raw = '';
  request.on('data', (chunk) => {
    raw += chunk;
  });
  request.on('end', () => {
    const payload = (() => {
      try {
        return JSON.parse(raw);
      } catch {
        return {};
      }
    })();
    if (request.url === '/mint') {
      minted.push({ auth: request.headers.authorization, payload });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ key: 'sk-session-test', planName: 'Session · 15 min', secondsLeft: 900 }));
      return;
    }
    response.writeHead(502, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'billing is down' }));
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const env = {
  APPLE_BUNDLE_ID: BUNDLE,
  IAP_MINT_URL: `http://127.0.0.1:${port}/mint`,
  IAP_MINT_TOKEN: 'test-token',
  IAP_TRUST_ANCHORS: anchor,
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function purchase(signed, target = env) {
  const url = new URL('http://localhost:8787/api/iap/purchase');
  const request = new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ signedTransaction: signed, email: 'admin@innotel.us' }),
  });
  const response = await handleIap(request, url, target, json);
  return { status: response.status, body: await response.json() };
}

await check('purchase is disabled until a mint endpoint exists', async () => {
  expect(iapConfig({}).enabled === false, 'the button would appear with nowhere to mint');
  expect(iapConfig(env).enabled === true, 'a configured server still says disabled');
  expect(iapConfig({}).products.length === 3, 'the three consumables are not offered');
});

await check('a verified purchase becomes a session key', async () => {
  const result = await purchase(
    jws(transaction({ transactionId: '2000000000000100' })),
  );
  expect(result.status === 200, `answered ${result.status} ${JSON.stringify(result.body)}`);
  expect(result.body.key === 'sk-session-test', 'no key came back');
  expect(result.body.secondsLeft === 900, 'the session length did not survive');
  const call = minted[minted.length - 1];
  expect(call?.auth === 'Bearer test-token', 'the mint token was not sent');
  expect(call.payload.transactionId === '2000000000000100', 'the wrong transaction was minted');
  expect(call.payload.planSlug === 'sage-session-trial', 'the wrong plan was minted');
  expect(call.payload.environment === 'Sandbox', 'the environment was not passed through');
});

await check('the same purchase cannot be redeemed twice', async () => {
  const before = minted.length;
  const result = await purchase(jws(transaction({ transactionId: '2000000000000100' })));
  expect(result.status === 409, `answered ${result.status} instead of refusing a replay`);
  expect(minted.length === before, 'a replay reached the mint service');
});

await check('a forged purchase never reaches the mint service', async () => {
  const before = minted.length;
  const [head, , signature] = jws(transaction({ transactionId: '2000000000000200' })).split('.');
  const forged = Buffer.from(
    JSON.stringify(transaction({ transactionId: '2000000000000201' })),
  ).toString('base64url');
  const result = await purchase(`${head}.${forged}.${signature}`);
  expect(result.status === 400, `answered ${result.status} for a forged transaction`);
  expect(minted.length === before, 'a forged transaction was minted');
});

await check('a missing signed transaction is a bad request', async () => {
  const result = await purchase('');
  expect(result.status === 400, `answered ${result.status}`);
});

await check('a failing mint service is reported, not swallowed', async () => {
  const broken = { ...env, IAP_MINT_URL: `http://127.0.0.1:${port}/fail` };
  const result = await purchase(jws(transaction({ transactionId: '2000000000000300' })), broken);
  expect(result.status === 502, `answered ${result.status}`);
  expect(/billing is down/.test(result.body.message || ''), 'the reason was lost');
});

await new Promise((resolve) => server.close(resolve));

console.log('');
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} failed`);
  for (const failure of failures) console.log(`  · ${failure}`);
  process.exit(1);
}
console.log(`${passed} passed`);
