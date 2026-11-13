/**
 * ============================================================================
 * Expert Webs Designs
 * Google Apps Script backend (Web App)
 * ============================================================================
 *
 * Architecture (per PRD section 2):
 *   - One Google Spreadsheet, one tab per entity, header row = schema.
 *   - doPost router: every operation is one `action`.
 *   - LockService around writes only (not whole requests) to prevent race
 *     conditions without making unrelated reads feel slow.
 *   - CacheService for hot reference data (parties, items, settings).
 *   - Batch reads: whole sheet in one call, never row-by-row.
 *
 * SETUP: see SETUP.md in this folder.
 * ============================================================================
 */

/** Cache duration for reference data, in seconds (Perf Guide 1.2). */
var CACHE_SECONDS = 60;

/** Sheet schemas — the header row of each tab. */
var SCHEMA = {
  // lockHash/lockSalt appended: an optional per-party ledger password, stored
  // only as a salted hash. Blank means the ledger opens freely.
  Parties: ['id', 'name', 'phone', 'address', 'creditLimit', 'defaultDueDays', 'status', 'createdAt',
            'lockHash', 'lockSalt'],
  Items: ['id', 'name', 'baseUnit', 'altUnit', 'conversionRate', 'category', 'costPrice',
          'lastPurchaseDate', 'openingStock', 'lowStockAlert', 'status'],
  PartyItemPrices: ['id', 'partyId', 'itemId', 'price', 'unit', 'date'],
  // 'delivery' and 'deliveredAt' are appended, never inserted: readAll maps
  // values by header position, so moving an existing column would silently
  // reassign every value after it on every existing row.
  Bills: ['id', 'billNo', 'partyId', 'date', 'subtotal', 'roundOff', 'totalAmount',
          'status', 'dueDate', 'note', 'createdAt', 'voidReason', 'voidedAt',
          'delivery', 'deliveredAt',
          // installPlan appended: JSON text {base, parts:[{due, amount}]} when the credit
          // is paid in instalments. Blank for an ordinary bill.
          'installPlan'],
  // deliveredQty appended: how much of the line has gone out to the customer.
  // Blank on older rows, which then follow the bill's own delivery flag.
  // supplierId appended: which supplier's stock this line was sold from. Blank
  // means "any", and the oldest purchases are used first.
  BillItems: ['id', 'billId', 'itemId', 'qty', 'unit', 'price', 'costPriceAtSale', 'lineTotal',
              'deliveredQty', 'supplierId'],
  // groupId appended: the parts of one account payment spread over several
  // bills share it, so the ledger can show them as one entry.
  Payments: ['id', 'billId', 'partyId', 'method', 'amount', 'date', 'note', 'reversed',
             'reversedAt', 'reverseReason', 'isAdvance', 'groupId'],
  Returns: ['id', 'billId', 'itemId', 'qty', 'valueAdjusted', 'restock', 'date', 'note'],
  // accountHolder appended: the name printed on the cheque, which is often not
  // the party's own (a relative, a firm, a customer of theirs).
  Cheques: ['id', 'billId', 'partyId', 'paymentId', 'chequeNo', 'bankName', 'dateIssued',
            'dateDue', 'status', 'amount', 'note', 'statusChangedAt', 'accountHolder'],
  PartyAdvances: ['id', 'partyId', 'amount', 'applied', 'dateReceived', 'method', 'note'],
  // supplierId/purchaseBillId appended: a line of a supplier purchase bill.
  // Standalone purchases leave them blank.
  // receivedQty appended after them: how much of the line has arrived. Blank
  // on older rows, which read as fully received.
  Purchases: ['id', 'itemId', 'supplierName', 'qty', 'costPrice', 'date', 'note', 'method',
              'supplierId', 'purchaseBillId', 'receivedQty'],
  // The buying side. A supplier's balance is opening + purchases − payments −
  // returns; below zero is an advance the supplier holds.
  // partyId appended: set when this supplier is a party's buying side — a
  // customer who also sells to the shop.
  Suppliers: ['id', 'name', 'phone', 'address', 'openingBalance', 'status', 'createdAt',
              'partyId'],
  PurchaseBills: ['id', 'purchaseNo', 'supplierId', 'invoiceNo', 'date', 'totalAmount', 'note',
                  'status', 'createdAt', 'voidReason', 'voidedAt'],
  // isAdvance appended: money handed to a supplier before goods arrive.
  SupplierPayments: ['id', 'supplierId', 'purchaseBillId', 'method', 'amount', 'date', 'note',
                     'isAdvance'],
  SupplierReturns: ['id', 'supplierId', 'purchaseBillId', 'itemId', 'qty', 'value', 'date', 'note'],
  Employees: ['id', 'name', 'phone', 'role', 'monthlySalary', 'joinDate', 'status'],
  EmployeeTransactions: ['id', 'employeeId', 'type', 'amount', 'date', 'note', 'method'],
  Expenses: ['id', 'category', 'amount', 'date', 'note', 'method', 'linkedStockLossId'],
  StockLoss: ['id', 'itemId', 'qty', 'reason', 'estimatedValue', 'date', 'note', 'linkedExpenseId'],
  Assets: ['id', 'name', 'value', 'date', 'note'],
  ActivityLog: ['id', 'entityType', 'entityId', 'action', 'description', 'oldValue',
                'newValue', 'user', 'timestamp'],
  // fullName/status/allowedPages/createdAt appended (never inserted). role is
  // 'admin' (super admin: every page) or 'user'. status is 'active' or
  // 'inactive' — blank on older rows, which read as active. allowedPages is a
  // JSON array of page keys, only meaningful for role 'user'.
  Users: ['id', 'username', 'passwordHash', 'role', 'fullName', 'status', 'allowedPages',
          'createdAt'],
  PartyLedgerLinks: ['partyId', 'token', 'passwordHash', 'salt', 'active', 'createdAt'],
  Settings: ['key', 'value']
};

/** Maps a sheet tab to the JSON key the frontend expects. */
var TAB_TO_KEY = {
  Parties: 'parties',
  Items: 'items',
  PartyItemPrices: 'partyItemPrices',
  Bills: 'bills',
  BillItems: 'billItems',
  Payments: 'payments',
  Returns: 'returns',
  Cheques: 'cheques',
  PartyAdvances: 'partyAdvances',
  Purchases: 'purchases',
  Employees: 'employees',
  EmployeeTransactions: 'employeeTx',
  Expenses: 'expenses',
  StockLoss: 'stockLoss',
  Assets: 'assets',
  ActivityLog: 'activityLog',
  PartyLedgerLinks: 'partyLedgerLinks',
  Suppliers: 'suppliers',
  PurchaseBills: 'purchaseBills',
  SupplierPayments: 'supplierPayments',
  SupplierReturns: 'supplierReturns'
};

/** Columns stored as numbers. */
var NUMERIC = {
  creditLimit: 1, defaultDueDays: 1, conversionRate: 1, costPrice: 1, openingStock: 1,
  lowStockAlert: 1, price: 1, subtotal: 1, roundOff: 1, totalAmount: 1, qty: 1,
  costPriceAtSale: 1, lineTotal: 1, amount: 1, valueAdjusted: 1, applied: 1,
  monthlySalary: 1, estimatedValue: 1, value: 1, openingBalance: 1
};

/**
 * Columns that hold text made of digits. Sheets turns "03001234567" into the
 * number 3001234567 — dropping the leading 0 — unless the cell is written
 * with a leading apostrophe, which keeps it as text and is not part of the
 * value read back.
 */
var TEXT_DIGITS = { phone: 1, chequeNo: 1, invoiceNo: 1 };

/** A value for a TEXT_DIGITS column, written so Sheets keeps it as text. */
function asText(key, v) {
  if (!TEXT_DIGITS[key] || v === '' || v === null || v === undefined) return v;
  var s = String(v);
  return /^[\d+\-\s]+$/.test(s) ? "'" + s : s;
}

/** A phone read back as a number lost its 0: 3001234567 -> 03001234567. */
function phoneText(v) {
  var s = String(v === null || v === undefined ? '' : v);
  return /^3\d{9}$/.test(s) ? '0' + s : s;
}

/** Columns stored as booleans. */
var BOOLEAN = { reversed: 1, restock: 1, active: 1, isAdvance: 1 };

/* ==========================================================================
   Web app entry points
   ========================================================================== */

function doGet(e) {
  return json({ ok: true, data: { status: 'Expert Webs Designs backend is running' } });
}

// Who the current request is acting as, for the activity log. Set per request
// from the validated session rather than hardcoded, so attribution stays
// correct once a second account exists.
var ACTING_USER = 'system';

/**
 * Actions that create records, and so must never run twice for one request.
 *
 * A write can genuinely arrive twice without anybody clicking twice: the
 * browser retries a request whose response was lost, a phone changes network
 * mid-send, the page is refreshed while a save is in flight. Each of those
 * lands a second identical POST, and without a guard it writes a second bill.
 */
var REPLAY_GUARDED = {
  saveBill: 1, addPayment: 1, addReturn: 1, addAdvance: 1, savePurchase: 1,
  addEmployeeTx: 1, saveExpense: 1, saveStockLoss: 1, saveAsset: 1,
  saveCheque: 1, settleParty: 1,
  savePurchaseBill: 1, adoptPurchases: 1, addSupplierPayment: 1, addSupplierReturn: 1, saveSupplier: 1,
  setOffParty: 1
};

/** How long a completed request's result stays replayable, in seconds. */
var REPLAY_TTL = 600;

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var action = body.action;
    var payload = body.payload || {};

    // The client stamps each write with a one-off id. If this exact request
    // has already been carried out, return what it returned the first time
    // rather than doing the work again — the caller cannot tell the difference,
    // and no second row is written.
    var rid = body.requestId;
    var cache = null;
    var key = null;

    if (rid && REPLAY_GUARDED[action]) {
      try { cache = CacheService.getScriptCache(); } catch (err2) { cache = null; }
      key = 'req:' + rid;
      if (cache) {
        var prior = null;
        try { prior = cache.get(key); } catch (err3) { prior = null; }
        if (prior) {
          // Already done. Hand back the original outcome.
          return ContentService
            .createTextOutput(prior)
            .setMimeType(ContentService.MimeType.JSON);
        }
      }
    }

    var data = route(action, payload, body.token);
    var out = JSON.stringify({ ok: true, data: data });

    if (cache && key) {
      // Only successful writes are remembered: a failure should be retryable.
      try { cache.put(key, out, REPLAY_TTL); } catch (err4) {}
    }

    return ContentService.createTextOutput(out).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return json({ ok: false, error: publicError(err) });
  }
}

/**
 * What the caller is allowed to see about a failure.
 *
 * Messages thrown deliberately by this file are written for the person using
 * the dashboard ("Payment exceeds the amount due"), so they are safe and
 * useful to return. Anything else is a runtime fault whose text can name sheets
 * and row numbers, so it is logged server-side and replaced with a generic
 * line. `throw stamped(new Error(...))` is what marks a message as intended
 * for the caller.
 */
function publicError(err) {
  if (err && err.ewdPublic) return String(err.message);
  try {
    console.error('Unhandled backend error: ' + (err && err.stack ? err.stack : err));
  } catch (e) {}
  return 'Something went wrong on the server. Please try again.';
}

/** Mark an Error as safe to show the caller. */
function stamped(err) {
  err.ewdPublic = true;
  return err;
}

/** Throw a message written for the person using the dashboard. */
function fail(message) {
  throw stamped(new Error(message));
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ==========================================================================
   Router — one case per action, matching src/lib/api.js exactly
   ========================================================================== */

/**
 * Actions reachable without a session.
 *
 * `login` must be, or nobody could ever get a token. `openSharedLedger` is the
 * party-facing link: its caller is a customer who has no dashboard account and
 * authenticates with the link's own token plus password instead.
 *
 * Everything absent from this list — including `bootstrap`, which returns the
 * whole database — requires a valid session.
 */
var PUBLIC_ACTIONS = { login: 1, openSharedLedger: 1 };

function route(action, p, token) {
  if (!PUBLIC_ACTIONS[action]) {
    var session = validSession(token);
    if (!session) fail('Your session has expired. Please sign in again.');
    ACTING_USER = session.username;
  } else {
    ACTING_USER = 'system';
  }

  switch (action) {
    case 'login':            return login(p);
    case 'changePassword':   return changePassword(p);
    case 'bootstrap':        return bootstrap();

    // User management — every one of these checks for an active super admin.
    case 'listUsers':        return listUsers();
    case 'saveUser':         return saveUser(p);
    case 'setUserPassword':  return setUserPassword(p);
    case 'setUserStatus':    return setUserStatus(p);
    case 'deleteUser':       return deleteUser(p);

    case 'saveParty':        return saveParty(p);
    case 'archiveParty':     return toggleArchive('Parties', p.id, 'party');
    case 'setPartyLock':     return setPartyLock(p);

    case 'saveItem':         return saveItem(p);
    case 'archiveItem':      return toggleArchive('Items', p.id, 'item');

    case 'saveBill':         return saveBill(p);
    case 'voidBill':         return voidBill(p);
    case 'setDelivery':      return setDelivery(p);
    case 'setLineDelivery':  return setLineDelivery(p);

    case 'addPayment':       return addPayment(p);
    case 'reversePayment':   return reversePayment(p);
    case 'deletePayment':    return deletePayment(p);
    case 'updatePayment':    return updatePayment(p);
    case 'settleParty':      return settleParty(p);

    case 'addReturn':        return addReturn(p);

    case 'saveCheque':       return saveCheque(p);
    case 'setChequeStatus':  return setChequeStatus(p);
    case 'deleteCheque':     return deleteCheque(p);

    case 'addAdvance':       return addAdvance(p);
    case 'deleteAdvance':    return deleteAdvance(p);
    case 'savePurchase':     return savePurchase(p);
    case 'updatePurchase':   return updatePurchase(p);
    case 'deletePurchase':   return deletePurchase(p);

    case 'saveSupplier':          return saveSupplier(p);
    case 'archiveSupplier':       return toggleArchive('Suppliers', p.id, 'supplier');
    case 'savePurchaseBill':      return savePurchaseBill(p);
    case 'adoptPurchases':        return adoptPurchases(p);
    case 'voidPurchaseBill':      return voidPurchaseBill(p);
    case 'setPurchaseReceipt':    return setPurchaseReceipt(p);
    case 'addSupplierPayment':    return addSupplierPayment(p);
    case 'deleteSupplierPayment': return deleteSupplierPayment(p);
    case 'addSupplierReturn':     return addSupplierReturn(p);
    case 'deleteSupplierReturn':  return deleteSupplierReturn(p);
    case 'linkPartySupplier':     return linkPartySupplier(p);
    case 'setOffParty':           return setOffParty(p);

    case 'saveEmployee':     return saveEmployee(p);
    case 'addEmployeeTx':    return addEmployeeTx(p);

    case 'saveExpense':      return saveExpense(p);
    case 'saveStockLoss':    return saveStockLoss(p);
    case 'saveAsset':        return saveAsset(p);

    case 'saveSettings':     return saveSettings(p);

    case 'createShareLink':  return createShareLink(p);
    case 'revokeShareLink':  return revokeShareLink(p);
    case 'openSharedLedger': return openSharedLedger(p);

    case 'fullBackup':       requireSuperAdmin(readAll('Users')); return bootstrapShared();

    case 'syncPush':         return syncPush(p);

    // Safe to echo: the caller chose this string, so it reveals nothing.
    default: fail('Unknown action: ' + action);
  }
}

/* ==========================================================================
   Spreadsheet helpers
   ========================================================================== */

function ss() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

/**
 * Get a tab, creating it with its header row if missing.
 *
 * A tab created by an older version of this file can be missing columns that
 * SCHEMA has since gained. Reads and writes both address columns by SCHEMA
 * position, so a stale header would shift every value in the row.
 *
 * A new column is not necessarily added at the end — `salt` sits in the middle
 * of PartyLedgerLinks — so each missing column is inserted at its SCHEMA
 * position and existing cells shift right with it. Existing rows keep their
 * data and read back blank in the new column, which is what a migration should
 * do.
 */
function sheet(name) {
  var s = ss().getSheetByName(name);
  if (!s) {
    s = ss().insertSheet(name);
    s.appendRow(SCHEMA[name]);
    s.setFrozenRows(1);
    return s;
  }

  var want = SCHEMA[name];
  var width = s.getLastColumn();
  if (s.getLastRow() < 1 || width >= want.length) return s;

  var have = s.getRange(1, 1, 1, width).getValues()[0];
  for (var i = 0; i < want.length; i++) {
    if (String(have[i] || '') === want[i]) continue;
    // want[i] is missing here: open a column and label it.
    s.insertColumnBefore(i + 1);
    s.getRange(1, i + 1).setValue(want[i]);
    have.splice(i, 0, want[i]);
  }
  return s;
}

/**
 * Read an entire tab in ONE call and map rows to objects.
 * Apps Script is slow at many small calls, fast at few large ones.
 */
function readAll(name) {
  var s = sheet(name);
  var last = s.getLastRow();
  if (last < 2) return [];

  var values = s.getRange(1, 1, last, SCHEMA[name].length).getValues();
  var headers = values[0];
  var out = [];

  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (isBlankRow(row)) continue;
    var obj = {};
    for (var c = 0; c < headers.length; c++) {
      var key = headers[c];
      if (!key) continue;
      obj[key] = decodeCell(key, row[c], name);
    }
    out.push(obj);
  }
  return out;
}

function isBlankRow(row) {
  for (var i = 0; i < row.length; i++) {
    if (row[i] !== '' && row[i] !== null && row[i] !== undefined) return false;
  }
  return true;
}

