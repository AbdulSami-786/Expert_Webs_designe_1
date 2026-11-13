// Sync — keep the device and the Google Sheet holding the same records.
//
// How the dashboard is meant to behave (and now does):
//
//   * Every write goes to local storage first, always. Billing never waits on
//     the network, and a dropped connection mid-sale changes nothing.
//   * Whenever there is internet, the local records are pushed to the Sheet.
//     Online, that happens right after each write, so the Sheet is effectively
//     live. Offline, the work simply accumulates and goes up on reconnect.
//   * Both databases end up with the SAME ids, so a bill's partyId resolves on
//     either side and the two ledgers agree row for row.
//
// The two properties that matter for money, and how they are guaranteed:
//
//   No duplicates — the server upserts on the record's id, which this device
//   generated. Pushing the same day twice updates the same rows rather than
//   adding a second copy. Sync is safe to retry, and safe to interrupt.
//
//   No lost entries — a record is only marked as synced after the server has
//   confirmed it in that same response. Anything the server rejected, or that
//   never made it, stays pending and goes again next time.

import { CONFIG } from './config';
import * as local from './localAdapter';

/* ------------------------------------------------------------------ */
/* Which local collections map to which sheet tabs                     */
/* ------------------------------------------------------------------ */

// Parents first: a bill must not reach the Sheet before the party it belongs
// to. The server applies the tabs in this same order.
export const SYNC_TABS = [
  ['parties', 'Parties'],
  ['suppliers', 'Suppliers'],
  ['items', 'Items'],
  ['employees', 'Employees'],
  ['assets', 'Assets'],
  ['purchaseBills', 'PurchaseBills'],
  ['purchases', 'Purchases'],
  ['bills', 'Bills'],
  ['billItems', 'BillItems'],
  ['partyItemPrices', 'PartyItemPrices'],
  ['payments', 'Payments'],
  ['returns', 'Returns'],
  ['cheques', 'Cheques'],
  ['partyAdvances', 'PartyAdvances'],
  ['employeeTx', 'EmployeeTransactions'],
  ['expenses', 'Expenses'],
  ['stockLoss', 'StockLoss'],
  ['supplierPayments', 'SupplierPayments'],
  ['supplierReturns', 'SupplierReturns'],
  // Last, so a log entry never reaches the Sheet ahead of what it describes.
  // Not in localAdapter's SYNCED_KEYS: the log is append-only, so it never
  // needs a deletion recorded.
  ['activityLog', 'ActivityLog'],
];

const TAB_FOR_KEY = Object.fromEntries(SYNC_TABS);

// The id sync uses to track the settings object, which is one record rather
// than a list. Matches the entity id localAdapter logs a settings edit under.
const SETTINGS_ID = 'settings';

const SYNCED_KEY = 'ewd_synced_at';

/** When each record was last confirmed present on the server. */
export function readSynced() {
  try { return JSON.parse(localStorage.getItem(SYNCED_KEY) || '{}') || {}; }
  catch { return {}; }
}

function writeSynced(map) {
  try { localStorage.setItem(SYNCED_KEY, JSON.stringify(map)); }
  catch { /* a full disk must not break billing; sync retries next time */ }
}

/** Forget all sync state, so the next push re-sends everything. */
export function resetSyncState() {
  try { localStorage.removeItem(SYNCED_KEY); } catch { /* ignore */ }
}

function notify(detail) {
  try { window.dispatchEvent(new CustomEvent('ewd:sync-changed', { detail })); }
  catch { /* no window in tests */ }
}

/* ------------------------------------------------------------------ */
/* What still needs to go up                                           */
/* ------------------------------------------------------------------ */

/**
 * Records this device holds that the server has not confirmed at their current
 * version. A record counts as pending when it has never been synced, or when
 * it was edited here after it was last synced.
 */
