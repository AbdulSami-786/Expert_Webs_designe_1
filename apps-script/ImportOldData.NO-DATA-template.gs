/**
 * !!! IF YOU CAN READ "NO-DATA-template" IN THIS FILE'S NAME, DO NOT PASTE IT INTO APPS SCRIPT. !!!
 * It has no shop data in it, so it cannot add anything. The file to paste is
 *   old data/ImportOldData.gs      (same code, with your data inside)
 * ============================================================================
 * Expert Webs Designs — one-time import of the old Excel records (8 NOV)
 * ============================================================================
 *
 * Run from the Apps Script editor (no web-app redeploy needed). It puts into the Sheet:
 *   - every supplier, with its purchase bill (the items bought, quantity and cost),
 *   - what was already sold from each supplier (as "Old Data Sales" bills),
 *   - what was paid (only for a supplier that has no purchases in the software yet),
 *   - shop expenses, salaries and assets.
 *
 * It works with what the Sheet ALREADY holds, so nothing is counted twice:
 *   - Purchases already on the Purchases tab (supplier typed as text) are MOVED into the supplier's
 *     purchase bill — the same rows, so stock does not change. The supplier names you typed are kept.
 *   - Only what the sheet says was bought beyond those rows is added.
 *   - Existing items are reused by name; missing ones are created.
 *   - Money is recorded under the method "Old Data", so Cash / Bank balances do not change.
 *
 * Safe to run again: suppliers, items and the customer are reused by name, and each bill, payment
 * and record is created only if it is not there yet. If the run is cut short by Apps Script's
 * 6-minute limit it says so — just run importOldData again to carry on.
 *
 * HOW TO RUN
 *   1. Open the Google Sheet -> Extensions -> Apps Script.
 *   2. Make sure Code.gs there is the latest apps-script/Code.gs from the project (it must contain
 *      the function adoptPurchases). Paste this whole file in as a NEW file (+ next to Files), save.
 *   3. Pick  previewOldData  in the function list and press Run — read the execution log (what it
 *      WOULD do; nothing is written). The first run asks you to allow access: allow it.
 *   4. Pick  importOldData  and press Run. Read the execution log when it finishes.
 *   5. Pick  checkOldData  and press Run: every supplier should say OK.
 *   6. Open the software and press refresh.
 *
 * This file holds the shop's private data. Keep it out of GitHub (it lives in the "old data" folder).
 * ============================================================================
 */

var OLD = /*__OLD_DATA__*/null;

var NO_DATA_MSG = 'STOPPED: this copy of the script has NO shop data inside it (it is the empty template). ' +
  'Delete it and paste the file  old data/ImportOldData.gs  instead, then run again.';

var IMPORT_TAG = 'Imported from old Excel (8 NOV)';
var IMPORT_METHOD = 'Old Data';
var OLD_SALES_PARTY = 'Old Data Sales';
var IMPORT_BUDGET_MS = 270000;   // stop before the 6-minute limit; running again carries on

/* -------------------------------------------------------------------------- helpers */

function tidy_(s) {
  return String(s === null || s === undefined ? '' : s).replace(/^\s+|\s+$/g, '').replace(/\s+/g, ' ');
}
function key_(s) { return tidy_(s).toLowerCase(); }
function day_(v) { return String(v || '').slice(0, 10); }
function money_(n) { return String(Math.round((Number(n) || 0) * 100) / 100); }

function indexBy_(list, fn) {
  var out = {};
  list.forEach(function (x) { out[fn(x)] = x; });
  return out;
}
function pushTo_(map, k, v) {
  if (!map[k]) map[k] = [];
  map[k].push(v);
}
function setOf_(list, fn) {
  var out = {};
  list.forEach(function (x) { out[fn(x)] = true; });
  return out;
}

/* -------------------------------------------------------------------------- planning (no writes) */

/**
 * Work out what the import would do with the Sheet as it is now.
 * Returns { groups, extras, summary, warnings }.
 */
