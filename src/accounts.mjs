/**
 * Subscriber accounts.
 *
 * The self-hosted SAGE was guarded by one access code: an instance belonged to
 * the person who ran it. A SaaS instance belongs to nobody in particular, so an
 * account is the identity and the subscription attached to it is what buys the
 * right to spend the gateway key.
 *
 * Files, not a database, for the same reason the panel uses a file: one Node
 * process, one volume, and a document small enough to rewrite whole and rename
 * into place. Only a salted scrypt digest of a password is kept, so a copied
 * `accounts.json` is not a set of logins.
 *
 * Every write goes through one queue, so two sign-ups landing together cannot
 * interleave into a broken file.
 */
import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseCookies, setCookie, dropCookie, signPayload, readPayload } from './session.mjs';

export const ACCOUNT_COOKIE = 'sage_account';
const SESSION_TTL = 30 * 24 * 60 * 60;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const MIN_PASSWORD = 8;

function dataDir() {
  return process.env.SAGE_DATA_DIR || path.join(process.cwd(), 'data');
}

function accountsFile() {
  return path.join(dataDir(), 'accounts.json');
}

// `accounts` is keyed by account id; `byEmail` is the index, kept beside it so a
// sign-in is a lookup rather than a scan.
let accounts = {};
let byEmail = {};
let loaded = false;
let queue = Promise.resolve();

