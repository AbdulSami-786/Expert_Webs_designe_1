/**
 * Expert Webs Designs — LICENSE SERVER (monthly maintenance control)
 * ===================================================================
 *
 * One small Google Apps Script Web App that decides whether each client's dashboard is
 * switched on. It is SEPARATE from the client's own data Sheet: it lives in YOUR Google
 * account, so a client can never edit their own expiry date.
 *
 * Two audiences talk to it:
 *
 *   1. The CLIENT dashboard (public, no password)
 *        status  — "is my subscription valid?"   -> expiry, locked flag, message
 *        redeem  — "I have a renewal code"       -> extends the expiry
 *
 *   2. YOUR admin dashboard (no password)
 *        adminList, adminSaveClient, adminDeleteClient,
 *        adminSetExpiry, adminExtend, adminSetLocked,
 *        adminCreateCode, adminRevokeCode, adminLog
 *
 * SETUP: see ../SETUP.md  (create a Sheet > Extensions > Apps Script > paste this >
 * Deploy as Web App: Execute as ME, access ANYONE).
 *
 * Storage: three tabs in the Sheet this script is attached to (created automatically):
 *   Clients — id, name, contact, expiresAt, locked, lockMessage, warnDays, createdAt, lastSeen
 *   Codes   — code, clientId, months, status, createdAt, usedAt
 *   Log     — at, clientId, event, detail
 */

var LICENSE_VERSION = '1.0.3';

var CLIENT_COLS = ['id', 'name', 'contact', 'expiresAt', 'locked', 'lockMessage', 'warnDays', 'createdAt', 'lastSeen'];
var CODE_COLS   = ['code', 'clientId', 'months', 'status', 'createdAt', 'usedAt'];
var LOG_COLS    = ['at', 'clientId', 'event', 'detail'];

// Unambiguous characters only (no 0/O, 1/I/L) so a code read out over the phone is not misheard.
var CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/* ------------------------------------------------------------------ */
/* Entry points                                                        */
/* ------------------------------------------------------------------ */

function doGet() {
  return out_({ ok: true, data: { status: 'Expert Webs Designs license server is running', version: LICENSE_VERSION } });
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var action = String(body.action || '');
    var p = body.payload || {};

    // Public actions (used by the client dashboards).
    if (action === 'status') return out_({ ok: true, data: status_(p) });
    if (action === 'redeem') return out_({ ok: true, data: redeem_(p) });

    // Everything else is the admin dashboard's. There is no password (by choice).
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      switch (action) {
        case 'adminPing':         return out_({ ok: true, data: { ok: true } });
        case 'adminList':         return out_({ ok: true, data: adminList_() });
        case 'adminSaveClient':   return out_({ ok: true, data: adminSaveClient_(p) });
        case 'adminDeleteClient': return out_({ ok: true, data: adminDeleteClient_(p) });
        case 'adminSetExpiry':    return out_({ ok: true, data: adminSetExpiry_(p) });
        case 'adminExtend':       return out_({ ok: true, data: adminExtend_(p) });
        case 'adminSetLocked':    return out_({ ok: true, data: adminSetLocked_(p) });
        case 'adminCreateCode':   return out_({ ok: true, data: adminCreateCode_(p) });
        case 'adminRevokeCode':   return out_({ ok: true, data: adminRevokeCode_(p) });
        case 'adminLog':          return out_({ ok: true, data: adminLog_(p) });
        default: throw new Error('Unknown action: ' + action);
      }
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return out_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ------------------------------------------------------------------ */
/* Sheet helpers                                                       */
/* ------------------------------------------------------------------ */

function sheet_(name, cols) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function readAll_(name, cols) {
  var sh = sheet_(name, cols);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var vals = sh.getRange(2, 1, last - 1, cols.length).getValues();
  return vals.map(function (row, i) {
    var o = { _row: i + 2 };
    for (var c = 0; c < cols.length; c++) o[cols[c]] = row[c];
    return o;
  });
}

function writeRow_(name, cols, rowNo, obj) {
  var sh = sheet_(name, cols);
  var row = cols.map(function (c) { return obj[c] === undefined || obj[c] === null ? '' : obj[c]; });
  sh.getRange(rowNo, 1, 1, cols.length).setValues([row]);
}

function appendRow_(name, cols, obj) {
  var sh = sheet_(name, cols);
  var row = cols.map(function (c) { return obj[c] === undefined || obj[c] === null ? '' : obj[c]; });
  sh.appendRow(row);
}

function log_(clientId, event, detail) {
  appendRow_('Log', LOG_COLS, { at: new Date().getTime(), clientId: clientId || '', event: event, detail: detail || '' });
}

function findClient_(id) {
  var rows = readAll_('Clients', CLIENT_COLS);
  for (var i = 0; i < rows.length; i++) if (String(rows[i].id) === String(id)) return rows[i];
  return null;
}

function publicClient_(c) {
  return {
    id: String(c.id),
    name: String(c.name || ''),
    contact: String(c.contact || ''),
    expiresAt: Number(c.expiresAt) || 0,
    locked: c.locked === true || String(c.locked).toLowerCase() === 'true',
    lockMessage: String(c.lockMessage || ''),
    warnDays: Number(c.warnDays) || 5,
    createdAt: Number(c.createdAt) || 0,
    lastSeen: Number(c.lastSeen) || 0
  };
}

/** Adds whole calendar months, keeping the same day and time (31 Jan + 1 month = 28/29 Feb). */
function addMonths_(ms, months) {
  var d = new Date(ms);
  var day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  var daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, daysInMonth));
  return d.getTime();
}