function planOld_() {
  var items = readAll('Items');
  var suppliers = readAll('Suppliers');
  var purchases = readAll('Purchases');

  var itemByName = indexBy_(items, function (i) { return key_(i.name); });
  var supByName = indexBy_(suppliers, function (s) { return key_(s.name); });

  // Purchases still outside the Suppliers module, by item; and every purchase that names a supplier.
  var standalone = purchases.filter(function (p) { return !p.purchaseBillId && !p.supplierId; });
  var byItem = {};
  standalone.forEach(function (p) { pushTo_(byItem, p.itemId, p); });
  var namedByItem = {};
  purchases.filter(function (p) { return tidy_(p.supplierName); })
    .forEach(function (p) { pushTo_(namedByItem, p.itemId, p); });

  /* 1) one group per supplier, named the way the shop already names them */
  var groups = {};
  var order = [];
  function groupFor(name, seed) {
    seed = seed || {};
    var k = key_(name);
    if (!groups[k]) {
      groups[k] = {
        key: k, name: tidy_(name), existing: supByName[k] || null, address: seed.address || '',
        category: seed.category || '', rows: [], payments: [], adopt: [], date: '',
        newLines: [], sales: [], createItems: []
      };
      order.push(k);
    }
    return groups[k];
  }

  OLD.suppliers.forEach(function (s) {
    var votes = {};
    s.rows.forEach(function (r) {
      var it = itemByName[key_(r.item)];
      (it ? namedByItem[it.id] || [] : []).forEach(function (p) {
        var nm = tidy_(p.supplierName);
        if (nm) votes[nm] = (votes[nm] || 0) + 1;
      });
    });
    var best = s.name;
    var top = 0;
    for (var nm in votes) {
      if (votes[nm] > top) { top = votes[nm]; best = nm; }
    }
    var g = groupFor(best, { address: s.address, category: s.category });
    s.rows.forEach(function (r) {
      g.rows.push({ item: r.item, qty: r.qty, cost: r.cost, sold: r.sold, revenue: r.revenue, category: s.category });
    });
    s.payments.forEach(function (p) { g.payments.push(p); });
    if (!g.date || String(s.purchaseDate) < g.date) g.date = s.purchaseDate;
  });

  /* 2) per group: what to move in, what to add, what was sold */
  var claimed = {};
  var warnings = [];
  var openingItems = 0;

  order.forEach(function (gk) {
    var g = groups[gk];
    var perItem = {};
    var perOrder = [];
    g.rows.forEach(function (r) {
      var k = key_(r.item);
      if (!perItem[k]) { perItem[k] = { name: tidy_(r.item), category: r.category, rows: [] }; perOrder.push(k); }
      perItem[k].rows.push(r);
    });

    perOrder.forEach(function (k) {
      var e = perItem[k];
      var item = itemByName[k];
      if (!item) g.createItems.push({ name: e.name, category: e.category, costPrice: e.rows[e.rows.length - 1].cost });
      else if (Number(item.openingStock) > 0) openingItems += 1;

      var mine = (item ? byItem[item.id] || [] : []).filter(function (p) {
        return key_(p.supplierName || '') === g.key && !claimed[p.id];
      });
      var have = 0;
      mine.forEach(function (p) { claimed[p.id] = true; g.adopt.push(p); have += Number(p.qty) || 0; });
      have = r2(have);

      var bought = 0, spent = 0;
      e.rows.forEach(function (r) { bought += r.qty; spent += r.qty * r.cost; });
      bought = r2(bought);
      var more = r2(Math.max(0, bought - have));
      if (more > 0) g.newLines.push({ itemKey: k, name: e.name, qty: more, costPrice: r2(spent / bought) });
      if (have > bought + 0.0001) {
        warnings.push(e.name + ': the Sheet already has ' + have + ' bought, the Excel says ' + bought);
      }

      e.rows.forEach(function (r) {
        if (r.sold > 0) {
          g.sales.push({ itemKey: k, name: e.name, qty: r.sold, price: r2(r.revenue / r.sold), costPrice: r.cost });
        }
      });
    });
  });

  /* 3) purchases left over (items not in the Excel) go to their own supplier */
  var loose = 0, noSupplier = 0;
  standalone.forEach(function (p) {
    if (claimed[p.id]) return;
    if (!tidy_(p.supplierName)) { noSupplier += 1; return; }
    groupFor(p.supplierName).adopt.push(p);
    loose += 1;
  });

  var list = order.map(function (k) { return groups[k]; }).filter(function (g) {
    return g.adopt.length || g.newLines.length || g.sales.length;
  });
  // A supplier whose existing rows move in is already "paid" through them.
  list.forEach(function (g) { if (g.adopt.length) g.payments = []; });

  var extras = planExtras_();
  var summary = {
    suppliers: list.length,
    newSuppliers: list.filter(function (g) { return !g.existing; }).length,
    moved: list.reduce(function (t, g) { return t + g.adopt.length; }, 0),
    movedLoose: loose,
    added: list.reduce(function (t, g) { return t + g.newLines.length; }, 0),
    newItems: list.reduce(function (t, g) { return t + g.createItems.length; }, 0),
    sales: list.reduce(function (t, g) { return t + g.sales.length; }, 0),
    payments: list.reduce(function (t, g) { return t + g.payments.length; }, 0),
    assets: extras.assets.length, expenses: extras.expenses.length,
    salaries: extras.salaries.length, newEmployees: extras.newEmployees.length,
    noSupplier: noSupplier
  };
  if (openingItems) {
    warnings.push(openingItems + ' item(s) have opening stock typed in, which counts IN ADDITION to the purchases - ' +
      'their stock will read higher than the Excel.');
  }
  if (noSupplier) warnings.push(noSupplier + ' purchase row(s) have no supplier name and stay on the Purchases page.');
  return {
    groups: list, all: order.map(function (k) { return groups[k]; }),
    extras: extras, summary: summary, warnings: warnings
  };
}

