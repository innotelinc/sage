/**
 * Instance settings that can change while the server runs.
 *
 * The access code used to be whatever `ACCESS_CODE` said at boot, so changing it
 * meant editing `.env` and restarting the container — not something you can do
 * from a phone. It now lives in `data/settings.json`, which the admin panel
 * writes; the environment variable stays as the bootstrap value for a fresh
 * instance and as the fallback when the file is absent.
 *
 * Only a salted SHA-256 digest is kept, so a copied file does not hand anyone
 * the code, and the panel can still say truthfully whether one is set.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

function dataDir() {
  return process.env.SAGE_DATA_DIR || path.join(process.cwd(), 'data');
}

function settingsFile() {
  return path.join(dataDir(), 'settings.json');
}

// `loaded` says the file exists, which is what lets an explicit "off" beat an
// inherited ACCESS_CODE. Without the file, the environment decides.
let loaded = false;
let current = { accessCode: null, updatedAt: null, updatedBy: null };
let lastError = '';

function digest(salt, code) {
  return createHash('sha256').update(`${salt}:${code}`).digest('hex');
}

function safeEqualHex(a, b) {
  const left = Buffer.from(String(a), 'hex');
  const right = Buffer.from(String(b), 'hex');
  if (left.length !== right.length || !left.length) return false;
  return timingSafeEqual(left, right);
}

export async function loadSettings() {
  try {
    const raw = await readFile(settingsFile(), 'utf8');
    const parsed = JSON.parse(raw);
    const code = parsed.accessCode;
    current = {
      accessCode:
        code && typeof code === 'object' && code.hash
          ? { salt: String(code.salt || ''), hash: String(code.hash || '') }
          : null,
      updatedAt: parsed.updatedAt || null,
      updatedBy: parsed.updatedBy || null,
    };
    loaded = true;
    lastError = '';
  } catch (error) {
    loaded = false;
    current = { accessCode: null, updatedAt: null, updatedBy: null };
    lastError = error.code === 'ENOENT' ? '' : error.message;
  }
  return { loaded, ...current, error: lastError };
}

async function persist(next) {
  const dir = dataDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = settingsFile();
  const temporary = `${target}.${process.pid}.tmp`;
  const body = JSON.stringify(
    {
      version: 1,
      accessCode: next.accessCode,
      updatedAt: next.updatedAt,
      updatedBy: next.updatedBy,
    },
    null,
    2,
  );
  await writeFile(temporary, `${body}\n`, { mode: 0o600 });
  await rename(temporary, target);
  current = next;
  loaded = true;
  lastError = '';
  return { loaded, ...current, error: '' };
}

/**
 * A code is required when the file sets one, or when no file exists and the
 * environment supplied one. An explicit clear in the panel writes a file with
 * no code, which switches the requirement off even if ACCESS_CODE is still in
 * the container's environment.
 */
export function accessRequired(envCode = '') {
  if (loaded) return Boolean(current.accessCode);
  return Boolean(envCode);
}

/** Who is allowed in, compared in constant time so a wrong code cannot be probed. */
export function accessAccepted(candidate, envCode = '') {
  const provided = String(candidate || '');
  if (!provided) return false;
  if (loaded) {
    if (!current.accessCode) return true; // no code is required at all
    return safeEqualHex(digest(current.accessCode.salt, provided), current.accessCode.hash);
  }
  return Boolean(envCode) && provided === envCode;
}

export async function setAccessCode(code, by = '') {
  const trimmed = String(code || '');
  if (trimmed.length < 6) {
    throw new Error('Use at least 6 characters — this is the only thing standing in front of the instance.');
  }
  if (trimmed.length > 200) throw new Error('That code is too long (200 characters at most).');
  const salt = randomBytes(16).toString('hex');
  return persist({
    accessCode: { salt, hash: digest(salt, trimmed) },
    updatedAt: new Date().toISOString(),
    updatedBy: String(by || '').slice(0, 200),
  });
}

export async function clearAccessCode(by = '') {
  return persist({
    accessCode: null,
    updatedAt: new Date().toISOString(),
    updatedBy: String(by || '').slice(0, 200),
  });
}

/** What the panel may show: never the code, only whether one exists. */
export function settingsStatus(envCode = '') {
  return {
    source: loaded ? 'panel' : envCode ? 'environment' : 'none',
    required: accessRequired(envCode),
    updatedAt: current.updatedAt,
    updatedBy: current.updatedBy,
    writable: true,
    file: settingsFile(),
    error: lastError,
  };
}