/**
 * Decode one cell.
 *
 * `tab` matters: the Settings sheet stores generic key/value pairs, and its
 * `value` column holds text (shop name, rounding rule) as well as numbers.
 * Assets also has a `value` column, but there it is always money. Coercing by
 * column name alone turned every text setting into NaN, so the tab is passed
 * in and Settings is exempt from numeric coercion.
 */
function decodeCell(key, v, tab) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  if (BOOLEAN[key]) return v === true || v === 'TRUE' || v === 'true';
  if (NUMERIC[key] && tab !== 'Settings') return v === '' || v === null ? 0 : Number(v);
  if (key === 'phone') return v === '' || v === null || v === undefined ? '' : phoneText(v);
  if (TEXT_DIGITS[key] && typeof v === 'number') return String(v);
  return v === null || v === undefined ? '' : v;
}

/** Append one object as a row, in schema column order. */
function appendRow(name, obj) {
  var s = sheet(name);
  var row = SCHEMA[name].map(function (k) {
    var v = obj[k];
    if (v === undefined || v === null) return '';
    if (typeof v === 'boolean') return v;
    return asText(k, v);
  });
  s.appendRow(row);
  return obj;
}

/** Find the 1-based sheet row number for a record id. */
function findRow(name, idValue, idField) {
  idField = idField || 'id';
  var s = sheet(name);
  var last = s.getLastRow();
  if (last < 2) return -1;

  var col = SCHEMA[name].indexOf(idField) + 1;
  if (col < 1) return -1;

  var values = s.getRange(2, col, last - 1, 1).getValues();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]) === String(idValue)) return i + 2;
  }
  return -1;
}

/** Update specific fields of a row, leaving others untouched. */
function updateRow(name, rowNum, patch) {
  var s = sheet(name);
  var headers = SCHEMA[name];
  for (var k in patch) {
    var col = headers.indexOf(k) + 1;
    if (col > 0) {
      var v = patch[k];
      s.getRange(rowNum, col).setValue(v === undefined || v === null ? '' : asText(k, v));
    }
  }
}

/** Read one record as an object by id. */
function getById(name, idValue, idField) {
  var rowNum = findRow(name, idValue, idField);
  if (rowNum < 0) return null;
  var s = sheet(name);
  var values = s.getRange(rowNum, 1, 1, SCHEMA[name].length).getValues()[0];
  var obj = {};
  SCHEMA[name].forEach(function (k, i) { obj[k] = decodeCell(k, values[i], name); });
  obj._row = rowNum;
  return obj;
}

/* ==========================================================================
   Locking — around the write only, per Performance Guide 1.2
   ========================================================================== */

function withLock(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) fail('System busy, please try again');
  try {
    var result = fn();
    SpreadsheetApp.flush();
    clearCache();
    return result;
  } finally {
    lock.releaseLock();
  }
}

function clearCache() {
  try { CacheService.getScriptCache().remove('bootstrap'); } catch (e) {}
}

/* ==========================================================================
   Utilities
   ========================================================================== */

function uid(prefix) {
  return prefix + '_' + new Date().getTime().toString(36) +
         Math.random().toString(36).slice(2, 7);
}

function nowISO() {
  return new Date().toISOString();
}

function todayISO() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

/**
 * A date in any shape reduced to YYYY-MM-DD, or '' if it is not one.
 *
 * A date column comes back from Sheets as a string on one read and a Date
 * object on another, depending on how the cell was written. Comparing the raw
 * values then fails for two rows that describe the same day.
 */
function dayOf(v) {
  if (!v) return '';
  if (v instanceof Date) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  var s = String(v);
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[0];
  var d = new Date(s);
  if (isNaN(d.getTime())) return '';
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function addDaysISO(iso, days) {
  var d = iso ? new Date(iso) : new Date();
  d.setDate(d.getDate() + Number(days || 0));
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function r2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** A name reduced to its comparable form: case and spacing are not meaningful. */
function nameKey(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * A phone reduced to its comparable form, so "0300-1234567", "0300 1234567",
 * "+923001234567" and 3001234567 (a number Sheets stripped the 0 from) all
 * match. Mirror of phoneKey() in src/lib/localAdapter.js.
 */
function phoneKey(v) {
  var d = String(v === null || v === undefined ? '' : v).replace(/\D/g, '');
  if (/^92\d{10}$/.test(d)) d = '0' + d.slice(2);
  if (/^3\d{9}$/.test(d)) d = '0' + d;
  return d;
}

/** Mirror of applyRounding() in src/lib/format.js — keep the two in step. */
function applyRounding(amount, rule) {
  var v = r2(amount);
  switch (rule) {
    case 'exact':     return v;
    case 'nearest5':  return Math.round(v / 5) * 5;
    case 'nearest10': return Math.round(v / 10) * 10;
    default:          return Math.round(v);
  }
}

/**
 * Recompute a bill's money from its lines (Safety Guide 2.3).
 * The client's subtotal/roundOff/total are display values only: over a real
 * network anyone can post their own, so the server must derive its own.
 */
function billTotalsFromLines(lines, roundingRule) {
  var subtotal = r2(lines.reduce(function (s, l) {
    return s + (Number(l.qty) || 0) * (Number(l.price) || 0);
  }, 0));
  var total = applyRounding(subtotal, roundingRule);
  return { subtotal: subtotal, roundOff: r2(total - subtotal), total: r2(total) };
}

/**
 * Amount still owed on a bill, derived the same way billState() does on the
 * client: gross, less returns, less payments that are neither reversed nor
 * backed by a bounced cheque.
 */
function billDue(billId) {
  var bill = getById('Bills', billId);
  if (!bill) return 0;

  var returned = r2(readAll('Returns')
    .filter(function (r) { return r.billId === billId; })
    .reduce(function (s, r) { return s + (Number(r.valueAdjusted) || 0); }, 0));

  var bounced = {};
  readAll('Cheques').forEach(function (c) {
    if (c.status === 'bounced' && c.paymentId) bounced[c.paymentId] = 1;
  });

  var paid = r2(readAll('Payments')
    .filter(function (p) {
      return p.billId === billId && !p.reversed && !bounced[p.id];
    })
    .reduce(function (s, p) { return s + (Number(p.amount) || 0); }, 0));

  return r2(Math.max(0, r2(r2(bill.totalAmount) - returned) - paid));
}

/**
 * Reject lines that would produce impossible money or stock before any of it
 * reaches the sheet. `min="0"` in the form is a browser hint only.
 */
function validateBillLines(lines, itemById) {
  lines.forEach(function (l, i) {
    var qty = Number(l.qty);
    var price = Number(l.price);
    if (!isFinite(qty) || qty <= 0) {
      fail('Line ' + (i + 1) + ': quantity must be greater than zero');
    }
    if (!isFinite(price) || price < 0) {
      fail('Line ' + (i + 1) + ': price must be zero or more');
    }
    if (!itemById[l.itemId]) {
      fail('Line ' + (i + 1) + ': item not found');
    }
  });
}

/**
 * Share-link password hash, salted per link.
 *
 * Without a salt, two parties who pick the same password get the same hash, and
 * every hash can be attacked with one precomputed table. The salt is stored
 * beside the hash — that is expected; its job is to make each link's password
 * have to be attacked on its own.
 */
function saltedHash(password, salt) {
  return sha256(String(salt || '') + ':' + String(password || ''));
}

/**
 * Check a share password against a stored link, accepting links created before
 * salting existed so that adding it does not lock out live links.
 */
function sharePasswordMatches(link, password) {
  if (link.salt) return saltedHash(password, link.salt) === link.passwordHash;
  return sha256(String(password || '')) === link.passwordHash;
}

/** SHA-256 hex — same hashing the frontend local adapter uses (NFR-5). */
function sha256(text) {
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(text),
    Utilities.Charset.UTF_8
  );
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i];
    if (b < 0) b += 256;
    var s = b.toString(16);
    hex += s.length === 1 ? '0' + s : s;
  }
  return hex;
}

function logActivity(entityType, entityId, action, description, oldValue, newValue) {
  appendRow('ActivityLog', {
    id: uid('log'),
    entityType: entityType,
    entityId: entityId,
    action: action,
    description: description,
    oldValue: oldValue ? JSON.stringify(oldValue) : '',
    newValue: newValue ? JSON.stringify(newValue) : '',
    user: ACTING_USER,
    timestamp: nowISO()
  });
}

/* ==========================================================================
   Settings (stored as key/value rows)
   ========================================================================== */

var SETTINGS_DEFAULTS = {
  shopName: 'Expert Webs Designs',
  phone: '', address: '', email: '', logoUrl: '',
  roundingRule: 'nearest1',
  priceAlertThreshold: 15,
  defaultCreditDays: 7,
  customMethods: []
};

function readSettings() {
  var rows = readAll('Settings');
  var out = {};
  for (var k in SETTINGS_DEFAULTS) out[k] = SETTINGS_DEFAULTS[k];

  rows.forEach(function (r) {
    if (!r.key) return;
    var v = r.value;
    if (r.key === 'customMethods') {
      try { v = JSON.parse(v || '[]'); } catch (e) { v = []; }
    } else if (r.key === 'phone') {
      v = phoneText(v);
    } else if (r.key === 'priceAlertThreshold' || r.key === 'defaultCreditDays') {
      v = Number(v) || SETTINGS_DEFAULTS[r.key];
    }
    out[r.key] = v;
  });
  return out;
}

function saveSettings(patch) {
  return withLock(function () {
    var before = readSettings();
    var s = sheet('Settings');

    for (var key in patch) {
      var value = patch[key];
      if (key === 'customMethods') value = JSON.stringify(value || []);
      value = asText(key, value);
      var rowNum = findRow('Settings', key, 'key');
      if (rowNum > 0) {
        s.getRange(rowNum, 2).setValue(value);
      } else {
        s.appendRow([key, value]);
      }
    }

    var after = readSettings();
    logActivity('settings', 'settings', 'edit', 'Settings updated', before, after);
    return after;
  });
}

/* ==========================================================================
   Auth
   ========================================================================== */

// Failed-attempt throttling. Unlike the browser adapter's localStorage copy,
// this one is server-side and so cannot be cleared by whoever is guessing.
var MAX_ATTEMPTS = 5;
var LOCK_MS = 60 * 1000;

/** Seconds left on a lockout for this key, or 0 if it may try now. */
function lockRemaining(key) {
  var raw = PropertiesService.getScriptProperties().getProperty('lock:' + key);
  if (!raw) return 0;
  var rec = JSON.parse(raw);
  if (rec.count < MAX_ATTEMPTS) return 0;
  var left = rec.lockedAt + LOCK_MS - Date.now();
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

function recordFailure(key) {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty('lock:' + key);
  var rec = raw ? JSON.parse(raw) : { count: 0, lockedAt: 0 };
  // An expired lockout starts counting again from zero.
  if (rec.count >= MAX_ATTEMPTS && rec.lockedAt + LOCK_MS <= Date.now()) rec.count = 0;
  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) rec.lockedAt = Date.now();
  props.setProperty('lock:' + key, JSON.stringify(rec));
}

function clearFailures(key) {
  PropertiesService.getScriptProperties().deleteProperty('lock:' + key);
}

function assertNotLocked(key) {
  var wait = lockRemaining(key);
  if (wait > 0) {
    fail('Too many failed attempts. Try again in ' + wait +
         ' second' + (wait === 1 ? '' : 's') + '.');
  }
}

/* --------------------------------------------------------------------------
   Sessions

   A token is only meaningful because this file wrote it down. Every non-public
   action is checked against this store, so a caller who has the deployment URL
   but no valid token can do nothing at all.

   Script properties are the store rather than a sheet: a session check runs on
   every request, and a property read does not contend with the spreadsheet
   lock that writes hold.
   -------------------------------------------------------------------------- */

// Sessions do not expire — signing in once lasts until someone presses logout.
// A till is open all day and a re-login prompt mid-sale is worse than a browser
// left signed in on the shop's own device.
//
// Ten years rather than Infinity so expiresAt stays a real timestamp that
// pruneSessions and validateToken can still compare.
// Matches SESSION_TTL_MS in src/lib/localAdapter.js.
var SESSION_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000;

/**
 * Script properties are a bounded store, so sessions cannot accumulate
 * forever. Expired entries are dropped first; only if live sessions still
 * exceed the cap are the oldest of those evicted, which signs that user out.
 */
var MAX_SESSIONS = 200;

/**
 * How many live sessions one username may hold.
 *
 * Sessions no longer expire, so without this every login would keep its record
 * forever: the same shop device signing in each morning would consume a slot a
 * day until it filled MAX_SESSIONS and started evicting other people's logins.
 * Trimming a user's own oldest sessions keeps that self-inflicted growth away
 * from the shared cap, while still allowing several real devices per account.
 */
var MAX_SESSIONS_PER_USER = 10;

function sessionKey(token) {
  return 'sess:' + token;
}

/** The session this token names, or null if absent, malformed or expired. */
function validSession(token) {
  if (!token) return null;

  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(sessionKey(token));
  if (!raw) return null;

  var rec;
  try {
    rec = JSON.parse(raw);
  } catch (e) {
    // A malformed entry can never become valid again, so drop it.
    props.deleteProperty(sessionKey(token));
    return null;
  }

  if (!rec || !rec.username || !rec.expiresAt || Date.now() >= rec.expiresAt) {
    props.deleteProperty(sessionKey(token));
    return null;
  }
  return rec;
}

function createSession(username, role) {
  var props = PropertiesService.getScriptProperties();
  pruneSessions(props);
  trimUserSessions(props, username);

  var token = uid('tok');
  var expiresAt = Date.now() + SESSION_TTL_MS;
  props.setProperty(sessionKey(token), JSON.stringify({
    username: username,
    role: role,
    expiresAt: expiresAt
  }));
  return { token: token, expiresAt: expiresAt };
}

function pruneSessions(props) {
  var keys = props.getKeys().filter(function (k) { return k.indexOf('sess:') === 0; });
  if (keys.length < MAX_SESSIONS) return;

  var live = [];
  keys.forEach(function (k) {
    var rec = null;
    try { rec = JSON.parse(props.getProperty(k)); } catch (e) {}
    if (!rec || !rec.expiresAt || Date.now() >= rec.expiresAt) {
      props.deleteProperty(k);
    } else {
      live.push({ key: k, expiresAt: rec.expiresAt });
    }
  });

  // Still over the cap even after clearing the dead ones: evict the oldest
  // logins. Sessions no longer expire, so almost nothing is ever cleared as
  // dead above and this eviction is the only thing keeping the property store
  // inside its bounds. Ordering by expiresAt still means oldest-login-first,
  // because every session is issued with the same fixed lifetime.
  var excess = live.length - MAX_SESSIONS + 1;
  if (excess <= 0) return;
  live.sort(function (a, b) { return a.expiresAt - b.expiresAt; });
  live.slice(0, excess).forEach(function (s) { props.deleteProperty(s.key); });
}

/**
 * Keep one user's live sessions under MAX_SESSIONS_PER_USER, dropping their
 * oldest first. Called as a new session is about to be created, so it leaves
 * room for that one. Only ever touches this username's own sessions: a busy
 * device must not be able to sign anybody else out.
 */
function trimUserSessions(props, username) {
  var mine = [];
  props.getKeys().forEach(function (k) {
    if (k.indexOf('sess:') !== 0) return;
    var rec = null;
    try { rec = JSON.parse(props.getProperty(k)); } catch (e) {}
    if (!rec || rec.username !== username) return;
    if (!rec.expiresAt || Date.now() >= rec.expiresAt) {
      props.deleteProperty(k);
      return;
    }
    mine.push({ key: k, expiresAt: rec.expiresAt });
  });

  var excess = mine.length - MAX_SESSIONS_PER_USER + 1;
  if (excess <= 0) return;
  // Same fixed lifetime for every session, so nearest expiry is oldest login.
  mine.sort(function (a, b) { return a.expiresAt - b.expiresAt; });
  mine.slice(0, excess).forEach(function (s) { props.deleteProperty(s.key); });
}

/** Invalidate every session for a user — used when the password changes. */
function revokeSessionsFor(username) {
  var props = PropertiesService.getScriptProperties();
  props.getKeys().forEach(function (k) {
    if (k.indexOf('sess:') !== 0) return;
    var rec = null;
    try { rec = JSON.parse(props.getProperty(k)); } catch (e) {}
    if (rec && rec.username === username) props.deleteProperty(k);
  });
}

function login(p) {
  ensureSeed();
  var users = readAll('Users');
  var username = String(p.username || '').toLowerCase();

  assertNotLocked('login:' + username);

  var hash = sha256(p.password || '');

  for (var i = 0; i < users.length; i++) {
    if (String(users[i].username).toLowerCase() === username &&
        users[i].passwordHash === hash) {
      if (!userIsActive(users[i])) {
        fail('This account is inactive. Please contact the super admin.');
      }
      clearFailures('login:' + username);
      var pub = publicUser(users[i]);
      var session = createSession(users[i].username, pub.role);
      return {
        token: session.token,
        username: users[i].username,
        fullName: pub.fullName,
        role: pub.role,
        allowedPages: pub.allowedPages,
        expiresAt: session.expiresAt
      };
    }
  }
  recordFailure('login:' + username);
  fail('Invalid username or password');
}