/** Shop expenses, salaries and assets the Sheet does not have yet. */
function planExtras_() {
  var ex = OLD.extras || {};
  var haveExp = setOf_(readAll('Expenses'), function (e) { return day_(e.date) + '|' + r2(e.amount); });
  var haveAsset = setOf_(readAll('Assets'), function (a) { return key_(a.name) + '|' + r2(a.value); });
  var emps = readAll('Employees');
  var haveTx = setOf_(readAll('EmployeeTransactions'), function (t) {
    return t.employeeId + '|' + day_(t.date) + '|' + r2(t.amount);
  });

  function empFor(name) {
    var k = key_(name);
    var found = null;
    emps.forEach(function (e) { if (!found && key_(e.name) === k) found = e; });
    emps.forEach(function (e) {
      var ek = key_(e.name);
      if (!found && (ek.indexOf(k) >= 0 || k.indexOf(ek) >= 0)) found = e;
    });
    return found;
  }

  var newEmployees = [];
  var salaries = [];
  (ex.salaries || []).forEach(function (t) {
    var e = empFor(t.employee);
    if (!e && newEmployees.indexOf(t.employee) < 0) newEmployees.push(t.employee);
    if (e && haveTx[e.id + '|' + day_(t.date) + '|' + r2(t.amount)]) return;
    salaries.push({ employee: t.employee, amount: t.amount, date: t.date, note: t.note, employeeId: e ? e.id : '' });
  });
  return {
    assets: (ex.assets || []).filter(function (a) { return !haveAsset[key_(a.name) + '|' + r2(a.value)]; }),
    expenses: (ex.expenses || []).filter(function (x) { return !haveExp[day_(x.date) + '|' + r2(x.amount)]; }),
    salaries: salaries, newEmployees: newEmployees
  };
}

/**
 * What is genuinely still to do: bills the import already made are not counted again.
 * (planOld_ describes the whole Excel; importOldData skips what is already there.)
 */
