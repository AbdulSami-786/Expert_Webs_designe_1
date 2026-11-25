// API layer — the single seam between the app and its backend.
//
// The contract matches the Apps Script Web App router exactly (one `action` per
// operation, POST body = {action, payload}). Two adapters implement it:
//
//   'local'  — browser localStorage. Runs with zero setup, seeded with demo data.
//   'sheets' — the deployed Google Apps Script Web App (Google Sheets database).
//
// Switch adapters in src/lib/config.js. No page imports an adapter directly:
// every screen calls api.<action>() so swapping backends changes nothing else.

import { CONFIG } from './config';
import * as local from './localAdapter';
import { callServerAction } from './sync';

/* ------------------------------------------------------------------ */
/* Sheets adapter — talks to the deployed Apps Script Web App          */
/* ------------------------------------------------------------------ */

/** Actions that only read data, so retrying them cannot duplicate a record. */
const READ_ONLY_ACTIONS = new Set(['bootstrap', 'fullBackup', 'login', 'openSharedLedger']);

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/**
 * One request to the Apps Script Web App.
 *
 * Apps Script intermittently returns an HTML error page (commonly 404 or 500)
 * instead of JSON, especially on cold starts or heavier calls. Read-only
 * actions are retried with a short backoff so a blip does not empty the
 * dashboard. Writes are NEVER retried automatically — a retried write could
 * create the same bill twice, which is far worse than surfacing an error.
 */