function changePassword(p) {
  return withLock(function () {
    var users = readAll('Users');
    if (!users.length) fail('No user account found');

    // Change the password of whoever is signed in, not whoever happens to be
    // first in the sheet.
    var user = null;
    for (var i = 0; i < users.length; i++) {
      if (String(users[i].username).toLowerCase() === String(ACTING_USER).toLowerCase()) {
        user = users[i];
        break;
      }
    }
    if (!user) fail('No user account found');

    // Throttled like login: this endpoint takes the current password, so
    // without a limit it would be a guessing oracle for a stolen token.
    assertNotLocked('pw:' + user.username);

    if (user.passwordHash !== sha256(p.oldPassword || '')) {
      recordFailure('pw:' + user.username);
      fail('Current password is incorrect');
    }
    if (!p.newPassword || String(p.newPassword).length < 6) {
      fail('New password must be at least 6 characters');
    }
    clearFailures('pw:' + user.username);

    var rowNum = findRow('Users', user.id);
    updateRow('Users', rowNum, { passwordHash: sha256(p.newPassword) });

    // A password change must end sessions opened with the old one.
    revokeSessionsFor(user.username);

    logActivity('user', user.id, 'edit', 'Password changed');
    return { ok: true };
  });
}

/* ==========================================================================
   User management — super admin only

   Every action below starts with requireSuperAdmin(), which checks the
   signed-in account in the Users sheet (not the role the browser claims). A
   deactivated or deleted user's sessions are revoked on the spot, so they are
   signed out on their next request.
   ========================================================================== */

function userIsSuper(u) {
  return u.role === 'admin' || u.role === 'superadmin';
}

/** Blank status (rows from before this column existed) counts as active. */
function userIsActive(u) {
  return String(u.status || 'active') !== 'inactive';
}

function parsePages(raw) {
  if (Array.isArray(raw)) return raw;
  try {
    var v = JSON.parse(String(raw || '[]'));
    return Array.isArray(v) ? v : [];
  } catch (e) {
    return [];
  }
}

/** Only keys shaped like page keys, de-duplicated. */
function cleanPages(pages) {
  var seen = {};
  var out = [];
  (Array.isArray(pages) ? pages : []).forEach(function (k) {
    k = String(k);
    if (/^[a-z-]{2,30}$/.test(k) && !seen[k]) { seen[k] = 1; out.push(k); }
  });
  return out;
}

/** A user as the dashboard may see them — never the password hash. */
function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    fullName: u.fullName || '',
    role: userIsSuper(u) ? 'admin' : 'user',
    status: userIsActive(u) ? 'active' : 'inactive',
    allowedPages: parsePages(u.allowedPages),
    createdAt: u.createdAt || ''
  };
}

function findUserByName(users, name) {
  var want = String(name || '').toLowerCase();
  for (var i = 0; i < users.length; i++) {
    if (String(users[i].username).toLowerCase() === want) return users[i];
  }
  return null;
}

function requireSuperAdmin(users) {
  var me = findUserByName(users, ACTING_USER);
  if (!me || !userIsSuper(me) || !userIsActive(me)) {
    fail('Only a super admin can manage users.');
  }
  return me;
}

function otherActiveAdmins(users, exceptId) {
  return users.filter(function (u) {
    return u.id !== exceptId && userIsSuper(u) && userIsActive(u);
  }).length;
}

function validUsername(raw) {
  var name = String(raw || '').trim();
  if (!/^[A-Za-z0-9._-]{3,30}$/.test(name)) {
    fail('Username must be 3–30 characters: letters, numbers, dot, dash or underscore.');
  }
  return name;
}

/** The signed-in user's live record, attached to bootstrap as `me`. */
function currentUserInfo() {
  var me = findUserByName(readAll('Users'), ACTING_USER);
  return me ? publicUser(me) : null;
}

function listUsers() {
  var users = readAll('Users');
  requireSuperAdmin(users);
  return users.map(publicUser);
}

function saveUser(p) {
  return withLock(function () {
    var users = readAll('Users');
    var me = requireSuperAdmin(users);

    var username = validUsername(p.username);
    var clash = findUserByName(users, username);
    if (clash && clash.id !== p.id) fail('The username "' + clash.username + '" is already taken.');

    var role = p.role === 'admin' ? 'admin' : 'user';
    var pages = role === 'admin' ? [] : cleanPages(p.allowedPages);
    var fullName = String(p.fullName || '').trim();

    if (!p.id) {
      if (!p.password || String(p.password).length < 6) fail('Set a password of at least 6 characters');
      var rec = {
        id: uid('usr'),
        username: username,
        passwordHash: sha256(String(p.password)),
        role: role,
        fullName: fullName,
        status: 'active',
        allowedPages: JSON.stringify(pages),
        createdAt: nowISO()
      };
      appendRow('Users', rec);
      logActivity('user', rec.id, 'create', 'Created user "' + username + '"');
      return publicUser(rec);
    }

    var user = null;
    for (var i = 0; i < users.length; i++) if (users[i].id === p.id) user = users[i];
    if (!user) fail('User not found');
    if (userIsSuper(user) && role !== 'admin' && otherActiveAdmins(users, user.id) === 0) {
      fail('You cannot remove the last active super admin.');
    }
    if (user.id === me.id && role !== 'admin') {
      fail('You cannot take super admin rights away from yourself.');
    }
    // The session is tied to the username, so renaming yourself would strand it.
    if (user.id === me.id && username.toLowerCase() !== String(user.username).toLowerCase()) {
      fail('You cannot change your own username. Ask another super admin.');
    }

    var patch = {
      username: username, role: role, fullName: fullName,
      allowedPages: JSON.stringify(pages)
    };
    updateRow('Users', findRow('Users', user.id), patch);

    // A renamed account must not keep sessions under its old name.
    if (String(user.username) !== username) revokeSessionsFor(user.username);

    logActivity('user', user.id, 'edit', 'Updated user "' + username + '"');
    user.username = username; user.role = role; user.fullName = fullName;
    user.allowedPages = patch.allowedPages;
    return publicUser(user);
  });
}

function setUserPassword(p) {
  return withLock(function () {
    var users = readAll('Users');
    requireSuperAdmin(users);
    var user = null;
    for (var i = 0; i < users.length; i++) if (users[i].id === p.id) user = users[i];
    if (!user) fail('User not found');
    if (!p.newPassword || String(p.newPassword).length < 6) {
      fail('New password must be at least 6 characters');
    }
    updateRow('Users', findRow('Users', user.id), { passwordHash: sha256(String(p.newPassword)) });
    // Whoever knew the old password is signed out everywhere.
    revokeSessionsFor(user.username);
    logActivity('user', user.id, 'edit', 'Password reset for "' + user.username + '"');
    return { ok: true };
  });
}

function setUserStatus(p) {
  return withLock(function () {
    var users = readAll('Users');
    var me = requireSuperAdmin(users);
    var user = null;
    for (var i = 0; i < users.length; i++) if (users[i].id === p.id) user = users[i];
    if (!user) fail('User not found');

    var status = p.status === 'inactive' ? 'inactive' : 'active';
    if (status === 'inactive') {
      if (user.id === me.id) fail('You cannot deactivate your own account.');
      if (userIsSuper(user) && otherActiveAdmins(users, user.id) === 0) {
        fail('You cannot deactivate the last active super admin.');
      }
    }
    updateRow('Users', findRow('Users', user.id), { status: status });
    if (status === 'inactive') revokeSessionsFor(user.username);

    logActivity('user', user.id, 'edit',
      (status === 'inactive' ? 'Deactivated' : 'Activated') + ' user "' + user.username + '"');
    user.status = status;
    return publicUser(user);
  });
}

function deleteUser(p) {
  return withLock(function () {
    var users = readAll('Users');
    var me = requireSuperAdmin(users);
    var user = null;
    for (var i = 0; i < users.length; i++) if (users[i].id === p.id) user = users[i];
    if (!user) fail('User not found');
    if (user.id === me.id) fail('You cannot delete your own account.');
    if (userIsSuper(user) && otherActiveAdmins(users, user.id) === 0) {
      fail('You cannot delete the last active super admin.');
    }
    deleteRowById('Users', user.id);
    revokeSessionsFor(user.username);
    logActivity('user', user.id, 'delete', 'Deleted user "' + user.username + '"');
    return { ok: true };
  });
}

/* ==========================================================================
   Bootstrap — every tab in one response (cached briefly)
   ========================================================================== */

function bootstrap() {
  var out = bootstrapShared();
  // Per-user, so it is added AFTER the shared cache: one person's pages must
  // never be served to another from the cache.
  out.me = currentUserInfo();
  return out;
}

/** Everything in bootstrap that is the same for every user (cached briefly). */
function bootstrapShared() {
  // ensureSeed() touches all 19 tabs and can create sheets, which is slow and
  // contends with concurrent requests. Once the workbook is initialised it never
  // needs to run again, so a Script Property gates it after the first success.
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('seeded') !== 'yes') {
    ensureSeed();
    props.setProperty('seeded', 'yes');
  }

  var cache = null;
  try { cache = CacheService.getScriptCache(); } catch (e) {}

  if (cache) {
    try {
      var hit = cache.get('bootstrap');
      if (hit) return JSON.parse(hit);
    } catch (e) {
      // A cache miss, expiry, or parse failure must never fail the request —
      // fall through and read from the sheets instead.
    }
  }

  var out = {};
  for (var tab in TAB_TO_KEY) {
    out[TAB_TO_KEY[tab]] = readAll(tab);
  }

  // A share link's password hash is never needed by the dashboard — it only
  // shows whether a link exists and lets you revoke it. Sending the hash would
  // put every share password into the bootstrap response (and its cache) for
  // offline cracking.
  out.partyLedgerLinks = (out.partyLedgerLinks || []).map(function (l) {
    return {
      partyId: l.partyId,
      token: l.token,
      active: l.active,
      createdAt: l.createdAt
    };
  });
  out.settings = readSettings();
  out.methods = ['Cash', 'JazzCash', 'EasyPaisa', 'HBL Bank', 'Cheque']
    .concat(out.settings.customMethods || []);

  if (cache) {
    try {
      var payload = JSON.stringify(out);
      // CacheService caps an entry at 100KB of UTF-8, so measure bytes, not
      // JS characters, and leave headroom.
      if (Utilities.newBlob(payload).getBytes().length < 90000) {
        cache.put('bootstrap', payload, CACHE_SECONDS);
      }
    } catch (e) {
      // Caching is an optimisation; never let it break the response.
    }
  }

  return out;
}

/* ==========================================================================
   Sync — accept records entered offline on a device
   ========================================================================== */

/**
 * Upsert records that were created while the dashboard had no internet.
 *
 * The contract that makes this safe:
 *
 *   1. The DEVICE's id is authoritative. Ids are `prefix_<base36 time><random>`
 *      and are generated identically on both sides, so a local id can be
 *      written straight into the sheet. Same id in both places means the two
 *      databases line up exactly — a bill's partyId still resolves, and the
 *      ledgers agree without any id translation.
 *
 *   2. An id that already exists is an UPDATE, never a second row. That is what
 *      makes pushing twice harmless: re-sending the same day's work cannot
 *      duplicate a bill. Sync is idempotent by construction.
 *
 *   3. When both sides changed the same record, the more recently edited one
 *      wins, compared on `updatedAt` (falling back to `createdAt`). A record
 *      the server has edited more recently is KEPT and reported as `kept`, so
 *      nothing is silently overwritten either way.
 *
 * Everything is written under one lock and one flush, so a half-applied push
 * cannot leave the sheet inconsistent.
 */
function syncPush(p) {
  var groups = p && p.records ? p.records : {};

  // Parents before children: a bill must not land before its party exists, or
  // a ledger would briefly reference a missing row.
  var ORDER = [
    'Parties', 'Suppliers', 'Items', 'Employees', 'Assets',
    'PurchaseBills', 'Purchases', 'Bills', 'BillItems', 'PartyItemPrices',
    'Payments', 'Returns', 'Cheques', 'PartyAdvances',
    'EmployeeTransactions', 'Expenses', 'StockLoss',
    'SupplierPayments', 'SupplierReturns',
    'ActivityLog'
  ];

  return withLock(function () {
    var result = {
      inserted: 0, updated: 0, kept: 0, failed: 0,
      byTab: {}, conflicts: [], errors: [], billNoChanges: []
    };

    for (var i = 0; i < ORDER.length; i++) {
      var tab = ORDER[i];
      var rows = groups[tab];
      if (!rows || !rows.length) continue;

      // One read per tab rather than one lookup per record: Apps Script is slow
      // at many small calls, and a day's sync can carry hundreds of rows.
      var existing = readAll(tab);
      var byId = {};
      for (var e = 0; e < existing.length; e++) byId[String(existing[e].id)] = existing[e];

      var stats = { inserted: 0, updated: 0, kept: 0, failed: 0 };

      for (var r = 0; r < rows.length; r++) {
        var rec = rows[r];
        try {
          if (!rec || !rec.id) { stats.failed++; result.failed++; continue; }

          var current = byId[String(rec.id)];

          if (!current) {
            // Bills carry a human-facing number that both sides allocate
            // independently, so an offline bill can arrive holding a number
            // the server already issued to a different bill. The record is
            // still inserted — never dropped — under the next free number,
            // and the change is reported so the shopkeeper can see it.
            if (tab === 'Bills') {
              var wanted = String(rec.billNo || '');
              if (wanted && billNoTakenBy(existing, wanted, rec.id)) {
                var replacement = nextFreeBillNo(existing, wanted);
                result.billNoChanges.push({ id: rec.id, from: wanted, to: replacement });
                rec.billNo = replacement;
              }
            }

            appendRow(tab, rec);
            existing.push(rec);
            byId[String(rec.id)] = rec;
            stats.inserted++;
            result.inserted++;
          } else if (isNewer(rec, current)) {
            updateRow(tab, findRow(tab, rec.id), rec);
            byId[String(rec.id)] = rec;
            stats.updated++;
            result.updated++;
          } else {
            // The server's copy is the same or newer: leave it alone.
            stats.kept++;
            result.kept++;
            if (changed(rec, current)) {
              result.conflicts.push({
                tab: tab, id: rec.id,
                keptServerVersion: true,
                serverUpdatedAt: stamp(current),
                deviceUpdatedAt: stamp(rec)
              });
            }
          }
        } catch (err) {
          stats.failed++;
          result.failed++;
          // Report and continue: one bad row must not abandon the rest of the
          // day's work.
          result.errors.push({
            tab: tab,
            id: rec && rec.id ? rec.id : '(no id)',
            error: String(err && err.message ? err.message : err)
          });
        }
      }

      result.byTab[tab] = stats;
    }

    // Records the device deleted — a removed payment, or the old lines of an
    // edited bill. Without this the Sheet keeps them forever, and the next
    // download would hand them straight back to the device. Limited to the
    // tabs sync writes; the log is append-only and never deleted from.
    // `deleted` is always a number, even 0: the device reads its presence as
    // "this backend understands deletions" before marking any as done.
    result.deleted = 0;
    var del = p && p.deleted ? p.deleted : {};
    for (var dt in del) {
      if (ORDER.indexOf(dt) < 0 || dt === 'ActivityLog') continue;
      var ids = del[dt] || [];
      for (var x = 0; x < ids.length; x++) {
        try {
          // Already gone counts as done: the device only needs it absent.
          deleteRowById(dt, ids[x]);
          result.deleted++;
        } catch (err) {
          result.failed++;
          result.errors.push({
            tab: dt, id: ids[x],
            error: String(err && err.message ? err.message : err)
          });
        }
      }
    }

    logActivity('system', 'sync', 'create',
      'Synced from a device: ' + result.inserted + ' new, ' + result.updated +
      ' updated, ' + result.deleted + ' deleted, ' + result.kept + ' kept, ' +
      result.failed + ' failed');

    return result;
  });
}

/** The edit time a sync comparison should use. */
function stamp(rec) {
  if (!rec) return '';
  return String(rec.updatedAt || rec.createdAt || rec.timestamp || '');
}

/** Is the incoming record more recently edited than the one on the server? */
function isNewer(incoming, current) {
  var a = stamp(incoming);
  var b = stamp(current);
  // With nothing to compare, keep the server's copy rather than overwrite
  // blind. A record with no timestamps is almost always unchanged reference
  // data that has simply been re-sent.
  if (!a) return false;
  if (!b) return true;
  return a > b;
}

/** Do two versions of a record actually differ on any shared field? */
function changed(a, b) {
  for (var k in a) {
    if (k === '_row' || k === 'updatedAt') continue;
    if (b[k] === undefined) continue;
    if (String(a[k]) !== String(b[k])) return true;
  }
  return false;
}

/** Is this bill number already used by a DIFFERENT bill? */
function billNoTakenBy(bills, billNo, selfId) {
  for (var i = 0; i < bills.length; i++) {
    if (String(bills[i].billNo) === String(billNo) &&
        String(bills[i].id) !== String(selfId)) return true;
  }
  return false;
}

/** The next unused number in the same YEAR-SEQ series. */
function nextFreeBillNo(bills, wanted) {
  var parts = String(wanted).split('-');
  var year = parts.length > 1 ? parts[0] : String(new Date().getFullYear());

  var max = 0;
  for (var i = 0; i < bills.length; i++) {
    var bits = String(bills[i].billNo || '').split('-');
    if (bits.length === 2 && bits[0] === year) {
      var n = parseInt(bits[1], 10);
      if (!isNaN(n) && n > max) max = n;
    }
  }
  var next = String(max + 1);
  while (next.length < 4) next = '0' + next;
  return year + '-' + next;
}

/* ==========================================================================
   Parties
   ========================================================================== */