function remaining_(plan) {
  var supByName = indexBy_(readAll('Suppliers'), function (s) { return key_(s.name); });
  var tagged = setOf_(readAll('PurchaseBills').filter(function (b) { return b.note === IMPORT_TAG; }),
    function (b) { return b.supplierId; });
  var salesDone = setOf_(readAll('Bills').filter(function (b) {
    return String(b.note || '').indexOf(IMPORT_TAG) === 0;
  }), function (b) { return b.note; });
  var r = { moved: 0, added: 0, sales: 0, newSuppliers: 0 };
  plan.groups.forEach(function (g) {
    var sup = supByName[g.key];
    if (!sup) r.newSuppliers += 1;
    r.moved += g.adopt.length;
    if (!(sup && tagged[sup.id])) r.added += g.newLines.length;
    if (g.sales.length && !salesDone[IMPORT_TAG + ' \u2014 ' + g.name]) r.sales += g.sales.length;
  });
  return r;
}

/* -------------------------------------------------------------------------- entry points */

/** Read-only: write to the log what importOldData would do. */
function previewOldData() {
  if (!OLD || !OLD.suppliers) { Logger.log(NO_DATA_MSG); return NO_DATA_MSG; }
  var plan = planOld_();
  var s = plan.summary;
  var todo = remaining_(plan);
  var lines = [];
  lines.push('PREVIEW - nothing is written. (Counts are what is STILL to do; what an earlier run did is not counted.)');
  lines.push(s.suppliers + ' suppliers on the Excel (' + todo.newSuppliers + ' not in the software yet)');
  lines.push(todo.moved + ' existing purchase rows to move into supplier bills (stock unchanged)');
  lines.push(todo.added + ' extra purchase lines to add; ' + s.newItems + ' new items to create');
  lines.push(todo.sales + ' sold lines to add as "' + OLD_SALES_PARTY + '" bills dated ' + OLD.asOf);
  lines.push(s.payments + ' supplier payments from the Excel');
  lines.push(s.expenses + ' shop expenses, ' + s.salaries + ' salary payments (' + s.newEmployees +
    ' new employees), ' + s.assets + ' assets');
  plan.groups.forEach(function (g) {
    lines.push('  - ' + g.name + (g.existing ? '' : ' (new)') + ': move ' + g.adopt.length + ', add ' +
      g.newLines.length + ', sold ' + g.sales.length);
  });
  plan.warnings.forEach(function (w) { lines.push('! ' + w); });
  Logger.log(lines.join('\n'));
  return lines.join('\n');
}