export function collectPending(db, synced = readSynced()) {
  const touched = db?.sync?.touched || {};
  const out = {};
  let count = 0;

  for (const [key, tab] of SYNC_TABS) {
    const rows = db?.[key] || [];
    const pending = rows.filter((rec) => {
      if (!rec?.id) return false;
      const confirmedAt = synced[rec.id];
      if (!confirmedAt) return true;             // never sent
      const editedAt = touched[rec.id];
      if (!editedAt) return false;               // sent, untouched since
      // The confirmation is stamped from just BEFORE the request was sent, so
      // an edit at the same moment or later has genuinely not been uploaded at
      // its current version and must go again. Erring towards re-sending is
      // safe: the server upserts by id, so a redundant push updates in place
      // and can never duplicate.
      return editedAt >= confirmedAt;
    });

    if (pending.length) {
      // Attach the time this device last wrote each record. The server settles
      // a conflict on it, and without it a genuine edit would look older than
      // the server's copy and be ignored. It is sent alongside the record
      // rather than stored on it, so no sheet column is needed.
      out[tab] = pending.map((rec) => (
        touched[rec.id] ? { ...rec, updatedAt: touched[rec.id] } : rec
      ));
      count += pending.length;
    }
  }

  // Records deleted on this device that the Sheet has not yet confirmed
  // deleting. Tracked under a 'del:' key so they cannot collide with the
  // record's own sync stamp.
  const deleted = {};
  for (const [id, info] of Object.entries(db?.sync?.deleted || {})) {
    const tab = TAB_FOR_KEY[info?.key];
    if (!tab || synced[`del:${id}`]) continue;
    (deleted[tab] = deleted[tab] || []).push(id);
    count += 1;
  }

  // Settings are one object, not a list, so they ride separately.
  const settingsEdited = touched[SETTINGS_ID];
  const settings = settingsEdited && !(synced[SETTINGS_ID] > settingsEdited)
    ? db.settings : null;
  if (settings) count += 1;

  return { records: out, deleted, settings, count };
}

/** How many records are waiting to reach the Sheet. */
export function pendingCount() {
  if (CONFIG.backend !== 'local') return 0;
  try { return collectPending(local.snapshot()).count; }
  catch { return 0; }
}

/* ------------------------------------------------------------------ */
/* Pushing                                                             */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One request to the Apps Script Web App, retried through Google's flakiness.
 *
 * Apps Script intermittently answers a perfectly good deployment with an HTML
 * 404 or 500 page instead of JSON — often enough to see it within three calls.
 * Retrying is safe here for the same reason syncing twice is safe: the server
 * upserts on the record id, so a request that did land and a retry of it
 * produce the same rows. Giving up on the first blip would strand a day's work
 * and show the shopkeeper a redeploy message about a deployment that is fine.
 */
async function callSheets(action, payload, attempt = 0) {
  const url = CONFIG.appsScriptUrl;
  if (!url) throw new Error('No Google Sheets URL is configured (src/lib/config.js).');

  const MAX_RETRIES = 3;

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, payload, token: readSheetsToken() }),
      redirect: 'follow',
    });
  } catch (networkErr) {
    if (attempt < MAX_RETRIES && navigator.onLine) {
      await sleep(900 * (attempt + 1));
      return callSheets(action, payload, attempt + 1);
    }
    throw new Error('Could not reach Google Sheets. Check your internet connection.');
  }

  const text = await res.text();

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // An HTML page rather than JSON: almost always a transient Apps Script
    // fault, so try again before blaming the deployment.
    if (attempt < MAX_RETRIES) {
      await sleep(900 * (attempt + 1));
      return callSheets(action, payload, attempt + 1);
    }
    throw new Error(
      `Google Sheets returned an error page (HTTP ${res.status}) ${MAX_RETRIES + 1} times. ` +
      'Check that the Web App URL in src/lib/config.js matches your current deployment.'
    );
  }

  if (!json.ok) {
    // A lapsed session is recoverable without bothering anyone: the credentials
    // live in config, so sign in again and repeat the call once. Sessions are
    // effectively permanent now, so this should be rare — but a session can
    // still be revoked server-side (a password change, or eviction at the
    // session cap), and syncing must recover from that on its own.
    if (isSessionError(json.error) && action !== 'login' && attempt < 1) {
      signOutOfSheets();
      await ensureSignedIn();
      return callSheets(action, payload, attempt + 1);
    }
    // Any other rejection is the server's considered answer, not a blip.
    throw new Error(json.error || 'Google Sheets rejected the request');
  }
  return json.data;
}

function isSessionError(message) {
  return /session has expired|sign in again/i.test(String(message || ''));
}

const SHEETS_SESSION_KEY = 'ewd_sheets_session';

function readSheetsToken() {
  try {
    const s = JSON.parse(localStorage.getItem(SHEETS_SESSION_KEY) || 'null');
    if (!s?.token) return null;
    if (s.expiresAt && Date.now() >= s.expiresAt) return null;
    return s.token;
  } catch { return null; }
}

