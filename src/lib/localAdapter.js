// Local backend adapter — browser localStorage.
//
// Implements exactly the same action contract as the Apps Script backend, so
// the app behaves identically against either. Every write here mirrors what
// apps-script/Code.gs does server-side, including Activity Log entries
// (Safety Guide 2.2) and the never-delete rule (Safety Guide 2.1).

import { CONFIG, DEFAULT_METHODS } from './config';
import { uid, todayISO, r2, addDays } from './format';
import {
  billTotals, billState, billPaymentRoom, lineDeliveredQty, lineReceivedQty, supplierBalance,
} from './calc';

const DB_KEY = 'ewd_db_v1';
const SESSION_KEY = 'ewd_session';

/* ------------------------------------------------------------------ */
/* Password hashing                                                    */
/* ------------------------------------------------------------------ */
// NFR-5: passwords are stored hashed, never plaintext. The local adapter uses
// the same SHA-256 approach the Apps Script backend uses.

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

function emptyDb() {
  return {
    parties: [], items: [], partyItemPrices: [],
    bills: [], billItems: [], payments: [], returns: [],
    cheques: [], partyAdvances: [], purchases: [],
    employees: [], employeeTx: [],
    expenses: [], stockLoss: [], assets: [],
    activityLog: [], users: [], partyLedgerLinks: [],
    // The buying side: suppliers, their purchase bills (lines live in
    // `purchases`), payments made to them and goods sent back to them.
    suppliers: [], purchaseBills: [], supplierPayments: [], supplierReturns: [],
    // Sync bookkeeping (see lib/sync.js). `touched` maps a record id to the
    // time it was last written on this device, which is how the server decides
    // a conflict. It lives outside the record so no sheet column is needed.
    sync: { touched: {}, lastPushAt: '', lastPullAt: '' },
    settings: {
      shopName: CONFIG.defaultShopName,
      phone: '', address: '', email: '', logoUrl: '',
      roundingRule: 'nearest1',
      priceAlertThreshold: 15,
      defaultCreditDays: 7,
      customMethods: [],
    },
    billCounter: {},
  };
}

function read() {
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (raw) return { ...emptyDb(), ...JSON.parse(raw) };
  } catch (e) {
    console.error('Local DB read failed, starting fresh', e);
  }
  return null;
}

function write(db) {
  try {
    localStorage.setItem(DB_KEY, JSON.stringify(db));
  } catch (e) {
    // A blocked write (quota exceeded, or Safari/Firefox private mode) must
    // never look like a success: the record would sit in memory, appear saved,
    // and vanish on the next reload. Surfacing it lets the UI show the error.
    throw new Error(
      'Could not save to this device’s storage. It may be full, or the browser ' +
      'is in private mode. Free up space or export a backup, then try again.'
    );
  }
  return db;
}

let _db = null;

/**
 * The live database.
 *
 * Always re-read from localStorage rather than trusting the in-memory copy.
 * The dashboard is routinely open in more than one place at once — a second
 * tab, a bill receipt opened in a new window, the shared-ledger link — and all
 * of them share this one origin's storage. A cached copy goes stale the moment
 * any other tab writes, and because every action here saves the WHOLE object,
 * a stale copy silently erases whatever the other tab added. That is what made
 * newly created parties and items disappear from the New Bill screen.
 *
 * Re-reading costs a JSON.parse per action, which is negligible next to losing
 * a party the user just typed in.
 */
function db() {
  _db = read();
  if (!_db) {
    _db = emptyDb();
    if (CONFIG.seedDemoData) seed(_db);
    ensureAdmin(_db);
    write(_db);
  } else {
    // A DB written by an earlier build can predate the admin user.
    ensureAdmin(_db);
  }
  return _db;
}

/** Collections that sync with the Google Sheet (see SYNC_TABS in sync.js). */
export const SYNCED_KEYS = [
  'parties', 'items', 'employees', 'assets', 'purchases', 'bills', 'billItems',
  'partyItemPrices', 'payments', 'returns', 'cheques', 'partyAdvances',
  'employeeTx', 'expenses', 'stockLoss',
  'suppliers', 'purchaseBills', 'supplierPayments', 'supplierReturns',
];

/**
 * Remember every synced record that this write removed.
 *
 * Sync downloads the Sheet's records into this device. Without a note of what
 * was deleted here, a deleted payment — or the old lines of an edited bill —
 * would simply be downloaded again and reappear. The note also tells the next
 * upload to delete the same rows from the Sheet.
 *
 * Done by comparing against what is still in storage, so every delete in this
 * file is covered without each action having to remember to record it.
 */
function recordRemovals(prev, next) {
  if (!prev) return;
  const now = new Date().toISOString();
  for (const key of SYNCED_KEYS) {
    const kept = new Set((next[key] || []).map((r) => r?.id));
    for (const rec of prev[key] || []) {
      if (rec?.id && !kept.has(rec.id)) {
        next.sync = next.sync || { touched: {}, lastPushAt: '', lastPullAt: '' };
        next.sync.deleted = next.sync.deleted || {};
        next.sync.deleted[rec.id] = { key, at: now };
      }
    }
  }
}

function save() {
  recordRemovals(read(), _db);
  const result = write(_db);
  // Tells the sync engine there is something new to upload, so that with
  // internet the Google Sheet updates right after the write rather than on the
  // next timer tick.
  try { window.dispatchEvent(new CustomEvent('ewd:data-changed')); }
  catch { /* no window (tests); the timer and reconnect still cover it */ }
  return result;
}

/** Seed a default super admin (username: admin / password: admin123). */
function ensureAdmin(d) {
  if (!d.users.length) {
    // SHA-256 of "admin123", precomputed so first load needs no async work.
    d.users.push({
      id: uid('usr'), username: 'admin', fullName: 'Super Admin', role: 'admin',
      status: 'active', allowedPages: [], createdAt: new Date().toISOString(),
      passwordHash: '240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9',
    });
  }
}

/* ------------------------------------------------------------------ */
/* User management helpers                                             */
/* ------------------------------------------------------------------ */

const isSuper = (u) => u?.role === 'admin' || u?.role === 'superadmin';
const isActiveUser = (u) => (u?.status || 'active') !== 'inactive';

/** A user as the UI may see it — never the password hash. */
function publicUser(u) {
  return {
    id: u.id, username: u.username, fullName: u.fullName || '',
    role: isSuper(u) ? 'admin' : 'user',
    status: isActiveUser(u) ? 'active' : 'inactive',
    allowedPages: Array.isArray(u.allowedPages) ? u.allowedPages : [],
    createdAt: u.createdAt || '',
  };
}

/** The account behind the current session, or undefined. */
function sessionUser(d) {
  const name = String(readSession()?.username || '').toLowerCase();
  return d.users.find((u) => String(u.username).toLowerCase() === name);
}

/** Only an active super admin may manage users. */
function requireSuperAdmin(d) {
  const me = sessionUser(d);
  if (!me || !isSuper(me) || !isActiveUser(me)) {
    throw new Error('Only a super admin can manage users.');
  }
  return me;
}

/** How many active super admins exist besides this one. */
function otherActiveAdmins(d, exceptId) {
  return d.users.filter((u) => u.id !== exceptId && isSuper(u) && isActiveUser(u)).length;
}

function cleanPages(pages) {
  if (!Array.isArray(pages)) return [];
  return [...new Set(pages.map(String).filter((k) => /^[a-z-]{2,30}$/.test(k)))];
}

function validUsername(raw) {
  const name = String(raw || '').trim();
  if (!/^[A-Za-z0-9._-]{3,30}$/.test(name)) {
    throw new Error('Username must be 3–30 characters: letters, numbers, dot, dash or underscore.');
  }
  return name;
}

/* ------------------------------------------------------------------ */
/* Session lifetime + login throttling                                 */
/* ------------------------------------------------------------------ */

// A session does not expire. Signing in once is meant to last: the till is
// open all day, a re-login prompt in the middle of a sale is worse than a
// browser left signed in, and the device is the shop's own. Ten years rather
// than Infinity so expiresAt stays a real timestamp everything can compare
// against — the expiry machinery still works, it just never fires in practice.
//
// Signing out is still possible, and still deliberate: the logout button.
// Matches SESSION_TTL_MS in apps-script/Code.gs, which is the one that counts
// on the 'sheets' backend.
export const SESSION_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000;

const LOCK_KEY = 'ewd_login_attempts';
const MAX_ATTEMPTS = 5;
const LOCK_MS = 60 * 1000;

function readAttempts() {
  try { return JSON.parse(localStorage.getItem(LOCK_KEY) || '{}') || {}; }
  catch { return {}; }
}

/** Seconds left on a lockout for this username, or 0 if it may try now. */
export function loginLockRemaining(username) {
  const rec = readAttempts()[username];
  if (!rec || rec.count < MAX_ATTEMPTS) return 0;
  const left = rec.lockedAt + LOCK_MS - Date.now();
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

function recordLoginFailure(username) {
  const all = readAttempts();
  const rec = all[username] || { count: 0, lockedAt: 0 };
  // A lockout that has already expired starts the count over.
  if (rec.count >= MAX_ATTEMPTS && rec.lockedAt + LOCK_MS <= Date.now()) rec.count = 0;
  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) rec.lockedAt = Date.now();
  all[username] = rec;
  localStorage.setItem(LOCK_KEY, JSON.stringify(all));
}

function clearLoginFailures(username) {
  const all = readAttempts();
  delete all[username];
  localStorage.setItem(LOCK_KEY, JSON.stringify(all));
}

/** The stored session, or null if it is missing, malformed or expired. */
export function readSession() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    if (!s?.token) return null;
    // Sessions written before expiry existed have no expiresAt — treat them as
    // expired rather than granting them an unlimited lifetime.
    if (!s.expiresAt || Date.now() >= s.expiresAt) {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }
    return s;
  } catch { return null; }
}

export function getToken() {
  return readSession()?.token || null;
}

/* ------------------------------------------------------------------ */
/* Activity log (Safety Guide 2.2 / FR-27)                             */
/* ------------------------------------------------------------------ */

/**
 * Record that this device wrote `id` just now.
 *
 * Sync compares these times against the server's to settle a conflict, so a
 * record edited here after the last push is recognised as the newer one. It is
 * kept beside the data rather than on it, so the Google Sheet needs no extra
 * column.
 */
/**
 * A phone reduced to its comparable form, so "0300-1234567", "+923001234567"
 * and 3001234567 (a number Sheets stripped the 0 from) all match. Mirrors
 * phoneKey() in apps-script/Code.gs.
 */
export function phoneKey(v) {
  let d = String(v ?? '').replace(/\D/g, '');
  if (/^92\d{10}$/.test(d)) d = '0' + d.slice(2);
  if (/^3\d{9}$/.test(d)) d = '0' + d;
  return d;
}

/**
 * Every row that records the same physical cheque as `c`: same party, same
 * cheque number, same bank. A cheque with no number cannot be matched safely,
 * so it stands alone. Mirrors chequeSiblings() in apps-script/Code.gs.
 */
export function chequeSiblings(cheques, c) {
  const key = (s) => String(s || '').trim().toLowerCase();
  if (!key(c.chequeNo)) return [c];
  return cheques.filter((x) => x.id === c.id || (
    x.partyId === c.partyId
    && key(x.chequeNo) === key(c.chequeNo)
    && key(x.bankName) === key(c.bankName)
  ));
}

function touch(d, id) {
  if (!id) return;
  d.sync = d.sync || { touched: {}, lastPushAt: '', lastPullAt: '' };
  d.sync.touched = d.sync.touched || {};
  d.sync.touched[id] = new Date().toISOString();
}

function logActivity(d, entityType, entityId, action, description, oldValue = null, newValue = null) {
  // Every write in this file logs, so this is the one place that reliably sees
  // each changed record id.
  touch(d, entityId);

  d.activityLog.unshift({
    id: uid('log'), entityType, entityId, action, description,
    oldValue: oldValue ? JSON.stringify(oldValue) : '',
    newValue: newValue ? JSON.stringify(newValue) : '',
    // Read from the live session rather than hardcoding 'admin', so the log
    // still attributes correctly once a second account exists.
    user: readSession()?.username || 'system', timestamp: new Date().toISOString(),
  });
}

/* ------------------------------------------------------------------ */
/* Bill numbering — auto-increment per year (FR-10)                    */
/* ------------------------------------------------------------------ */

function nextBillNo(d) {
  const year = new Date().getFullYear();
  d.billCounter = d.billCounter || {};
  d.billCounter[year] = (d.billCounter[year] || 0) + 1;
  return `${year}-${String(d.billCounter[year]).padStart(4, '0')}`;
}

/**
 * Next purchase number for the bill's year, PUR-2026-0001 style.
 *
 * Taken from the highest number already used rather than a stored counter, so
 * records downloaded from the Sheet move it on without any extra bookkeeping.
 * Mirrors nextPurchaseNo() in apps-script/Code.gs.
 */
function nextPurchaseNo(purchaseBills = [], date = todayISO()) {
  const year = String(date).slice(0, 4) || String(new Date().getFullYear());
  let max = 0;
  for (const b of purchaseBills) {
    const m = /^PUR-(\d{4})-(\d+)$/.exec(String(b.purchaseNo || ''));
    if (m && m[1] === year) max = Math.max(max, Number(m[2]));
  }
  return `PUR-${year}-${String(max + 1).padStart(4, '0')}`;
}

