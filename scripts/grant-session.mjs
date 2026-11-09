/**
 * Mint a session code without the App Store.
 *
 *   SESSION_GRANT_SECRET=… node scripts/grant-session.mjs --plan standard --email me@example.com
 *
 * The secret must be the one the server holds (`SESSION_GRANT_SECRET`, or
 * `SAGE_ADMIN_SECRET` if that is what is configured). Nothing is sent anywhere: the
 * code is signed here and redeemed by the app through `/api/iap/grant`, which mints the
 * session with the same key service a purchase uses.
 *
 * Print it, paste it into Settings → Session → "Use a session code" on the phone, and
 * the session installs exactly as a bought one would.
 */
import { signGrant } from '../src/grants.mjs';
import { sessionPlan } from '../src/plans.mjs';

const args = process.argv.slice(2);
function arg(name, fallback = '') {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? String(args[index + 1] || '') : fallback;
}

const planSlug = arg('plan', 'sage-session-standard');
const email = arg('email', '').trim();
const days = Number(arg('days', '7')) || 7;

const plan = sessionPlan(planSlug);
if (!plan) {
  console.error(`Unknown plan "${planSlug}". Try one of: sage-session-trial, sage-session-standard, sage-session-intensive.`);
  process.exit(1);
}

const secret = String(process.env.SESSION_GRANT_SECRET || process.env.SAGE_ADMIN_SECRET || '').trim();
if (!secret) {
  console.error('Set SESSION_GRANT_SECRET (the value the server holds) to mint a code.');
  process.exit(1);
}

const code = await signGrant({ planSlug, email, ttlMinutes: days * 24 * 60 }, secret);
console.log(code);
console.error(`\n${plan.name} · ${plan.minutes} minutes · expires in ${days} day${days === 1 ? '' : 's'}`);
if (email) console.error(`issued for ${email}`);
console.error('Paste it into Settings → Session → "Use a session code".');