function newId_(prefix) {
  var s = '';
  for (var i = 0; i < 8; i++) s += CODE_ALPHABET.charAt(Math.floor(Math.random() * CODE_ALPHABET.length));
  return prefix + s.toLowerCase();
}

function newCode_() {
  var groups = [];
  for (var g = 0; g < 3; g++) {
    var s = '';
    for (var i = 0; i < 4; i++) s += CODE_ALPHABET.charAt(Math.floor(Math.random() * CODE_ALPHABET.length));
    groups.push(s);
  }
  return 'EWD-' + groups.join('-');
}

function normCode_(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/* ------------------------------------------------------------------ */
/* Public: status + redeem (called by the client dashboard)            */
/* ------------------------------------------------------------------ */

function status_(p) {
  var id = String(p.clientId || '').trim();
  if (!id) throw new Error('No client id.');
  var now = new Date().getTime();
  var c = findClient_(id);
  if (!c) return { found: false, serverNow: now };

  // Only touch the sheet when the stored value is more than 5 minutes old — a dashboard that
  // re-checks every few minutes must not write a row every time.
  if (now - (Number(c.lastSeen) || 0) > 5 * 60 * 1000) {
    c.lastSeen = now;
    writeRow_('Clients', CLIENT_COLS, c._row, c);
  }

  var pc = publicClient_(c);
  return {
    found: true,
    serverNow: now,
    name: pc.name,
    contact: pc.contact,
    expiresAt: pc.expiresAt,
    locked: pc.locked,
    lockMessage: pc.lockMessage,
    warnDays: pc.warnDays
  };
}

function redeem_(p) {
  var id = String(p.clientId || '').trim();
  var entered = normCode_(p.code);
  if (!id) throw new Error('No client id.');
  if (!entered) throw new Error('Enter the renewal code.');

  // Throttle guessing: 10 wrong tries per client per 15 minutes.
  var cache = CacheService.getScriptCache();
  var failKey = 'redeem_fails_' + id;
  var fails = Number(cache.get(failKey) || 0);
  if (fails >= 10) throw new Error('Too many wrong codes. Try again in 15 minutes.');

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var client = findClient_(id);
    if (!client) throw new Error('This dashboard is not registered. Contact support.');

    var codes = readAll_('Codes', CODE_COLS);
    var hit = null;
    for (var i = 0; i < codes.length; i++) {
      if (normCode_(codes[i].code) === entered && String(codes[i].clientId) === id) { hit = codes[i]; break; }
    }
    if (!hit) {
      cache.put(failKey, String(fails + 1), 900);
      throw new Error('That code is not valid for this dashboard.');
    }
    if (hit.status === 'used')    throw new Error('That code has already been used.');
    if (hit.status === 'revoked') throw new Error('That code was cancelled. Ask for a new one.');

    var now = new Date().getTime();
    var months = Number(hit.months) || 1;
    // Still-valid subscription: the new month is added on the end, so renewing early loses nothing.
    // Already expired: a full month from today.
    var base = Math.max(Number(client.expiresAt) || 0, now);
    client.expiresAt = addMonths_(base, months);
    client.locked = false;   // paying again re-opens a dashboard that was closed for non-payment
    writeRow_('Clients', CLIENT_COLS, client._row, client);

    hit.status = 'used';
    hit.usedAt = now;
    writeRow_('Codes', CODE_COLS, hit._row, hit);

    log_(id, 'renewed', 'Code ' + hit.code + ' (+' + months + ' month' + (months === 1 ? '' : 's') + ')');
    cache.remove(failKey);
    return status_({ clientId: id });
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------ */
/* Admin actions                                                       */
/* ------------------------------------------------------------------ */

function adminList_() {
  var clients = readAll_('Clients', CLIENT_COLS).map(publicClient_);
  var codes = readAll_('Codes', CODE_COLS).map(function (c) {
    return {
      code: String(c.code), clientId: String(c.clientId), months: Number(c.months) || 1,
      status: String(c.status || 'unused'), createdAt: Number(c.createdAt) || 0, usedAt: Number(c.usedAt) || 0
    };
  });
  return { serverNow: new Date().getTime(), clients: clients, codes: codes };
}

function adminSaveClient_(p) {
  var name = String(p.name || '').trim();
  if (!name) throw new Error('Client name is required.');
  var now = new Date().getTime();
  var warn = Math.max(1, Math.min(30, Number(p.warnDays) || 5));

  if (p.id) {
    var c = findClient_(p.id);
    if (!c) throw new Error('Client not found.');
    c.name = name;
    c.contact = String(p.contact || '').trim();
    c.lockMessage = String(p.lockMessage || '').trim();
    c.warnDays = warn;
    writeRow_('Clients', CLIENT_COLS, c._row, c);
    log_(c.id, 'edited', 'Details updated');
    return publicClient_(c);
  }

  var expires = Number(p.expiresAt) || addMonths_(now, 1);
  var created = {
    id: newId_('c_'), name: name, contact: String(p.contact || '').trim(),
    expiresAt: expires, locked: false, lockMessage: String(p.lockMessage || '').trim(),
    warnDays: warn, createdAt: now, lastSeen: 0
  };
  appendRow_('Clients', CLIENT_COLS, created);
  log_(created.id, 'created', 'Expires ' + new Date(expires).toISOString());
  return publicClient_(created);
}

function adminDeleteClient_(p) {
  var c = findClient_(p.id);
  if (!c) throw new Error('Client not found.');
  sheet_('Clients', CLIENT_COLS).deleteRow(c._row);

  // Delete the client's codes too, bottom-up so row numbers stay valid.
  var codes = readAll_('Codes', CODE_COLS).filter(function (x) { return String(x.clientId) === String(p.id); });
  var sh = sheet_('Codes', CODE_COLS);
  codes.sort(function (a, b) { return b._row - a._row; }).forEach(function (x) { sh.deleteRow(x._row); });

  log_(p.id, 'deleted', c.name);
  return { ok: true };
}

function adminSetExpiry_(p) {
  var c = findClient_(p.id);
  if (!c) throw new Error('Client not found.');
  var at = Number(p.expiresAt);
  if (!at || at < 0) throw new Error('Pick a valid expiry date and time.');
  c.expiresAt = at;
  writeRow_('Clients', CLIENT_COLS, c._row, c);
  log_(c.id, 'expiry set', new Date(at).toISOString());
  return publicClient_(c);
}

function adminExtend_(p) {
  var c = findClient_(p.id);
  if (!c) throw new Error('Client not found.');
  var months = Math.max(1, Math.min(36, Number(p.months) || 1));
  var now = new Date().getTime();
  c.expiresAt = addMonths_(Math.max(Number(c.expiresAt) || 0, now), months);
  writeRow_('Clients', CLIENT_COLS, c._row, c);
  log_(c.id, 'extended', '+' + months + ' month(s) -> ' + new Date(c.expiresAt).toISOString());
  return publicClient_(c);
}

function adminSetLocked_(p) {
  var c = findClient_(p.id);
  if (!c) throw new Error('Client not found.');
  c.locked = p.locked === true;
  writeRow_('Clients', CLIENT_COLS, c._row, c);
  log_(c.id, c.locked ? 'locked' : 'unlocked', c.locked ? 'Dashboard closed by admin' : 'Dashboard re-opened by admin');
  return publicClient_(c);
}

function adminCreateCode_(p) {
  var c = findClient_(p.id);
  if (!c) throw new Error('Client not found.');
  var months = Math.max(1, Math.min(36, Number(p.months) || 1));

  var existing = {};
  readAll_('Codes', CODE_COLS).forEach(function (x) { existing[normCode_(x.code)] = true; });
  var code = newCode_();
  while (existing[normCode_(code)]) code = newCode_();

  var now = new Date().getTime();
  var row = { code: code, clientId: String(c.id), months: months, status: 'unused', createdAt: now, usedAt: '' };
  appendRow_('Codes', CODE_COLS, row);
  log_(c.id, 'code created', code + ' (' + months + ' month' + (months === 1 ? '' : 's') + ')');
  return { code: code, clientId: String(c.id), months: months, status: 'unused', createdAt: now, usedAt: 0 };
}

function adminRevokeCode_(p) {
  var target = normCode_(p.code);
  var codes = readAll_('Codes', CODE_COLS);
  for (var i = 0; i < codes.length; i++) {
    if (normCode_(codes[i].code) === target) {
      if (codes[i].status === 'used') throw new Error('That code was already used.');
      codes[i].status = 'revoked';
      writeRow_('Codes', CODE_COLS, codes[i]._row, codes[i]);
      log_(codes[i].clientId, 'code revoked', codes[i].code);
      return { ok: true };
    }
  }
  throw new Error('Code not found.');
}

function adminLog_(p) {
  var rows = readAll_('Log', LOG_COLS);
  if (p && p.id) rows = rows.filter(function (r) { return String(r.clientId) === String(p.id); });
  rows = rows.slice(-100).reverse();
  return rows.map(function (r) {
    return { at: Number(r.at) || 0, clientId: String(r.clientId), event: String(r.event), detail: String(r.detail) };
  });
}