/**
 * The item's most recent purchase that actually brought goods in — the one its
 * current cost price came from. Mirrors latestPurchase() in Code.gs.
 */
function latestPurchase(d, itemId) {
  const voided = new Set(d.purchaseBills.filter((b) => b.status === 'voided').map((b) => b.id));
  let best = null;
  for (const p of d.purchases) {
    if (p.itemId !== itemId || voided.has(p.purchaseBillId)) continue;
    if (!best || String(p.date) >= String(best.date)) best = p;
  }
  return best;
}

/**
 * Put the item's cost price back in step with its latest purchase, after that
 * purchase was edited or deleted. With no purchase left the cost is kept: it
 * was typed in by hand and there is nothing better to replace it with.
 */
function refreshItemCost(d, itemId) {
  const item = d.items.find((x) => x.id === itemId);
  if (!item) return;
  const last = latestPurchase(d, itemId);
  if (last) {
    item.costPrice = r2(last.costPrice);
    item.lastPurchaseDate = last.date;
  } else {
    item.lastPurchaseDate = '';
  }
  touch(d, item.id);
}

/** A purchase bill's total, worked out again from the lines it still has. */
function recomputePurchaseBill(d, bill) {
  bill.totalAmount = r2(d.purchases
    .filter((x) => x.purchaseBillId === bill.id)
    .reduce((s, x) => s + (Number(x.qty) || 0) * (Number(x.costPrice) || 0), 0));
  touch(d, bill.id);
}

/** A quantity the caller actually supplied, or null when it left it out. */
function givenQty(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error('Quantity must be a number');
  return n;
}

/**
 * Keep a bill's whole-bill `delivery` flag in step with its lines.
 *
 * The flag stays 'pending' until every line has fully gone out, so the bills
 * list, the receipt and anything else that only reads the flag still treat a
 * part-delivered bill as not finished.
 */
function syncBillDeliveryFlag(d, bill) {
  const lines = d.billItems.filter((x) => x.billId === bill.id);
  const all = lines.every((l) => lineDeliveredQty(l, bill) >= (Number(l.qty) || 0) - 0.0001);
  const next = all ? 'delivered' : 'pending';
  if (next === 'delivered' && bill.delivery !== 'delivered') bill.deliveredAt = new Date().toISOString();
  if (next === 'pending') bill.deliveredAt = '';
  bill.delivery = next;
  touch(d, bill.id);
}

/**
 * Refuse an edit or delete that would leave goods returned to the supplier
 * which, on paper, were never bought on that bill. `newQty` is what this line
 * will hold afterwards under `newItemId` (0 for a delete).
 */
function assertReturnsCovered(d, billId, line, newItemId, newQty) {
  const returned = d.supplierReturns
    .filter((r) => r.purchaseBillId === billId && r.itemId === line.itemId)
    .reduce((s, r) => s + (Number(r.qty) || 0), 0);
  if (!returned) return;
  const others = d.purchases
    .filter((x) => x.purchaseBillId === billId && x.itemId === line.itemId && x.id !== line.id)
    .reduce((s, x) => s + (Number(x.qty) || 0), 0);
  const kept = others + (newItemId === line.itemId ? newQty : 0);
  if (kept < returned - 0.0001) {
    throw new Error(`${returned} of this item was already returned to the supplier from this purchase. `
      + 'Delete that return first.');
  }
}

/* ------------------------------------------------------------------ */
/* Action handler                                                      */
/* ------------------------------------------------------------------ */

const delay = (ms = 90) => new Promise((res) => setTimeout(res, ms));

// Actions run one at a time. Each one reads the whole DB and writes the whole
// DB back, so two overlapping actions would both read the same starting state
// and the second write would discard the first one's record. The UI can easily
// fire two at once — a double-tapped Save, or a form submitted while a refresh
// is still in flight — so the tail of this chain is awaited before each action
// touches storage.
let _chain = Promise.resolve();

export async function handle(action, payload = {}) {
  const run = _chain.then(() => perform(action, payload));
  // Keep the chain alive even when an action rejects, or one failed save would
  // wedge every later write.
  _chain = run.catch(() => {});
  return run;
}