/** Do the import. Safe to run again. */
function importOldData() {
  if (!OLD || !OLD.suppliers) { Logger.log(NO_DATA_MSG); return NO_DATA_MSG; }
  // This file calls functions that live in Code.gs. An old Code.gs has no adoptPurchases, and the
  // import would stop halfway - so say so up front, before anything is written.
  if (typeof adoptPurchases !== 'function') {
    var stop = 'STOPPED BEFORE WRITING ANYTHING: the Code.gs in this Apps Script project is old. ' +
      'Replace ALL of Code.gs with the latest apps-script/Code.gs from the project, save, then run importOldData again.';
    Logger.log(stop);
    return stop;
  }
  var t0 = new Date().getTime();
  function late() { return new Date().getTime() - t0 > IMPORT_BUDGET_MS; }

  var plan = planOld_();
  var settings = readSettings();
  var suppliers = readAll('Suppliers');
  var supByName = indexBy_(suppliers, function (s) { return key_(s.name); });
  var itemByName = indexBy_(readAll('Items'), function (i) { return key_(i.name); });
  var billDone = setOf_(readAll('PurchaseBills').filter(function (b) { return b.note === IMPORT_TAG; }),
    function (b) { return b.supplierId; });
  var payments = readAll('SupplierPayments');
  var payDone = setOf_(payments, function (p) {
    return p.supplierId + '|' + day_(p.date) + '|' + r2(p.amount) + '|' + p.note;
  });
  var movedBefore = {};
  payments.forEach(function (p) {
    if (String(p.note || '').indexOf('Paid - recorded before') === 0) movedBefore[p.supplierId] = true;
  });
  var salesDone = setOf_(readAll('Bills').filter(function (b) {
    return String(b.note || '').indexOf(IMPORT_TAG) === 0;
  }), function (b) { return b.note; });

  var res = {
    suppliers: 0, moved: 0, items: 0, purchases: 0, payments: 0, sales: 0,
    expenses: 0, salaries: 0, assets: 0, employees: 0, skipped: []
  };
  var party = null;
  readAll('Parties').forEach(function (p) { if (!party && key_(p.name) === key_(OLD_SALES_PARTY)) party = p; });

  function ensureItem(name, category, costPrice) {
    var k = key_(name);
    var item = itemByName[k];
    if (!item) {
      item = saveItem({
        name: tidy_(name), baseUnit: 'Piece', category: category || '',
        costPrice: costPrice, openingStock: 0, lowStockAlert: 0
      });
      itemByName[k] = item;
      res.items += 1;
    }
    return item;
  }

  function finish(done) {
    var msg = (done ? 'DONE. ' : 'STOPPED EARLY (Apps Script time limit) - run importOldData again to carry on. ') +
      JSON.stringify(res);
    Logger.log(msg);
    return msg;
  }

  for (var gi = 0; gi < plan.groups.length; gi++) {
    var g = plan.groups[gi];
    if (late()) return finish(false);
    Logger.log('(' + (gi + 1) + '/' + plan.groups.length + ') ' + g.name);

    var sup = supByName[g.key];
    if (!sup) {
      sup = saveSupplier({ name: g.name, address: g.address || '', phone: '', openingBalance: 0 });
      supByName[g.key] = sup;
      res.suppliers += 1;
    }

    var made;
    for (made = 0; made < g.createItems.length; made++) {
      if (late()) return finish(false);
      ensureItem(g.createItems[made].name, g.createItems[made].category, g.createItems[made].costPrice);
    }

    // The Excel's extra lines go in once: a bill already tagged for this supplier means they did.
    var again = !!billDone[sup.id];
    var newLines = [];
    if (!again) {
      g.newLines.forEach(function (l) {
        newLines.push({ itemId: ensureItem(l.name, '', l.costPrice).id, qty: l.qty, costPrice: l.costPrice });
      });
    }
    var date = g.date || (g.adopt[0] ? day_(g.adopt[0].date) : '');

    if (g.adopt.length) {
      adoptPurchases({
        supplierId: sup.id, purchaseIds: g.adopt.map(function (p) { return p.id; }), newLines: newLines,
        note: IMPORT_TAG, method: IMPORT_METHOD, date: date || undefined
      });
      res.moved += g.adopt.length;
      res.purchases += 1;
    } else if (newLines.length) {
      savePurchaseBill({
        supplierId: sup.id, date: g.date, invoiceNo: '', note: IMPORT_TAG,
        lines: newLines, paidNow: 0, received: true
      });
      res.purchases += 1;
    } else if (again) {
      res.skipped.push(g.name);
    }

    // Payments from the Excel: only for a supplier that had nothing in the software.
    if (!movedBefore[sup.id]) {
      for (var pi = 0; pi < g.payments.length; pi++) {
        if (late()) return finish(false);
        var p = g.payments[pi];
        var pd = p.date || g.date;
        if (payDone[sup.id + '|' + day_(pd) + '|' + r2(p.amount) + '|' + p.note]) continue;
        addSupplierPayment({ supplierId: sup.id, amount: p.amount, date: pd, method: IMPORT_METHOD, note: p.note });
        res.payments += 1;
      }
    }

    // What was already sold, as one fully paid old sales bill drawn from this supplier.
    var salesNote = IMPORT_TAG + ' — ' + g.name;
    if (g.sales.length && !salesDone[salesNote]) {
      if (late()) return finish(false);
      if (!party) {
        party = saveParty({ name: OLD_SALES_PARTY, phone: '', address: 'Sales recorded before this software' });
      }
      var lines = g.sales.map(function (x) {
        var item = itemByName[x.itemKey] || ensureItem(x.name, '', x.costPrice);
        return { itemId: item.id, qty: x.qty, unit: 'Piece', price: x.price, costPriceAtSale: x.costPrice, supplierId: sup.id };
      });
      var total = billTotalsFromLines(lines, settings.roundingRule).total;
      saveBill({
        partyId: party.id, date: OLD.asOf, note: salesNote, delivery: 'delivered', lines: lines,
        payments: total > 0 ? [{ method: IMPORT_METHOD, amount: total }] : []
      });
      res.sales += 1;
    }
  }

  /* shop records */
  var ex = plan.extras;
  var i;
  for (i = 0; i < ex.assets.length; i++) {
    if (late()) return finish(false);
    saveAsset({ name: ex.assets[i].name, value: ex.assets[i].value, date: ex.assets[i].date, note: ex.assets[i].note });
    res.assets += 1;
  }
  var empId = {};
  ex.newEmployees.forEach(function (name) {
    if (late()) return;
    var sal = ex.salaries.filter(function (t) { return t.employee === name; });
    var rec = saveEmployee({
      name: name, role: 'Staff', phone: '',
      monthlySalary: sal.length ? sal[sal.length - 1].amount : 0, joinDate: sal.length ? sal[0].date : undefined
    });
    empId[name] = rec.id;
    res.employees += 1;
  });
  for (i = 0; i < ex.salaries.length; i++) {
    if (late()) return finish(false);
    var t = ex.salaries[i];
    var eid = t.employeeId || empId[t.employee];
    if (!eid) continue;
    addEmployeeTx({ employeeId: eid, type: 'salary', amount: t.amount, date: t.date, method: IMPORT_METHOD, note: t.note });
    res.salaries += 1;
  }
  for (i = 0; i < ex.expenses.length; i++) {
    if (late()) return finish(false);
    var x = ex.expenses[i];
    saveExpense({ category: x.category, amount: x.amount, date: x.date, method: IMPORT_METHOD, note: x.note });
    res.expenses += 1;
  }
  return finish(true);
}