function saveParty(p) {
  return withLock(function () {
    if (!String(p.name || '').trim()) fail('Party name is required');

    // Two parties with the same name each get their own ledger, so payments
    // land on whichever was picked and neither balance is right — and the
    // shopkeeper cannot tell them apart in a dropdown. Compared case- and
    // space-insensitively: "hamza foods" and "Hamza  Foods" are one shop to
    // everyone except a string comparison.
    var wantKey = nameKey(p.name);
    var parties = readAll('Parties');
    for (var dp = 0; dp < parties.length; dp++) {
      if (String(parties[dp].id) !== String(p.id) && nameKey(parties[dp].name) === wantKey) {
        fail('A party called "' + parties[dp].name + '" already exists. ' +
             'Use a different name, or open the existing one.');
      }
    }

    // One mobile number, one party: otherwise the same customer can end up
    // with two ledgers under two names.
    var wantPhone = phoneKey(p.phone);
    if (wantPhone) {
      for (var pp = 0; pp < parties.length; pp++) {
        if (String(parties[pp].id) !== String(p.id) && phoneKey(parties[pp].phone) === wantPhone) {
          fail('This mobile number is already registered on party "' + parties[pp].name + '".');
        }
      }
    }

    var settings = readSettings();

    if (p.id) {
      var existing = getById('Parties', p.id);
      if (!existing) fail('Party not found');
      var patch = {
        name: String(p.name).trim(),
        phone: p.phone || '',
        address: p.address || '',
        creditLimit: Number(p.creditLimit) || 0,
        defaultDueDays: Number(p.defaultDueDays) || settings.defaultCreditDays
      };
      // A party who is also a supplier is one business: keep the supplier
      // row's name, phone and address the same. Mirrors saveParty in
      // src/lib/localAdapter.js.
      var linkedSup = null;
      var sups = readAll('Suppliers');
      for (var ls = 0; ls < sups.length; ls++) {
        if (String(sups[ls].partyId) === String(p.id)) { linkedSup = sups[ls]; break; }
      }
      if (linkedSup) {
        for (var sc = 0; sc < sups.length; sc++) {
          if (String(sups[sc].id) !== String(linkedSup.id) && nameKey(sups[sc].name) === wantKey) {
            fail('A supplier called "' + sups[sc].name + '" already exists, and this party\'s ' +
                 'supplier side must carry the same name.');
          }
        }
      }
      updateRow('Parties', existing._row, patch);
      if (linkedSup) {
        updateRow('Suppliers', linkedSup._row, { name: patch.name, phone: patch.phone, address: patch.address });
      }
      logActivity('party', p.id, 'edit', 'Edited party "' + patch.name + '"', existing, patch);
      return getById('Parties', p.id);
    }

    var rec = {
      id: uid('pty'),
      name: String(p.name).trim(),
      phone: p.phone || '',
      address: p.address || '',
      creditLimit: Number(p.creditLimit) || 0,
      defaultDueDays: Number(p.defaultDueDays) || settings.defaultCreditDays,
      status: 'active',
      createdAt: nowISO()
    };
    appendRow('Parties', rec);
    logActivity('party', rec.id, 'create', 'Added party "' + rec.name + '"');
    return rec;
  });
}

/**
 * Set, change or remove the password on one party's ledger. Mirrors
 * setPartyLock in src/lib/localAdapter.js.
 *
 * Changing or removing an existing lock needs the party's current password,
 * or the signed-in user's login password so a forgotten one can be reset.
 */
function setPartyLock(p) {
  return withLock(function () {
    var party = getById('Parties', p.partyId);
    if (!party) fail('Party not found');

    var next = String(p.password || '');
    if (next && next.length < 4) fail('Party password must be at least 4 characters');

    if (party.lockHash) {
      var cur = String(p.currentPassword || '');
      var partyOk = saltedHash(cur, party.lockSalt) === party.lockHash;
      var loginOk = false;
      readAll('Users').forEach(function (u) {
        if (String(u.username).toLowerCase() === String(ACTING_USER).toLowerCase() &&
            u.passwordHash === sha256(cur)) loginOk = true;
      });
      if (!partyOk && !loginOk) {
        fail('Current password is wrong. Enter this party’s password, or your login password.');
      }
    }

    var salt = next ? uid('slt') : '';
    updateRow('Parties', party._row, {
      lockSalt: salt,
      lockHash: next ? saltedHash(next, salt) : ''
    });
    logActivity('party', party.id, 'edit',
      next ? (party.lockHash ? 'Changed ledger password for "' + party.name + '"'
                             : 'Locked ledger of "' + party.name + '" with a password')
           : 'Removed ledger password from "' + party.name + '"');
    return { ok: true, locked: Boolean(next) };
  });
}

/** Archive/restore — never delete (Safety Guide 2.1). */
function toggleArchive(tab, id, label) {
  return withLock(function () {
    var rec = getById(tab, id);
    if (!rec) fail(label + ' not found');
    var next = rec.status === 'archived' ? 'active' : 'archived';
    updateRow(tab, rec._row, { status: next });
    logActivity(label, id,
      'edit',
      (next === 'archived' ? 'Archived ' : 'Restored ') + label + ' "' + rec.name + '"');
    return getById(tab, id);
  });
}

/* ==========================================================================
   Items
   ========================================================================== */

function saveItem(p) {
  return withLock(function () {
    if (!String(p.name || '').trim()) fail('Item name is required');

    // Same reasoning as parties: two items of one name split a product's stock
    // and price history across two records, so neither reads correctly.
    var wantItemKey = nameKey(p.name);
    var allItems = readAll('Items');
    for (var di = 0; di < allItems.length; di++) {
      if (String(allItems[di].id) !== String(p.id) &&
          nameKey(allItems[di].name) === wantItemKey) {
        fail('An item called "' + allItems[di].name + '" already exists. ' +
             'Use a different name, or edit the existing one.');
      }
    }

    if (p.id) {
      var existing = getById('Items', p.id);
      if (!existing) fail('Item not found');
      var patch = {
        name: String(p.name).trim(),
        baseUnit: p.baseUnit || 'Piece',
        altUnit: p.altUnit || '',
        conversionRate: Number(p.conversionRate) || 0,
        category: p.category || '',
        costPrice: Number(p.costPrice) || 0,
        lowStockAlert: Number(p.lowStockAlert) || 0
      };
      updateRow('Items', existing._row, patch);
      logActivity('item', p.id, 'edit', 'Edited item "' + patch.name + '"', existing, patch);
      return getById('Items', p.id);
    }

    var rec = {
      id: uid('itm'),
      name: String(p.name).trim(),
      baseUnit: p.baseUnit || 'Piece',
      altUnit: p.altUnit || '',
      conversionRate: Number(p.conversionRate) || 0,
      category: p.category || '',
      costPrice: Number(p.costPrice) || 0,
      lastPurchaseDate: '',
      openingStock: Number(p.openingStock) || 0,
      lowStockAlert: Number(p.lowStockAlert) || 0,
      status: 'active'
    };
    appendRow('Items', rec);
    logActivity('item', rec.id, 'create', 'Added item "' + rec.name + '"');
    return rec;
  });
}

/* ==========================================================================
   Bills
   ========================================================================== */

/** Auto-incrementing bill number per year (FR-10). */
function nextBillNo() {
  var year = new Date().getFullYear();
  var props = PropertiesService.getScriptProperties();
  var key = 'billCounter_' + year;
  var n = Number(props.getProperty(key) || 0) + 1;
  props.setProperty(key, String(n));
  var padded = ('0000' + n).slice(-4);
  return year + '-' + padded;
}

function saveBill(p) {
  return withLock(function () {
    if (!p.partyId) fail('Select a party');
    if (!p.lines || !p.lines.length) fail('Add at least one item');

    if (!getById('Parties', p.partyId)) fail('Party not found');

    var settings = readSettings();
    var items = readAll('Items');
    var itemById = {};
    items.forEach(function (it) { itemById[it.id] = it; });

    validateBillLines(p.lines, itemById);
    var computed = billTotalsFromLines(p.lines, settings.roundingRule);

    var bill;
    var editing = Boolean(p.id);
    // itemId -> quantity already delivered on the bill being edited.
    var deliveredBefore = {};

    if (p.id) {
      /* ---- Editing an existing bill (FR-25) ---- */
      var existing = getById('Bills', p.id);
      if (!existing) fail('Bill not found');
      if (existing.status === 'voided') fail('A voided bill cannot be edited');

      // Editing a bill down below what has already been paid would leave the
      // overpayment with nowhere to go: it is not refunded, not held as an
      // advance, and simply disappears from the ledger. Refusing says what is
      // wrong and leaves the shopkeeper to record a return or a refund, which
      // are the operations that actually account for the money.
      var alreadyPaid = r2(r2(existing.totalAmount) - billDue(p.id));
      if (alreadyPaid > r2(computed.total) + 0.004) {
        fail('This bill already has ' + alreadyPaid.toFixed(2) + ' paid against it, ' +
             'so it cannot be reduced to ' + computed.total.toFixed(2) + '. ' +
             'Record a return, or reverse a payment first.');
      }

      var patch = {
        partyId: p.partyId,
        date: p.date,
        subtotal: computed.subtotal,
        roundOff: computed.roundOff,
        totalAmount: computed.total,
        dueDate: p.dueDate || '',
        note: p.note || ''
      };
      // Left alone unless the caller sends one, so editing a bill's items
      // does not wipe its instalment plan.
      if (p.installPlan !== undefined) patch.installPlan = String(p.installPlan || '');
      updateRow('Bills', existing._row, patch);

      // What had already gone out, per item, so an edit does not forget it.
      readAll('BillItems').forEach(function (x) {
        if (x.billId !== p.id) return;
        deliveredBefore[x.itemId] = (deliveredBefore[x.itemId] || 0) + lineDeliveredQty(x, existing);
      });

      // Replace line items; payments stay attached to the bill
      deleteRowsWhere('BillItems', 'billId', p.id);

      logActivity('bill', p.id, 'edit', 'Edited Bill ' + existing.billNo, existing, patch);
      bill = getById('Bills', p.id);

    } else {
      /* ---- New bill ---- */
      bill = {
        id: uid('bil'),
        billNo: nextBillNo(),
        partyId: p.partyId,
        date: p.date || todayISO(),
        subtotal: computed.subtotal,
        roundOff: computed.roundOff,
        totalAmount: computed.total,
        status: 'due',
        dueDate: p.dueDate || addDaysISO(p.date || todayISO(), settings.defaultCreditDays),
        note: p.note || '',
        createdAt: nowISO(),
        voidReason: '',
        voidedAt: '',
        // Most sales are handed over as the bill is written, so the biller marks
        // the exceptions as pending rather than confirming every ordinary sale.
        delivery: p.delivery === 'pending' ? 'pending' : 'delivered',
        deliveredAt: p.delivery === 'pending' ? '' : nowISO(),
        installPlan: String(p.installPlan || '')
      };
      appendRow('Bills', bill);
      logActivity('bill', bill.id, 'create', 'Created Bill ' + bill.billNo);
    }

    /* ---- Bill lines: capture cost price at time of sale (FR-38) ---- */
    p.lines.forEach(function (l) {
      var item = itemById[l.itemId] || {};
      var qty = Number(l.qty) || 0;
      // Delivered on this line: what the caller says; else all of it when the
      // bill is marked delivered; else whatever of this item had already gone
      // out before the edit (none on a new pending bill).
      var delivered = givenQty(l.deliveredQty);
      if (delivered === null) {
        if (p.delivery === 'delivered' || (!editing && p.delivery !== 'pending')) {
          delivered = qty;
        } else {
          delivered = Math.min(qty, deliveredBefore[l.itemId] || 0);
          deliveredBefore[l.itemId] = r2((deliveredBefore[l.itemId] || 0) - delivered);
        }
      }
      if (delivered < 0 || delivered > qty + 0.0001) {
        fail((item.name || 'Item') + ': delivered quantity must be between 0 and ' + qty);
      }
      appendRow('BillItems', {
        id: uid('bli'),
        billId: bill.id,
        itemId: l.itemId,
        qty: qty,
        unit: l.unit || item.baseUnit || 'Piece',
        price: r2(l.price),
        costPriceAtSale: r2(l.costPriceAtSale !== undefined && l.costPriceAtSale !== null
          ? l.costPriceAtSale : (item.costPrice || 0)),
        lineTotal: r2((Number(l.qty) || 0) * (Number(l.price) || 0)),
        deliveredQty: r2(delivered),
        supplierId: String(l.supplierId || '')
      });

      // Remember this party's price for this item (source for FR-3 auto-fill)
      appendRow('PartyItemPrices', {
        id: uid('pip'),
        partyId: bill.partyId,
        itemId: l.itemId,
        price: r2(l.price),
        unit: l.unit || item.baseUnit || 'Piece',
        date: bill.date
      });
    });

    /* ---- Payments recorded with the bill (FR-7) ---- */
    (p.payments || []).forEach(function (pay) {
      if (!(Number(pay.amount) > 0)) return;
      var payId = uid('pay');
      appendRow('Payments', {
        id: payId,
        billId: bill.id,
        partyId: bill.partyId,
        method: pay.method,
        amount: r2(pay.amount),
        date: bill.date,
        note: pay.note || '',
        reversed: false,
        reversedAt: '',
        reverseReason: '',
        isAdvance: false
      });

      if (pay.method === 'Cheque' && pay.cheque) {
        appendRow('Cheques', {
          id: uid('chq'),
          billId: bill.id,
          partyId: bill.partyId,
          paymentId: payId,
          chequeNo: pay.cheque.chequeNo || '',
          bankName: pay.cheque.bankName || '',
          accountHolder: pay.cheque.accountHolder || '',
          dateIssued: pay.cheque.dateIssued || bill.date,
          dateDue: pay.cheque.dateDue || bill.date,
          status: 'pending',
          amount: r2(pay.amount),
          note: pay.cheque.note || '',
          statusChangedAt: ''
        });
      }
    });

    /* ---- Applied party advance (FR-9) ---- */
    var wantAdvance = Number(p.advanceApplied);
    if (isFinite(wantAdvance) && wantAdvance > 0) {
      // Never apply more advance than the party actually holds, and never more
      // than the bill is worth: either would record a payment against money
      // that does not exist.
      var available = advanceAvailable(bill.partyId);
      if (r2(wantAdvance) > r2(available) + 0.004) {
        fail('Advance applied (' + r2(wantAdvance).toFixed(2) + ') exceeds this ' +
             'party’s available advance of ' + available.toFixed(2) + '.');
      }
      if (r2(wantAdvance) > r2(bill.totalAmount) + 0.004) {
        fail('Advance applied cannot exceed the bill total.');
      }

      // Record exactly what was consumed, so the payment row and the advance
      // ledger can never disagree.
      var used = applyAdvance(bill.partyId, wantAdvance);
      appendRow('Payments', {
        id: uid('pay'),
        billId: bill.id,
        partyId: bill.partyId,
        method: 'Advance',
        amount: used,
        date: bill.date,
        note: 'Advance applied',
        reversed: false,
        reversedAt: '',
        reverseReason: '',
        isAdvance: false
      });
    }

    syncBillDeliveryFlag(bill.id);
    return getById('Bills', bill.id) || bill;
  });
}

/** Unapplied advance a party still holds. */
function advanceAvailable(partyId) {
  return r2(readAll('PartyAdvances')
    .filter(function (a) { return a.partyId === partyId; })
    .reduce(function (s, a) {
      return s + Math.max(0, (Number(a.amount) || 0) - (Number(a.applied) || 0));
    }, 0));
}

/**
 * Consume a party's advance balance, oldest first.
 * Returns the amount actually consumed, which the caller records as the
 * payment so the two can never drift apart.
 */
function applyAdvance(partyId, amount) {
  var advances = readAll('PartyAdvances').filter(function (a) { return a.partyId === partyId; });
  var requested = Number(amount);
  if (!isFinite(requested) || requested <= 0) return 0;

  var remaining = r2(requested);
  for (var i = 0; i < advances.length && remaining > 0; i++) {
    var a = advances[i];
    var avail = (Number(a.amount) || 0) - (Number(a.applied) || 0);
    if (avail <= 0) continue;
    var use = Math.min(avail, remaining);
    var rowNum = findRow('PartyAdvances', a.id);
    updateRow('PartyAdvances', rowNum, { applied: r2((Number(a.applied) || 0) + use) });
    remaining = r2(remaining - use);
  }
  return r2(requested - remaining);
}

/** Remove rows matching a field value (used only to replace bill lines on edit). */
function deleteRowsWhere(name, field, value) {
  var s = sheet(name);
  var last = s.getLastRow();
  if (last < 2) return;

  var col = SCHEMA[name].indexOf(field) + 1;
  if (col < 1) return;

  var values = s.getRange(2, col, last - 1, 1).getValues();
  // Delete bottom-up so row numbers stay valid
  for (var i = values.length - 1; i >= 0; i--) {
    if (String(values[i][0]) === String(value)) s.deleteRow(i + 2);
  }
}

/**
 * Mark a bill's goods as handed over, or still waiting.
 *
 * Delivery is its own field because `status` already carries the money state
 * (due/partial/paid/voided) — a bill can be paid but not yet delivered, or
 * delivered and still unpaid.
 */