async function callSheets(action, payload = {}, attempt = 0, requestId = null) {
  const url = CONFIG.appsScriptUrl;
  if (!url) throw new Error('No Apps Script URL configured. Set appsScriptUrl in src/lib/config.js');

  const maxRetries = READ_ONLY_ACTIONS.has(action) ? 2 : 0;

  // One id per logical write, reused across retries of that same write.
  // The backend remembers it briefly, so a request that genuinely arrives
  // twice — a lost response, a network switch mid-send, a refresh during a
  // save — is carried out once and replies with the original result.
  const rid = requestId
    || (READ_ONLY_ACTIONS.has(action)
      ? null
      : `r_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      // text/plain avoids a CORS preflight, which Apps Script does not answer.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, payload, token: local.getToken(), requestId: rid }),
      redirect: 'follow',
    });
  } catch (networkErr) {
    if (attempt < maxRetries) {
      await sleep(800 * (attempt + 1));
      // Same rid, so the backend treats this as the same write rather than a
      // new one — which is what makes a retry safe to repeat.
      return callSheets(action, payload, attempt + 1, rid);
    }
    // Flagged so offlineSafe can tell a genuine outage (queue the write) from
    // a write the backend rejected on its merits (surface the error).
    const err = new Error('Could not reach the backend. Check your internet connection.');
    err.isNetworkError = true;
    throw err;
  }

  const text = await res.text();

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // Apps Script handed back an HTML error page rather than JSON.
    if (attempt < maxRetries) {
      await sleep(800 * (attempt + 1));
      return callSheets(action, payload, attempt + 1, rid);
    }
    const err = new Error(
      `The backend returned an error page (HTTP ${res.status}). ` +
      'If this keeps happening, redeploy the Apps Script Web App.'
    );
    // Whether the write happened is unknown. A queued write is retried under the same request id,
    // which the backend uses to carry out a write once.
    err.isTransient = true;
    throw err;
  }

  if (!json.ok) {
    // The backend no longer accepts this token. Tell the app so it can sign
    // out and return to the login screen instead of leaving a dead dashboard.
    if (action !== 'login' && /session has expired|sign in again/i.test(json.error || '')) {
      window.dispatchEvent(new CustomEvent('ewd:session-expired'));
    }
    // The Sheet's script is older than this app and has never heard of the action. Saying so
    // (and how to fix it) beats a bare "Unknown action: addRefund".
    if (/^Unknown action:/i.test(json.error || '')) {
      const err = new Error(
        `Your Google Sheet script is out of date and does not know "${action}" yet. `
        + 'Open the Sheet > Extensions > Apps Script, paste the latest Code.gs, then '
        + 'Deploy > Manage deployments > pencil > Version: New version > Deploy.');
      err.outdatedBackend = true;
      throw err;
    }
    throw new Error(json.error || 'Request failed');
  }
  return json.data;
}

/* ------------------------------------------------------------------ */
/* Adapter selection                                                   */
/* ------------------------------------------------------------------ */

const useLocal = () => CONFIG.backend === 'local';

/**
 * Actions that only mean anything on the Sheet. A share link is opened by a
 * customer on the website, which reads the Sheet, so a link stored only on
 * this computer would open nothing. The desktop app sends these to the Sheet
 * even though it otherwise works from local storage.
 */
const SHEET_ONLY_ACTIONS = new Set(['createShareLink', 'revokeShareLink']);

/** Dispatch one action to the active adapter. */
async function call(action, payload = {}, requestId = null) {
  if (useLocal()) {
    if (SHEET_ONLY_ACTIONS.has(action) && CONFIG.appsScriptUrl) {
      return callServerAction(action, payload);
    }
    return local.handle(action, payload);
  }

  if (action === 'bootstrap') return bootstrapAny();

  // Saving is instant: rehearse it on the working copy, show it, and send the real
  // save to the Sheet in the background (see "Instant saving" below).
  if (OPTIMISTIC.has(action) && shadowUsable()) {
    const done = await tryOptimistic(action, payload);
    if (done) return done.value;
  }

  // Anything that goes straight to the Sheet must not overtake saves still waiting to be sent.
  if (!READ_ONLY_ACTIONS.has(action) && !requestId) await pump();
  return callSheets(action, payload, 0, requestId);
}

/* ------------------------------------------------------------------ */
/* Instant saving                                                      */
/* ------------------------------------------------------------------ */
//
// Each write to the Google Sheet is a round trip of several seconds, and the screen used to wait
// for it and then for a full reload of every tab. Now:
//
//   1. the save is rehearsed on the working copy ("shadow", localAdapter.js) with the same
//      rules this app always applies, so the screen updates immediately;
//   2. the real save is put in a stored queue and sent to the Sheet in the background, in order,
//      carrying the ids the screen already shows so both sides hold the SAME records;
//   3. when the queue is empty the screen is refreshed from the Sheet, which is the truth. A save
//      the Sheet refuses is reported and disappears at that refresh.
//
// The queue is kept in storage, so closing the tab or losing the connection does not lose a save.

/** Writes the working copy can rehearse: the local adapter mirrors each of them. */
const OPTIMISTIC = new Set([
  'saveBill', 'voidBill', 'setDelivery', 'setLineDelivery',
  'addPayment', 'settleParty', 'reversePayment', 'deletePayment', 'updatePayment',
  'addReturn', 'addRefund', 'deleteReturn',
  'saveParty', 'archiveParty', 'saveItem', 'archiveItem',
  'saveCheque', 'setChequeStatus', 'deleteCheque',
  'addAdvance', 'deleteAdvance',
  'savePurchase', 'updatePurchase', 'deletePurchase',
  'saveSupplier', 'archiveSupplier', 'savePurchaseBill', 'voidPurchaseBill', 'setPurchaseReceipt',
  'addSupplierPayment', 'deleteSupplierPayment', 'addSupplierReturn', 'deleteSupplierReturn',
  'setOffParty',
  'saveEmployee', 'addEmployeeTx', 'saveExpense', 'saveStockLoss', 'saveAsset',
  'saveInvestment', 'deleteInvestment', 'saveTransfer', 'deleteTransfer',
  'saveSettings',
]);

let shadowReady = false;     // the working copy holds the Sheet's data
let shadowBroken = false;    // it could not be stored (storage full): save the slow, direct way
let shadowVersion = 0;       // counts instant saves, so a slower reload can tell it is out of date
const ME_KEY = 'ewd_last_me';

const shadowUsable = () => CONFIG.backend === 'sheets' && shadowReady && !shadowBroken;
const clone = (v) => JSON.parse(JSON.stringify(v ?? {}));

/** Anything saved on screen that the Sheet has not confirmed yet. */
function queueBusy() {
  return getQueue().length > 0 || Boolean(pumping);
}

function rememberMe(me) {
  try { localStorage.setItem(ME_KEY, JSON.stringify(me ?? null)); } catch { /* ignore */ }
}

function lastMe() {
  try {
    const m = JSON.parse(localStorage.getItem(ME_KEY) || 'null');
    if (m) return m;
  } catch { /* fall through */ }
  const ses = local.readSession();
  return ses ? {
    id: ses.username, username: ses.username, fullName: ses.fullName || '', role: ses.role || 'admin',
    status: 'active', allowedPages: ses.allowedPages || [], createdAt: '',
  } : null;
}

/** The screen's data, read from the working copy (it holds the Sheet's data plus what is unsent). */
async function shadowBootstrap() {
  const d = await local.handle('bootstrap');
  // The working copy has no user accounts; keep who is signed in as the Sheet last said.
  return { ...d, me: lastMe() };
}

/**
 * The screen's data. While saves are waiting to go out, the working copy answers (the Sheet does
 * not have them yet, and replacing the screen with its older picture would make them vanish).
 * Otherwise the Sheet answers and the working copy is refilled from it.
 */
async function bootstrapAny() {
  if (shadowUsable() && queueBusy()) return shadowBootstrap();

  const version = shadowVersion;
  const d = await callSheets('bootstrap', {}, 0, null);
  if (d?.me) rememberMe(d.me);

  // A save made while this was loading is not in `d`, so `d` must not replace the screen.
  const newer = () => queueBusy() || version !== shadowVersion;
  if (shadowBroken) return d;
  if (shadowReady && newer()) return shadowBootstrap();

  try {
    await local.seedShadow(d);
    shadowReady = true;
  } catch {
    // Storage is full or blocked: no instant saves on this device, the old direct way still works.
    shadowBroken = true;
    return d;
  }
  return newer() ? shadowBootstrap() : d;
}

/** Rehearse a write. Returns { value } when it is queued for the Sheet, or null to save directly. */
async function tryOptimistic(action, payload) {
  let out;
  try {
    out = await local.handleCapturing(action, clone(payload));
  } catch (err) {
    // Whatever stopped the rehearsal — a rule, a stale copy, full storage — the Sheet gets the
    // final say, so this save goes to it directly and its answer (or error) is what is shown.
    if (err?.storageFull) shadowBroken = true;
    return null;
  }

  const tempId = `q_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const entry = {
    tempId,
    action,
    // Settings are stored key by key, so an extra key would become a setting.
    payload: action === 'saveSettings' || !out.ids.length ? payload : { ...payload, _ids: out.ids },
    requestId: `q_${tempId}`,
    createdAt: new Date().toISOString(),
    syncedStatus: 'pending',
    localIds: collectIds(out.result),
    billNo: out.result?.billNo || '',
  };
  shadowVersion += 1;
  enqueueEntry(entry);
  pump();
  return { value: out.result };
}

/** `{ 'id': 'bil_…', 'lines.0.id': … }` — where each record id sits in a result. */
function collectIds(v, path = '', out = {}, depth = 0) {
  if (!v || typeof v !== 'object' || depth > 3) return out;
  if (!Array.isArray(v) && typeof v.id === 'string') out[`${path}id`] = v.id;
  Object.keys(v).forEach((k) => {
    if (v[k] && typeof v[k] === 'object') collectIds(v[k], `${path}${k}.`, out, depth + 1);
  });
  return out;
}

/* ---- the stored queue ---- */

const QUEUE_KEY = 'ewd_pending_sync';
const ID_MAP_KEY = 'ewd_id_map';
const LOCK_KEY = 'ewd_pump_lock';
const TAB_ID = Math.random().toString(36).slice(2, 9);

export function getQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); }
  catch { return []; }
}