/**
 * Read-only: compare the Excel with the Sheet, item by item for every supplier (bought and sold).
 * Every supplier should say OK once importOldData has finished.
 */
function checkOldData() {
  if (!OLD || !OLD.suppliers) { Logger.log(NO_DATA_MSG); return NO_DATA_MSG; }
  var plan = planOld_();
  var supByName = indexBy_(readAll('Suppliers'), function (s) { return key_(s.name); });
  var itemByName = indexBy_(readAll('Items'), function (i) { return key_(i.name); });
  var voidedBill = setOf_(readAll('Bills').filter(function (b) { return b.status === 'voided'; }), function (b) { return b.id; });
  var voidedPur = setOf_(readAll('PurchaseBills').filter(function (b) { return b.status === 'voided'; }), function (b) { return b.id; });

  // supplier|item -> quantity bought / sold from that supplier
  var bought = {}, sold = {};
  readAll('Purchases').forEach(function (p) {
    if (voidedPur[p.purchaseBillId] || !p.supplierId) return;
    var k = p.supplierId + '|' + p.itemId;
    bought[k] = (bought[k] || 0) + (Number(p.qty) || 0);
  });
  readAll('BillItems').forEach(function (l) {
    if (voidedBill[l.billId] || !l.supplierId) return;
    var k = l.supplierId + '|' + l.itemId;
    sold[k] = (sold[k] || 0) + (Number(l.qty) || 0);
  });

  var out = [];
  var bad = 0;
  plan.all.forEach(function (g) {
    if (!g.rows.length) return;
    var want = {};
    g.rows.forEach(function (r) {
      var k = key_(r.item);
      if (!want[k]) want[k] = { name: tidy_(r.item), bought: 0, sold: 0 };
      want[k].bought += r.qty;
      want[k].sold += r.sold;
    });
    var sup = supByName[g.key];
    if (!sup) {
      bad += 1;
      out.push('MISSING  ' + g.name + ': not in the Sheet yet');
      return;
    }
    var wrong = [];
    var totalB = 0, totalS = 0;
    for (var k in want) {
      var it = itemByName[k];
      var b = it ? bought[sup.id + '|' + it.id] || 0 : 0;
      var s = it ? sold[sup.id + '|' + it.id] || 0 : 0;
      totalB += want[k].bought;
      totalS += want[k].sold;
      if (Math.abs(b - want[k].bought) > 0.01 || Math.abs(s - want[k].sold) > 0.01) {
        wrong.push(want[k].name + ' (Excel ' + r2(want[k].bought) + '/' + r2(want[k].sold) +
          ', Sheet ' + r2(b) + '/' + r2(s) + ')');
      }
    }
    if (wrong.length) bad += 1;
    out.push((wrong.length ? 'DIFFERS  ' : 'OK       ') + g.name + ': Excel bought ' + r2(totalB) + ' / sold ' + r2(totalS) +
      (wrong.length ? '  -> ' + wrong.length + ' item(s) differ, e.g. ' + wrong.slice(0, 3).join('; ') : ''));
  });
  out.push(bad ? bad + ' supplier(s) need attention - run importOldData (again).' : 'ALL SUPPLIERS MATCH THE EXCEL.');
  Logger.log(out.join('\n'));
  return out.join('\n');
}