function setDelivery(p) {
  return withLock(function () {
    var bill = getById('Bills', p.id);
    if (!bill) fail('Bill not found');
    if (p.delivery !== 'pending' && p.delivery !== 'delivered') {
      fail('Delivery must be pending or delivered');
    }
    // A voided bill has no goods to hand over; marking it delivered would put a
    // cancelled sale on the delivery list.
    if (bill.status === 'voided') fail('A voided bill cannot be delivered');

    var patch = {
      delivery: p.delivery,
      deliveredAt: p.delivery === 'delivered' ? nowISO() : ''
    };
    updateRow('Bills', bill._row, patch);
    // The whole bill at once: every line follows.
    readAll('BillItems').forEach(function (x) {
      if (x.billId !== p.id) return;
      var rowNum = findRow('BillItems', x.id);
      if (rowNum > 0) {
        updateRow('BillItems', rowNum,
          { deliveredQty: p.delivery === 'delivered' ? (Number(x.qty) || 0) : 0 });
      }
    });
    logActivity('bill', p.id, 'edit',
      'Bill ' + bill.billNo + ' marked ' + p.delivery, bill, patch);
    return getById('Bills', p.id);
  });
}

/* ---------------- Per-line delivery and receiving ---------------- */

/** A quantity the caller actually supplied, or null when it left it out. */
function givenQty(v) {
  if (v === '' || v === null || v === undefined) return null;
  var n = Number(v);
  if (!isFinite(n)) fail('Quantity must be a number');
  return n;
}

/**
 * How much of one bill line has gone out. Rows from before per-line delivery
 * have a blank deliveredQty and follow the bill's own flag.
 */
function lineDeliveredQty(line, bill) {
  var qty = Number(line.qty) || 0;
  var v = line.deliveredQty;
  if (v === '' || v === null || v === undefined || !isFinite(Number(v))) {
    return bill && bill.delivery === 'pending' ? 0 : qty;
  }
  return Math.min(qty, Math.max(0, Number(v)));
}

/** How much of one purchase line has arrived. Blank reads as all of it. */
function lineReceivedQty(line) {
  var qty = Number(line.qty) || 0;
  var v = line.receivedQty;
  if (v === '' || v === null || v === undefined || !isFinite(Number(v))) return qty;
  return Math.min(qty, Math.max(0, Number(v)));
}

/**
 * Keep the bill's whole-bill delivery flag in step with its lines: it stays
 * 'pending' until every line has fully gone out.
 */
function syncBillDeliveryFlag(billId) {
  var bill = getById('Bills', billId);
  if (!bill) return;
  var lines = readAll('BillItems').filter(function (x) { return x.billId === billId; });
  var all = lines.every(function (l) {
    return lineDeliveredQty(l, bill) >= (Number(l.qty) || 0) - 0.0001;
  });
  var next = all ? 'delivered' : 'pending';
  if (next === bill.delivery) return;
  updateRow('Bills', bill._row, {
    delivery: next,
    deliveredAt: next === 'delivered' ? nowISO() : ''
  });
}

/** Record how much of each line has gone out: some items now, the rest later. */
function setLineDelivery(p) {
  return withLock(function () {
    var bill = getById('Bills', p.billId);
    if (!bill) fail('Bill not found');
    if (bill.status === 'voided') fail('A voided bill cannot be delivered');
    var changes = p.lines || [];
    if (!changes.length) fail('Nothing to update');

    var lines = readAll('BillItems').filter(function (x) { return x.billId === bill.id; });
    var byId = {};
    lines.forEach(function (l) { byId[l.id] = l; });

    // Validated in full first, so one bad line leaves the bill untouched.
    var done = changes.map(function (c) {
      var line = byId[c.id];
      if (!line) fail('Bill line not found');
      var qty = Number(line.qty) || 0;
      var delivered = givenQty(c.deliveredQty);
      if (delivered === null || delivered < 0 || delivered > qty + 0.0001) {
        var it = getById('Items', line.itemId);
        fail((it ? it.name : 'Item') + ': delivered quantity must be between 0 and ' + qty);
      }
      return [line, r2(delivered)];
    });
    done.forEach(function (pair) {
      updateRow('BillItems', findRow('BillItems', pair[0].id), { deliveredQty: pair[1] });
      pair[0].deliveredQty = pair[1];
    });
    syncBillDeliveryFlag(bill.id);

    var sent = 0;
    var total = 0;
    lines.forEach(function (l) { sent += lineDeliveredQty(l, bill); total += Number(l.qty) || 0; });
    logActivity('bill', bill.id, 'edit',
      'Bill ' + bill.billNo + ' delivery updated: ' + r2(sent) + ' of ' + r2(total) + ' delivered');
    return getById('Bills', bill.id);
  });
}

/** Record how much of each purchase line has arrived from the supplier. */
function setPurchaseReceipt(p) {
  return withLock(function () {
    var bill = getById('PurchaseBills', p.purchaseBillId);
    if (!bill) fail('Purchase bill not found');
    if (bill.status === 'voided') fail('This purchase was cancelled');
    var changes = p.lines || [];
    if (!changes.length) fail('Nothing to update');

    var lines = readAll('Purchases').filter(function (x) { return x.purchaseBillId === bill.id; });
    var byId = {};
    lines.forEach(function (l) { byId[l.id] = l; });

    var done = changes.map(function (c) {
      var line = byId[c.id];
      if (!line) fail('Purchase line not found');
      var qty = Number(line.qty) || 0;
      var received = givenQty(c.receivedQty);
      if (received === null || received < 0 || received > qty + 0.0001) {
        var it = getById('Items', line.itemId);
        fail((it ? it.name : 'Item') + ': received quantity must be between 0 and ' + qty);
      }
      return [line, r2(received)];
    });
    done.forEach(function (pair) {
      updateRow('Purchases', findRow('Purchases', pair[0].id), { receivedQty: pair[1] });
      pair[0].receivedQty = pair[1];
    });

    var got = 0;
    var total = 0;
    lines.forEach(function (l) { got += lineReceivedQty(l); total += Number(l.qty) || 0; });
    logActivity('purchaseBill', bill.id, 'edit',
      'Purchase ' + bill.purchaseNo + ' receiving updated: ' + r2(got) + ' of ' + r2(total) + ' received');
    return getById('PurchaseBills', bill.id);
  });
}

function voidBill(p) {
  return withLock(function () {
    var bill = getById('Bills', p.id);
    if (!bill) fail('Bill not found');
    if (bill.status === 'voided') fail('This bill is already voided');

    // A payment against a voided bill would stay in the cash balance with no
    // bill to belong to. Reverse it first, which takes the money back out of
    // the books on purpose. Same rule as editing a bill below what was paid.
    var livePaid = 0;
    readAll('Payments').forEach(function (pay) {
      if (pay.billId === bill.id && !pay.reversed) livePaid += Number(pay.amount) || 0;
    });
    if (livePaid > 0.004) {
      fail('Bill ' + bill.billNo + ' has ' + r2(livePaid).toFixed(2) + ' paid against it. ' +
           'Reverse its payments first (or record a return), then void the bill.');
    }

    var patch = { status: 'voided', voidReason: p.reason || '', voidedAt: nowISO() };
    updateRow('Bills', bill._row, patch);
    logActivity('bill', p.id, 'void',
      'Voided Bill ' + bill.billNo + (p.reason ? ' — ' + p.reason : ''), bill, patch);
    return getById('Bills', p.id);
  });
}

/* ==========================================================================
   Payments
   ========================================================================== */

function addPayment(p) {
  return withLock(function () {
    var amount = Number(p.amount);
    if (!isFinite(amount) || amount <= 0) fail('Enter a payment amount');

    // FR-26: never take more than is owed. The client clamps the display at
    // zero, so an unchecked excess would simply disappear from the ledger.
    if (p.billId) {
      var target = getById('Bills', p.billId);
      if (!target) fail('Bill not found');
      if (target.status === 'voided') fail('A voided bill cannot take a payment');

      var due = billDue(p.billId);
      if (r2(amount) > r2(due) + 0.004) {
        fail('Payment exceeds the amount due (' + due.toFixed(2) + '). ' +
                        'Record the extra as an advance instead.');
      }
    }

    var payId = uid('pay');
    var rec = {
      id: payId,
      billId: p.billId || '',
      partyId: p.partyId,
      method: p.method || 'Cash',
      amount: r2(p.amount),
      date: p.date || todayISO(),
      note: p.note || '',
      reversed: false,
      reversedAt: '',
      reverseReason: '',
      isAdvance: false
    };
    appendRow('Payments', rec);

    if (p.method === 'Cheque' && p.cheque) {
      appendRow('Cheques', {
        id: uid('chq'),
        billId: p.billId || '',
        partyId: p.partyId,
        paymentId: payId,
        chequeNo: p.cheque.chequeNo || '',
        bankName: p.cheque.bankName || '',
        accountHolder: p.cheque.accountHolder || '',
        dateIssued: p.cheque.dateIssued || rec.date,
        dateDue: p.cheque.dateDue || rec.date,
        status: 'pending',
        amount: r2(p.amount),
        note: p.cheque.note || '',
        statusChangedAt: ''
      });
    }

    var bill = p.billId ? getById('Bills', p.billId) : null;
    logActivity('payment', payId, 'create',
      'Payment received' + (bill ? ' for Bill ' + bill.billNo : '') + ' — ' + rec.method);
    return rec;
  });
}

/** Remove a single row by id. Returns true if a row was actually removed. */
function deleteRowById(name, id) {
  var rowNum = findRow(name, id);
  if (rowNum < 0) return false;
  sheet(name).deleteRow(rowNum);
  return true;
}

/**
 * Permanently remove a payment.
 *
 * Distinct from reversePayment, which keeps the row and flags it: a reversal
 * is a correction that stays on the record, this erases the entry outright.
 * It is for a row that should never have existed — a test entry, or money
 * logged against the wrong party — where leaving a struck-through line on a
 * customer's statement would only confuse them.
 *
 * Any cheque attached to the payment goes with it. Leaving it would strand a
 * cheque pointing at a payment id that no longer resolves, and billState()
 * would still count that dangling cheque when deciding what a bill owes.
 *
 * An advance receipt is refused: the money has an entry in PartyAdvances that
 * this action cannot see, and deleting one side would leave the party holding
 * a balance with nothing behind it.
 */
function deletePayment(p) {
  return withLock(function () {
    var pay = getById('Payments', p.id);
    if (!pay) fail('Payment not found');
    // An advance receipt normally has to go via deleteAdvance, which removes
    // the balance row with it. The exception is a receipt whose advance row no
    // longer exists: there is nothing to keep in step, and refusing would leave
    // a stranded row nobody can clear.
    if (pay.isAdvance && !p.orphan) {
      fail('This is an advance receipt. Delete the advance itself from the ' +
           'Advances list, which removes this receipt with it and keeps the ' +
           'party’s advance balance correct.');
    }

    var killed = [];
    readAll('Cheques').forEach(function (c) {
      if (c.paymentId === p.id) {
        deleteRowById('Cheques', c.id);
        killed.push(c.chequeNo || c.id);
      }
    });

    deleteRowById('Payments', p.id);

    logActivity('payment', p.id, 'delete',
      'Deleted payment of ' + pay.amount + ' (' + pay.method + ')' +
      (killed.length ? ' and cheque ' + killed.join(', ') : '') +
      (p.reason ? ' — ' + p.reason : ''), pay, null);
    return { ok: true, deletedCheques: killed.length };
  });
}

/**
 * Edit a payment that was recorded wrongly — wrong amount, method, date or note.
 *
 * Only those four fields move. billId and partyId are deliberately fixed: a
 * payment that landed on the wrong bill is a different correction, and
 * re-pointing it here would silently change two bills' balances at once.
 */
function updatePayment(p) {
  return withLock(function () {
    var pay = getById('Payments', p.id);
    if (!pay) fail('Payment not found');
    if (pay.reversed) fail('A reversed payment cannot be edited');

    var patch = {};
    if (p.amount !== undefined) {
      var amt = Number(p.amount);
      if (!isFinite(amt) || amt <= 0) fail('Enter a payment amount');

      // Same ceiling addPayment enforces, but measured against what the bill
      // would owe WITHOUT this payment — otherwise its own amount counts
      // against itself and any increase is rejected.
      if (pay.billId) {
        var bill = getById('Bills', pay.billId);
        if (bill) {
          var headroom = r2(billDue(pay.billId) + (Number(pay.amount) || 0));
          if (r2(amt) > headroom + 0.004) {
            fail('Payment exceeds the amount due (' + headroom.toFixed(2) + '). ' +
                 'Record the extra as an advance instead.');
          }
        }
      }
      patch.amount = r2(amt);
    }
    if (p.method !== undefined) patch.method = p.method;
    if (p.date !== undefined) patch.date = p.date;
    if (p.note !== undefined) patch.note = p.note || '';

    updateRow('Payments', pay._row, patch);

    // A cheque mirrors its payment's amount; letting them diverge would make
    // the bill and the cheque register disagree about the same money.
    if (patch.amount !== undefined) {
      readAll('Cheques').forEach(function (c) {
        if (c.paymentId === p.id) {
          updateRow('Cheques', findRow('Cheques', c.id), { amount: patch.amount });
        }
      });
    }

    logActivity('payment', p.id, 'edit', 'Edited payment', pay, patch);
    return getById('Payments', p.id);
  });
}

/**
 * Permanently remove a cheque.
 *
 * The payment it backs is left alone and becomes an ordinary one of its
 * method. That is the point: deleting a cheque record must not quietly erase
 * the money, only the bank instrument attached to it.
 */
function deleteCheque(p) {
  return withLock(function () {
    var chq = getById('Cheques', p.id);
    if (!chq) fail('Cheque not found');
    deleteRowById('Cheques', p.id);
    logActivity('cheque', p.id, 'delete',
      'Deleted cheque ' + (chq.chequeNo || '') + ' of ' + chq.amount +
      (p.reason ? ' — ' + p.reason : ''), chq, null);
    return { ok: true };
  });
}

/**
 * One payment spread across a party's unpaid bills, oldest first.
 *
 * This is how money actually arrives in the shop: a customer hands over a sum
 * against their whole account, not against an invoice number. Recording it
 * bill-by-bill means the shopkeeper does the allocation arithmetic by hand and
 * the ledger disagrees with the cash drawer whenever they get it wrong.
 *
 * Oldest first, because that is both normal trade practice and what keeps the
 * ageing buckets honest — paying a new bill while an old one sits open would
 * understate how overdue the account really is.
 *
 * Anything left once every bill is settled becomes an advance rather than
 * being refused, so the shopkeeper is never forced to reject cash that is
 * genuinely in their hand.
 */
function settleParty(p) {
  return withLock(function () {
    var total = Number(p.amount);
    if (!isFinite(total) || total <= 0) fail('Enter a payment amount');
    if (!p.partyId) fail('Select a party');
    if (!getById('Parties', p.partyId)) fail('Party not found');

    var date = p.date || todayISO();
    var method = p.method || 'Cash';

    /**
     * A cheque is not money until the bank clears it.
     *
     * Without a Cheques row, billDue() and billState() have nothing to hold
     * the payment back with, so an uncleared cheque counts as cash: the bill
     * reads paid, outstanding is understated and the cash position is
     * overstated. One row per payment, as addPayment and saveBill already do.
     */
    function chequeFor(payId, amount) {
      if (method !== 'Cheque') return;
      var c = p.cheque || {};
      appendRow('Cheques', {
        id: uid('chq'),
        billId: '',
        partyId: p.partyId,
        paymentId: payId,
        chequeNo: c.chequeNo || '',
        bankName: c.bankName || '',
        accountHolder: c.accountHolder || '',
        dateIssued: c.dateIssued || date,
        dateDue: c.dateDue || date,
        status: 'pending',
        amount: r2(amount),
        note: c.note || '',
        statusChangedAt: ''
      });
    }

    // Oldest first by bill date, with the bill number breaking ties so two
    // bills written the same day always allocate in a stable order.
    var mine = readAll('Bills')
      .filter(function (b) { return b.partyId === p.partyId && b.status !== 'voided'; })
      .sort(function (a, b) {
        return String(a.date).localeCompare(String(b.date)) ||
               String(a.billNo).localeCompare(String(b.billNo));
      });

    var remaining = r2(total);
    var applied = [];
    // Shared by every part of this one receipt, so the ledger shows one entry.
    var groupId = uid('grp');

    for (var i = 0; i < mine.length && remaining > 0.004; i++) {
      var due = billDue(mine[i].id);
      if (due <= 0.004) continue;

      var use = r2(Math.min(due, remaining));
      var payId = uid('pay');
      appendRow('Payments', {
        id: payId,
        billId: mine[i].id,
        partyId: p.partyId,
        method: method,
        amount: use,
        date: date,
        note: p.note || 'Account payment',
        reversed: false,
        reversedAt: '',
        reverseReason: '',
        isAdvance: false,
        groupId: groupId
      });

      chequeFor(payId, use);
      applied.push({ billId: mine[i].id, billNo: mine[i].billNo, amount: use });
      remaining = r2(remaining - use);
    }

    // Whatever the bills could not absorb is money the party has genuinely
    // overpaid, so it is held as an advance against their next bill.
    var asAdvance = 0;
    if (remaining > 0.004) {
      asAdvance = remaining;
      var advId = uid('adv');
      appendRow('PartyAdvances', {
        id: advId,
        partyId: p.partyId,
        amount: asAdvance,
        applied: 0,
        dateReceived: date,
        method: method,
        note: p.note || 'Overpayment held as advance'
      });
      var advPayId = uid('pay');
      appendRow('Payments', {
        id: advPayId,
        billId: '',
        partyId: p.partyId,
        method: method,
        amount: asAdvance,
        date: date,
        note: 'Advance received',
        reversed: false,
        reversedAt: '',
        reverseReason: '',
        isAdvance: true,
        groupId: groupId
      });
      chequeFor(advPayId, asAdvance);
    }

    logActivity('payment', p.partyId, 'create',
      'Account payment ' + r2(total) + ' — settled ' + applied.length +
      ' bill' + (applied.length === 1 ? '' : 's') +
      (asAdvance > 0 ? ', ' + asAdvance + ' held as advance' : ''));

    return { applied: applied, advance: asAdvance, total: r2(total) };
  });
}

