// Monthly-maintenance subscription check.
//
// The expiry date is NOT stored in this app. It lives on the license server
// (admin-dashboard/license-server/Code.gs), in the developer's own Google account, and is changed
// from the separate Admin Dashboard. This file only asks that server "is this dashboard switched
// on?" and remembers the answer.
//
// Rules this module follows:
//   - Not configured (no licenseUrl / licenseClientId in config.js)  -> no limit, nothing is checked.
//   - Server unreachable but an earlier answer is remembered         -> the remembered expiry still applies.
//   - Server unreachable and never reached once                      -> stay open (a flaky connection must
//                                                                       never lock a paying shop out).
//   - The clock only moves forward: setting the computer's date back cannot buy more days.

import { CONFIG } from './config';

const KEY = 'ewd_license';
const DAY = 86400000;
const FETCH_TIMEOUT_MS = 10000;

export const LICENSE_ENABLED = Boolean(CONFIG.licenseUrl && CONFIG.licenseClientId);

/* ------------------------------------------------------------------ */
/* Remembered answer                                                   */
/* ------------------------------------------------------------------ */

/** { status, offset, maxSeen } — `offset` is (server time − this computer's time) at the last check. */
export function readCache() {
  try {
    const c = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (c && c.status && typeof c.status === 'object') return c;
  } catch { /* corrupt entry: treat as never checked */ }
  return null;
}

function writeCache(cache) {
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* storage full/blocked */ }
}

/**
 * "Now", as best we can know it. Server-corrected, and never earlier than the latest moment this
 * browser has already seen — so winding the computer's clock back does not undo an expiry.
 */
export function trustedNow(cache) {
  const guess = Date.now() + (cache?.offset || 0);
  return Math.max(guess, cache?.maxSeen || 0);
}

/** Records the moment just used, so a later clock rewind cannot go behind it. */
export function touchSeen(cache) {
  if (!cache) return cache;
  const now = trustedNow(cache);
  if (now > (cache.maxSeen || 0)) {
    const next = { ...cache, maxSeen: now };
    writeCache(next);
    return next;
  }
  return cache;
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

/**
 * ok           — valid, more than `warnDays` left
 * soon         — valid, but expires within `warnDays` (show the reminder popup)
 * expired      — past the expiry moment
 * locked       — the admin closed the dashboard
 * unregistered — the server does not know this Client ID
 */
export function computeState(status, now) {
  if (!status) return { state: 'ok', daysLeft: Infinity };
  if (status.found === false) return { state: 'unregistered', daysLeft: 0 };
  if (status.locked) return { state: 'locked', daysLeft: 0 };
  const left = (status.expiresAt || 0) - now;
  if (left <= 0) return { state: 'expired', daysLeft: 0 };
  const days = Math.ceil(left / DAY);
  return { state: days <= (status.warnDays || 5) ? 'soon' : 'ok', daysLeft: days };
}

/* ------------------------------------------------------------------ */
/* Server calls                                                        */
/* ------------------------------------------------------------------ */

async function post(action, payload) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(CONFIG.licenseUrl, {
      method: 'POST',
      // text/plain avoids a CORS preflight, which Apps Script does not answer.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, payload }),
      redirect: 'follow',
      signal: ctrl.signal,
    });
  } catch {
    const err = new Error('Could not reach the subscription server. Check your internet connection.');
    err.isNetworkError = true;
    throw err;
  } finally {
    clearTimeout(timer);
  }

  let json;
  try {
    json = JSON.parse(await res.text());
  } catch {
    const err = new Error('The subscription server did not answer properly. Try again in a minute.');
    err.isNetworkError = true;
    throw err;
  }
  if (!json.ok) throw new Error(json.error || 'Request failed');
  return json.data;
}

/** Stores a fresh server answer and returns the new cache. */
function remember(status) {
  const serverNow = status.serverNow || Date.now();
  const cache = {
    status,
    offset: serverNow - Date.now(),
    // The server's clock replaces the remembered one: that is what lets a computer with a wrong date
    // recover, while still holding back a clock rewound while offline.
    maxSeen: serverNow,
    fetchedAt: Date.now(),
  };
  writeCache(cache);
  return cache;
}

/** Asks the server for the current status. Throws on network trouble (callers keep the old answer). */
export async function fetchStatus() {
  const status = await post('status', { clientId: CONFIG.licenseClientId });
  return remember(status);
}

/** Redeems a renewal code. Throws with a readable message when the code is wrong or already used. */
export async function redeemCode(code) {
  const status = await post('redeem', { clientId: CONFIG.licenseClientId, code });
  return remember(status);
}