function scryptAsync(password, salt) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await scryptAsync(password, salt);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt}$${key.toString('hex')}`;
}

async function verifyPassword(stored, password) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, hex] = parts;
  const expected = Buffer.from(hex, 'hex');
  const key = await new Promise((resolve, reject) => {
    scrypt(password, salt, expected.length, { N: Number(n), r: Number(r), p: Number(p) }, (error, out) =>
      error ? reject(error) : resolve(out),
    );
  });
  if (key.length !== expected.length) return false;
  return timingSafeEqual(key, expected);
}

export async function loadAccounts() {
  try {
    const parsed = JSON.parse(await readFile(accountsFile(), 'utf8'));
    accounts = parsed && typeof parsed.accounts === 'object' && parsed.accounts ? parsed.accounts : {};
    byEmail = parsed && typeof parsed.byEmail === 'object' && parsed.byEmail ? parsed.byEmail : {};
    // A file written before the index existed is repaired on read rather than
    // refused, so an upgrade never loses sign-ins.
    for (const [id, account] of Object.entries(accounts)) {
      if (account && account.email) byEmail[String(account.email).toLowerCase()] = id;
    }
    loaded = true;
  } catch {
    accounts = {};
    byEmail = {};
    loaded = true;
  }
  return loaded;
}

function persist() {
  const snapshot = JSON.stringify({ version: 1, accounts, byEmail }, null, 2);
  queue = queue
    .then(async () => {
      await mkdir(dataDir(), { recursive: true, mode: 0o700 });
      const target = accountsFile();
      const temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, `${snapshot}\n`, { mode: 0o600 });
      try {
        await rename(temporary, target);
      } catch {
        // Windows refuses a rename over a file another handle is holding — a
        // scanner, an editor, a slow reader. A sign-up must not be lost to that,
        // so write in place: slightly less atomic, never silently dropped.
        await writeFile(target, `${snapshot}\n`, { mode: 0o600 });
        await rm(temporary, { force: true });
      }
    })
    .catch((error) => {
      console.error('Could not write accounts:', error.message);
    });
  return queue;
}

/** Stay in step with the file when the process outlives a manual edit. */
async function ready() {
  if (!loaded) await loadAccounts();
}

export function normaliseEmail(value) {
  return String(value || '').trim().toLowerCase();
}

export function validEmail(value) {
  const email = normaliseEmail(value);
  return email.length <= 200 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}

export function accountById(id) {
  return accounts[String(id || '')] || null;
}

export function accountByEmail(email) {
  const id = byEmail[normaliseEmail(email)];
  return id ? accounts[id] || null : null;
}

export function accountCount() {
  return Object.keys(accounts).length;
}

/** Every account record. Used for lookups a webhook can only state by customer. */
export function allAccounts() {
  return Object.values(accounts);
}

function publicAccount(account) {
  if (!account) return null;
  return {
    id: account.id,
    email: account.email,
    plan: account.plan || null,
    status: account.status || 'none',
    currentPeriodEnd: account.currentPeriodEnd || null,
    cancelAtPeriodEnd: Boolean(account.cancelAtPeriodEnd),
    hasCustomer: Boolean(account.stripeCustomerId),
    createdAt: account.createdAt || null,
    usage: monthUsage(account),
  };
}

export { publicAccount };

/** Answers are counted per calendar month; the plan's cap is what the gate reads. */
export function monthKey(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

export function monthUsage(account, date = new Date()) {
  const key = monthKey(date);
  return { month: key, used: Number(account?.usage?.[key]?.answers) || 0 };
}

export async function createAccount({ email, password }) {
  await ready();
  const normalised = normaliseEmail(email);
  if (!validEmail(normalised)) throw Object.assign(new Error('That email address does not look right.'), { status: 400 });
  if (byEmail[normalised]) throw Object.assign(new Error('That email already has an account — sign in instead.'), { status: 409 });
  const secret = String(password || '');
  if (secret.length < MIN_PASSWORD) {
    throw Object.assign(new Error(`Use at least ${MIN_PASSWORD} characters for the password.`), { status: 400 });
  }
  if (secret.length > 200) throw Object.assign(new Error('That password is too long (200 characters at most).'), { status: 400 });

  const id = randomBytes(12).toString('hex');
  const account = {
    id,
    email: normalised,
    passwordHash: await hashPassword(secret),
    plan: null,
    status: 'none',
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    usage: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  accounts[id] = account;
  byEmail[normalised] = id;
  await persist();
  return publicAccount(account);
}

export async function authenticate({ email, password }) {
  await ready();
  const account = accountByEmail(email);
  // A wrong email and a wrong password answer the same way, so the form cannot
  // be used to find out who has an account.
  const refused = Object.assign(new Error('Email or password is wrong.'), { status: 401 });
  if (!account) {
    await verifyPassword('scrypt$16384$8$1$00$00', String(password || ''));
    throw refused;
  }
  if (!(await verifyPassword(account.passwordHash, String(password || '')))) throw refused;
  return publicAccount(account);
}

/** Apply a billing change. The raw record is returned so callers can persist. */
export async function patchAccount(id, patch) {
  await ready();
  const account = accounts[String(id || '')];
  if (!account) return null;
  Object.assign(account, patch, { updatedAt: new Date().toISOString() });
  await persist();
  return publicAccount(account);
}

export async function setPassword(id, password) {
  await ready();
  const account = accounts[String(id || '')];
  if (!account) throw Object.assign(new Error('No such account.'), { status: 404 });
  const secret = String(password || '');
  if (secret.length < MIN_PASSWORD) throw Object.assign(new Error('That password is too short.'), { status: 400 });
  account.passwordHash = await hashPassword(secret);
  account.updatedAt = new Date().toISOString();
  await persist();
  return publicAccount(account);
}

/**
 * Count one answered turn against the month.
 *
 * The count is kept per account rather than per device: a subscription is one
 * person, and a phone plus a laptop is still one person.
 */
export async function recordAnswer(id) {
  await ready();
  const account = accounts[String(id || '')];
  if (!account) return null;
  const key = monthKey();
  const bucket = account.usage?.[key] || { answers: 0 };
  bucket.answers = Number(bucket.answers || 0) + 1;
  account.usage = { ...(account.usage || {}), [key]: bucket };
  // Two months of history is enough for a "how much did I use" line and small
  // enough that the file cannot grow without bound.
  const keep = [monthKey(), monthKey(new Date(Date.now() - 31 * 86400000))];
  for (const existing of Object.keys(account.usage)) {
    if (!keep.includes(existing)) delete account.usage[existing];
  }
  account.updatedAt = new Date().toISOString();
  await persist();
  return { used: bucket.answers, month: key };
}

/* ── session cookie ───────────────────────────────────────── */
/* The same HMAC cookie the panel uses, under its own name and secret, so an
   operator signed in to /admin is not automatically signed in as a subscriber
   and vice versa. */

export function accountSecret(env = {}) {
  return String(env.SAGE_SESSION_SECRET || env.SAGE_ADMIN_SECRET || '').trim();
}

function randomSecretFallback() {
  // A deployment with no secret would silently accept no logins; say so loudly
  // rather than pretend the gate works.
  console.error('SAGE_SESSION_SECRET (or SAGE_ADMIN_SECRET) is not set — subscriber sessions cannot be issued.');
  return '';
}

export function issueAccountCookie(account, env = {}, url = null) {
  const secret = accountSecret(env);
  if (!secret) {
    randomSecretFallback();
    return null;
  }
  const token = signPayload({ sub: account.id, email: account.email, kind: 'account' }, secret, SESSION_TTL);
  return setCookie(ACCOUNT_COOKIE, token, {
    secure: Boolean((env.APP_ORIGIN || '').startsWith('https://') || url?.protocol === 'https:'),
    maxAgeSeconds: SESSION_TTL,
  });
}

export function clearAccountCookie(env = {}, url = null) {
  return dropCookie(ACCOUNT_COOKIE, {
    secure: Boolean((env.APP_ORIGIN || '').startsWith('https://') || url?.protocol === 'https:'),
  });
}

/** The signed-in account for this request, or null. */
export async function accountFromRequest(request, env = {}) {
  const secret = accountSecret(env);
  if (!secret) return null;
  const jar = parseCookies(request.headers.get('cookie') || '');
  const session = readPayload(jar[ACCOUNT_COOKIE], secret);
  if (!session || session.kind !== 'account' || !session.sub) return null;
  await ready();
  return accountById(session.sub);
}

/** A stable, non-reversible key for anything stored per subscriber. */
export function identityKey(id) {
  return createHash('sha256').update(String(id)).digest('hex').slice(0, 32);
}