/**
 * Sign in to the Sheets backend so pushes are authorised.
 *
 * The Sheet has its own user list, so syncing needs its own session. These are
 * the credentials for the Sheet, which may differ from the ones used on this
 * device.
 */
export async function signInToSheets(username, password) {
  const session = await callSheets('login', { username, password });
  localStorage.setItem(SHEETS_SESSION_KEY, JSON.stringify(session));
  return session;
}

/**
 * Make sure there is a usable Sheets session, signing in from the credentials
 * in config if there is not.
 *
 * This is what keeps sync invisible: the shopkeeper never sees a login for the
 * Sheet, and a session that lapses overnight is renewed on the next attempt
 * rather than quietly stopping the uploads.
 */
export async function ensureSignedIn() {
  if (readSheetsToken()) return true;

  const { username, password } = CONFIG.sheetsAuth || {};
  if (!username || !password) {
    throw new Error('No Google Sheets credentials are configured (sheetsAuth in src/lib/config.js).');
  }

  await signInToSheets(username, password);
  return true;
}

export function signedInToSheets() {
  return Boolean(readSheetsToken());
}

export function signOutOfSheets() {
  try { localStorage.removeItem(SHEETS_SESSION_KEY); } catch { /* ignore */ }
}

/**
 * Push everything outstanding to the Google Sheet.
 *
 * Returns a summary the UI can show. Throwing is reserved for "the push did not
 * happen at all" — a per-record failure is reported inside the summary and
 * leaves that record pending.
 */
export async function pushToSheets({ force = false } = {}) {
  if (CONFIG.backend !== 'local') {
    throw new Error('Sync is for the local backend. This dashboard already writes to Sheets directly.');
  }
  if (!navigator.onLine) throw new Error('No internet connection.');

  // Connects itself from the credentials in config — there is no sign-in step
  // for anyone to perform or forget.
  await ensureSignedIn();

  const synced = force ? {} : readSynced();
  const db = local.snapshot();
  const { records, deleted, settings, count } = collectPending(db, synced);

  if (!count) {
    notify({ pending: 0, status: 'idle' });
    return { pushed: 0, inserted: 0, updated: 0, kept: 0, failed: 0, upToDate: true };
  }

  notify({ pending: count, status: 'syncing' });

  // Taken BEFORE the request goes out. Anything edited while the push is in
  // flight then has a later timestamp than this confirmation and is correctly
  // seen as still pending, instead of being marked synced at a version the
  // server never received.
  const sentAt = new Date().toISOString();

  const result = await callSheets('syncPush', { records, deleted });

  // Mark as confirmed ONLY what the server accepted in this response. A record
  // it rejected keeps its pending state and goes up again next time, which is
  // what stops a failed row from being quietly dropped.
  const failedIds = new Set((result.errors || []).map((e) => String(e.id)));
  const now = new Date().toISOString();
  const nextSynced = { ...readSynced() };

  // The server reports each tab it actually processed. An older Code.gs that
  // does not know a tab (Suppliers, before redeploying) skips it without an
  // error — marking those records as synced would strand them on this device
  // forever. So they stay pending until a server that knows the tab takes them.
  const handled = (tab) => !result.byTab || Object.prototype.hasOwnProperty.call(result.byTab, tab);

  for (const [tab, rows] of Object.entries(records)) {
    if (!handled(tab)) continue;
    for (const rec of rows) {
      if (!failedIds.has(String(rec.id))) nextSynced[rec.id] = sentAt;
    }
  }

  // A backend older than deletion support ignores `deleted` and reports no
  // count for it. Those stay pending rather than being marked done, so the
  // deletes go up once the new Code.gs is deployed.
  if (typeof result.deleted === 'number') {
    for (const ids of Object.values(deleted)) {
      for (const id of ids) {
        if (!failedIds.has(String(id))) nextSynced[`del:${id}`] = sentAt;
      }
    }
  }
  writeSynced(nextSynced);

  // Settings go through the ordinary saveSettings action, which the server
  // has always had.
  if (settings) {
    try {
      await callSheets('saveSettings', settings);
      writeSynced({ ...readSynced(), [SETTINGS_ID]: sentAt });
    } catch {
      // Left pending; the next sync tries again.
    }
  }

  // The server renumbers a bill whose number was already taken. Apply that
  // locally so both sides show the same number on the same bill.
  if (result.billNoChanges?.length) {
    local.applyBillNoChanges(result.billNoChanges);
  }

  const remaining = collectPending(local.snapshot(), readSynced()).count;
  // billNoChanges rides along because a renumbered bill is the one sync outcome
  // the shopkeeper must actually see — the number on the printed bill in the
  // customer's hand no longer matches the ledger. Sync now runs entirely in the
  // background, so if this is not reported here it is reported nowhere.
  notify({
    pending: remaining, status: 'idle', lastSyncAt: now,
    billNoChanges: result.billNoChanges || [],
    failed: result.failed || 0,
    errors: result.errors || [],
  });

  return {
    pushed: count,
    inserted: result.inserted || 0,
    updated: result.updated || 0,
    kept: result.kept || 0,
    failed: result.failed || 0,
    conflicts: result.conflicts || [],
    errors: result.errors || [],
    billNoChanges: result.billNoChanges || [],
    remaining,
    lastSyncAt: now,
  };
}