async function perform(action, payload = {}) {
  // Mimic a small network hop so loading states are real. This happens BEFORE
  // the DB is read: reading first would reintroduce the stale-snapshot bug,
  // since another action could commit during the wait.
  await delay();
  const d = db();

  switch (action) {

    /* ---------------- Auth ---------------- */
    case 'login': {
      const uname = String(payload.username || '').toLowerCase();
      const wait = loginLockRemaining(uname);
      if (wait > 0) {
        throw new Error(`Too many failed attempts. Try again in ${wait} second${wait === 1 ? '' : 's'}.`);
      }

      const hash = await sha256(payload.password || '');
      const user = d.users.find((u) => u.username.toLowerCase() === uname);
      if (!user || user.passwordHash !== hash) {
        recordLoginFailure(uname);
        throw new Error('Invalid username or password');
      }
      if (!isActiveUser(user)) {
        throw new Error('This account is inactive. Please contact the super admin.');
      }
      clearLoginFailures(uname);

      const token = uid('tok');
      const session = {
        token, username: user.username, role: isSuper(user) ? 'admin' : 'user',
        fullName: user.fullName || '',
        allowedPages: Array.isArray(user.allowedPages) ? user.allowedPages : [],
        expiresAt: Date.now() + SESSION_TTL_MS,
      };
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      return session;
    }

    case 'changePassword': {
      // The signed-in user's own password — not whoever is first in the list.
      const user = sessionUser(d);
      if (!user) throw new Error('No user account found');
      const oldHash = await sha256(payload.oldPassword || '');
      if (user.passwordHash !== oldHash) throw new Error('Current password is incorrect');
      if (!payload.newPassword || payload.newPassword.length < 6) {
        throw new Error('New password must be at least 6 characters');
      }
      user.passwordHash = await sha256(payload.newPassword);
      logActivity(d, 'user', user.id, 'edit', 'Password changed');
      save();
      return { ok: true };
    }

    /* ---------------- User management (super admin only) ---------------- */
    case 'listUsers': {
      requireSuperAdmin(d);
      return d.users.map(publicUser);
    }

    case 'saveUser': {
      const me = requireSuperAdmin(d);
      const isNew = !payload.id;
      const username = validUsername(payload.username);
      const clash = d.users.find((u) => u.id !== payload.id
        && String(u.username).toLowerCase() === username.toLowerCase());
      if (clash) throw new Error(`The username "${clash.username}" is already taken.`);

      const role = payload.role === 'admin' ? 'admin' : 'user';
      const pages = role === 'admin' ? [] : cleanPages(payload.allowedPages);

      if (isNew) {
        if (!payload.password || String(payload.password).length < 6) {
          throw new Error('Set a password of at least 6 characters');
        }
        const rec = {
          id: uid('usr'), username, fullName: String(payload.fullName || '').trim(),
          role, status: 'active', allowedPages: pages, createdAt: new Date().toISOString(),
          passwordHash: await sha256(String(payload.password)),
        };
        d.users.push(rec);
        logActivity(d, 'user', rec.id, 'create', `Created user "${username}"`);
        save();
        return publicUser(rec);
      }

      const user = d.users.find((u) => u.id === payload.id);
      if (!user) throw new Error('User not found');
      if (isSuper(user) && role !== 'admin' && otherActiveAdmins(d, user.id) === 0) {
        throw new Error('You cannot remove the last active super admin.');
      }
      if (user.id === me.id && role !== 'admin') {
        throw new Error('You cannot take super admin rights away from yourself.');
      }
      // The session is tied to the username, so renaming yourself would strand it.
      if (user.id === me.id && username.toLowerCase() !== String(user.username).toLowerCase()) {
        throw new Error('You cannot change your own username. Ask another super admin.');
      }
      user.username = username;
      user.fullName = String(payload.fullName || '').trim();
      user.role = role;
      user.allowedPages = pages;
      logActivity(d, 'user', user.id, 'edit', `Updated user "${username}"`);
      save();
      return publicUser(user);
    }

    case 'setUserPassword': {
      requireSuperAdmin(d);
      const user = d.users.find((u) => u.id === payload.id);
      if (!user) throw new Error('User not found');
      if (!payload.newPassword || String(payload.newPassword).length < 6) {
        throw new Error('New password must be at least 6 characters');
      }
      user.passwordHash = await sha256(String(payload.newPassword));
      logActivity(d, 'user', user.id, 'edit', `Password reset for "${user.username}"`);
      save();
      return { ok: true };
    }

    case 'setUserStatus': {
      const me = requireSuperAdmin(d);
      const user = d.users.find((u) => u.id === payload.id);
      if (!user) throw new Error('User not found');
      const status = payload.status === 'inactive' ? 'inactive' : 'active';
      if (status === 'inactive') {
        if (user.id === me.id) throw new Error('You cannot deactivate your own account.');
        if (isSuper(user) && otherActiveAdmins(d, user.id) === 0) {
          throw new Error('You cannot deactivate the last active super admin.');
        }
      }
      user.status = status;
      logActivity(d, 'user', user.id, 'edit',
        `${status === 'inactive' ? 'Deactivated' : 'Activated'} user "${user.username}"`);
      save();
      return publicUser(user);
    }

    case 'deleteUser': {
      const me = requireSuperAdmin(d);
      const user = d.users.find((u) => u.id === payload.id);
      if (!user) throw new Error('User not found');
      if (user.id === me.id) throw new Error('You cannot delete your own account.');
      if (isSuper(user) && otherActiveAdmins(d, user.id) === 0) {
        throw new Error('You cannot delete the last active super admin.');
      }
      d.users = d.users.filter((u) => u.id !== user.id);
      logActivity(d, 'user', user.id, 'delete', `Deleted user "${user.username}"`);
      save();
      return { ok: true };
    }

    /* ---------------- Bootstrap ---------------- */
    case 'bootstrap': {
      const { users, ...rest } = d;
      // `me` is the live record of whoever is signed in, so a change a super
      // admin makes (pages, inactive, deleted) reaches them on the next load.
      const mine = sessionUser(d);
      return { ...rest, methods: allMethods(d), me: mine ? publicUser(mine) : null };
    }

    /* ---------------- Parties ---------------- */
    case 'saveParty': {
      const p = payload;
      if (!String(p.name || '').trim()) throw new Error('Party name is required');

      // Two parties with the same name each get their own ledger, so payments
      // land on whichever one was picked and neither balance is right. The
      // shopkeeper cannot tell them apart in a dropdown either. Compared
      // case- and space-insensitively, because "hamza foods" and "Hamza  Foods"
      // are the same shop to everyone except a string comparison.
      const key = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
      const clash = d.parties.find((x) => x.id !== p.id && key(x.name) === key(p.name));
      if (clash) {
        throw new Error(`A party called "${clash.name}" already exists. `
          + 'Use a different name, or open the existing one.');
      }

      // One mobile number, one party. Mirrors saveParty in apps-script/Code.gs.
      const want = phoneKey(p.phone);
      const phoneClash = want && d.parties.find((x) => x.id !== p.id && phoneKey(x.phone) === want);
      if (phoneClash) {
        throw new Error(`This mobile number is already registered on party "${phoneClash.name}".`);
      }

      if (p.id) {
        const i = d.parties.findIndex((x) => x.id === p.id);
        if (i < 0) throw new Error('Party not found');

        // A party who is also a supplier is one business: keep the supplier
        // row's name, phone and address the same, checked before anything is
        // changed so a refusal leaves both sides as they were.
        const sup = d.suppliers.find((x) => x.partyId === p.id);
        if (sup) {
          const sclash = d.suppliers.find((x) => x.id !== sup.id && key(x.name) === key(p.name));
          if (sclash) {
            throw new Error(`A supplier called "${sclash.name}" already exists, and this party's `
              + 'supplier side must carry the same name.');
          }
        }

        const old = { ...d.parties[i] };
        d.parties[i] = { ...old, ...p };
        if (sup) {
          sup.name = String(p.name).trim();
          sup.phone = p.phone || '';
          sup.address = p.address || '';
        }
        logActivity(d, 'party', p.id, 'edit', `Edited party "${p.name}"`, old, d.parties[i]);
        save();
        return d.parties[i];
      }
      const rec = {
        id: uid('pty'), name: p.name.trim(), phone: p.phone || '', address: p.address || '',
        creditLimit: Number(p.creditLimit) || 0,
        defaultDueDays: Number(p.defaultDueDays) || d.settings.defaultCreditDays,
        status: 'active', createdAt: new Date().toISOString(),
      };
      d.parties.push(rec);
      logActivity(d, 'party', rec.id, 'create', `Added party "${rec.name}"`);
      save();
      return rec;
    }

    case 'setPartyLock': {
      // Set, change or remove the password on one party's ledger.
      const p = d.parties.find((x) => x.id === payload.partyId);
      if (!p) throw new Error('Party not found');

      const next = String(payload.password || '');
      if (next && next.length < 4) throw new Error('Party password must be at least 4 characters');

      // Changing or removing an existing lock needs the party's current
      // password — or the dashboard login password, so a forgotten party
      // password can still be reset by the owner.
      if (p.lockHash) {
        const cur = String(payload.currentPassword || '');
        const partyOk = (await sha256(`${p.lockSalt || ''}:${cur}`)) === p.lockHash;
        const me = d.users.find((u) => u.username === readSession()?.username) || d.users[0];
        const loginOk = me && (await sha256(cur)) === me.passwordHash;
        if (!partyOk && !loginOk) {
          throw new Error('Current password is wrong. Enter this party’s password, or your login password.');
        }
      }

      const old = { ...p };
      if (next) {
        p.lockSalt = uid('slt');
        p.lockHash = await sha256(`${p.lockSalt}:${next}`);
      } else {
        p.lockSalt = '';
        p.lockHash = '';
      }
      // Hashes are left out of the log on purpose.
      logActivity(d, 'party', p.id, 'edit',
        next ? (old.lockHash ? `Changed ledger password for "${p.name}"` : `Locked ledger of "${p.name}" with a password`)
             : `Removed ledger password from "${p.name}"`);
      save();
      return { ok: true, locked: Boolean(next) };
    }

    case 'archiveParty': {
      // Never deleted — archived only (Safety Guide 2.1)
      const p = d.parties.find((x) => x.id === payload.id);
      if (!p) throw new Error('Party not found');
      p.status = p.status === 'archived' ? 'active' : 'archived';
      logActivity(d, 'party', p.id, 'edit', `${p.status === 'archived' ? 'Archived' : 'Restored'} party "${p.name}"`);
      save();
      return p;
    }

    /* ---------------- Items ---------------- */
    case 'saveItem': {
      const it = payload;
      if (!String(it.name || '').trim()) throw new Error('Item name is required');

      // Same reasoning as parties: two items of the same name split one
      // product's stock and price history across two records, so neither
      // reads correctly.
      const ikey = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
      const iclash = d.items.find((x) => x.id !== it.id && ikey(x.name) === ikey(it.name));
      if (iclash) {
        throw new Error(`An item called "${iclash.name}" already exists. `
          + 'Use a different name, or edit the existing one.');
      }

      if (it.id) {
        const i = d.items.findIndex((x) => x.id === it.id);
        if (i < 0) throw new Error('Item not found');
        const old = { ...d.items[i] };
        d.items[i] = { ...old, ...it };
        logActivity(d, 'item', it.id, 'edit', `Edited item "${it.name}"`, old, d.items[i]);
        save();
        return d.items[i];
      }
      const rec = {
        id: uid('itm'), name: it.name.trim(), baseUnit: it.baseUnit || 'Piece',
        altUnit: it.altUnit || '', conversionRate: Number(it.conversionRate) || 0,
        category: it.category || '', costPrice: Number(it.costPrice) || 0,
        lastPurchaseDate: '', openingStock: Number(it.openingStock) || 0,
        lowStockAlert: Number(it.lowStockAlert) || 0, status: 'active',
      };
      d.items.push(rec);
      logActivity(d, 'item', rec.id, 'create', `Added item "${rec.name}"`);
      save();
      return rec;
    }

    case 'archiveItem': {
      const it = d.items.find((x) => x.id === payload.id);
      if (!it) throw new Error('Item not found');
      it.status = it.status === 'archived' ? 'active' : 'archived';
      logActivity(d, 'item', it.id, 'edit', `${it.status === 'archived' ? 'Archived' : 'Restored'} item "${it.name}"`);
      save();
      return it;
    }

    /* ---------------- Bills ---------------- */
    case 'saveBill': {
      const b = payload;
      if (!b.partyId) throw new Error('Select a party');
      if (!b.lines?.length) throw new Error('Add at least one item');
      if (!d.parties.some((p) => p.id === b.partyId)) throw new Error('Party not found');

      // Safety Guide 2.3: the money is recomputed here from the lines. Totals
      // that arrive in the payload are the client's *display* values and are
      // never trusted — a tampered or stale payload must not be able to set
      // its own price. Line values are validated before they reach the math.
      b.lines.forEach((l, i) => {
        const qty = Number(l.qty);
        const price = Number(l.price);
        if (!Number.isFinite(qty) || qty <= 0) {
          throw new Error(`Line ${i + 1}: quantity must be greater than zero`);
        }
        if (!Number.isFinite(price) || price < 0) {
          throw new Error(`Line ${i + 1}: price must be zero or more`);
        }
        if (!d.items.some((x) => x.id === l.itemId)) {
          throw new Error(`Line ${i + 1}: item not found`);
        }
      });

      const computed = billTotals(
        b.lines.map((l) => ({ qty: Number(l.qty), price: Number(l.price) })),
        d.settings.roundingRule
      );

      const editing = Boolean(b.id);
      let bill;
      // itemId -> quantity already delivered on the bill being edited.
      const deliveredBefore = new Map();

      if (editing) {
        const i = d.bills.findIndex((x) => x.id === b.id);
        if (i < 0) throw new Error('Bill not found');
        const old = { ...d.bills[i] };
        if (old.status === 'voided') throw new Error('A voided bill cannot be edited');

        // Editing a bill down below what has already been paid would leave the
        // overpayment with nowhere to go: not refunded, not held as an advance,
        // simply gone from the ledger. Refusing says what is wrong and leaves
        // the shopkeeper to record a return or reverse a payment, which are the
        // operations that actually account for the money.
        // Uncleared cheques count too: they pay the bill the day they clear,
        // and an edit below them leaves that money overpaid.
        const oldState = billState(old, d);
        const alreadyPaid = r2(oldState.paid + oldState.pendingCheques);
        if (alreadyPaid > r2(computed.total) + 0.004) {
          throw new Error(`This bill already has ${alreadyPaid.toFixed(2)} paid against it, `
            + `so it cannot be reduced to ${computed.total.toFixed(2)}. `
            + 'Record a return, or reverse a payment first.');
        }

        bill = {
          ...old, partyId: b.partyId, date: b.date,
          subtotal: computed.subtotal, roundOff: computed.roundOff, totalAmount: computed.total,
          dueDate: b.dueDate, note: b.note || '',
          // Editing a bill's lines says nothing about whether the goods went
          // out, so an existing delivery state is preserved unless the payload
          // deliberately changes it.
          delivery: b.delivery || old.delivery || 'pending',
          // An instalment plan is kept unless the caller sends a new one.
          installPlan: b.installPlan !== undefined ? String(b.installPlan || '') : (old.installPlan || ''),
        };
        d.bills[i] = bill;
        // What had already gone out, per item, so an edit does not forget it.
        d.billItems.filter((x) => x.billId === b.id).forEach((x) => {
          deliveredBefore.set(x.itemId, (deliveredBefore.get(x.itemId) || 0) + lineDeliveredQty(x, old));
        });
        // Replace lines; old payments stay attached (FR-25 edit, not delete)
        d.billItems = d.billItems.filter((x) => x.billId !== b.id);
        logActivity(d, 'bill', bill.id, 'edit', `Edited Bill ${bill.billNo}`, old, bill);
      } else {
        bill = {
          id: uid('bil'), billNo: nextBillNo(d), partyId: b.partyId,
          date: b.date || todayISO(),
          subtotal: computed.subtotal, roundOff: computed.roundOff,
          totalAmount: computed.total, status: 'due',
          dueDate: b.dueDate || addDays(b.date || todayISO(), d.settings.defaultCreditDays),
          note: b.note || '', createdAt: new Date().toISOString(),
          // Delivery is tracked separately from `status`, which already carries
          // the money state (due/partial/paid/voided). Defaults to 'delivered'
          // because most sales are handed over across the counter as the bill
          // is written; the biller marks the exceptions as pending. Defaulting
          // the other way would show a shop full of undelivered bills that
          // nobody would then trust.
          delivery: b.delivery === 'pending' ? 'pending' : 'delivered',
          // JSON {base, parts:[{due, amount}]} when the credit is paid in instalments.
          installPlan: String(b.installPlan || ''),
        };
        d.bills.push(bill);
        logActivity(d, 'bill', bill.id, 'create', `Created Bill ${bill.billNo}`);
      }

      // Bill lines — capture cost price at time of sale (FR-38)
      b.lines.forEach((l) => {
        const item = d.items.find((x) => x.id === l.itemId);
        const qty = Number(l.qty) || 0;
        // Delivered on this line: what the caller says; else all of it when the
        // bill is marked delivered; else whatever of this item had already gone
        // out before the edit (none on a new pending bill).
        let delivered = givenQty(l.deliveredQty);
        if (delivered === null) {
          if (b.delivery === 'delivered' || (!editing && b.delivery !== 'pending')) {
            delivered = qty;
          } else {
            delivered = Math.min(qty, deliveredBefore.get(l.itemId) || 0);
            deliveredBefore.set(l.itemId, r2((deliveredBefore.get(l.itemId) || 0) - delivered));
          }
        }
        if (delivered < 0 || delivered > qty + 0.0001) {
          throw new Error(`${item?.name || 'Item'}: delivered quantity must be between 0 and ${qty}`);
        }
        d.billItems.push({
          id: uid('bli'), billId: bill.id, itemId: l.itemId, qty,
          unit: l.unit || item?.baseUnit || 'Piece', price: r2(l.price),
          costPriceAtSale: r2(l.costPriceAtSale ?? item?.costPrice ?? 0),
          lineTotal: r2((Number(l.qty) || 0) * (Number(l.price) || 0)),
          deliveredQty: r2(delivered),
          // Which supplier's stock this was sold from ('' = any, oldest first).
          supplierId: l.supplierId || '',
        });

        // Remember this party's price for this item (FR-3 auto-fill source)
        d.partyItemPrices.push({
          id: uid('pip'), partyId: bill.partyId, itemId: l.itemId,
          price: r2(l.price), unit: l.unit || item?.baseUnit || 'Piece', date: bill.date,
        });
      });

      // Payments recorded with the bill (FR-7 split payment)
      (b.payments || []).forEach((p) => {
        if (!(Number(p.amount) > 0)) return;
        const pay = {
          id: uid('pay'), billId: bill.id, partyId: bill.partyId, method: p.method,
          amount: r2(p.amount), date: bill.date, note: p.note || '', reversed: false,
        };
        d.payments.push(pay);

        // Cheque payments carry their own record (FR-28)
        if (p.method === 'Cheque' && p.cheque) {
          d.cheques.push({
            id: uid('chq'), billId: bill.id, partyId: bill.partyId, paymentId: pay.id,
            chequeNo: p.cheque.chequeNo || '', bankName: p.cheque.bankName || '',
            accountHolder: p.cheque.accountHolder || '',
            dateIssued: p.cheque.dateIssued || bill.date, dateDue: p.cheque.dateDue || bill.date,
            status: 'pending', amount: r2(p.amount), note: p.cheque.note || '',
          });
        }
      });

      // Applied party advance reduces what is owed (FR-9)
      if (Number(b.advanceApplied) > 0) {
        let remaining = Number(b.advanceApplied);
        d.partyAdvances
          .filter((a) => a.partyId === bill.partyId)
          .forEach((a) => {
            if (remaining <= 0) return;
            const avail = (Number(a.amount) || 0) - (Number(a.applied) || 0);
            if (avail <= 0) return;
            const use = Math.min(avail, remaining);
            a.applied = r2((Number(a.applied) || 0) + use);
            remaining = r2(remaining - use);
          });
        d.payments.push({
          id: uid('pay'), billId: bill.id, partyId: bill.partyId, method: 'Advance',
          amount: r2(b.advanceApplied), date: bill.date, note: 'Advance applied', reversed: false,
        });
      }

      syncBillDeliveryFlag(d, bill);
      save();
      return bill;
    }

    case 'setDelivery': {
      const bill = d.bills.find((x) => x.id === payload.id);
      if (!bill) throw new Error('Bill not found');
      const next = payload.delivery;
      if (next !== 'pending' && next !== 'delivered') {
        throw new Error('Delivery must be pending or delivered');
      }
      // A voided bill has no goods to deliver. Letting it be marked delivered
      // would put a cancelled sale on the delivery list.
      if (bill.status === 'voided') throw new Error('A voided bill cannot be delivered');

      const old = { ...bill };
      bill.delivery = next;
      bill.deliveredAt = next === 'delivered' ? new Date().toISOString() : '';
      // The whole bill at once: every line follows.
      d.billItems.filter((x) => x.billId === bill.id).forEach((x) => {
        x.deliveredQty = next === 'delivered' ? (Number(x.qty) || 0) : 0;
        touch(d, x.id);
      });
      logActivity(
        d, 'bill', bill.id, 'edit',
        `Bill ${bill.billNo} marked ${next}`, old, bill,
      );
      save();
      return bill;
    }

    /* Record how much of each line has gone out: some items now, the rest later. */
    case 'setLineDelivery': {
      const bill = d.bills.find((x) => x.id === payload.billId);
      if (!bill) throw new Error('Bill not found');
      if (bill.status === 'voided') throw new Error('A voided bill cannot be delivered');
      const changes = payload.lines || [];
      if (!changes.length) throw new Error('Nothing to update');

      const old = { ...bill };
      const done = [];
      changes.forEach((c) => {
        const line = d.billItems.find((x) => x.id === c.id && x.billId === bill.id);
        if (!line) throw new Error('Bill line not found');
        const qty = Number(line.qty) || 0;
        const delivered = givenQty(c.deliveredQty);
        if (delivered === null || delivered < 0 || delivered > qty + 0.0001) {
          const name = d.items.find((it) => it.id === line.itemId)?.name || 'Item';
          throw new Error(`${name}: delivered quantity must be between 0 and ${qty}`);
        }
        done.push([line, r2(delivered)]);
      });
      // Validated in full first, so one bad line leaves the bill untouched.
      done.forEach(([line, delivered]) => {
        line.deliveredQty = delivered;
        touch(d, line.id);
      });
      syncBillDeliveryFlag(d, bill);

      const lines = d.billItems.filter((x) => x.billId === bill.id);
      const sent = r2(lines.reduce((s, l) => s + lineDeliveredQty(l, bill), 0));
      const total = r2(lines.reduce((s, l) => s + (Number(l.qty) || 0), 0));
      logActivity(d, 'bill', bill.id, 'edit',
        `Bill ${bill.billNo} delivery updated: ${sent} of ${total} delivered`, old, bill);
      save();
      return bill;
    }

    case 'voidBill': {
      // Voided, never deleted — number and history are preserved (Safety 2.1)
      const bill = d.bills.find((x) => x.id === payload.id);
      if (!bill) throw new Error('Bill not found');
      if (bill.status === 'voided') throw new Error('This bill is already voided');

      // A voided bill stops counting, but a payment against it would stay in the
      // cash balance with no bill to belong to: the party statement would show
      // the shop owing them, and no other screen would say so. Same rule as
      // editing a bill below what was paid — reverse the payment first, which
      // takes the money back out of the books on purpose.
      const livePaid = r2(d.payments
        .filter((p) => p.billId === bill.id && !p.reversed)
        .reduce((s, p) => s + (Number(p.amount) || 0), 0));
      if (livePaid > 0.004) {
        throw new Error(`Bill ${bill.billNo} has ${livePaid.toFixed(2)} paid against it. `
          + 'Reverse its payments first (or record a return), then void the bill.');
      }

      const old = { ...bill };
      bill.status = 'voided';
      bill.voidReason = payload.reason || '';
      bill.voidedAt = new Date().toISOString();
      logActivity(d, 'bill', bill.id, 'void', `Voided Bill ${bill.billNo}${payload.reason ? ` — ${payload.reason}` : ''}`, old, bill);
      save();
      return bill;
    }

    /* ---------------- Payments ---------------- */
    case 'addPayment': {
      const p = payload;
      const amount = Number(p.amount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('Enter a payment amount');
      const bill = d.bills.find((x) => x.id === p.billId);
      if (!bill) throw new Error('Bill not found');
      if (bill.status === 'voided') throw new Error('A voided bill cannot take a payment');

      // FR-26: never accept more than is actually owed. Without this the excess
      // is silently swallowed by the Math.max(0, …) clamp in billState, so the
      // money would vanish from the ledger instead of becoming an advance.
      // Cheques already waiting at the bank count against the limit: each will
      // settle its share once it clears (see billPaymentRoom).
      const st = billState(bill, d);
      const due = billPaymentRoom(st);
      if (r2(amount) > r2(due) + 0.004) {
        throw new Error(
          `Payment exceeds the amount due (${due.toFixed(2)}` +
          `${st.pendingCheques > 0 ? `, after ${st.pendingCheques.toFixed(2)} in uncleared cheques` : ''}). ` +
          'Record the extra as an advance instead.'
        );
      }

      const pay = {
        id: uid('pay'), billId: p.billId, partyId: p.partyId, method: p.method || 'Cash',
        amount: r2(p.amount), date: p.date || todayISO(), note: p.note || '', reversed: false,
      };
      d.payments.push(pay);

      if (p.method === 'Cheque' && p.cheque) {
        d.cheques.push({
          id: uid('chq'), billId: p.billId, partyId: p.partyId, paymentId: pay.id,
          chequeNo: p.cheque.chequeNo || '', bankName: p.cheque.bankName || '',
          accountHolder: p.cheque.accountHolder || '',
          dateIssued: p.cheque.dateIssued || pay.date, dateDue: p.cheque.dateDue || pay.date,
          status: 'pending', amount: r2(p.amount), note: p.cheque.note || '',
        });
      }

      logActivity(d, 'payment', pay.id, 'create',
        `Payment received${bill ? ` for Bill ${bill.billNo}` : ''} — ${pay.method}`);
      save();
      return pay;
    }

    case 'reversePayment': {
      // Offsetting flag, not a delete (FR-26)
      const pay = d.payments.find((x) => x.id === payload.id);
      if (!pay) throw new Error('Payment not found');
      if (pay.reversed) throw new Error('This payment is already reversed');
      const old = { ...pay };
      pay.reversed = true;
      pay.reversedAt = new Date().toISOString();
      pay.reverseReason = payload.reason || '';
      logActivity(d, 'payment', pay.id, 'reverse',
        `Reversed payment of ${pay.amount} (${pay.method})${payload.reason ? ` — ${payload.reason}` : ''}`, old, pay);
      save();
      return pay;
    }

    /* Permanent removal, unlike reversePayment which keeps the row flagged.
       For an entry that should never have existed — a test row, or money put
       against the wrong party — where a struck-through line would only puzzle
       the customer reading their statement. Any cheque backing it goes too,
       or billState() would keep counting a cheque whose payment is gone. */
    case 'deletePayment': {
      const i = d.payments.findIndex((x) => x.id === payload.id);
      if (i < 0) throw new Error('Payment not found');
      const pay = d.payments[i];
      // An advance receipt normally has to go via deleteAdvance, which removes
      // the balance row with it. The exception is a receipt whose advance row
      // no longer exists: there is nothing to keep in step, and refusing would
      // leave a stranded row nobody can clear.
      if (pay.isAdvance && !payload.orphan) {
        throw new Error('This is an advance receipt. Delete the advance itself '
          + 'from the Advances list, which removes this receipt with it and '
          + 'keeps the party’s advance balance correct.');
      }
      const killed = d.cheques.filter((c) => c.paymentId === pay.id).map((c) => c.chequeNo || c.id);
      d.cheques = d.cheques.filter((c) => c.paymentId !== pay.id);
      d.payments.splice(i, 1);
      logActivity(d, 'payment', pay.id, 'delete',
        `Deleted payment of ${pay.amount} (${pay.method})`
        + (killed.length ? ` and cheque ${killed.join(', ')}` : '')
        + (payload.reason ? ` — ${payload.reason}` : ''), pay, null);
      save();
      return { ok: true, deletedCheques: killed.length };
    }

    /* Amount, method, date and note only. billId/partyId stay put: moving a
       payment to another bill silently changes two balances at once, which is
       a different correction than fixing a typo. */
    case 'updatePayment': {
      const pay = d.payments.find((x) => x.id === payload.id);
      if (!pay) throw new Error('Payment not found');
      if (pay.reversed) throw new Error('A reversed payment cannot be edited');
      const old = { ...pay };

      if (payload.amount !== undefined) {
        const amt = Number(payload.amount);
        if (!Number.isFinite(amt) || amt <= 0) throw new Error('Enter a payment amount');
        if (pay.billId) {
          const bill = d.bills.find((b) => b.id === pay.billId);
          if (bill) {
            // Measured without this payment's own contribution, or its current
            // amount would count against itself and block any increase.
            const st = billState(bill, {
              payments: d.payments.filter((x) => x.id !== pay.id),
              returns: d.returns,
              cheques: d.cheques,
            });
            const room = billPaymentRoom(st);
            if (r2(amt) > room + 0.004) {
              throw new Error(`Payment exceeds the amount due (${room.toFixed(2)}`
                + `${st.pendingCheques > 0 ? `, after ${st.pendingCheques.toFixed(2)} in uncleared cheques` : ''}). `
                + 'Record the extra as an advance instead.');
            }
          }
        }
        pay.amount = r2(amt);
        // A cheque mirrors its payment, or the two registers disagree.
        d.cheques.forEach((c) => { if (c.paymentId === pay.id) c.amount = pay.amount; });
      }
      if (payload.method !== undefined) pay.method = payload.method;
      if (payload.date !== undefined) pay.date = payload.date;
      if (payload.note !== undefined) pay.note = payload.note || '';

      logActivity(d, 'payment', pay.id, 'edit', 'Edited payment', old, pay);
      save();
      return pay;
    }

    /**
     * One payment spread across the party's unpaid bills, oldest first.
     *
     * How money actually arrives: a sum against the account, not against an
     * invoice number. Oldest first matches trade practice and keeps the ageing
     * buckets honest. Whatever the bills cannot absorb is held as an advance
     * rather than refused — the cash is already in hand.
     */
    case 'settleParty': {
      const total = Number(payload.amount);
      if (!Number.isFinite(total) || total <= 0) throw new Error('Enter a payment amount');
      if (!payload.partyId) throw new Error('Select a party');
      // Without this an unknown id still writes an advance row, leaving money
      // credited to a party that does not exist and shows on no ledger.
      if (!d.parties.some((x) => x.id === payload.partyId)) throw new Error('Party not found');

      const date = payload.date || todayISO();
      const method = payload.method || 'Cash';

      /**
       * A cheque is not money until the bank clears it.
       *
       * Without a Cheques row, billState() has nothing to hold the payment
       * back with, so an uncleared cheque counts as cash: the bill reads paid,
       * outstanding is understated and the cash position is overstated. One
       * row per payment, mirroring what addPayment and saveBill already do.
       */
      const chequeFor = (payId, amount) => {
        if (method !== 'Cheque') return;
        const c = payload.cheque || {};
        d.cheques.push({
          id: uid('chq'), billId: '', partyId: payload.partyId, paymentId: payId,
          chequeNo: c.chequeNo || '', bankName: c.bankName || '',
          accountHolder: c.accountHolder || '',
          dateIssued: c.dateIssued || date, dateDue: c.dateDue || date,
          status: 'pending', amount: r2(amount), note: c.note || '',
          statusChangedAt: '',
        });
      };

      const mine = d.bills
        .filter((b) => b.partyId === payload.partyId && b.status !== 'voided')
        .sort((a, b) => String(a.date).localeCompare(String(b.date))
          || String(a.billNo).localeCompare(String(b.billNo)));

      let remaining = r2(total);
      const applied = [];
      // Every part of this one receipt shares a groupId, so the ledger can
      // show it as the single payment it was: "Bill 1: 500, Bill 2: 500".
      const groupId = uid('grp');

      for (const bill of mine) {
        if (remaining <= 0.004) break;
        const st = billState(bill, {
          payments: d.payments, returns: d.returns, cheques: d.cheques,
        });
        if (st.due <= 0.004) continue;

        const use = r2(Math.min(st.due, remaining));
        const payId = uid('pay');
        d.payments.push({
          id: payId, billId: bill.id, partyId: payload.partyId,
          method, amount: use, date, note: payload.note || 'Account payment',
          reversed: false, reversedAt: '', reverseReason: '', isAdvance: false, groupId,
        });
        chequeFor(payId, use);
        applied.push({ billId: bill.id, billNo: bill.billNo, amount: use });
        remaining = r2(remaining - use);
      }

      let asAdvance = 0;
      if (remaining > 0.004) {
        asAdvance = remaining;
        d.partyAdvances.push({
          id: uid('adv'), partyId: payload.partyId, amount: asAdvance, applied: 0,
          dateReceived: date, method, note: payload.note || 'Overpayment held as advance',
        });
        const advPayId = uid('pay');
        d.payments.push({
          id: advPayId, billId: '', partyId: payload.partyId,
          method, amount: asAdvance, date, note: 'Advance received',
          reversed: false, reversedAt: '', reverseReason: '', isAdvance: true, groupId,
        });
        chequeFor(advPayId, asAdvance);
      }

      logActivity(d, 'payment', payload.partyId, 'create',
        `Account payment ${r2(total)} — settled ${applied.length} bill`
        + `${applied.length === 1 ? '' : 's'}`
        + (asAdvance > 0 ? `, ${asAdvance} held as advance` : ''));
      save();
      return { applied, advance: asAdvance, total: r2(total) };
    }

    /* ---------------- Returns ---------------- */
    case 'addReturn': {
      const rt = payload;
      const bill = d.bills.find((x) => x.id === rt.billId);
      if (!bill) throw new Error('Bill not found');

      /* The form already caps a return at what was sold. These repeat the rule
         where it actually protects the books: a record arriving from an
         offline device, or a row typed straight into the Sheet, reaches this
         point without ever passing the form.

         Unchecked, returning more than was sold drives the bill's net negative
         — a Rs 200 bill reading as the shop owing Rs 4,800 — and restocking
         more than was sold invents stock that never existed. */
      const qty = Number(rt.qty) || 0;
      if (qty <= 0) throw new Error('Return quantity must be greater than zero');

      const soldQty = d.billItems
        .filter((bi) => bi.billId === rt.billId && bi.itemId === rt.itemId)
        .reduce((s, bi) => s + (Number(bi.qty) || 0), 0);
      if (!soldQty) throw new Error('That item is not on this bill');

      const returnedQty = d.returns
        .filter((r) => r.billId === rt.billId && r.itemId === rt.itemId)
        .reduce((s, r) => s + (Number(r.qty) || 0), 0);
      const qtyLeft = r2(soldQty - returnedQty);
      if (qty > qtyLeft + 0.0001) {
        throw new Error(`Only ${qtyLeft} of that item is left to return `
          + `(${soldQty} sold, ${returnedQty} already returned).`);
      }

      // Value is capped separately: qty and value are independent fields, so a
      // valid quantity can still carry an absurd amount.
      const value = r2(rt.valueAdjusted);
      if (value < 0) throw new Error('Return value cannot be negative');
      const returnedValue = d.returns
        .filter((r) => r.billId === rt.billId)
        .reduce((s, r) => s + (Number(r.valueAdjusted) || 0), 0);
      const valueLeft = r2(r2(bill.totalAmount) - returnedValue);
      if (value > valueLeft + 0.004) {
        throw new Error(`Return value cannot exceed what is left on the bill `
          + `(${valueLeft.toFixed(2)}).`);
      }

      const rec = {
        id: uid('ret'), billId: rt.billId, itemId: rt.itemId, qty: Number(rt.qty) || 0,
        valueAdjusted: r2(rt.valueAdjusted), restock: Boolean(rt.restock),
        date: rt.date || todayISO(), note: rt.note || '',
      };
      d.returns.push(rec);
      logActivity(d, 'return', rec.id, 'create',
        `Return against Bill ${bill.billNo} — value ${rec.valueAdjusted}`);
      save();
      return rec;
    }

    /* ---------------- Cheques ---------------- */
    case 'saveCheque': {
      const c = payload;
      if (c.id) {
        const i = d.cheques.findIndex((x) => x.id === c.id);
        if (i < 0) throw new Error('Cheque not found');
        d.cheques[i] = { ...d.cheques[i], ...c };
        save();
        return d.cheques[i];
      }
      const rec = { id: uid('chq'), status: 'pending', ...c, amount: r2(c.amount) };
      d.cheques.push(rec);
      logActivity(d, 'cheque', rec.id, 'create', `Cheque ${rec.chequeNo} recorded`);
      save();
      return rec;
    }

    case 'setChequeStatus': {
      const c = d.cheques.find((x) => x.id === payload.id);
      if (!c) throw new Error('Cheque not found');
      const old = { ...c };
      const at = new Date().toISOString();
      // One physical cheque can sit in several rows: an account payment spread
      // over many bills writes one row per bill. The bank clears or bounces the
      // whole cheque, so every row of it moves together — otherwise the other
      // bills stay outstanding after the cheque has cleared.
      const rows = chequeSiblings(d.cheques, c);
      // A bounced cheque stopped counting, so its bill reopened and may since
      // have been paid another way. Reviving it would pay that bill twice.
      if (payload.status !== 'bounced') {
        rows.filter((x) => x.status === 'bounced' && x.paymentId).forEach((x) => {
          const pay = d.payments.find((p) => p.id === x.paymentId);
          const bill = pay && !pay.reversed && pay.billId && d.bills.find((b) => b.id === pay.billId);
          if (!bill) return;
          const room = billPaymentRoom(billState(bill, d));
          if (r2(pay.amount) > room + 0.004) {
            throw new Error(`Bill ${bill.billNo} has only ${room.toFixed(2)} left to pay, so this `
              + `bounced cheque of ${r2(pay.amount).toFixed(2)} cannot be revived. `
              + 'Record the money as a new payment instead.');
          }
        });
      }
      rows.forEach((x) => {
        x.status = payload.status;
        x.statusChangedAt = at;
        if (x.id !== c.id) touch(d, x.id);
      });
      // A bounced cheque reopens the bill's due automatically, because billState()
      // excludes payments backed by a bounced cheque (FR-30).
      logActivity(d, 'cheque', c.id, 'edit',
        `Cheque ${c.chequeNo} marked ${payload.status}`
        + (rows.length > 1 ? ` (${rows.length} bill entries)` : ''), old, c);
      save();
      return c;
    }

    /* The payment the cheque backed is deliberately left in place and becomes
       an ordinary one of its method: removing the bank instrument must not
       quietly erase the money itself. */
    case 'deleteCheque': {
      const i = d.cheques.findIndex((x) => x.id === payload.id);
      if (i < 0) throw new Error('Cheque not found');
      const chq = d.cheques[i];
      d.cheques.splice(i, 1);
      logActivity(d, 'cheque', chq.id, 'delete',
        `Deleted cheque ${chq.chequeNo || ''} of ${chq.amount}`
        + (payload.reason ? ` — ${payload.reason}` : ''), chq, null);
      save();
      return { ok: true };
    }

    /* ---------------- Party advances ---------------- */
    case 'addAdvance': {
      const a = payload;
      if (!(Number(a.amount) > 0)) throw new Error('Enter an advance amount');
      const rec = {
        id: uid('adv'), partyId: a.partyId, amount: r2(a.amount), applied: 0,
        dateReceived: a.dateReceived || todayISO(), method: a.method || 'Cash', note: a.note || '',
      };
      d.partyAdvances.push(rec);
      const advPay = uid('pay');
      d.payments.push({
        id: advPay, billId: null, partyId: a.partyId, method: rec.method,
        amount: rec.amount, date: rec.dateReceived, note: 'Advance received', reversed: false,
        isAdvance: true,
      });
      // An advance handed over as a cheque is not money until it clears, the
      // same as any other cheque. Without this row nothing holds it back and
      // the party appears to hold a balance the bank has not yet paid.
      if (rec.method === 'Cheque') {
        const c = a.cheque || {};
        d.cheques.push({
          id: uid('chq'), billId: '', partyId: a.partyId, paymentId: advPay,
          chequeNo: c.chequeNo || '', bankName: c.bankName || '',
          accountHolder: c.accountHolder || '',
          dateIssued: c.dateIssued || rec.dateReceived, dateDue: c.dateDue || rec.dateReceived,
          status: 'pending', amount: rec.amount, note: c.note || '', statusChangedAt: '',
        });
      }
      logActivity(d, 'advance', rec.id, 'create', `Advance received ${rec.amount}`);
      save();
      return rec;
    }

    /**
     * Remove an advance and everything it paid for.
     *
     * Three records sit behind one advance: the balance row, the receipt that
     * recorded the money arriving, and any 'Advance' payments already spent
     * out of it on bills. All three go — leaving the spent payments would keep
     * bills marked paid by money that no longer exists, so those bills reopen
     * for their proper amount.
     */
    case 'deleteAdvance': {
      const i = d.partyAdvances.findIndex((x) => x.id === payload.id);
      if (i < 0) throw new Error('Advance not found');

      const adv = d.partyAdvances[i];
      const amount = r2(adv.amount);
      const applied = r2(adv.applied);

      // The receipt. No id links it to the advance, so it is matched on party
      // and amount, with the day only breaking a tie between several advances
      // of the same size. Comparing raw dates would be wrong — the two rows
      // can hold the same day in different shapes.
      const day = (v) => {
        if (!v) return '';
        const s = String(v);
        const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (m) return m[0];
        const dt = new Date(s);
        if (Number.isNaN(dt.getTime())) return '';
        const p2 = (n) => String(n).padStart(2, '0');
        return `${dt.getFullYear()}-${p2(dt.getMonth() + 1)}-${p2(dt.getDate())}`;
      };
      const candidates = d.payments.filter((p) => p.isAdvance
        && p.partyId === adv.partyId
        && r2(p.amount) === amount);
      const receipt = candidates.length === 1
        ? candidates[0]
        : candidates.find((p) => day(p.date) === day(adv.dateReceived)) || candidates[0];

      // Payments made OUT of this balance: method 'Advance' is what saveBill
      // writes when a bill consumes it.
      const reopened = [];
      let budget = applied;
      const spentIds = new Set();
      if (applied > 0.004) {
        for (const ap of d.payments) {
          if (budget <= 0.004) break;
          if (ap.partyId !== adv.partyId || ap.method !== 'Advance' || ap.reversed) continue;
          const bill = d.bills.find((b) => b.id === ap.billId);
          reopened.push({
            billId: ap.billId,
            billNo: bill?.billNo || '',
            amount: r2(ap.amount),
          });
          spentIds.add(ap.id);
          budget = r2(budget - r2(ap.amount));
        }
      }

      const doomed = new Set(spentIds);
      if (receipt) doomed.add(receipt.id);

      // A cheque left pointing at a deleted payment is still counted when
      // working out what a bill owes.
      d.cheques = d.cheques.filter((c) => !doomed.has(c.paymentId));
      d.payments = d.payments.filter((p) => !doomed.has(p.id));
      d.partyAdvances.splice(i, 1);

      const party = d.parties.find((x) => x.id === adv.partyId);
      logActivity(d, 'advance', adv.id, 'delete',
        `Deleted advance of ${amount} for ${party?.name || 'party'}`
        + (reopened.length ? ` — reopened ${reopened.length} bill${reopened.length === 1 ? '' : 's'}` : '')
        + (payload.reason ? ` — ${payload.reason}` : ''), adv, null);
      save();
      return {
        ok: true,
        amount,
        reopened,
        reopenedValue: r2(reopened.reduce((s, x) => s + x.amount, 0)),
      };
    }

    /* ---------------- Purchases ---------------- */
    case 'savePurchase': {
      const p = payload;
      const rec = {
        id: uid('pur'), itemId: p.itemId, supplierName: p.supplierName || '',
        qty: Number(p.qty) || 0, costPrice: r2(p.costPrice),
        date: p.date || todayISO(), note: p.note || '',
        method: p.method || 'Cash',
      };
      d.purchases.push(rec);
      // Purchase updates the item's current cost price + last purchase date (FR-37)
      const item = d.items.find((x) => x.id === p.itemId);
      if (item) {
        item.costPrice = rec.costPrice;
        item.lastPurchaseDate = rec.date;
      }
      logActivity(d, 'purchase', rec.id, 'create',
        `Purchased ${rec.qty} × ${item?.name || 'item'} @ ${rec.costPrice}`);
      save();
      return rec;
    }

    /* Fix a purchase entered wrongly. A line of a supplier purchase bill keeps
       its bill's supplier, date and payment; only what was bought changes, and
       the bill total is worked out again from its lines. */
    case 'updatePurchase': {
      const p = payload;
      const rec = d.purchases.find((x) => x.id === p.id);
      if (!rec) throw new Error('Purchase not found');
      const bill = rec.purchaseBillId ? d.purchaseBills.find((b) => b.id === rec.purchaseBillId) : null;
      if (bill?.status === 'voided') throw new Error('This purchase was cancelled and cannot be edited');

      const itemId = p.itemId || rec.itemId;
      if (!d.items.some((it) => it.id === itemId)) throw new Error('Select an item');
      const qty = Number(p.qty);
      if (!(qty > 0)) throw new Error('Quantity must be greater than zero');
      const cost = Number(p.costPrice);
      if (!(cost >= 0)) throw new Error('Cost price must be zero or more');
      if (bill) assertReturnsCovered(d, bill.id, rec, itemId, qty);

      const old = { ...rec };
      const wasLatest = latestPurchase(d, rec.itemId)?.id === rec.id;
      // A line that had fully arrived stays fully arrived at its new quantity;
      // a part-received one keeps what came, up to the new quantity.
      const givenReceived = givenQty(p.receivedQty);
      const hadAll = lineReceivedQty(rec) >= (Number(rec.qty) || 0) - 0.0001;
      const received = givenReceived !== null ? givenReceived
        : hadAll ? qty : Math.min(qty, lineReceivedQty(rec));
      if (received < 0 || received > qty + 0.0001) {
        throw new Error(`Received quantity must be between 0 and ${qty}`);
      }
      rec.receivedQty = r2(received);
      rec.itemId = itemId;
      rec.qty = qty;
      rec.costPrice = r2(cost);
      if (p.note !== undefined) rec.note = p.note || '';
      if (!bill) {
        if (p.supplierName !== undefined) rec.supplierName = p.supplierName || '';
        if (p.date) rec.date = p.date;
        if (p.method) rec.method = p.method;
      }
      touch(d, rec.id);
      if (bill) recomputePurchaseBill(d, bill);

      if (wasLatest) refreshItemCost(d, old.itemId);
      if (latestPurchase(d, itemId)?.id === rec.id) refreshItemCost(d, itemId);

      const it = d.items.find((x) => x.id === itemId);
      logActivity(d, 'purchase', rec.id, 'edit',
        `Edited purchase: ${rec.qty} × ${it?.name || 'item'} @ ${rec.costPrice}`
        + (bill ? ` (${bill.purchaseNo})` : ''), old, rec);
      save();
      return rec;
    }

    /* Remove a purchase outright. The last line of a purchase bill takes the
       bill with it; any payment made against that bill stays, on account. */
    case 'deletePurchase': {
      const i = d.purchases.findIndex((x) => x.id === payload.id);
      if (i < 0) throw new Error('Purchase not found');
      const rec = d.purchases[i];
      const bill = rec.purchaseBillId ? d.purchaseBills.find((b) => b.id === rec.purchaseBillId) : null;
      if (bill) assertReturnsCovered(d, bill.id, rec, rec.itemId, 0);

      const wasLatest = latestPurchase(d, rec.itemId)?.id === rec.id;
      d.purchases.splice(i, 1);

      let billRemoved = false;
      if (bill) {
        if (d.purchases.some((x) => x.purchaseBillId === bill.id)) {
          recomputePurchaseBill(d, bill);
        } else {
          d.supplierPayments.forEach((sp) => {
            if (sp.purchaseBillId === bill.id) { sp.purchaseBillId = ''; touch(d, sp.id); }
          });
          d.purchaseBills = d.purchaseBills.filter((b) => b.id !== bill.id);
          billRemoved = true;
        }
      }
      if (wasLatest) refreshItemCost(d, rec.itemId);

      const it = d.items.find((x) => x.id === rec.itemId);
      logActivity(d, 'purchase', rec.id, 'delete',
        `Deleted purchase: ${rec.qty} × ${it?.name || 'item'} @ ${rec.costPrice}`
        + (bill ? (billRemoved ? ` — purchase ${bill.purchaseNo} removed` : ` from ${bill.purchaseNo}`) : '')
        + (payload.reason ? ` — ${payload.reason}` : ''), rec, null);
      save();
      return { ok: true, billRemoved };
    }

    /* ---------------- Suppliers (the buying side) ---------------- */
    case 'saveSupplier': {
      const s = payload;
      if (!String(s.name || '').trim()) throw new Error('Supplier name is required');
      const skey = (x) => String(x || '').trim().toLowerCase().replace(/\s+/g, ' ');
      const sclash = d.suppliers.find((x) => x.id !== s.id && skey(x.name) === skey(s.name));
      if (sclash) {
        throw new Error(`A supplier called "${sclash.name}" already exists. `
          + 'Use a different name, or open the existing one.');
      }
      const fields = {
        name: s.name.trim(), phone: s.phone || '', address: s.address || '',
        openingBalance: r2(s.openingBalance),
      };
      if (s.id) {
        const i = d.suppliers.findIndex((x) => x.id === s.id);
        if (i < 0) throw new Error('Supplier not found');
        const old = { ...d.suppliers[i] };

        // A supplier who is also a party (customer) is one business: keep the
        // party's name, phone and address the same. Same rules as saveParty,
        // checked first so a refusal leaves both sides as they were.
        const party = old.partyId ? d.parties.find((x) => x.id === old.partyId) : null;
        if (party) {
          const pclash = d.parties.find((x) => x.id !== party.id && skey(x.name) === skey(fields.name));
          if (pclash) {
            throw new Error(`A party called "${pclash.name}" already exists, and this supplier's `
              + 'customer side must carry the same name.');
          }
          const want = phoneKey(fields.phone);
          const phoneClash = want && d.parties.find((x) => x.id !== party.id && phoneKey(x.phone) === want);
          if (phoneClash) {
            throw new Error(`This mobile number is already registered on party "${phoneClash.name}".`);
          }
          party.name = fields.name;
          party.phone = fields.phone;
          party.address = fields.address;
        }

        d.suppliers[i] = { ...old, ...fields };
        logActivity(d, 'supplier', s.id, 'edit', `Edited supplier "${fields.name}"`, old, d.suppliers[i]);
        save();
        return d.suppliers[i];
      }
      const rec = { id: uid('sup'), ...fields, status: 'active', createdAt: new Date().toISOString() };
      d.suppliers.push(rec);
      logActivity(d, 'supplier', rec.id, 'create', `Added supplier "${rec.name}"`);
      save();
      return rec;
    }

    case 'archiveSupplier': {
      const s = d.suppliers.find((x) => x.id === payload.id);
      if (!s) throw new Error('Supplier not found');
      s.status = s.status === 'archived' ? 'active' : 'archived';
      logActivity(d, 'supplier', s.id, 'edit',
        `${s.status === 'archived' ? 'Archived' : 'Restored'} supplier "${s.name}"`);
      save();
      return s;
    }

    /* A party who also sells to the shop. Their buying side is an ordinary
       supplier row carrying the party's id, created on first use. A supplier
       already kept under the same name is linked rather than duplicated. */
    case 'linkPartySupplier': {
      const party = d.parties.find((x) => x.id === payload.partyId);
      if (!party) throw new Error('Party not found');

      const linked = d.suppliers.find((x) => x.partyId === party.id);

      // A named supplier, linked by hand from its own page: the names need not
      // match. One party, one supplier side, so neither may already be taken.
      if (payload.supplierId) {
        const sup = d.suppliers.find((x) => x.id === payload.supplierId);
        if (!sup) throw new Error('Supplier not found');
        if (linked && linked.id !== sup.id) {
          throw new Error(`"${party.name}" is already linked to supplier "${linked.name}".`);
        }
        if (sup.partyId && sup.partyId !== party.id) {
          throw new Error(`Supplier "${sup.name}" is already linked to another party.`);
        }
        if (sup.partyId !== party.id) {
          sup.partyId = party.id;
          logActivity(d, 'supplier', sup.id, 'edit',
            `Linked supplier "${sup.name}" to party "${party.name}"`);
          save();
        }
        return sup;
      }

      if (linked) {
        if (linked.status === 'archived') { linked.status = 'active'; save(); }
        return linked;
      }

      const skey = (x) => String(x || '').trim().toLowerCase().replace(/\s+/g, ' ');
      const same = d.suppliers.find((x) => skey(x.name) === skey(party.name));
      if (same && same.partyId) {
        throw new Error(`Supplier "${same.name}" is already linked to another party.`);
      }
      if (same) {
        same.partyId = party.id;
        if (same.status === 'archived') same.status = 'active';
        logActivity(d, 'supplier', same.id, 'edit',
          `Linked supplier "${same.name}" to party "${party.name}"`);
        save();
        return same;
      }

      const rec = {
        id: uid('sup'), name: party.name, phone: party.phone || '', address: party.address || '',
        openingBalance: 0, status: 'active', createdAt: new Date().toISOString(), partyId: party.id,
      };
      d.suppliers.push(rec);
      logActivity(d, 'supplier', rec.id, 'create',
        `Party "${party.name}" set up as a supplier`);
      save();
      return rec;
    }

    /* Settle what a party owes on sales against what the shop owes them on
       purchases. No cash moves: the sale bills are paid oldest first with a
       'Set-off' payment, and the same amount is paid to their supplier side,
       so both halves of the khata go down together and the net is unchanged. */
    case 'setOffParty': {
      const party = d.parties.find((x) => x.id === payload.partyId);
      if (!party) throw new Error('Party not found');
      const sup = d.suppliers.find((x) => x.partyId === party.id);
      if (!sup) throw new Error('Nothing has been bought from this party yet');

      const amount = r2(payload.amount);
      if (!(amount > 0)) throw new Error('Enter an amount to set off');

      const mine = d.bills
        .filter((b) => b.partyId === party.id && b.status !== 'voided')
        .sort((a, b) => String(a.date).localeCompare(String(b.date))
          || String(a.billNo).localeCompare(String(b.billNo)));
      const dues = mine.map((b) => [b, billState(b, {
        payments: d.payments, returns: d.returns, cheques: d.cheques,
      }).due]);
      const receivable = r2(dues.reduce((s, x) => s + x[1], 0));
      const payable = r2(supplierBalance(sup.id, d));

      if (amount > receivable + 0.004) {
        throw new Error(`Set-off cannot be more than ${party.name} owes on sales (${receivable.toFixed(2)}).`);
      }
      if (amount > payable + 0.004) {
        throw new Error(`Set-off cannot be more than you owe ${party.name} on purchases (${Math.max(0, payable).toFixed(2)}).`);
      }

      const date = payload.date || todayISO();
      const note = payload.note || 'Set off against purchases';
      let remaining = amount;
      const applied = [];
      for (const [bill, due] of dues) {
        if (remaining <= 0.004) break;
        if (due <= 0.004) continue;
        const use = r2(Math.min(due, remaining));
        d.payments.push({
          id: uid('pay'), billId: bill.id, partyId: party.id,
          method: 'Set-off', amount: use, date, note,
          reversed: false, reversedAt: '', reverseReason: '', isAdvance: false,
        });
        applied.push({ billId: bill.id, billNo: bill.billNo, amount: use });
        remaining = r2(remaining - use);
      }

      d.supplierPayments.push({
        id: uid('spy'), supplierId: sup.id, purchaseBillId: '',
        method: 'Set-off', amount, date, note, isAdvance: false,
      });

      logActivity(d, 'payment', party.id, 'create',
        `Set off ${amount} between sales and purchases of "${party.name}"`);
      save();
      return { applied, amount };
    }

    case 'savePurchaseBill': {
      const p = payload;
      const supplier = d.suppliers.find((x) => x.id === p.supplierId);
      if (!supplier) throw new Error('Select a supplier');
      const lines = p.lines || [];
      if (!lines.length) throw new Error('Add at least one item');
      lines.forEach((l, i) => {
        if (!d.items.some((it) => it.id === l.itemId)) throw new Error(`Line ${i + 1}: item not found`);
        if (!(Number(l.qty) > 0)) throw new Error(`Line ${i + 1}: quantity must be greater than zero`);
        if (!(Number(l.costPrice) >= 0)) throw new Error(`Line ${i + 1}: price must be zero or more`);
      });

      // Worked out here, never taken from the screen.
      const total = r2(lines.reduce((s, l) => s + Number(l.qty) * Number(l.costPrice), 0));
      const paidNow = r2(p.paidNow);
      if (paidNow < 0) throw new Error('Amount paid cannot be negative');
      if (paidNow > total + 0.004) {
        throw new Error(`Amount paid (${paidNow}) is more than the bill total (${total}). `
          + 'Record the extra as a separate payment to the supplier.');
      }

      const date = p.date || todayISO();
      const bill = {
        id: uid('pbl'), purchaseNo: nextPurchaseNo(d.purchaseBills, date),
        supplierId: supplier.id, invoiceNo: String(p.invoiceNo || '').trim(),
        date, totalAmount: total, note: p.note || '', status: 'active',
        createdAt: new Date().toISOString(), voidReason: '', voidedAt: '',
      };
      d.purchaseBills.push(bill);

      lines.forEach((l) => {
        // Goods usually arrive with the bill. `received: false` records an
        // order still on its way, and a line may say exactly how much came.
        const qty = Number(l.qty);
        const given = givenQty(l.receivedQty);
        const received = given !== null ? given : (p.received === false ? 0 : qty);
        if (received < 0 || received > qty + 0.0001) {
          throw new Error(`Received quantity must be between 0 and ${qty}`);
        }
        const rec = {
          id: uid('pur'), itemId: l.itemId, supplierName: supplier.name,
          qty, costPrice: r2(l.costPrice), date, note: '',
          // Paid through the supplier account, not straight from a till.
          method: '', supplierId: supplier.id, purchaseBillId: bill.id,
          receivedQty: r2(received),
        };
        d.purchases.push(rec);
        touch(d, rec.id);
        const item = d.items.find((x) => x.id === l.itemId);
        if (item) {
          item.costPrice = rec.costPrice;
          item.lastPurchaseDate = date;
          touch(d, item.id);
        }
      });

      if (paidNow > 0) {
        const pay = {
          id: uid('spy'), supplierId: supplier.id, purchaseBillId: bill.id,
          method: p.method || 'Cash', amount: paidNow, date, note: 'Paid at purchase',
        };
        d.supplierPayments.push(pay);
        touch(d, pay.id);
      }

      logActivity(d, 'purchaseBill', bill.id, 'create',
        `Purchase ${bill.purchaseNo} from ${supplier.name} — ${total}`
        + (paidNow > 0 ? `, paid ${paidNow} (${p.method || 'Cash'})` : ''));
      save();
      return bill;
    }

    /* Record how much of each purchase line has arrived from the supplier. */
    case 'setPurchaseReceipt': {
      const bill = d.purchaseBills.find((x) => x.id === payload.purchaseBillId);
      if (!bill) throw new Error('Purchase bill not found');
      if (bill.status === 'voided') throw new Error('This purchase was cancelled');
      const changes = payload.lines || [];
      if (!changes.length) throw new Error('Nothing to update');

      const done = [];
      changes.forEach((c) => {
        const line = d.purchases.find((x) => x.id === c.id && x.purchaseBillId === bill.id);
        if (!line) throw new Error('Purchase line not found');
        const qty = Number(line.qty) || 0;
        const received = givenQty(c.receivedQty);
        if (received === null || received < 0 || received > qty + 0.0001) {
          const name = d.items.find((it) => it.id === line.itemId)?.name || 'Item';
          throw new Error(`${name}: received quantity must be between 0 and ${qty}`);
        }
        done.push([line, r2(received)]);
      });
      done.forEach(([line, received]) => {
        line.receivedQty = received;
        touch(d, line.id);
      });

      const lines = d.purchases.filter((x) => x.purchaseBillId === bill.id);
      const got = r2(lines.reduce((s, l) => s + lineReceivedQty(l), 0));
      const total = r2(lines.reduce((s, l) => s + (Number(l.qty) || 0), 0));
      logActivity(d, 'purchaseBill', bill.id, 'edit',
        `Purchase ${bill.purchaseNo} receiving updated: ${got} of ${total} received`);
      save();
      return bill;
    }

    case 'voidPurchaseBill': {
      const bill = d.purchaseBills.find((x) => x.id === payload.id);
      if (!bill) throw new Error('Purchase bill not found');
      if (bill.status === 'voided') throw new Error('This purchase is already cancelled');
      if (d.supplierReturns.some((r) => r.purchaseBillId === bill.id)) {
        throw new Error('Goods from this purchase were returned to the supplier. '
          + 'Delete those returns first, then cancel the purchase.');
      }
      const old = { ...bill };
      bill.status = 'voided';
      bill.voidReason = payload.reason || '';
      bill.voidedAt = new Date().toISOString();
      logActivity(d, 'purchaseBill', bill.id, 'void',
        `Cancelled purchase ${bill.purchaseNo}${payload.reason ? ` — ${payload.reason}` : ''}`, old, bill);
      save();
      return bill;
    }

    case 'addSupplierPayment': {
      const p = payload;
      if (!d.suppliers.some((x) => x.id === p.supplierId)) throw new Error('Select a supplier');
      const amount = r2(p.amount);
      if (!(amount > 0)) throw new Error('Enter a payment amount');
      if (!p.isAdvance && p.purchaseBillId && !d.purchaseBills.some((b) => b.id === p.purchaseBillId && b.supplierId === p.supplierId)) {
        throw new Error('Purchase bill not found for this supplier');
      }
      // An advance is money handed over before goods arrive, so it never
      // belongs to one purchase bill.
      const isAdvance = Boolean(p.isAdvance);
      const rec = {
        id: uid('spy'), supplierId: p.supplierId,
        purchaseBillId: isAdvance ? '' : (p.purchaseBillId || ''),
        method: p.method || 'Cash', amount, date: p.date || todayISO(), note: p.note || '',
        isAdvance,
      };
      d.supplierPayments.push(rec);
      const sup = d.suppliers.find((x) => x.id === p.supplierId);
      logActivity(d, 'supplierPayment', rec.id, 'create',
        `${isAdvance ? 'Advance' : 'Paid'} ${amount} to ${sup?.name || 'supplier'} — ${rec.method}`);
      save();
      return rec;
    }

    case 'deleteSupplierPayment': {
      const i = d.supplierPayments.findIndex((x) => x.id === payload.id);
      if (i < 0) throw new Error('Payment not found');
      const pay = d.supplierPayments[i];
      d.supplierPayments.splice(i, 1);
      logActivity(d, 'supplierPayment', pay.id, 'delete',
        `Deleted payment of ${pay.amount} (${pay.method}) to supplier`
        + (payload.reason ? ` — ${payload.reason}` : ''), pay, null);
      save();
      return { ok: true };
    }

    case 'addSupplierReturn': {
      const r = payload;
      if (!d.suppliers.some((x) => x.id === r.supplierId)) throw new Error('Select a supplier');
      if (!d.items.some((x) => x.id === r.itemId)) throw new Error('Select an item');
      const qty = Number(r.qty);
      if (!(qty > 0)) throw new Error('Return quantity must be greater than zero');
      const value = r2(r.value);
      if (value < 0) throw new Error('Return value cannot be negative');

      if (r.purchaseBillId) {
        const bill = d.purchaseBills.find((b) => b.id === r.purchaseBillId && b.supplierId === r.supplierId);
        if (!bill) throw new Error('Purchase bill not found for this supplier');
        if (bill.status === 'voided') throw new Error('That purchase was cancelled');
        const bought = d.purchases
          .filter((x) => x.purchaseBillId === bill.id && x.itemId === r.itemId)
          .reduce((s, x) => s + (Number(x.qty) || 0), 0);
        if (!bought) throw new Error('That item is not on this purchase bill');
        const already = d.supplierReturns
          .filter((x) => x.purchaseBillId === bill.id && x.itemId === r.itemId)
          .reduce((s, x) => s + (Number(x.qty) || 0), 0);
        if (qty > r2(bought - already) + 0.0001) {
          throw new Error(`Only ${r2(bought - already)} of that item is left to return `
            + `(${bought} bought, ${already} already returned).`);
        }
      }

      const rec = {
        id: uid('srt'), supplierId: r.supplierId, purchaseBillId: r.purchaseBillId || '',
        itemId: r.itemId, qty, value, date: r.date || todayISO(), note: r.note || '',
      };
      d.supplierReturns.push(rec);
      const it = d.items.find((x) => x.id === r.itemId);
      logActivity(d, 'supplierReturn', rec.id, 'create',
        `Returned ${qty} × ${it?.name || 'item'} to supplier — value ${value}`);
      save();
      return rec;
    }

    case 'deleteSupplierReturn': {
      const i = d.supplierReturns.findIndex((x) => x.id === payload.id);
      if (i < 0) throw new Error('Return not found');
      const ret = d.supplierReturns[i];
      d.supplierReturns.splice(i, 1);
      logActivity(d, 'supplierReturn', ret.id, 'delete',
        `Deleted return to supplier (value ${ret.value})`, ret, null);
      save();
      return { ok: true };
    }

    /* ---------------- Employees ---------------- */
    case 'saveEmployee': {
      const e = payload;
      if (!String(e.name || '').trim()) throw new Error('Employee name is required');
      if (e.id) {
        const i = d.employees.findIndex((x) => x.id === e.id);
        if (i < 0) throw new Error('Employee not found');
        const old = { ...d.employees[i] };
        d.employees[i] = { ...old, ...e };
        logActivity(d, 'employee', e.id, 'edit', `Edited employee "${e.name}"`, old, d.employees[i]);
        save();
        return d.employees[i];
      }
      const rec = {
        id: uid('emp'), name: e.name.trim(), phone: e.phone || '', role: e.role || '',
        monthlySalary: r2(e.monthlySalary), joinDate: e.joinDate || todayISO(), status: 'active',
      };
      d.employees.push(rec);
      logActivity(d, 'employee', rec.id, 'create', `Added employee "${rec.name}"`);
      save();
      return rec;
    }

    case 'addEmployeeTx': {
      const t = payload;
      if (!(Number(t.amount) > 0)) throw new Error('Enter an amount');
      if (!d.employees.some((x) => x.id === t.employeeId)) throw new Error('Employee not found');
      const rec = {
        id: uid('etx'), employeeId: t.employeeId, type: t.type || 'salary',
        amount: r2(t.amount), date: t.date || todayISO(), note: t.note || '',
        method: t.method || 'Cash',
      };
      d.employeeTx.push(rec);
      const emp = d.employees.find((x) => x.id === t.employeeId);
      logActivity(d, 'employeeTx', rec.id, 'create',
        `${rec.type} ${rec.amount} to ${emp?.name || 'employee'}`);
      save();
      return rec;
    }

    /* ---------------- Expenses / stock loss / assets ---------------- */
    case 'saveExpense': {
      const e = payload;
      if (!(Number(e.amount) > 0)) throw new Error('Enter an expense amount greater than zero');
      const rec = {
        id: uid('exp'), category: e.category || 'Miscellaneous', amount: r2(e.amount),
        date: e.date || todayISO(), note: e.note || '', method: e.method || 'Cash',
        linkedStockLossId: e.linkedStockLossId || '',
      };
      d.expenses.push(rec);
      logActivity(d, 'expense', rec.id, 'create', `Expense ${rec.category} — ${rec.amount}`);
      save();
      return rec;
    }

    case 'saveStockLoss': {
      // Creates the loss log AND a linked Expense entry, no double entry (FR-36)
      const l = payload;
      const item = d.items.find((x) => x.id === l.itemId);
      if (!item) throw new Error('Select an item');
      if (!(Number(l.qty) > 0)) throw new Error('Quantity must be greater than zero');
      if (Number(l.estimatedValue) < 0) throw new Error('Estimated value cannot be negative');
      const lossId = uid('stl');
      const expId = uid('exp');

      const loss = {
        id: lossId, itemId: l.itemId, qty: Number(l.qty) || 0, reason: l.reason || 'Damaged',
        estimatedValue: r2(l.estimatedValue), date: l.date || todayISO(),
        note: l.note || '', linkedExpenseId: expId,
      };
      d.stockLoss.push(loss);

      d.expenses.push({
        id: expId, category: 'Stock Loss', amount: r2(l.estimatedValue),
        date: loss.date, note: `${item?.name || 'Item'} × ${loss.qty} — ${loss.reason}`,
        method: '', linkedStockLossId: lossId,
      });

      logActivity(d, 'stockLoss', lossId, 'create',
        `Stock loss: ${loss.qty} × ${item?.name || 'item'} (${loss.reason})`);
      save();
      return loss;
    }

    case 'saveAsset': {
      const a = payload;
      if (!String(a.name || '').trim()) throw new Error('Asset name is required');
      if (!(Number(a.value) >= 0)) throw new Error('Asset value cannot be negative');
      const rec = {
        id: uid('ast'), name: String(a.name).trim(), value: r2(a.value),
        date: a.date || todayISO(), note: a.note || '',
      };
      d.assets.push(rec);
      logActivity(d, 'asset', rec.id, 'create', `Asset added "${rec.name}"`);
      save();
      return rec;
    }

    /* ---------------- Settings ---------------- */
    case 'saveSettings': {
      const old = { ...d.settings };
      d.settings = { ...d.settings, ...payload };
      logActivity(d, 'settings', 'settings', 'edit', 'Settings updated', old, d.settings);
      save();
      return d.settings;
    }

    /* ---------------- Shared ledger links (FR-20/21) ---------------- */
    case 'createShareLink': {
      if (!payload.password || payload.password.length < 6) {
        throw new Error('Set a password of at least 6 characters');
      }
      const token = uid('shr');
      const hash = await sha256(payload.password);
      d.partyLedgerLinks = d.partyLedgerLinks.filter((l) => l.partyId !== payload.partyId);
      d.partyLedgerLinks.push({ partyId: payload.partyId, token, passwordHash: hash, active: true, createdAt: new Date().toISOString() });
      logActivity(d, 'shareLink', token, 'create', 'Shared ledger link created');
      save();
      return { token };
    }

    case 'revokeShareLink': {
      d.partyLedgerLinks = d.partyLedgerLinks.filter((l) => l.partyId !== payload.partyId);
      logActivity(d, 'shareLink', payload.partyId, 'void', 'Shared ledger link revoked');
      save();
      return { ok: true };
    }

    case 'openSharedLedger': {
      // Throttled on the token, so guessing a share password is rate-limited
      // the same way the main login is.
      const lockKey = `share:${payload.token}`;
      const wait = loginLockRemaining(lockKey);
      if (wait > 0) {
        throw new Error(`Too many attempts. Try again in ${wait} second${wait === 1 ? '' : 's'}.`);
      }

      const link = d.partyLedgerLinks.find((l) => l.token === payload.token && l.active);
      if (!link) throw new Error('This link is no longer valid');
      const hash = await sha256(payload.password || '');
      if (hash !== link.passwordHash) {
        recordLoginFailure(lockKey);
        throw new Error('Incorrect password');
      }
      clearLoginFailures(lockKey);

      const party = d.parties.find((p) => p.id === link.partyId);
      const bills = d.bills.filter((b) => b.partyId === link.partyId);
      const billIds = new Set(bills.map((b) => b.id));
      return {
        party: { name: party?.name, phone: party?.phone },
        shopName: d.settings.shopName,
        bills,
        // Attach the item NAME to each line. The shared view has no access to
        // the Items table, and showing a raw id would be meaningless to the
        // party. Only the name is exposed — no cost price or stock data.
        billItems: d.billItems
          .filter((bi) => billIds.has(bi.billId))
          .map((bi) => ({
            id: bi.id, billId: bi.billId, itemId: bi.itemId,
            qty: bi.qty, unit: bi.unit, price: bi.price,
            itemName: d.items.find((i) => i.id === bi.itemId)?.name || 'Item',
          })),
        payments: d.payments.filter((p) => p.partyId === link.partyId),
        returns: d.returns.filter((r) => billIds.has(r.billId)),
        cheques: d.cheques.filter((c) => c.partyId === link.partyId),
        partyAdvances: d.partyAdvances.filter((a) => a.partyId === link.partyId),
      };
    }

    /* ---------------- Backup (FR-51) ---------------- */
    case 'fullBackup': {
      const { users, ...rest } = d;
      return rest;
    }

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

/** Default methods plus any custom ones added in Settings. */
function allMethods(d) {
  return [...DEFAULT_METHODS, ...(d.settings.customMethods || [])];
}

/**
 * The current database, for sync to read.
 *
 * Always straight from storage, for the same reason every action re-reads: a
 * cached copy could be missing what another tab just wrote, and sync would
 * then fail to upload it.
 */
export function snapshot() {
  return db();
}

/**
 * Apply records downloaded from the Sheet.
 *
 * Runs in the same one-at-a-time chain as every action, so a download can
 * never interleave with a bill being saved and overwrite it. Written without
 * recordRemovals or touch: nothing here is a local edit, and marking it as one
 * would upload the Sheet's own records straight back to it.
 */
export function applyDownload(mutator) {
  const run = _chain.then(() => {
    const d = db();
    const changed = mutator(d);
    if (changed) {
      write(d);
      try { window.dispatchEvent(new CustomEvent('ewd:data-pulled')); }
      catch { /* no window in tests */ }
    }
    return changed;
  });
  _chain = run.catch(() => {});
  return run;
}

/**
 * Renumber bills the server had to move.
 *
 * Both sides allocate bill numbers independently, so a bill created offline can
 * arrive at a number the Sheet already gave to a different bill. The server
 * keeps the record under the next free number and reports the change; applying
 * it here keeps the same bill showing the same number in both places.
 */
export function applyBillNoChanges(changes = []) {
  if (!changes.length) return;
  const d = db();
  let dirty = false;

  changes.forEach(({ id, from, to }) => {
    const bill = d.bills.find((b) => b.id === id);
    if (!bill || !to || bill.billNo === to) return;
    bill.billNo = to;

    // Logged WITHOUT touching the bill. This number came from the server, so
    // the two sides already agree — marking it as locally edited would leave
    // it permanently pending, re-uploading on every sync forever.
    const editedAt = d.sync?.touched?.[id];
    logActivity(d, 'bill', id, 'edit',
      `Bill ${from} renumbered to ${to} — that number was already used in the Google Sheet`);
    if (d.sync?.touched) {
      if (editedAt) d.sync.touched[id] = editedAt;
      else delete d.sync.touched[id];
    }

    dirty = true;
  });

  if (dirty) save();
}

/** Wipe local data (Settings → reset). */
export function resetLocal() {
  localStorage.removeItem(DB_KEY);
  localStorage.removeItem('ewd_pending_sync');
  // Sync state describes records that no longer exist. Left behind, the next
  // push would treat fresh records with recycled ids as already uploaded.
  localStorage.removeItem('ewd_synced_at');
  _db = null;
}

/* ------------------------------------------------------------------ */
/* Demo seed data                                                      */
/* ------------------------------------------------------------------ */

function seed(d) {
  const today = new Date();
  const iso = (offset) => {
    const x = new Date(today);
    x.setDate(x.getDate() - offset);
    const p = (n) => String(n).padStart(2, '0');
    return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
  };

  d.settings.shopName = CONFIG.defaultShopName;
  d.settings.phone = '0300-1234567';
  d.settings.address = 'Main Bazaar, Karachi';

  const P = (name, phone, address, creditLimit, dueDays) => {
    const rec = { id: uid('pty'), name, phone, address, creditLimit, defaultDueDays: dueDays, status: 'active', createdAt: new Date().toISOString() };
    d.parties.push(rec); return rec;
  };
  const ahmed  = P('Ahmed Bhai Kiryana', '0301-2345678', 'Saddar Market', 60000, 7);
  const bilal  = P('Bilal General Store', '0302-3456789', 'Gulshan Block 5', 40000, 10);
  const chand  = P('Chand Traders',       '0303-4567890', 'Korangi No 5',  100000, 15);
  const dawood = P('Dawood Super Mart',   '0304-5678901', 'North Nazimabad', 50000, 7);
  const farhan = P('Farhan Karyana',      '0305-6789012', 'Malir Halt',     25000, 7);
  // Orders like clockwork every ~7 days, but has gone quiet — this is the
  // party the reorder-suggestion widget is meant to catch.
  const gulzar = P('Gulzar Store',        '0306-7890123', 'Landhi No 6',    30000, 7);

  // openingStock stays 0 for seeded items: the Purchases below are their sole
  // stock source, so stock is not double-counted.
  const I = (name, baseUnit, altUnit, conv, category, cost, low) => {
    const rec = { id: uid('itm'), name, baseUnit, altUnit, conversionRate: conv, category, costPrice: cost, lastPurchaseDate: iso(25), openingStock: 0, lowStockAlert: low, status: 'active' };
    d.items.push(rec); return rec;
  };
  const sugar  = I('Sugar',            'KG',    'Bag',    50, 'Grocery',   140, 100);
  const rice   = I('Basmati Rice',     'KG',    'Bag',    25, 'Grocery',   210,  80);
  const oil    = I('Cooking Oil 1L',   'Piece', 'Carton', 12, 'Grocery',   480,  60);
  const tea    = I('Tea Pack 250g',    'Piece', 'Carton', 24, 'Beverage',  310,  70);
  const soap   = I('Washing Soap',     'Piece', 'Carton', 48, 'Household',  55, 120);
  const flour  = I('Wheat Flour',      'KG',    'Bag',    20, 'Grocery',   120, 100);
  const milk   = I('Milk Pack 1L',     'Piece', 'Carton', 12, 'Dairy',     200,  60);

  // Purchases establish stock + cost
  // Milk is deliberately stocked thin so the Low Stock widget has something real
  // to show once sales are deducted.
  [[sugar, 900, 138], [rice, 600, 205], [oil, 420, 472], [tea, 300, 305],
   [soap, 900, 52], [flour, 700, 118], [milk, 108, 196]].forEach(([it, qty, cp]) => {
    d.purchases.push({ id: uid('pur'), itemId: it.id, supplierName: 'City Wholesale Supply', qty, costPrice: cp, date: iso(25), note: '', method: 'HBL Bank' });
  });

  // ---- Bills -------------------------------------------------------
  const year = today.getFullYear();
  let seq = 0;
  const mkBill = (party, daysAgo, lines, pays, dueDays = 7) => {
    seq++;
    const date = iso(daysAgo);
    const subtotal = r2(lines.reduce((s, [, qty, price]) => s + qty * price, 0));
    const total = Math.round(subtotal);
    const bill = {
      id: uid('bil'), billNo: `${year}-${String(seq).padStart(4, '0')}`, partyId: party.id,
      date, subtotal, roundOff: r2(total - subtotal), totalAmount: total, status: 'due',
      dueDate: addDays(date, dueDays), note: '', createdAt: new Date().toISOString(),
    };
    d.bills.push(bill);
    lines.forEach(([item, qty, price]) => {
      d.billItems.push({
        id: uid('bli'), billId: bill.id, itemId: item.id, qty, unit: item.baseUnit,
        price: r2(price), costPriceAtSale: item.costPrice, lineTotal: r2(qty * price),
      });
      d.partyItemPrices.push({ id: uid('pip'), partyId: party.id, itemId: item.id, price: r2(price), unit: item.baseUnit, date });
    });
    (pays || []).forEach(([method, amount]) => {
      d.payments.push({ id: uid('pay'), billId: bill.id, partyId: party.id, method, amount: r2(amount), date, note: '', reversed: false });
    });
    return bill;
  };

  // Fully paid
  mkBill(ahmed, 42, [[sugar, 50, 152], [oil, 12, 505]], [['Cash', 13660]]);
  mkBill(bilal, 38, [[rice, 25, 228], [tea, 12, 335]], [['JazzCash', 9720]]);

  // 30+ days overdue
  mkBill(chand, 45, [[sugar, 100, 150], [flour, 80, 132], [soap, 96, 62]], [['Cash', 10000]], 7);

  // 8–30 days overdue
  mkBill(dawood, 22, [[oil, 24, 500], [milk, 24, 215]], [['EasyPaisa', 8000]], 7);
  mkBill(farhan, 18, [[tea, 24, 332], [soap, 48, 61]], [], 7);

  // 0–7 days
  mkBill(ahmed, 6, [[rice, 50, 225], [sugar, 40, 151]], [['Cash', 5000]], 7);
  mkBill(bilal, 4, [[flour, 60, 130], [milk, 12, 218]], [], 10);

  // Recent, paid
  mkBill(chand, 3, [[soap, 144, 60], [tea, 24, 330]], [['HBL Bank', 16560]], 15);
  mkBill(dawood, 2, [[sugar, 50, 153], [oil, 12, 508]], [['Cash', 6000], ['JazzCash', 7746]], 7);
  mkBill(ahmed, 1, [[milk, 24, 216], [tea, 12, 334]], [['Cash', 9192]], 7);
  mkBill(farhan, 0, [[flour, 40, 133], [sugar, 25, 154]], [['Cash', 3000]], 7);
  mkBill(bilal, 0, [[oil, 12, 506], [soap, 48, 62]], [], 10);

  // Gulzar's steady weekly cadence, then silence — average gap ~7 days,
  // last order 16 days ago, so he shows as overdue to reorder.
  mkBill(gulzar, 44, [[soap, 48, 60], [tea, 12, 330]], [['Cash', 6840]], 7);
  mkBill(gulzar, 37, [[flour, 40, 130], [sugar, 30, 150]], [['Cash', 9700]], 7);
  mkBill(gulzar, 30, [[oil, 12, 502], [milk, 12, 214]], [['JazzCash', 8592]], 7);
  mkBill(gulzar, 23, [[rice, 25, 224], [tea, 12, 332]], [['Cash', 9584]], 7);
  mkBill(gulzar, 16, [[sugar, 35, 151], [soap, 48, 61]], [['Cash', 8213]], 7);

  // A cheque payment, pending clearance
  const chqBill = mkBill(chand, 8, [[rice, 100, 222], [oil, 24, 502]], [], 15);
  const chqPay = { id: uid('pay'), billId: chqBill.id, partyId: chand.id, method: 'Cheque', amount: 20000, date: iso(8), note: '', reversed: false };
  d.payments.push(chqPay);
  d.cheques.push({
    id: uid('chq'), billId: chqBill.id, partyId: chand.id, paymentId: chqPay.id,
    chequeNo: 'HBL-448291', bankName: 'HBL Bank', dateIssued: iso(8), dateDue: iso(-4),
    status: 'pending', amount: 20000, note: '',
  });

  // A bounced cheque, which reopens its bill's due (FR-30)
  const bncBill = mkBill(farhan, 30, [[sugar, 60, 150], [flour, 50, 131]], [], 7);
  const bncPay = { id: uid('pay'), billId: bncBill.id, partyId: farhan.id, method: 'Cheque', amount: 15550, date: iso(30), note: '', reversed: false };
  d.payments.push(bncPay);
  d.cheques.push({
    id: uid('chq'), billId: bncBill.id, partyId: farhan.id, paymentId: bncPay.id,
    chequeNo: 'MCB-119023', bankName: 'MCB Bank', dateIssued: iso(30), dateDue: iso(12),
    status: 'bounced', amount: 15550, note: 'Insufficient funds',
  });

  // Opening cash float — the money already in the drawer before this history
  // begins. Without it, seeded expenses and salaries would make cash look negative.
  d.payments.push({ id: uid('pay'), billId: null, partyId: null, method: 'Cash',
    amount: 150000, date: iso(60), note: 'Opening cash balance', reversed: false, isOpening: true });
  d.payments.push({ id: uid('pay'), billId: null, partyId: null, method: 'HBL Bank',
    amount: 400000, date: iso(60), note: 'Opening bank balance', reversed: false, isOpening: true });

  // Party advance (Plan 7.2)
  d.partyAdvances.push({ id: uid('adv'), partyId: bilal.id, amount: 10000, applied: 0, dateReceived: iso(5), method: 'Cash', note: 'Advance for next order' });
  d.payments.push({ id: uid('pay'), billId: null, partyId: bilal.id, method: 'Cash', amount: 10000, date: iso(5), note: 'Advance received', reversed: false, isAdvance: true });

  // Employees
  const E = (name, phone, role, salary, days) => {
    const rec = { id: uid('emp'), name, phone, role, monthlySalary: salary, joinDate: iso(days), status: 'active' };
    d.employees.push(rec); return rec;
  };
  const e1 = E('Kashif Ali',  '0311-1112223', 'Shop Assistant', 35000, 400);
  const e2 = E('Naveed Khan', '0312-2223334', 'Delivery Driver', 42000, 250);
  const e3 = E('Imran Shah',  '0313-3334445', 'Helper', 28000, 120);

  d.employeeTx.push(
    { id: uid('etx'), employeeId: e1.id, type: 'salary',  amount: 20000, date: iso(10), note: 'Part salary', method: 'Cash' },
    { id: uid('etx'), employeeId: e2.id, type: 'advance', amount: 10000, date: iso(8),  note: 'Advance requested', method: 'Cash' },
    { id: uid('etx'), employeeId: e3.id, type: 'salary',  amount: 28000, date: iso(6),  note: 'Full salary', method: 'Cash' },
    { id: uid('etx'), employeeId: e1.id, type: 'bonus',   amount: 5000,  date: iso(3),  note: 'Eid bonus', method: 'Cash' },
  );

  // Expenses
  d.expenses.push(
    { id: uid('exp'), category: 'Rent',      amount: 45000, date: iso(12), note: 'Shop rent', method: 'HBL Bank', linkedStockLossId: '' },
    { id: uid('exp'), category: 'Utilities', amount: 8600,  date: iso(9),  note: 'Electricity bill', method: 'Cash', linkedStockLossId: '' },
    { id: uid('exp'), category: 'Transport', amount: 4200,  date: iso(5),  note: 'Delivery fuel', method: 'Cash', linkedStockLossId: '' },
    { id: uid('exp'), category: 'Tea & Food',amount: 1800,  date: iso(2),  note: 'Shop tea', method: 'Cash', linkedStockLossId: '' },
  );

  // Stock loss + its linked expense (FR-36)
  const lossId = uid('stl'), lossExpId = uid('exp');
  d.stockLoss.push({ id: lossId, itemId: milk.id, qty: 12, reason: 'Expired', estimatedValue: 2352, date: iso(7), note: 'Past expiry date', linkedExpenseId: lossExpId });
  d.expenses.push({ id: lossExpId, category: 'Stock Loss', amount: 2352, date: iso(7), note: 'Milk Pack 1L × 12 — Expired', method: '', linkedStockLossId: lossId });

  // Assets
  d.assets.push(
    { id: uid('ast'), name: 'Delivery Van (Suzuki Bolan)', value: 1850000, date: iso(300), note: '' },
    { id: uid('ast'), name: 'Shop Racks & Shelving',       value: 120000,  date: iso(280), note: '' },
    { id: uid('ast'), name: 'Computer & Printer',          value: 95000,   date: iso(60),  note: '' },
  );

  logActivity(d, 'system', 'seed', 'create', 'Demo data loaded');
}
