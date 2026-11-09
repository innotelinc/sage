/**
 * Session codes: the thing between a pasted string and a paid-for session.
 *
 * A grant is the only billing path that works while the App Store agreement is
 * missing, so its three promises are checked here rather than discovered: a code
 * verifies with the same secret and nothing else, an expired or edited code is
 * refused, and two codes are never the same code.
 */
import { signGrant, verifyGrant } from '../src/grants.mjs';

let passed = 0;
const failed = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (error) {
    failed.push(`${name}: ${error.message}`);
  }
}

function eq(actual, expected, what) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${what} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const SECRET = 'test-secret-not-a-real-one';

await check('a code verifies with the secret that signed it', async () => {
  const code = await signGrant({ planSlug: 'sage-session-standard', email: 'a@example.com' }, SECRET);
  const result = await verifyGrant(code, SECRET);
  eq(result.grant.planSlug, 'sage-session-standard', 'plan');
  eq(result.grant.email, 'a@example.com', 'email');
});

await check('a code signed with another secret is refused', async () => {
  const code = await signGrant({ planSlug: 'sage-session-standard' }, SECRET);
  const result = await verifyGrant(code, 'a-different-secret');
  eq(result.error, 'that session code is not genuine', 'refusal');
});

await check('an edited payload is refused', async () => {
  const code = await signGrant({ planSlug: 'sage-session-standard' }, SECRET);
  const [version, body, signature] = code.split('.');
  const forged = JSON.stringify({ v: 1, plan: 'sage-session-intensive', email: '', exp: Date.now() + 60000, n: 'x' });
  const edited = `${version}.${Buffer.from(forged).toString('base64url')}.${signature}`;
  const result = await verifyGrant(edited, SECRET);
  eq(result.error, 'that session code is not genuine', 'refusal');
});

await check('an expired code is refused, and says why', async () => {
  const code = await signGrant({ planSlug: 'sage-session-standard', ttlMinutes: -1 }, SECRET);
  const result = await verifyGrant(code, SECRET);
  eq(result.error, 'that session code has expired', 'refusal');
});

await check('two codes for the same plan are different codes', async () => {
  const a = await signGrant({ planSlug: 'sage-session-standard' }, SECRET);
  const b = await signGrant({ planSlug: 'sage-session-standard' }, SECRET);
  if (a === b) throw new Error('two grants were identical, so one would be replayable');
});

await check('garbage is refused without throwing', async () => {
  eq((await verifyGrant('not-a-code', SECRET)).error, 'that is not a session code', 'shape');
  eq((await verifyGrant('sage1.abc', SECRET)).error, 'that is not a session code', 'segments');
});

await check('no secret means grants are off, not open', async () => {
  const code = await signGrant({ planSlug: 'sage-session-standard' }, SECRET);
  eq((await verifyGrant(code, '')).error, 'session grants are not enabled on this server', 'off');
});

console.log(`\n${passed} passed`);
if (failed.length) {
  console.error(`\n${failed.length} failed:\n${failed.join('\n')}`);
  process.exit(1);
}