/* ------------------------------------------------------------------ */
/* Pulling                                                             */
/* ------------------------------------------------------------------ */

function sameRecord(a, b) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    if (String(a?.[k] ?? '') !== String(b?.[k] ?? '')) return false;
  }
  return true;
}

/** Highest sequence number used per year, from bill numbers like 2026-0042. */
function billCountersFrom(bills) {
  const out = {};
  for (const b of bills || []) {
    const m = /^(\d{4})-(\d+)$/.exec(String(b?.billNo || ''));
    if (m) out[m[1]] = Math.max(out[m[1]] || 0, Number(m[2]));
  }
  return out;
}

/**
 * Download the Sheet into this device.
 *
 * This is what lets the desktop app see records entered on the website or
 * another device. The rules, per record id:
 *
 *   * On the Sheet, not here           → added, unless it was deleted here.
 *   * On both, with no local edit      → the Sheet's version is taken.
 *   * On both, edited here since the
 *     last upload                      → kept as is; the next upload sends it.
 *   * Here only, never uploaded        → kept; it has not been sent yet.
 *   * Here only, already uploaded      → removed; someone deleted it on the Sheet.
 *
 * The Sheet's version is laid over the local one rather than replacing it, so
 * a field the Sheet has no column for is not lost.
 */
export async function pullFromSheets() {
  if (CONFIG.backend !== 'local') return null;
  if (!navigator.onLine) throw new Error('No internet connection.');

  await ensureSignedIn();
  const server = await callSheets('bootstrap', {});
  const fetchedAt = new Date().toISOString();
  const stats = { added: 0, updated: 0, removed: 0 };
  let synced = null;

  await local.applyDownload((d) => {
    synced = readSynced();
    const touched = d.sync?.touched || {};
    const deleted = d.sync?.deleted || {};
    const isPending = (id) => {
      const confirmedAt = synced[id];
      if (!confirmedAt) return true;
      const editedAt = touched[id];
      return Boolean(editedAt && editedAt >= confirmedAt);
    };
    let changed = false;

    for (const [key] of SYNC_TABS) {
      const rows = server?.[key];
      // A tab missing from the response says nothing about what it holds, so
      // it must not be read as "everything was deleted".
      if (!Array.isArray(rows)) continue;

      const serverById = new Map();
      rows.forEach((r) => { if (r?.id) serverById.set(String(r.id), r); });

      const next = [];
      const seen = new Set();

      for (const rec of d[key] || []) {
        const id = String(rec?.id);
        seen.add(id);
        const srv = serverById.get(id);

        if (!srv) {
          if (synced[id] && !isPending(id)) { stats.removed++; changed = true; continue; }
          next.push(rec);
          continue;
        }
        if (isPending(id)) { next.push(rec); continue; }

        const merged = { ...rec, ...srv };
        if (!sameRecord(rec, merged)) { stats.updated++; changed = true; }
        next.push(merged);
      }

      for (const [id, srv] of serverById) {
        if (seen.has(id) || deleted[id]) continue;
        next.push(srv);
        // Came from the Sheet, so there is nothing to send back.
        synced[id] = fetchedAt;
        stats.added++;
        changed = true;
      }

      d[key] = next;
    }

    // Newest first, as the Activity Log screen expects.
    d.activityLog.sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));

    // Share links live only on the Sheet (a customer opens them on the
    // website), so the Sheet's list is simply the truth.
    if (Array.isArray(server?.partyLedgerLinks) &&
        JSON.stringify(server.partyLedgerLinks) !== JSON.stringify(d.partyLedgerLinks || [])) {
      d.partyLedgerLinks = server.partyLedgerLinks;
      changed = true;
    }

    // Settings: the Sheet wins unless they were changed here and not yet sent.
    const settingsEdited = touched[SETTINGS_ID];
    const settingsPending = settingsEdited && !(synced[SETTINGS_ID] > settingsEdited);
    if (server?.settings && !settingsPending) {
      const merged = { ...d.settings, ...server.settings };
      if (!sameRecord(d.settings, merged)) { d.settings = merged; changed = true; }
    }

    // New bills here must continue after the Sheet's numbers, not reuse them.
    const counters = billCountersFrom(d.bills);
    d.billCounter = d.billCounter || {};
    for (const [year, n] of Object.entries(counters)) {
      if ((d.billCounter[year] || 0) < n) { d.billCounter[year] = n; changed = true; }
    }

    return changed;
  });

  if (synced) writeSynced(synced);
  try { localStorage.setItem(LAST_PULL_KEY, fetchedAt); } catch { /* ignore */ }
  return { ...stats, pulledAt: fetchedAt };
}