/**
 * Read-only: what does this Google Sheet look like right now? Run this and read the execution log.
 * It tells you whether the data file and Code.gs are the right ones, and how much is already in the Sheet.
 */
function diagnoseOldData() {
  var L = [];
  L.push('1. Data inside this script: ' + (OLD && OLD.suppliers
    ? 'YES (' + OLD.suppliers.length + ' suppliers) - good'
    : 'NO - this is the empty template. Paste old data/ImportOldData.gs instead.'));
  L.push('2. Code.gs is the latest (has adoptPurchases): ' + (typeof adoptPurchases === 'function'
    ? 'YES - good'
    : 'NO - replace ALL of Code.gs with the latest apps-script/Code.gs, save, then run again.'));

  var purchases = readAll('Purchases');
  var linked = purchases.filter(function (p) { return p.purchaseBillId; }).length;
  var tagged = readAll('PurchaseBills').filter(function (b) { return b.note === IMPORT_TAG; }).length;
  L.push('3. In the Sheet now: ' + readAll('Suppliers').length + ' suppliers, ' + readAll('PurchaseBills').length +
    ' purchase bills (' + tagged + ' made by this import), ' + readAll('Items').length + ' items.');
  L.push('4. Purchase rows: ' + purchases.length + ' in total - ' + linked + ' inside a supplier purchase bill, ' +
    (purchases.length - linked) + ' still only on the Purchases page.');
  L.push('5. Supplier payments: ' + readAll('SupplierPayments').length + '. Old-sales bills made by this import: ' +
    readAll('Bills').filter(function (b) { return String(b.note || '').indexOf(IMPORT_TAG) === 0; }).length + '.');
  L.push('6. Shop records: ' + readAll('Expenses').length + ' expenses, ' + readAll('Assets').length + ' assets, ' +
    readAll('Employees').length + ' employees.');
  if (OLD && OLD.suppliers && typeof adoptPurchases === 'function') {
    var plan = planOld_();
    var p = plan.summary;
    var todo = remaining_(plan);
    L.push('7. Still to do: ' + todo.moved + ' purchase rows to move, ' + todo.added + ' lines to add, ' + todo.sales +
      ' sold lines, ' + p.expenses + ' expenses, ' + p.salaries + ' salaries, ' + p.assets + ' assets.' +
      (todo.moved + todo.added + todo.sales + p.expenses + p.salaries + p.assets === 0
        ? ' NOTHING LEFT - the import is complete. Refresh the software (Ctrl+F5).'
        : ' Run importOldData to do them.'));
  }
  Logger.log(L.join('\n'));
  return L.join('\n');
}