/** Reversal is an offsetting flag, never a delete (FR-26). */
function reversePayment(p) {
  return withLock(function () {
    var pay = getById('Payments', p.id);
    if (!pay) fail('Payment not found');
    if (pay.reversed) fail('This payment is already reversed');

    var patch = { reversed: true, reversedAt: nowISO(), reverseReason: p.reason || '' };
    updateRow('Payments', pay._row, patch);
    logActivity('payment', p.id, 'reverse',
      'Reversed payment of ' + pay.amount + ' (' + pay.method + ')' +
      (p.reason ? ' — ' + p.reason : ''), pay, patch);
    return getById('Payments', p.id);
  });
}

/* ==========================================================================
   Returns
   ========================================================================== */

function addReturn(p) {
  return withLock(function () {
    var bill = getById('Bills', p.billId);
    if (!bill) fail('Bill not found');

    /* The form already caps a return at what was sold. These repeat the rule
       where it actually protects the books: a record arriving from an offline
       device, or a row typed straight into the Sheet, reaches this point
       without ever passing the form.

       Unchecked, returning more than was sold drives the bill's net negative —
       a Rs 200 bill reading as the shop owing Rs 4,800 — and restocking more
       than was sold invents stock that never existed. */
    var qty = Number(p.qty) || 0;
    if (qty <= 0) fail('Return quantity must be greater than zero');

    var soldQty = 0;
    readAll('BillItems').forEach(function (bi) {
      if (bi.billId === p.billId && bi.itemId === p.itemId) {
        soldQty += Number(bi.qty) || 0;
      }
    });
    if (!soldQty) fail('That item is not on this bill');

    var returnedQty = 0;
    var returnedValue = 0;
    readAll('Returns').forEach(function (r) {
      if (r.billId !== p.billId) return;
      returnedValue += Number(r.valueAdjusted) || 0;
      if (r.itemId === p.itemId) returnedQty += Number(r.qty) || 0;
    });

    var qtyLeft = r2(soldQty - returnedQty);
    if (qty > qtyLeft + 0.0001) {
      fail('Only ' + qtyLeft + ' of that item is left to return (' + soldQty +
           ' sold, ' + returnedQty + ' already returned).');
    }

    // Value is capped separately: qty and value are independent fields, so a
    // valid quantity can still carry an absurd amount.
    var value = r2(p.valueAdjusted);
    if (value < 0) fail('Return value cannot be negative');
    var valueLeft = r2(r2(bill.totalAmount) - r2(returnedValue));
    if (value > valueLeft + 0.004) {
      fail('Return value cannot exceed what is left on the bill (' +
           valueLeft.toFixed(2) + ').');
    }

    var rec = {
      id: uid('ret'),
      billId: p.billId,
      itemId: p.itemId,
      qty: Number(p.qty) || 0,
      valueAdjusted: r2(p.valueAdjusted),
      restock: Boolean(p.restock),
      date: p.date || todayISO(),
      note: p.note || ''
    };
    appendRow('Returns', rec);
    logActivity('return', rec.id, 'create',
      'Return against Bill ' + bill.billNo + ' — value ' + rec.valueAdjusted);
    return rec;
  });
}

/* ==========================================================================
   Cheques
   ========================================================================== */

function saveCheque(p) {
  return withLock(function () {
    if (p.id) {
      var existing = getById('Cheques', p.id);
      if (!existing) fail('Cheque not found');
      updateRow('Cheques', existing._row, p);
      return getById('Cheques', p.id);
    }
    var rec = {
      id: uid('chq'),
      billId: p.billId || '',
      partyId: p.partyId || '',
      paymentId: p.paymentId || '',
      chequeNo: p.chequeNo || '',
      bankName: p.bankName || '',
      accountHolder: p.accountHolder || '',
      dateIssued: p.dateIssued || todayISO(),
      dateDue: p.dateDue || todayISO(),
      status: p.status || 'pending',
      amount: r2(p.amount),
      note: p.note || '',
      statusChangedAt: ''
    };
    appendRow('Cheques', rec);
    logActivity('cheque', rec.id, 'create', 'Cheque ' + rec.chequeNo + ' recorded');
    return rec;
  });
}

/**
 * Change cheque status (FR-29 / FR-30).
 * Marking Bounced needs no extra write: the frontend excludes payments backed
 * by a bounced cheque, so the bill's due balance reopens automatically.
 */
function setChequeStatus(p) {
  return withLock(function () {
    var chq = getById('Cheques', p.id);
    if (!chq) fail('Cheque not found');

    // One physical cheque can sit in several rows: settleParty writes one per
    // bill it pays. The bank clears or bounces the whole cheque, so every row
    // of it moves together — otherwise the other bills stay outstanding.
    var patch = { status: p.status, statusChangedAt: nowISO() };
    var rows = chequeSiblings(readAll('Cheques'), chq);
    // A bounced cheque stopped counting, so its bill reopened and may since
    // have been paid another way. Reviving it would pay that bill twice.
    // Mirrors setChequeStatus in src/lib/localAdapter.js.
    if (p.status !== 'bounced') {
      rows.forEach(function (c) {
        if (c.status !== 'bounced' || !c.paymentId) return;
        var pay = getById('Payments', c.paymentId);
        if (!pay || pay.reversed || !pay.billId) return;
        var bill = getById('Bills', pay.billId);
        if (!bill) return;
        var room = billDue(pay.billId);
        if (r2(pay.amount) > room + 0.004) {
          fail('Bill ' + bill.billNo + ' has only ' + room.toFixed(2) + ' left to pay, so this ' +
               'bounced cheque of ' + r2(pay.amount).toFixed(2) + ' cannot be revived. ' +
               'Record the money as a new payment instead.');
        }
      });
    }
    rows.forEach(function (c) {
      var rowNum = c.id === chq.id ? chq._row : findRow('Cheques', c.id);
      if (rowNum > 0) updateRow('Cheques', rowNum, patch);
    });
    logActivity('cheque', p.id, 'edit',
      'Cheque ' + chq.chequeNo + ' marked ' + p.status +
      (rows.length > 1 ? ' (' + rows.length + ' bill entries)' : ''), chq, patch);
    return getById('Cheques', p.id);
  });
}

/**
 * Every row recording the same physical cheque: same party, number and bank.
 * A cheque with no number cannot be matched safely, so it stands alone.
 * Mirrors chequeSiblings() in src/lib/localAdapter.js.
 */
function chequeSiblings(cheques, chq) {
  function key(s) { return String(s || '').trim().toLowerCase(); }
  if (!key(chq.chequeNo)) return [chq];
  return cheques.filter(function (x) {
    return x.id === chq.id || (
      x.partyId === chq.partyId &&
      key(x.chequeNo) === key(chq.chequeNo) &&
      key(x.bankName) === key(chq.bankName));
  });
}

/* ==========================================================================
   Party advances
   ========================================================================== */

function addAdvance(p) {
  return withLock(function () {
    if (!(Number(p.amount) > 0)) fail('Enter an advance amount');

    var rec = {
      id: uid('adv'),
      partyId: p.partyId,
      amount: r2(p.amount),
      applied: 0,
      dateReceived: p.dateReceived || todayISO(),
      method: p.method || 'Cash',
      note: p.note || ''
    };
    appendRow('PartyAdvances', rec);

    var advPay = uid('pay');
    appendRow('Payments', {
      id: advPay,
      billId: '',
      partyId: p.partyId,
      method: rec.method,
      amount: rec.amount,
      date: rec.dateReceived,
      note: 'Advance received',
      reversed: false,
      reversedAt: '',
      reverseReason: '',
      isAdvance: true
    });

    // An advance handed over as a cheque is not money until it clears, the
    // same as any other cheque. Without this row nothing holds it back and the
    // party appears to hold a balance the bank has not yet paid.
    if (rec.method === 'Cheque') {
      var ac = p.cheque || {};
      appendRow('Cheques', {
        id: uid('chq'),
        billId: '',
        partyId: p.partyId,
        paymentId: advPay,
        chequeNo: ac.chequeNo || '',
        bankName: ac.bankName || '',
        accountHolder: ac.accountHolder || '',
        dateIssued: ac.dateIssued || rec.dateReceived,
        dateDue: ac.dateDue || rec.dateReceived,
        status: 'pending',
        amount: rec.amount,
        note: ac.note || '',
        statusChangedAt: ''
      });
    }

    logActivity('advance', rec.id, 'create', 'Advance received ' + rec.amount);
    return rec;
  });
}

/**
 * Remove an advance outright, along with everything it paid for.
 *
 * Three records can exist behind one advance, and leaving any of them would
 * leave the books disagreeing with themselves:
 *
 *   1. the PartyAdvances row — the balance the party is holding with the shop
 *   2. the Payments receipt (isAdvance) — the money arriving at the till
 *   3. any 'Advance' payments already applied to bills out of that balance
 *
 * The third is why this cannot simply drop one row. If part of the advance has
 * been spent on a bill, deleting only the advance would leave that bill still
 * showing as paid by money that no longer exists. Those payments go too, so
 * the bills they settled reopen for their proper amount — which is the honest
 * outcome, even though it changes balances elsewhere.
 *
 * A cheque advance takes its cheque with it, for the same reason deletePayment
 * does: a cheque pointing at a deleted payment is still counted by billDue().
 */
function deleteAdvance(p) {
  return withLock(function () {
    var adv = getById('PartyAdvances', p.id);
    if (!adv) fail('Advance not found');

    var partyId = adv.partyId;
    var amount = r2(adv.amount);
    var applied = r2(adv.applied);

    var payments = readAll('Payments');
    var cheques = readAll('Cheques');

    // The receipt: the advance arriving. Nothing links the two rows, so they
    // are matched on party and amount, with the day only breaking a tie
    // between several advances of the same size. Comparing the raw date would
    // be wrong — a date survives a round trip through Sheets as a string or a
    // Date object, and the two rows can come back in different shapes.
    var candidates = [];
    for (var i = 0; i < payments.length; i++) {
      var pay = payments[i];
      if (pay.isAdvance && pay.partyId === partyId && r2(pay.amount) === amount) {
        candidates.push(pay);
      }
    }

    var receiptId = null;
    if (candidates.length === 1) {
      receiptId = candidates[0].id;
    } else if (candidates.length > 1) {
      var wantDay = dayOf(adv.dateReceived);
      for (var c = 0; c < candidates.length; c++) {
        if (dayOf(candidates[c].date) === wantDay) { receiptId = candidates[c].id; break; }
      }
      if (!receiptId) receiptId = candidates[0].id;
    }

    // Payments made OUT of this balance. Method 'Advance' is what saveBill
    // writes when a bill consumes advance, so these are the bills to reopen.
    var reopened = [];
    var spent = 0;
    if (applied > 0.004) {
      var budget = applied;
      for (var j = 0; j < payments.length && budget > 0.004; j++) {
        var ap = payments[j];
        if (ap.partyId !== partyId || ap.method !== 'Advance' || ap.reversed) continue;

        var bill = ap.billId ? getById('Bills', ap.billId) : null;
        reopened.push({
          billId: ap.billId,
          billNo: bill ? bill.billNo : '',
          amount: r2(ap.amount)
        });
        spent = r2(spent + r2(ap.amount));
        budget = r2(budget - r2(ap.amount));

        cheques.forEach(function (c) {
          if (c.paymentId === ap.id) deleteRowById('Cheques', c.id);
        });
        deleteRowById('Payments', ap.id);
      }
    }

    if (receiptId) {
      cheques.forEach(function (c) {
        if (c.paymentId === receiptId) deleteRowById('Cheques', c.id);
      });
      deleteRowById('Payments', receiptId);
    }

    deleteRowById('PartyAdvances', p.id);

    var party = getById('Parties', partyId);
    logActivity('advance', p.id, 'delete',
      'Deleted advance of ' + amount + ' for ' +
      (party ? party.name : 'party') +
      (reopened.length
        ? ' — reopened ' + reopened.length + ' bill' + (reopened.length === 1 ? '' : 's')
        : '') +
      (p.reason ? ' — ' + p.reason : ''), adv, null);

    return { ok: true, amount: amount, reopened: reopened, reopenedValue: spent };
  });
}

/* ==========================================================================
   Purchases
   ========================================================================== */

function savePurchase(p) {
  return withLock(function () {
    var rec = {
      id: uid('pur'),
      itemId: p.itemId,
      supplierName: p.supplierName || '',
      qty: Number(p.qty) || 0,
      costPrice: r2(p.costPrice),
      date: p.date || todayISO(),
      note: p.note || '',
      method: p.method || 'Cash'
    };
    appendRow('Purchases', rec);

    // Purchase updates the item's current cost price and last purchase date (FR-37)
    var item = getById('Items', p.itemId);
    if (item) {
      updateRow('Items', item._row, {
        costPrice: rec.costPrice,
        lastPurchaseDate: rec.date
      });
    }

    logActivity('purchase', rec.id, 'create',
      'Purchased ' + rec.qty + ' x ' + (item ? item.name : 'item') + ' @ ' + rec.costPrice);
    return rec;
  });
}

/**
 * The item's most recent purchase that actually brought goods in — the one its
 * current cost price came from. Mirrors latestPurchase() in localAdapter.js.
 */
function latestPurchase(purchases, voided, itemId) {
  var best = null;
  purchases.forEach(function (x) {
    if (x.itemId !== itemId || voided[x.purchaseBillId]) return;
    if (!best || dayOf(x.date) >= dayOf(best.date)) best = x;
  });
  return best;
}

function voidedPurchaseBills() {
  var out = {};
  readAll('PurchaseBills').forEach(function (b) { if (b.status === 'voided') out[b.id] = 1; });
  return out;
}

/**
 * Put an item's cost price back in step with its latest purchase, after that
 * purchase was edited or deleted. With no purchase left the cost is kept.
 */
function refreshItemCost(itemId) {
  var item = getById('Items', itemId);
  if (!item) return;
  var last = latestPurchase(readAll('Purchases'), voidedPurchaseBills(), itemId);
  if (last) {
    updateRow('Items', item._row, { costPrice: r2(last.costPrice), lastPurchaseDate: dayOf(last.date) });
  } else {
    updateRow('Items', item._row, { lastPurchaseDate: '' });
  }
}

/** A purchase bill's total, worked out again from the lines it still has. */
function recomputePurchaseBill(billId) {
  var bill = getById('PurchaseBills', billId);
  if (!bill) return;
  var total = r2(readAll('Purchases')
    .filter(function (x) { return x.purchaseBillId === billId; })
    .reduce(function (s, x) { return s + (Number(x.qty) || 0) * (Number(x.costPrice) || 0); }, 0));
  updateRow('PurchaseBills', bill._row, { totalAmount: total });
}

/**
 * Refuse an edit or delete that would leave goods returned to the supplier
 * which, on paper, were never bought on that bill. `newQty` is what the line
 * holds afterwards under `newItemId` (0 for a delete).
 */
function assertReturnsCovered(billId, line, newItemId, newQty) {
  var returned = 0;
  readAll('SupplierReturns').forEach(function (r) {
    if (r.purchaseBillId === billId && r.itemId === line.itemId) returned += Number(r.qty) || 0;
  });
  if (!returned) return;
  var others = 0;
  readAll('Purchases').forEach(function (x) {
    if (x.purchaseBillId === billId && x.itemId === line.itemId && x.id !== line.id) {
      others += Number(x.qty) || 0;
    }
  });
  var kept = others + (newItemId === line.itemId ? newQty : 0);
  if (kept < returned - 0.0001) {
    fail(returned + ' of this item was already returned to the supplier from this purchase. ' +
         'Delete that return first.');
  }
}

/**
 * Fix a purchase entered wrongly. Mirrors updatePurchase in localAdapter.js.
 * A line of a supplier purchase bill keeps its bill's supplier, date and
 * payment; only what was bought changes, and the bill total is recomputed.
 */
function updatePurchase(p) {
  return withLock(function () {
    var rec = getById('Purchases', p.id);
    if (!rec) fail('Purchase not found');
    var bill = rec.purchaseBillId ? getById('PurchaseBills', rec.purchaseBillId) : null;
    if (bill && bill.status === 'voided') fail('This purchase was cancelled and cannot be edited');

    var itemId = p.itemId || rec.itemId;
    var item = getById('Items', itemId);
    if (!item) fail('Select an item');
    var qty = Number(p.qty);
    if (!(qty > 0)) fail('Quantity must be greater than zero');
    var cost = Number(p.costPrice);
    if (!(cost >= 0)) fail('Cost price must be zero or more');
    if (bill) assertReturnsCovered(bill.id, rec, itemId, qty);

    var latest = latestPurchase(readAll('Purchases'), voidedPurchaseBills(), rec.itemId);
    var wasLatest = Boolean(latest && latest.id === rec.id);

    // A line that had fully arrived stays fully arrived at its new quantity;
    // a part-received one keeps what came, up to the new quantity.
    var givenReceived = givenQty(p.receivedQty);
    var hadAll = lineReceivedQty(rec) >= (Number(rec.qty) || 0) - 0.0001;
    var received = givenReceived !== null ? givenReceived
      : hadAll ? qty : Math.min(qty, lineReceivedQty(rec));
    if (received < 0 || received > qty + 0.0001) {
      fail('Received quantity must be between 0 and ' + qty);
    }

    var patch = { itemId: itemId, qty: qty, costPrice: r2(cost), receivedQty: r2(received) };
    if (p.note !== undefined) patch.note = p.note || '';
    if (!bill) {
      if (p.supplierName !== undefined) patch.supplierName = p.supplierName || '';
      if (p.date) patch.date = p.date;
      if (p.method) patch.method = p.method;
    }
    updateRow('Purchases', rec._row, patch);
    if (bill) recomputePurchaseBill(bill.id);

    if (wasLatest) refreshItemCost(rec.itemId);
    var nowLatest = latestPurchase(readAll('Purchases'), voidedPurchaseBills(), itemId);
    if (nowLatest && nowLatest.id === rec.id) refreshItemCost(itemId);

    logActivity('purchase', rec.id, 'edit',
      'Edited purchase: ' + qty + ' x ' + item.name + ' @ ' + r2(cost) +
      (bill ? ' (' + bill.purchaseNo + ')' : ''), rec, patch);
    return getById('Purchases', p.id);
  });
}

