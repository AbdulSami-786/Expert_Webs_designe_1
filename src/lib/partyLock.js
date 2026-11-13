// Per-party ledger lock.
//
// A party can carry its own password. Its ledger then opens only after that
// password is entered, so a customer standing at the counter — or anyone
// glancing at the screen — cannot open a private account by clicking a name.
//
// Only a salted hash is stored on the party (lockHash / lockSalt). The check
// runs here, on the device, so it works with no internet. It is a screen lock,
// not encryption: the ledger's numbers are still in the app's data, and other
// screens (All Bills, Outstanding) still list them.

const UNLOCK_MS = 10 * 60 * 1000;   // stays open for 10 minutes
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 60 * 1000;
const ATTEMPTS_KEY = 'ewd_party_lock_attempts';

// In memory only: closing or reloading the app locks every party again.
const unlockedUntil = new Map();

export async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Same formula as saltedHash() in apps-script/Code.gs, so either side can check. */
export function lockHashFor(password, salt) {
  return sha256(`${salt || ''}:${password || ''}`);
}

export function isLocked(party) {
  return Boolean(party?.lockHash);
}

export function isUnlocked(partyId) {
  const until = unlockedUntil.get(partyId);
  if (!until) return false;
  if (Date.now() >= until) { unlockedUntil.delete(partyId); return false; }
  return true;
}

/** Can this party's ledger be shown right now? */
export function canOpen(party) {
  return !isLocked(party) || isUnlocked(party.id);
}

/** Treat the ledger as unlocked — used right after its password was just set. */
export function markUnlocked(partyId) {
  unlockedUntil.set(partyId, Date.now() + UNLOCK_MS);
}

export function relock(partyId) {
  unlockedUntil.delete(partyId);
}

export function relockAll() {
  unlockedUntil.clear();
}

function readAttempts() {
  try { return JSON.parse(localStorage.getItem(ATTEMPTS_KEY) || '{}') || {}; }
  catch { return {}; }
}

function writeAttempts(all) {
  try { localStorage.setItem(ATTEMPTS_KEY, JSON.stringify(all)); } catch { /* ignore */ }
}

/** Seconds before this party can be tried again, or 0. */
export function lockoutRemaining(partyId) {
  const rec = readAttempts()[partyId];
  if (!rec || rec.count < MAX_ATTEMPTS) return 0;
  const left = rec.at + LOCKOUT_MS - Date.now();
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

/**
 * Try a password. Resolves true and unlocks on success. Throws a message
 * meant for the screen when locked out; resolves false on a wrong password.
 */
export async function tryUnlock(party, password) {
  const wait = lockoutRemaining(party.id);
  if (wait > 0) throw new Error(`Too many wrong tries. Try again in ${wait} seconds.`);

  const ok = (await lockHashFor(password, party.lockSalt)) === party.lockHash;
  const all = readAttempts();
  if (ok) {
    delete all[party.id];
    writeAttempts(all);
    unlockedUntil.set(party.id, Date.now() + UNLOCK_MS);
    return true;
  }
  const rec = all[party.id] || { count: 0, at: 0 };
  if (rec.count >= MAX_ATTEMPTS && rec.at + LOCKOUT_MS <= Date.now()) rec.count = 0;
  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) rec.at = Date.now();
  all[party.id] = rec;
  writeAttempts(all);
  return false;
}