function setQueue(q) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
  window.dispatchEvent(new CustomEvent('ewd:queue-changed', { detail: q.length }));
}

export function queueCount() {
  return getQueue().length;
}

function enqueueEntry(entry) {
  setQueue([...getQueue(), entry]);
}

/** Queue a write that failed because we were offline (the slow, direct path). */
function enqueue(action, payload) {
  const tempId = `q_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  enqueueEntry({
    tempId,
    action,
    payload,
    // Fixed now and reused on every attempt: the backend carries out one request id once, so a
    // send that succeeded but was never confirmed cannot duplicate a record.
    requestId: `q_${tempId}`,
    createdAt: new Date().toISOString(),
    syncedStatus: 'pending',
  });
}

function removeEntry(tempId) {
  setQueue(getQueue().filter((e) => e.tempId !== tempId));
}

/* ---- ids the Sheet gave a record other than the one the screen showed (an older script) ---- */

function readIdMap() {
  try { return JSON.parse(localStorage.getItem(ID_MAP_KEY) || '{}') || {}; }
  catch { return {}; }
}

function applyIdMap(payload) {
  const map = readIdMap();
  const keys = Object.keys(map);
  if (!keys.length) return payload;
  let text = JSON.stringify(payload);
  keys.forEach((k) => { if (text.includes(k)) text = text.split(k).join(map[k]); });
  return JSON.parse(text);
}

function learnIds(entry, result) {
  const then = entry.localIds || {};
  const now = collectIds(result);
  const changes = {};
  Object.keys(then).forEach((path) => {
    if (now[path] && now[path] !== then[path]) changes[then[path]] = now[path];
  });
  if (Object.keys(changes).length) {
    const map = { ...readIdMap(), ...changes };
    const keys = Object.keys(map);
    keys.slice(0, Math.max(0, keys.length - 300)).forEach((k) => { delete map[k]; });
    try { localStorage.setItem(ID_MAP_KEY, JSON.stringify(map)); } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent('ewd:ids-remapped', { detail: changes }));
  }
  if (entry.billNo && result?.billNo && result.billNo !== entry.billNo) {
    window.dispatchEvent(new CustomEvent('ewd:write-note', {
      detail: { message: `Bill ${entry.billNo} was saved as ${result.billNo} (that number was taken).` },
    }));
  }
}

/* ---- sending ---- */

let pumping = null;
let retryTimer = null;

/** Only one tab sends at a time; a lock that was not renewed for a while is dead. */
function takeLock() {
  try {
    const [owner, at] = String(localStorage.getItem(LOCK_KEY) || '').split('|');
    if (owner && owner !== TAB_ID && Date.now() - Number(at) < 90000) return false;
    localStorage.setItem(LOCK_KEY, `${TAB_ID}|${Date.now()}`);
  } catch { /* no storage: carry on */ }
  return true;
}

function dropLock() {
  try {
    if (String(localStorage.getItem(LOCK_KEY) || '').startsWith(`${TAB_ID}|`)) localStorage.removeItem(LOCK_KEY);
  } catch { /* ignore */ }
}

function retryLater(ms = 5000) {
  if (retryTimer) return;
  retryTimer = setTimeout(() => { retryTimer = null; pump(); }, ms);
}

const isSessionError = (err) => /session has expired|sign in again/i.test(err?.message || '');

/**
 * Send queued saves to the Sheet, oldest first, one at a time. Resolves when the queue is empty or
 * cannot go on right now (offline, signed out, another tab is sending).
 */
export function pump() {
  if (pumping) return pumping;
  if (!getQueue().length) return Promise.resolve();

  pumping = (async () => {
    let stalled = false;
    try {
      while (getQueue().length) {
        if (CONFIG.backend !== 'sheets' || !navigator.onLine || !local.getToken()) { stalled = true; break; }
        if (!takeLock()) { stalled = true; break; }

        const entry = getQueue()[0];
        let result;
        try {
          result = await callSheets(entry.action, applyIdMap(entry.payload), 0, entry.requestId);
        } catch (err) {
          if (err?.isNetworkError || isSessionError(err)) { stalled = true; break; }

          if (err?.isTransient && (entry.tries || 0) < 2) {
            // Unclear whether it was written. Try again under the same request id.
            setQueue(getQueue().map((e) => (e.tempId === entry.tempId ? { ...e, tries: (e.tries || 0) + 1 } : e)));
            stalled = true;
            break;
          }

          // The Sheet refused it for good. Report it; the refresh that follows removes it from the screen.
          removeEntry(entry.tempId);
          window.dispatchEvent(new CustomEvent('ewd:write-failed', {
            detail: { action: entry.action, message: err?.message || 'The Google Sheet did not accept it' },
          }));
          continue;
        }
        learnIds(entry, result);
        removeEntry(entry.tempId);
      }
    } finally {
      dropLock();
      pumping = null;
    }

    if (!getQueue().length) {
      window.dispatchEvent(new CustomEvent('ewd:writes-drained'));
    } else if (stalled) {
      retryLater();
    } else {
      pump();     // saved while this was finishing
    }
  })();
  return pumping;
}

/** Drop the working copy (sign-out). Only when nothing is waiting to be sent. */
export function forgetShadow() {
  if (getQueue().length) return;
  local.clearShadow();
  shadowReady = false;
  shadowVersion += 1;
}

/** Send what is queued (back online, signed in again). */
export async function flushQueue() {
  const before = getQueue().length;
  if (!before) return { synced: 0, failed: 0 };
  await pump();
  const after = getQueue().length;
  return { synced: Math.max(0, before - after), failed: after };
}

if (CONFIG.backend === 'sheets') {
  local.useShadowStore();
  shadowReady = getQueue().length > 0 && local.hasShadow();
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { pump(); });
  // Another tab finished sending what this one queued: look again.
  window.addEventListener('storage', (e) => {
    if (e.key !== QUEUE_KEY) return;
    const n = getQueue().length;
    window.dispatchEvent(new CustomEvent('ewd:queue-changed', { detail: n }));
    if (!n) window.dispatchEvent(new CustomEvent('ewd:writes-drained'));
  });
  // Saves left over from the last visit go out as soon as this page loads.
  setTimeout(() => { pump(); }, 1500);
}

/**
 * Wrapper for writes that must survive an outage: if the call fails while
 * offline, it is queued and reported as pending rather than lost.
 */
async function offlineSafe(action, payload) {
  try {
    return await call(action, payload);
  } catch (err) {
    // The local backend never touches the network, so a failure there is a
    // real problem with the data — "select a party", "quantity must be greater
    // than zero", a full disk. Queueing it would hide the message behind
    // "Saved offline", leave the record unsaved, and then replay the same
    // invalid write on reconnect.
    if (useLocal()) throw err;

    // On the Sheets backend, only queue when the browser is actually offline
    // AND the failure was the network itself. A rejected write — bad data, or
    // a bill the server refused — must surface, or the shopkeeper is told it
    // saved while it never will.
    if (!navigator.onLine && err?.isNetworkError) {
      enqueue(action, payload);
      return { queued: true, pendingSync: true };
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Public API — one method per backend action                          */
/* ------------------------------------------------------------------ */

export const api = {
  // Auth
  login:          (u, p)        => call('login', { username: u, password: p }),
  changePassword: (oldP, newP)  => call('changePassword', { oldPassword: oldP, newPassword: newP }),

  // User management — super admin only (enforced by the backend)
  listUsers:        ()                 => call('listUsers'),
  // { id?, username, fullName, password (new users), role, allowedPages }
  saveUser:         (user)             => call('saveUser', user),
  setUserPassword:  (id, newPassword)  => call('setUserPassword', { id, newPassword }),
  setUserStatus:    (id, status)       => call('setUserStatus', { id, status }),
  deleteUser:       (id)               => call('deleteUser', { id }),

  // Bootstrap — one call fetches all reference data (Perf Guide 1.2 batch reads)
  bootstrap:      ()            => call('bootstrap'),

  // Parties
  saveParty:      (party)       => call('saveParty', party),
  archiveParty:   (id)          => call('archiveParty', { id }),
  // Permanent: the party, all their bills, payments, returns, cheques and advances. Super admin only.
  deleteParty:    (id)          => call('deleteParty', { id }),
  // Per-party ledger password. An empty password removes the lock.
  setPartyLock:   (partyId, password, currentPassword) =>
    call('setPartyLock', { partyId, password, currentPassword }),

  // Items
  saveItem:       (item)        => call('saveItem', item),
  archiveItem:    (id)          => call('archiveItem', { id }),

  // Bills — offline-safe (FR-12)
  saveBill:       (bill)        => offlineSafe('saveBill', bill),
  voidBill:       (id, reason)  => call('voidBill', { id, reason }),
  // Permanent: the bill with its lines, payments, returns and cheques. Super admin only.
  deleteBill:     (id, reason)  => call('deleteBill', { id, reason }),
  // Remove every entry dated from..to (YYYY-MM-DD). Permanent. Super admin only.
  purgeEntries:   (from, to)    => call('purgeEntries', { from, to }),
  setDelivery:    (id, delivery) => call('setDelivery', { id, delivery }),
  // Per line: [{ id, deliveredQty }] — some items go now, the rest later.
  setLineDelivery: (billId, lines) => call('setLineDelivery', { billId, lines }),

  // Payments
  addPayment:     (payment)     => offlineSafe('addPayment', payment),
  reversePayment: (id, reason)  => call('reversePayment', { id, reason }),
  // `orphan` lets an advance receipt be removed when its advance row is gone.
  deletePayment:  (id, reason, orphan = false) =>
    call('deletePayment', { id, reason, orphan }),
  updatePayment:  (payment)     => call('updatePayment', payment),
  // One payment spread across a party's unpaid bills, oldest first.
  settleParty:    (settlement)  => offlineSafe('settleParty', settlement),

  // Returns
  addReturn:      (ret)         => call('addReturn', ret),
  // Hand money back for goods returned from a paid bill.
  addRefund:      (r)           => call('addRefund', r),
  // Remove a return entry for good (the bill goes back up, restocked goods leave stock again).
  deleteReturn:   (id, reason)  => call('deleteReturn', { id, reason }),

  // Cheques
  saveCheque:     (cheque)      => call('saveCheque', cheque),
  setChequeStatus:(id, status)  => call('setChequeStatus', { id, status }),
  deleteCheque:   (id, reason)  => call('deleteCheque', { id, reason }),

  // Party advances
  addAdvance:     (adv)         => call('addAdvance', adv),
  deleteAdvance:  (id, reason)  => call('deleteAdvance', { id, reason }),

  // Purchases
  savePurchase:   (p)           => call('savePurchase', p),
  updatePurchase: (p)           => call('updatePurchase', p),
  deletePurchase: (id, reason)  => call('deletePurchase', { id, reason }),

  // Suppliers — the buying side
  saveSupplier:          (s)          => call('saveSupplier', s),
  archiveSupplier:       (id)         => call('archiveSupplier', { id }),
  // Permanent: an archived supplier with all their purchases, payments and returns. Super admin only.
  deleteSupplier:        (id)         => call('deleteSupplier', { id }),
  savePurchaseBill:      (b)          => call('savePurchaseBill', b),
  // Move standalone Purchases-page rows into a supplier's purchase bill (stock unchanged).
  adoptPurchases:        (b)          => call('adoptPurchases', b),
  voidPurchaseBill:      (id, reason) => call('voidPurchaseBill', { id, reason }),
  // Per line: [{ id, receivedQty }] — how much of each item has arrived.
  setPurchaseReceipt:    (purchaseBillId, lines) => call('setPurchaseReceipt', { purchaseBillId, lines }),
  addSupplierPayment:    (p)          => call('addSupplierPayment', p),
  deleteSupplierPayment: (id, reason) => call('deleteSupplierPayment', { id, reason }),
  addSupplierReturn:     (r)          => call('addSupplierReturn', r),
  deleteSupplierReturn:  (id)         => call('deleteSupplierReturn', { id }),
  // A party who also sells to the shop: their supplier side, and settling
  // one side of their khata against the other without cash changing hands.
  linkPartySupplier:     (partyId, supplierId) => call('linkPartySupplier', { partyId, supplierId }),
  unlinkPartySupplier:   (supplierId) => call('unlinkPartySupplier', { supplierId }),
  setOffParty:           (s)          => call('setOffParty', s),

  // Employees
  saveEmployee:   (e)           => call('saveEmployee', e),
  addEmployeeTx:  (t)           => call('addEmployeeTx', t),

  // Expenses / stock loss / assets
  saveExpense:    (e)           => call('saveExpense', e),
  saveStockLoss:  (l)           => call('saveStockLoss', l),
  saveAsset:      (a)           => call('saveAsset', a),

  // Investments — money put into the business (counts as money in, like an opening balance)
  saveInvestment:   (i)         => call('saveInvestment', i),
  deleteInvestment: (id)        => call('deleteInvestment', { id }),
  // Transfers — money moved from one of the shop's accounts to another (net zero overall)
  saveTransfer:     (t)         => call('saveTransfer', t),
  deleteTransfer:   (id)        => call('deleteTransfer', { id }),
  // Permanent; a stock-loss expense also removes its loss entry. Super admin only.
  deleteExpense:  (id)          => call('deleteExpense', { id }),

  // Settings
  saveSettings:   (s)           => call('saveSettings', s),

  // Shared ledger links (FR-20/21)
  createShareLink:(partyId, pw) => call('createShareLink', { partyId, password: pw }),
  revokeShareLink:(partyId)     => call('revokeShareLink', { partyId }),
  openSharedLedger:(token, pw)  => call('openSharedLedger', { token, password: pw }),

  // Backup (FR-51)
  fullBackup:     ()            => call('fullBackup'),

  // Queue helpers
  queueCount,
  flushQueue,
};

export default api;
