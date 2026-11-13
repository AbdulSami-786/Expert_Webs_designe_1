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
    throw new Error(
      `The backend returned an error page (HTTP ${res.status}). ` +
      'If this keeps happening, redeploy the Apps Script Web App.'
    );
  }

  if (!json.ok) {
    // The backend no longer accepts this token. Tell the app so it can sign
    // out and return to the login screen instead of leaving a dead dashboard.
    if (action !== 'login' && /session has expired|sign in again/i.test(json.error || '')) {
      window.dispatchEvent(new CustomEvent('ewd:session-expired'));
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
  return callSheets(action, payload, 0, requestId);
}

/* ------------------------------------------------------------------ */
/* Offline queue (FR-12 / Plan 7.10)                                   */
/* ------------------------------------------------------------------ */

const QUEUE_KEY = 'ewd_pending_sync';

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

/** Queue a write that failed because we were offline. */
function enqueue(action, payload) {
  const q = getQueue();
  const tempId = `q_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  q.push({
    tempId,
    action,
    payload,
    // Fixed now and reused on every flush attempt. Without it each attempt
    // would look like a brand new write to the backend, so a flush that sent a
    // record and then failed before clearing the queue would duplicate it.
    requestId: `q_${tempId}`,
    createdAt: new Date().toISOString(),
    syncedStatus: 'pending',
  });
  setQueue(q);
}

/**
 * The flush currently running, if any.
 *
 * Without this, two callers that start a flush at the same moment each read
 * the queue before either writes it back, and every queued write is sent
 * twice — a duplicate bill, a duplicate payment. That is not a remote
 * possibility: reconnecting fires 'online' at every listener at once, and a
 * flush is also kicked off from the app's own reconnect handler.
 *
 * Sharing the in-flight promise means a second caller waits for, and reports,
 * the same run rather than starting a competing one.
 */
let flushing = null;

/**
 * Flush queued writes once connectivity returns.
 * Entries that fail stay queued so nothing is silently lost.
 */
export async function flushQueue() {
  if (flushing) return flushing;
  if (!navigator.onLine) return { synced: 0, failed: 0 };
  if (!getQueue().length) return { synced: 0, failed: 0 };

  flushing = (async () => {
    // Claim the queue before sending anything: a write that is in flight must
    // not still be sitting in storage where another flush could pick it up.
    // Failures are put back below.
    const q = getQueue();
    setQueue([]);

    const remaining = [];
    let synced = 0;
    for (const entry of q) {
      try {
        await call(entry.action, entry.payload, entry.requestId || null);
        synced++;
      } catch {
        remaining.push(entry);
      }
    }

    // Anything queued while this ran is still pending, so keep it.
    setQueue([...remaining, ...getQueue()]);
    return { synced, failed: remaining.length };
  })();

  try {
    return await flushing;
  } finally {
    flushing = null;
  }
}

// Auto-flush when the browser comes back online.
//
// AppContext also flushes on reconnect so it can refresh the screen and toast
// the result. Both call the same guarded function, so the second one joins the
// first rather than replaying the queue.
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { flushQueue(); });
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
  // Per-party ledger password. An empty password removes the lock.
  setPartyLock:   (partyId, password, currentPassword) =>
    call('setPartyLock', { partyId, password, currentPassword }),

  // Items
  saveItem:       (item)        => call('saveItem', item),
  archiveItem:    (id)          => call('archiveItem', { id }),

  // Bills — offline-safe (FR-12)
  saveBill:       (bill)        => offlineSafe('saveBill', bill),
  voidBill:       (id, reason)  => call('voidBill', { id, reason }),
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
  setOffParty:           (s)          => call('setOffParty', s),

  // Employees
  saveEmployee:   (e)           => call('saveEmployee', e),
  addEmployeeTx:  (t)           => call('addEmployeeTx', t),

  // Expenses / stock loss / assets
  saveExpense:    (e)           => call('saveExpense', e),
  saveStockLoss:  (l)           => call('saveStockLoss', l),
  saveAsset:      (a)           => call('saveAsset', a),

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