/**
 * Remove a purchase outright. The last line of a purchase bill takes the bill
 * with it; any payment made against that bill stays, on account.
 */
function deletePurchase(p) {
  return withLock(function () {
    var rec = getById('Purchases', p.id);
    if (!rec) fail('Purchase not found');
    var bill = rec.purchaseBillId ? getById('PurchaseBills', rec.purchaseBillId) : null;
    if (bill) assertReturnsCovered(bill.id, rec, rec.itemId, 0);

    var latest = latestPurchase(readAll('Purchases'), voidedPurchaseBills(), rec.itemId);
    var wasLatest = Boolean(latest && latest.id === rec.id);

    deleteRowById('Purchases', p.id);

    var billRemoved = false;
    if (bill) {
      var rest = readAll('Purchases').filter(function (x) { return x.purchaseBillId === bill.id; });
      if (rest.length) {
        recomputePurchaseBill(bill.id);
      } else {
        readAll('SupplierPayments').forEach(function (sp) {
          if (sp.purchaseBillId === bill.id) {
            updateRow('SupplierPayments', findRow('SupplierPayments', sp.id), { purchaseBillId: '' });
          }
        });
        deleteRowById('PurchaseBills', bill.id);
        billRemoved = true;
      }
    }
    if (wasLatest) refreshItemCost(rec.itemId);

    var item = getById('Items', rec.itemId);
    logActivity('purchase', rec.id, 'delete',
      'Deleted purchase: ' + rec.qty + ' x ' + (item ? item.name : 'item') + ' @ ' + rec.costPrice +
      (bill ? (billRemoved ? ' — purchase ' + bill.purchaseNo + ' removed' : ' from ' + bill.purchaseNo) : '') +
      (p.reason ? ' — ' + p.reason : ''), rec, null);
    return { ok: true, billRemoved: billRemoved };
  });
}

/* ==========================================================================
   Suppliers — the buying side (mirrors src/lib/localAdapter.js)
   ========================================================================== */

/** Next PUR-YYYY-NNNN number, from the highest already used that year. */
function nextPurchaseNo(date) {
  var year = String(date || todayISO()).slice(0, 4);
  var max = 0;
  readAll('PurchaseBills').forEach(function (b) {
    var m = /^PUR-(\d{4})-(\d+)$/.exec(String(b.purchaseNo || ''));
    if (m && m[1] === year) max = Math.max(max, Number(m[2]));
  });
  var n = String(max + 1);
  while (n.length < 4) n = '0' + n;
  return 'PUR-' + year + '-' + n;
}

function saveSupplier(p) {
  return withLock(function () {
    if (!String(p.name || '').trim()) fail('Supplier name is required');
    var want = nameKey(p.name);
    var all = readAll('Suppliers');
    for (var i = 0; i < all.length; i++) {
      if (String(all[i].id) !== String(p.id) && nameKey(all[i].name) === want) {
        fail('A supplier called "' + all[i].name + '" already exists. ' +
             'Use a different name, or open the existing one.');
      }
    }
    var fields = {
      name: String(p.name).trim(),
      phone: p.phone || '',
      address: p.address || '',
      openingBalance: r2(p.openingBalance)
    };
    if (p.id) {
      var existing = getById('Suppliers', p.id);
      if (!existing) fail('Supplier not found');
      // A supplier who is also a party is one business: keep the party's name,
      // phone and address the same, with saveParty's rules, checked first.
      var linkedParty = existing.partyId ? getById('Parties', existing.partyId) : null;
      if (linkedParty) {
        var allParties = readAll('Parties');
        var wantPh = phoneKey(fields.phone);
        for (var lp = 0; lp < allParties.length; lp++) {
          if (String(allParties[lp].id) === String(linkedParty.id)) continue;
          if (nameKey(allParties[lp].name) === want) {
            fail('A party called "' + allParties[lp].name + '" already exists, and this supplier\'s ' +
                 'customer side must carry the same name.');
          }
          if (wantPh && phoneKey(allParties[lp].phone) === wantPh) {
            fail('This mobile number is already registered on party "' + allParties[lp].name + '".');
          }
        }
        updateRow('Parties', linkedParty._row,
          { name: fields.name, phone: fields.phone, address: fields.address });
      }
      updateRow('Suppliers', existing._row, fields);
      logActivity('supplier', p.id, 'edit', 'Edited supplier "' + fields.name + '"', existing, fields);
      return getById('Suppliers', p.id);
    }
    var rec = {
      id: uid('sup'), name: fields.name, phone: fields.phone, address: fields.address,
      openingBalance: fields.openingBalance, status: 'active', createdAt: nowISO()
    };
    appendRow('Suppliers', rec);
    logActivity('supplier', rec.id, 'create', 'Added supplier "' + rec.name + '"');
    return rec;
  });
}

/**
 * A party who also sells to the shop. Their buying side is an ordinary
 * supplier row carrying the party's id, created on first use. A supplier
 * already kept under the same name is linked rather than duplicated. Mirrors
 * linkPartySupplier in src/lib/localAdapter.js.
 */
function linkPartySupplier(p) {
  return withLock(function () {
    var party = getById('Parties', p.partyId);
    if (!party) fail('Party not found');

    var all = readAll('Suppliers');

    // A named supplier, linked by hand from its own page: the names need not
    // match. One party, one supplier side, so neither may already be taken.
    if (p.supplierId) {
      var sup = getById('Suppliers', p.supplierId);
      if (!sup) fail('Supplier not found');
      for (var k = 0; k < all.length; k++) {
        if (String(all[k].partyId) === String(party.id) && all[k].id !== sup.id) {
          fail('"' + party.name + '" is already linked to supplier "' + all[k].name + '".');
        }
      }
      if (sup.partyId && String(sup.partyId) !== String(party.id)) {
        fail('Supplier "' + sup.name + '" is already linked to another party.');
      }
      if (String(sup.partyId) !== String(party.id)) {
        updateRow('Suppliers', sup._row, { partyId: party.id });
        logActivity('supplier', sup.id, 'edit',
          'Linked supplier "' + sup.name + '" to party "' + party.name + '"');
      }
      var done = getById('Suppliers', sup.id);
      delete done._row;
      return done;
    }

    for (var i = 0; i < all.length; i++) {
      if (String(all[i].partyId) === String(party.id)) {
        var linked = getById('Suppliers', all[i].id);
        if (linked.status === 'archived') {
          updateRow('Suppliers', linked._row, { status: 'active' });
          linked.status = 'active';
        }
        delete linked._row;
        return linked;
      }
    }

    var want = nameKey(party.name);
    for (var j = 0; j < all.length; j++) {
      if (nameKey(all[j].name) !== want) continue;
      if (all[j].partyId) fail('Supplier "' + all[j].name + '" is already linked to another party.');
      var same = getById('Suppliers', all[j].id);
      updateRow('Suppliers', same._row, { partyId: party.id, status: 'active' });
      logActivity('supplier', same.id, 'edit',
        'Linked supplier "' + same.name + '" to party "' + party.name + '"');
      var out = getById('Suppliers', same.id);
      delete out._row;
      return out;
    }

    var rec = {
      id: uid('sup'), name: party.name, phone: party.phone || '', address: party.address || '',
      openingBalance: 0, status: 'active', createdAt: nowISO(), partyId: party.id
    };
    appendRow('Suppliers', rec);
    logActivity('supplier', rec.id, 'create', 'Party "' + party.name + '" set up as a supplier');
    return rec;
  });
}

/** What the shop owes one supplier, as supplierBalance() in calc.js works it out. */
function supplierOwed(supplierId) {
  var sup = getById('Suppliers', supplierId);
  var total = Number(sup && sup.openingBalance) || 0;
  readAll('PurchaseBills').forEach(function (b) {
    if (b.supplierId === supplierId && b.status !== 'voided') total += Number(b.totalAmount) || 0;
  });
  readAll('SupplierPayments').forEach(function (x) {
    if (x.supplierId === supplierId) total -= Number(x.amount) || 0;
  });
  readAll('SupplierReturns').forEach(function (x) {
    if (x.supplierId === supplierId) total -= Number(x.value) || 0;
  });
  return r2(total);
}

/**
 * Settle what a party owes on sales against what the shop owes them on
 * purchases. No cash moves: the sale bills are paid oldest first with a
 * 'Set-off' payment, and the same amount is paid to their supplier side, so
 * both halves of the khata go down together and the net is unchanged.
 */
function setOffParty(p) {
  return withLock(function () {
    var party = getById('Parties', p.partyId);
    if (!party) fail('Party not found');
    var sup = null;
    readAll('Suppliers').forEach(function (s) {
      if (!sup && String(s.partyId) === String(party.id)) sup = s;
    });
    if (!sup) fail('Nothing has been bought from this party yet');

    var amount = r2(p.amount);
    if (!(amount > 0)) fail('Enter an amount to set off');

    var mine = readAll('Bills')
      .filter(function (b) { return b.partyId === party.id && b.status !== 'voided'; })
      .sort(function (a, b) {
        return String(a.date).localeCompare(String(b.date)) ||
               String(a.billNo).localeCompare(String(b.billNo));
      });
    var dues = mine.map(function (b) { return [b, billDue(b.id)]; });
    var receivable = r2(dues.reduce(function (s, x) { return s + x[1]; }, 0));
    var payable = supplierOwed(sup.id);

    if (amount > receivable + 0.004) {
      fail('Set-off cannot be more than ' + party.name + ' owes on sales (' + receivable.toFixed(2) + ').');
    }
    if (amount > payable + 0.004) {
      fail('Set-off cannot be more than you owe ' + party.name + ' on purchases (' +
           Math.max(0, payable).toFixed(2) + ').');
    }

    var date = p.date || todayISO();
    var note = p.note || 'Set off against purchases';
    var remaining = amount;
    var applied = [];
    for (var i = 0; i < dues.length && remaining > 0.004; i++) {
      if (dues[i][1] <= 0.004) continue;
      var use = r2(Math.min(dues[i][1], remaining));
      appendRow('Payments', {
        id: uid('pay'), billId: dues[i][0].id, partyId: party.id,
        method: 'Set-off', amount: use, date: date, note: note,
        reversed: false, reversedAt: '', reverseReason: '', isAdvance: false
      });
      applied.push({ billId: dues[i][0].id, billNo: dues[i][0].billNo, amount: use });
      remaining = r2(remaining - use);
    }

    appendRow('SupplierPayments', {
      id: uid('spy'), supplierId: sup.id, purchaseBillId: '',
      method: 'Set-off', amount: amount, date: date, note: note, isAdvance: false
    });

    logActivity('payment', party.id, 'create',
      'Set off ' + amount + ' between sales and purchases of "' + party.name + '"');
    return { applied: applied, amount: amount };
  });
}

function savePurchaseBill(p) {
  return withLock(function () {
    var supplier = getById('Suppliers', p.supplierId);
    if (!supplier) fail('Select a supplier');
    var lines = p.lines || [];
    if (!lines.length) fail('Add at least one item');

    var itemById = {};
    readAll('Items').forEach(function (it) { itemById[it.id] = it; });
    lines.forEach(function (l, i) {
      if (!itemById[l.itemId]) fail('Line ' + (i + 1) + ': item not found');
      if (!(Number(l.qty) > 0)) fail('Line ' + (i + 1) + ': quantity must be greater than zero');
      if (!(Number(l.costPrice) >= 0)) fail('Line ' + (i + 1) + ': price must be zero or more');
    });

    var total = r2(lines.reduce(function (s, l) {
      return s + Number(l.qty) * Number(l.costPrice);
    }, 0));
    var paidNow = r2(p.paidNow);
    if (paidNow < 0) fail('Amount paid cannot be negative');
    if (paidNow > total + 0.004) {
      fail('Amount paid (' + paidNow + ') is more than the bill total (' + total + '). ' +
           'Record the extra as a separate payment to the supplier.');
    }

    var date = p.date || todayISO();
    var bill = {
      id: uid('pbl'), purchaseNo: nextPurchaseNo(date), supplierId: supplier.id,
      invoiceNo: String(p.invoiceNo || '').trim(), date: date, totalAmount: total,
      note: p.note || '', status: 'active', createdAt: nowISO(), voidReason: '', voidedAt: ''
    };
    appendRow('PurchaseBills', bill);

    // Validated before anything is written, so a bad line leaves no half bill.
    var receivedOf = lines.map(function (l) {
      var qty = Number(l.qty);
      var given = givenQty(l.receivedQty);
      var received = given !== null ? given : (p.received === false ? 0 : qty);
      if (received < 0 || received > qty + 0.0001) {
        fail('Received quantity must be between 0 and ' + qty);
      }
      return r2(received);
    });

    lines.forEach(function (l, i) {
      var cost = r2(l.costPrice);
      appendRow('Purchases', {
        id: uid('pur'), itemId: l.itemId, supplierName: supplier.name,
        qty: Number(l.qty), costPrice: cost, date: date, note: '',
        method: '', supplierId: supplier.id, purchaseBillId: bill.id,
        receivedQty: receivedOf[i]
      });
      var item = getById('Items', l.itemId);
      if (item) updateRow('Items', item._row, { costPrice: cost, lastPurchaseDate: date });
    });

    if (paidNow > 0) {
      appendRow('SupplierPayments', {
        id: uid('spy'), supplierId: supplier.id, purchaseBillId: bill.id,
        method: p.method || 'Cash', amount: paidNow, date: date, note: 'Paid at purchase'
      });
    }

    logActivity('purchaseBill', bill.id, 'create',
      'Purchase ' + bill.purchaseNo + ' from ' + supplier.name + ' — ' + total +
      (paidNow > 0 ? ', paid ' + paidNow + ' (' + (p.method || 'Cash') + ')' : ''));
    return bill;
  });
}

/**
 * Move standalone purchase rows (the Purchases page, supplier typed as text) into the
 * Suppliers module. Mirrors the 'adoptPurchases' case in src/lib/localAdapter.js.
 *
 * The SAME rows keep counting toward stock, so stock does not change; they are gathered
 * into one purchase bill, optionally with extra lines, and recorded as paid (method
 * 'Old Data' by default, so no cash or bank balance moves). The Purchases tab is read
 * once and the changed columns written back once, so a few hundred rows is one request.
 */
function adoptPurchases(p) {
  return withLock(function () {
    var supplier = getById('Suppliers', p.supplierId);
    if (!supplier) fail('Select a supplier');
    var want = {};
    (p.purchaseIds || []).forEach(function (id) { want[String(id)] = 1; });
    var extra = p.newLines || [];

    var itemById = {};
    readAll('Items').forEach(function (it) { itemById[it.id] = it; });
    extra.forEach(function (l, i) {
      if (!itemById[l.itemId]) fail('Line ' + (i + 1) + ': item not found');
      if (!(Number(l.qty) > 0)) fail('Line ' + (i + 1) + ': quantity must be greater than zero');
      if (!(Number(l.costPrice) >= 0)) fail('Line ' + (i + 1) + ': price must be zero or more');
    });

    var s = sheet('Purchases');
    var last = s.getLastRow();
    var cols = SCHEMA.Purchases;
    var ci = {};
    cols.forEach(function (k, i) { ci[k] = i; });
    var range = last >= 2 ? s.getRange(2, 1, last - 1, cols.length) : null;
    var vals = range ? range.getValues() : [];

    var hit = [];
    for (var i = 0; i < vals.length; i++) {
      if (want[String(vals[i][ci.id])] && !vals[i][ci.purchaseBillId]) hit.push(i);
    }
    if (!hit.length && !extra.length) fail('Nothing to move');

    var total = 0;
    var days = [];
    hit.forEach(function (i) {
      total += (Number(vals[i][ci.qty]) || 0) * (Number(vals[i][ci.costPrice]) || 0);
      var dd = dayOf(vals[i][ci.date]);
      if (dd) days.push(dd);
    });
    extra.forEach(function (l) { total += Number(l.qty) * Number(l.costPrice); });
    total = r2(total);
    days.sort();
    var date = p.date || days[0] || todayISO();

    var bill = {
      id: uid('pbl'), purchaseNo: nextPurchaseNo(date), supplierId: supplier.id,
      invoiceNo: '', date: date, totalAmount: total, note: p.note || '',
      status: 'active', createdAt: nowISO(), voidReason: '', voidedAt: ''
    };
    appendRow('PurchaseBills', bill);

    hit.forEach(function (i) {
      vals[i][ci.supplierId] = supplier.id;
      vals[i][ci.purchaseBillId] = bill.id;
      vals[i][ci.supplierName] = supplier.name;
      vals[i][ci.method] = '';
    });
    if (hit.length) range.setValues(vals);

    extra.forEach(function (l) {
      appendRow('Purchases', {
        id: uid('pur'), itemId: l.itemId, supplierName: supplier.name,
        qty: Number(l.qty), costPrice: r2(l.costPrice), date: date, note: '', method: '',
        supplierId: supplier.id, purchaseBillId: bill.id, receivedQty: r2(l.qty)
      });
    });

    if (total > 0) {
      appendRow('SupplierPayments', {
        id: uid('spy'), supplierId: supplier.id, purchaseBillId: bill.id,
        method: p.method || 'Old Data', amount: total, date: date,
        note: p.payNote || 'Paid - recorded before the Suppliers module', isAdvance: false
      });
    }
    logActivity('purchaseBill', bill.id, 'create',
      'Purchase ' + bill.purchaseNo + ' from ' + supplier.name + ' - ' + total +
      ' (' + hit.length + ' existing purchase rows moved in, ' + extra.length + ' added)');
    return bill;
  });
}