const LAST_PULL_KEY = 'ewd_last_pull_at';

/** When this device last downloaded from the Sheet, or ''. */
export function lastPullAt() {
  try { return localStorage.getItem(LAST_PULL_KEY) || ''; } catch { return ''; }
}

/* ------------------------------------------------------------------ */
/* Automatic syncing                                                   */
/* ------------------------------------------------------------------ */

let timer = null;
let queue = Promise.resolve();

/**
 * Run sync work one job at a time. An upload and a download overlapping would
 * each read the sync stamps before the other wrote them back.
 */
function exclusive(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

/**
 * Upload anything pending, then (if asked) download the Sheet.
 * Quiet by design: a failure here is normal (no internet) and must never
 * interrupt someone in the middle of writing a bill.
 */
export async function trySync({ pull = false } = {}) {
  if (CONFIG.backend !== 'local') return null;
  if (!navigator.onLine) return null;
  if (!CONFIG.sheetsAuth?.username) return null;   // sync not configured
  if (!pull && !pendingCount()) return null;

  return exclusive(async () => {
    try {
      const pushed = pendingCount() ? await pushToSheets() : null;
      const pulled = pull ? await pullFromSheets() : null;
      if (pulled) notify({ pending: pendingCount(), status: 'idle', lastSyncAt: pulled.pulledAt });
      return { pushed, pulled };
    } catch (err) {
      notify({ pending: pendingCount(), status: 'error', error: err.message });
      return null;
    }
  });
}

/**
 * Call a Sheet-only action (share links) from the desktop app: upload first so
 * the Sheet knows the party, run the action, then download its result.
 */
export function callServerAction(action, payload) {
  if (!navigator.onLine) {
    return Promise.reject(new Error('This needs an internet connection. Please connect and try again.'));
  }
  return exclusive(async () => {
    await ensureSignedIn();
    if (pendingCount()) await pushToSheets();
    const result = await callSheets(action, payload);
    await pullFromSheets();
    return result;
  });
}

/**
 * Start automatic syncing: upload right after each write; upload and download
 * on start, on reconnect, and on a timer.
 */
export function startAutoSync({ intervalMs = 60000 } = {}) {
  if (typeof window === 'undefined') return () => {};

  const onOnline = () => { trySync({ pull: true }); };
  const onWrite = () => { trySync(); };

  window.addEventListener('online', onOnline);
  window.addEventListener('ewd:data-changed', onWrite);
  if (timer) clearInterval(timer);
  timer = setInterval(() => { trySync({ pull: true }); }, intervalMs);

  trySync({ pull: true });

  return () => {
    window.removeEventListener('online', onOnline);
    window.removeEventListener('ewd:data-changed', onWrite);
    if (timer) { clearInterval(timer); timer = null; }
  };
}

export default {
  pushToSheets, pullFromSheets, trySync, startAutoSync, pendingCount, callServerAction,
  signInToSheets, signedInToSheets, signOutOfSheets, resetSyncState,
};