function voidPurchaseBill(p) {
  return withLock(function () {
    var bill = getById('PurchaseBills', p.id);
    if (!bill) fail('Purchase bill not found');
    if (bill.status === 'voided') fail('This purchase is already cancelled');
    var hasReturns = readAll('SupplierReturns').some(function (r) { return r.purchaseBillId === p.id; });
    if (hasReturns) {
      fail('Goods from this purchase were returned to the supplier. ' +
           'Delete those returns first, then cancel the purchase.');
    }
    var patch = { status: 'voided', voidReason: p.reason || '', voidedAt: nowISO() };
    updateRow('PurchaseBills', bill._row, patch);
    logActivity('purchaseBill', p.id, 'void',
      'Cancelled purchase ' + bill.purchaseNo + (p.reason ? ' — ' + p.reason : ''), bill, patch);
    return getById('PurchaseBills', p.id);
  });
}

function addSupplierPayment(p) {
  return withLock(function () {
    var supplier = getById('Suppliers', p.supplierId);
    if (!supplier) fail('Select a supplier');
    var amount = r2(p.amount);
    if (!(amount > 0)) fail('Enter a payment amount');
    if (!p.isAdvance && p.purchaseBillId) {
      var bill = getById('PurchaseBills', p.purchaseBillId);
      if (!bill || bill.supplierId !== p.supplierId) fail('Purchase bill not found for this supplier');
    }
    // An advance is money handed over before goods arrive, so it never
    // belongs to one purchase bill.
    var isAdvance = Boolean(p.isAdvance);
    var rec = {
      id: uid('spy'), supplierId: p.supplierId,
      purchaseBillId: isAdvance ? '' : (p.purchaseBillId || ''),
      method: p.method || 'Cash', amount: amount, date: p.date || todayISO(), note: p.note || '',
      isAdvance: isAdvance
    };
    appendRow('SupplierPayments', rec);
    logActivity('supplierPayment', rec.id, 'create',
      (isAdvance ? 'Advance ' : 'Paid ') + amount + ' to ' + supplier.name + ' — ' + rec.method);
    return rec;
  });
}

function deleteSupplierPayment(p) {
  return withLock(function () {
    var pay = getById('SupplierPayments', p.id);
    if (!pay) fail('Payment not found');
    deleteRowById('SupplierPayments', p.id);
    logActivity('supplierPayment', p.id, 'delete',
      'Deleted payment of ' + pay.amount + ' (' + pay.method + ') to supplier' +
      (p.reason ? ' — ' + p.reason : ''), pay, null);
    return { ok: true };
  });
}

function addSupplierReturn(p) {
  return withLock(function () {
    if (!getById('Suppliers', p.supplierId)) fail('Select a supplier');
    var item = getById('Items', p.itemId);
    if (!item) fail('Select an item');
    var qty = Number(p.qty);
    if (!(qty > 0)) fail('Return quantity must be greater than zero');
    var value = r2(p.value);
    if (value < 0) fail('Return value cannot be negative');

    if (p.purchaseBillId) {
      var bill = getById('PurchaseBills', p.purchaseBillId);
      if (!bill || bill.supplierId !== p.supplierId) fail('Purchase bill not found for this supplier');
      if (bill.status === 'voided') fail('That purchase was cancelled');
      var bought = 0;
      readAll('Purchases').forEach(function (x) {
        if (x.purchaseBillId === bill.id && x.itemId === p.itemId) bought += Number(x.qty) || 0;
      });
      if (!bought) fail('That item is not on this purchase bill');
      var already = 0;
      readAll('SupplierReturns').forEach(function (x) {
        if (x.purchaseBillId === bill.id && x.itemId === p.itemId) already += Number(x.qty) || 0;
      });
      if (qty > r2(bought - already) + 0.0001) {
        fail('Only ' + r2(bought - already) + ' of that item is left to return (' +
             bought + ' bought, ' + already + ' already returned).');
      }
    }

    var rec = {
      id: uid('srt'), supplierId: p.supplierId, purchaseBillId: p.purchaseBillId || '',
      itemId: p.itemId, qty: qty, value: value, date: p.date || todayISO(), note: p.note || ''
    };
    appendRow('SupplierReturns', rec);
    logActivity('supplierReturn', rec.id, 'create',
      'Returned ' + qty + ' x ' + item.name + ' to supplier — value ' + value);
    return rec;
  });
}

function deleteSupplierReturn(p) {
  return withLock(function () {
    var ret = getById('SupplierReturns', p.id);
    if (!ret) fail('Return not found');
    deleteRowById('SupplierReturns', p.id);
    logActivity('supplierReturn', p.id, 'delete',
      'Deleted return to supplier (value ' + ret.value + ')', ret, null);
    return { ok: true };
  });
}

/* ==========================================================================
   Employees
   ========================================================================== */

function saveEmployee(p) {
  return withLock(function () {
    if (!String(p.name || '').trim()) fail('Employee name is required');

    if (p.id) {
      var existing = getById('Employees', p.id);
      if (!existing) fail('Employee not found');
      var patch = {
        name: String(p.name).trim(),
        phone: p.phone || '',
        role: p.role || '',
        monthlySalary: r2(p.monthlySalary),
        joinDate: p.joinDate || existing.joinDate
      };
      updateRow('Employees', existing._row, patch);
      logActivity('employee', p.id, 'edit', 'Edited employee "' + patch.name + '"', existing, patch);
      return getById('Employees', p.id);
    }

    var rec = {
      id: uid('emp'),
      name: String(p.name).trim(),
      phone: p.phone || '',
      role: p.role || '',
      monthlySalary: r2(p.monthlySalary),
      joinDate: p.joinDate || todayISO(),
      status: 'active'
    };
    appendRow('Employees', rec);
    logActivity('employee', rec.id, 'create', 'Added employee "' + rec.name + '"');
    return rec;
  });
}

function addEmployeeTx(p) {
  return withLock(function () {
    if (!(Number(p.amount) > 0)) fail('Enter an amount');
    if (!getById('Employees', p.employeeId)) fail('Employee not found');

    var rec = {
      id: uid('etx'),
      employeeId: p.employeeId,
      type: p.type || 'salary',
      amount: r2(p.amount),
      date: p.date || todayISO(),
      note: p.note || '',
      method: p.method || 'Cash'
    };
    appendRow('EmployeeTransactions', rec);

    var emp = getById('Employees', p.employeeId);
    logActivity('employeeTx', rec.id, 'create',
      rec.type + ' ' + rec.amount + ' to ' + (emp ? emp.name : 'employee'));
    return rec;
  });
}

/* ==========================================================================
   Expenses / stock loss / assets
   ========================================================================== */

function saveExpense(p) {
  return withLock(function () {
    if (!(Number(p.amount) > 0)) fail('Enter an expense amount greater than zero');
    var rec = {
      id: uid('exp'),
      category: p.category || 'Miscellaneous',
      amount: r2(p.amount),
      date: p.date || todayISO(),
      note: p.note || '',
      method: p.method || 'Cash',
      linkedStockLossId: p.linkedStockLossId || ''
    };
    appendRow('Expenses', rec);
    logActivity('expense', rec.id, 'create', 'Expense ' + rec.category + ' — ' + rec.amount);
    return rec;
  });
}

/** Stock loss also creates its linked expense — one entry, correct accounting (FR-36). */
function saveStockLoss(p) {
  return withLock(function () {
    var item = getById('Items', p.itemId);
    if (!item) fail('Select an item');
    if (!(Number(p.qty) > 0)) fail('Quantity must be greater than zero');
    if (Number(p.estimatedValue) < 0) fail('Estimated value cannot be negative');
    var lossId = uid('stl');
    var expId = uid('exp');

    var loss = {
      id: lossId,
      itemId: p.itemId,
      qty: Number(p.qty) || 0,
      reason: p.reason || 'Damaged',
      estimatedValue: r2(p.estimatedValue),
      date: p.date || todayISO(),
      note: p.note || '',
      linkedExpenseId: expId
    };
    appendRow('StockLoss', loss);

    appendRow('Expenses', {
      id: expId,
      category: 'Stock Loss',
      amount: r2(p.estimatedValue),
      date: loss.date,
      note: (item ? item.name : 'Item') + ' x ' + loss.qty + ' — ' + loss.reason,
      method: '',
      linkedStockLossId: lossId
    });

    logActivity('stockLoss', lossId, 'create',
      'Stock loss: ' + loss.qty + ' x ' + (item ? item.name : 'item') + ' (' + loss.reason + ')');
    return loss;
  });
}

function saveAsset(p) {
  return withLock(function () {
    if (!String(p.name || '').trim()) fail('Asset name is required');
    if (!(Number(p.value) >= 0)) fail('Asset value cannot be negative');
    var rec = {
      id: uid('ast'),
      name: String(p.name).trim(),
      value: r2(p.value),
      date: p.date || todayISO(),
      note: p.note || ''
    };
    appendRow('Assets', rec);
    logActivity('asset', rec.id, 'create', 'Asset added "' + rec.name + '"');
    return rec;
  });
}

/* ==========================================================================
   Shared ledger links (FR-20 / FR-21)
   ========================================================================== */

function createShareLink(p) {
  return withLock(function () {
    if (!p.password || String(p.password).length < 6) {
      fail('Set a password of at least 6 characters');
    }
    // One active link per party
    deleteRowsWhere('PartyLedgerLinks', 'partyId', p.partyId);

    var token = uid('shr');
    var salt = uid('slt');
    appendRow('PartyLedgerLinks', {
      partyId: p.partyId,
      token: token,
      passwordHash: saltedHash(p.password, salt),
      salt: salt,
      active: true,
      createdAt: nowISO()
    });
    logActivity('shareLink', token, 'create', 'Shared ledger link created');
    return { token: token };
  });
}

function revokeShareLink(p) {
  return withLock(function () {
    deleteRowsWhere('PartyLedgerLinks', 'partyId', p.partyId);
    logActivity('shareLink', p.partyId, 'void', 'Shared ledger link revoked');
    return { ok: true };
  });
}

/**
 * Bill lines for the public party view, with the item NAME attached.
 * The shared page has no access to the Items table, and a raw id would be
 * meaningless to the party. Only the name is exposed — never cost price or
 * stock levels.
 */
function sharedBillItems(billIds) {
  var items = readAll('Items');
  var nameById = {};
  items.forEach(function (i) { nameById[i.id] = i.name; });

  return readAll('BillItems')
    .filter(function (x) { return billIds[x.billId]; })
    .map(function (bi) {
      return {
        id: bi.id, billId: bi.billId, itemId: bi.itemId,
        qty: bi.qty, unit: bi.unit, price: bi.price,
        itemName: nameById[bi.itemId] || 'Item'
      };
    });
}

/** Read-only payload for the public party view — that party's data only. */
function openSharedLedger(p) {
  // Throttled on the token, so a share password is no easier to guess than
  // the main login.
  assertNotLocked('share:' + p.token);

  var links = readAll('PartyLedgerLinks');
  var link = null;
  for (var i = 0; i < links.length; i++) {
    if (links[i].token === p.token && links[i].active) { link = links[i]; break; }
  }
  if (!link) fail('This link is no longer valid');
  if (!sharePasswordMatches(link, p.password)) {
    recordFailure('share:' + p.token);
    fail('Incorrect password');
  }
  clearFailures('share:' + p.token);

  var settings = readSettings();
  var party = getById('Parties', link.partyId);

  var bills = readAll('Bills').filter(function (b) { return b.partyId === link.partyId; });
  var billIds = {};
  bills.forEach(function (b) { billIds[b.id] = 1; });

  return {
    party: { name: party ? party.name : '', phone: party ? party.phone : '' },
    shopName: settings.shopName,
    bills: bills,
    billItems: sharedBillItems(billIds),
    payments: readAll('Payments').filter(function (x) { return x.partyId === link.partyId; }),
    returns: readAll('Returns').filter(function (x) { return billIds[x.billId]; }),
    cheques: readAll('Cheques').filter(function (x) { return x.partyId === link.partyId; }),
    partyAdvances: readAll('PartyAdvances').filter(function (x) { return x.partyId === link.partyId; })
  };
}

/* ==========================================================================
   First-run setup
   ========================================================================== */

/** Create every tab with its header row, and seed the admin account. */
function ensureSeed() {
  for (var name in SCHEMA) sheet(name);

  var users = readAll('Users');
  if (!users.length) {
    appendRow('Users', {
      id: uid('usr'),
      username: 'admin',
      // SHA-256 of "admin123" — change it from Settings after first login
      passwordHash: '240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9',
      role: 'admin',
      fullName: 'Super Admin',
      status: 'active',
      allowedPages: '[]',
      createdAt: nowISO()
    });
  }

  var settingsRows = readAll('Settings');
  if (!settingsRows.length) {
    var s = sheet('Settings');
    for (var k in SETTINGS_DEFAULTS) {
      var v = SETTINGS_DEFAULTS[k];
      s.appendRow([k, k === 'customMethods' ? JSON.stringify(v) : v]);
    }
  }
}

/**
 * Run this ONCE from the Apps Script editor after creating the project.
 * It builds every tab and seeds the admin login.
 *
 * SpreadsheetApp.getUi() only works when the script runs with the spreadsheet
 * open in front of you. Run it from the editor's Run button, from a trigger,
 * or from a standalone project and it throws "Cannot call
 * SpreadsheetApp.getUi() from this context". Setup itself has nothing to do
 * with dialogs, so the alert is best-effort: the result always goes to the
 * execution log, which is visible in every context.
 */
function setup() {
  ensureSeed();
  PropertiesService.getScriptProperties().setProperty('seeded', 'yes');

  var message =
    'Setup complete.\n\n' +
    'All sheet tabs created.\n' +
    'Login: admin / admin123\n\n' +
    'Change the password from Settings after your first login.';

  Logger.log(message);

  // Show a dialog only if this context actually has a UI.
  try {
    SpreadsheetApp.getUi().alert(message);
  } catch (e) {
    // No UI here (editor Run button, trigger, or standalone project).
    // The log above is the result; nothing has failed.
  }

  return message;
}

/**
 * Verify the backend is wired up correctly. Run this from the editor and read
 * the execution log. It reports what it actually found rather than assuming.
 */
function healthCheck() {
  var book = null;
  try { book = ss(); } catch (e) {}

  if (!book) {
    Logger.log(
      'FAIL: this script is not bound to a spreadsheet.\n' +
      'SpreadsheetApp.getActiveSpreadsheet() returned nothing, so no data can\n' +
      'be read or written. Fix: open your Google Sheet, choose\n' +
      'Extensions > Apps Script, and paste this code into THAT project.\n' +
      'A standalone Apps Script project cannot work here.'
    );
    return;
  }

  var lines = [];
  lines.push('Spreadsheet: ' + book.getName());

  var missing = [];
  for (var name in SCHEMA) {
    if (!book.getSheetByName(name)) missing.push(name);
  }
  lines.push(missing.length
    ? 'Missing tabs: ' + missing.join(', ') + '  -> run setup()'
    : 'All ' + Object.keys(SCHEMA).length + ' tabs present.');

  var users = readAll('Users');
  lines.push('Admin account: ' +
    (users.length ? 'yes (' + users[0].username + ')' : 'MISSING -> run setup()'));

  var st = readSettings();
  lines.push('shopName reads back as: ' + JSON.stringify(st.shopName));
  lines.push('roundingRule reads back as: ' + JSON.stringify(st.roundingRule));

  if (st.shopName === null || typeof st.shopName === 'number') {
    lines.push('');
    lines.push('WARNING: settings are being corrupted on read. This deployment is');
    lines.push('running an OLD version of Code.gs. Paste the latest file and use');
    lines.push('Deploy > Manage deployments > edit > New version > Deploy.');
  }

  lines.push('Parties: ' + readAll('Parties').length +
             ', Items: ' + readAll('Items').length +
             ', Bills: ' + readAll('Bills').length);

  Logger.log(lines.join('\n'));
  return lines.join('\n');
}

/* ==========================================================================
   Optional nightly backup (Safety Guide 2.4)
   Create a time-driven trigger for this function to auto-copy the spreadsheet
   to a dated file in Drive every night.
   ========================================================================== */

function nightlyBackup() {
  var file = DriveApp.getFileById(ss().getId());
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var folderName = 'EWD Dashboard Backups';

  var folders = DriveApp.getFoldersByName(folderName);
  var folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(folderName);

  file.makeCopy('EWD Backup ' + stamp, folder);

  // Keep the most recent 30 copies
  var files = folder.getFiles();
  var list = [];
  while (files.hasNext()) {
    var f = files.next();
    list.push({ file: f, date: f.getDateCreated() });
  }
  list.sort(function (a, b) { return b.date - a.date; });
  for (var i = 30; i < list.length; i++) list[i].file.setTrashed(true);
}
