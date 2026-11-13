/**
 * ============================================================================
 * Duplicate finder — REPORT ONLY, changes nothing
 * ============================================================================
 *
 * Paste this alongside Code.gs in the same Apps Script project, then run
 * findDuplicates() from the editor and read the execution log.
 *
 * Nothing here writes, deletes or edits a single cell. It reads the sheet and
 * prints what it found, so the shopkeeper can look at the rows themselves
 * before deciding what should happen to them. Deleting a party or a bill is
 * irreversible and the consequences differ case by case — a repeated party
 * name may be two genuine shops, and two bills of the same amount on one day
 * may be two real sales.
 *
 * What it looks for:
 *
 *   1. Parties and Items sharing a name (ignoring case and spacing). These are
 *      the ones that actually cost money: two ledgers for one shop means
 *      payments land on whichever was picked and neither balance is right.
 *
 *   2. Bills sharing a bill number. Two bills numbered the same cannot be told
 *      apart on a printed receipt or in the ledger.
 *
 *   3. Records whose id appears twice. That should be impossible, so it points
 *      at a sync or a hand-edit that went wrong.
 *
 *   4. Payments identical in party, bill, amount, method and date — the shape a
 *      double-submit leaves behind. Flagged as SUSPECTED only: a customer
 *      paying the same amount twice in one day is perfectly ordinary, so these
 *      need a human to look at them.
 * ============================================================================
 */

function findDuplicates() {
  var out = [];
  var p = function (s) { out.push(s == null ? '' : String(s)); };

  p('DUPLICATE REPORT — ' + new Date().toString());
  p('Nothing has been changed. This is a read-only scan.');
  p('');

  var totals = { blocking: 0, suspected: 0 };

  /* ---------------- 1. Parties and Items by name ---------------- */

  [['Parties', 'party'], ['Items', 'item']].forEach(function (pair) {
    var tab = pair[0];
    var label = pair[1];
    var rows = readAll(tab);
    var groups = {};

    rows.forEach(function (r) {
      var k = nameKey(r.name);
      if (!k) return;
      if (!groups[k]) groups[k] = [];
      groups[k].push(r);
    });

    var dupes = Object.keys(groups).filter(function (k) { return groups[k].length > 1; });

    p('=== ' + tab.toUpperCase() + ' WITH THE SAME NAME ===');
    if (!dupes.length) {
      p('  none');
    } else {
      dupes.forEach(function (k) {
        var g = groups[k];
        totals.blocking += g.length - 1;
        p('  "' + g[0].name + '" — ' + g.length + ' records:');
        g.forEach(function (r) {
          // Usage counts decide which copy is the real one: the record with
          // history is the one to keep, and an unused duplicate is safe to
          // archive.
          var used = tab === 'Parties'
            ? countPartyUsage(r.id)
            : countItemUsage(r.id);
          p('     id=' + r.id +
            '  status=' + (r.status || 'active') +
            (tab === 'Parties' ? '  phone=' + (r.phone || '-') : '') +
            '  ' + used);
        });
        p('');
      });
    }
    p('');
  });

  /* ---------------- 2. Bills sharing a number ---------------- */

  var bills = readAll('Bills');
  var byNo = {};
  bills.forEach(function (b) {
    var k = String(b.billNo || '').trim();
    if (!k) return;
    if (!byNo[k]) byNo[k] = [];
    byNo[k].push(b);
  });

  p('=== BILLS SHARING A BILL NUMBER ===');
  var billDupes = Object.keys(byNo).filter(function (k) { return byNo[k].length > 1; });
  if (!billDupes.length) {
    p('  none');
  } else {
    billDupes.forEach(function (k) {
      totals.blocking += byNo[k].length - 1;
      p('  Bill No ' + k + ' — ' + byNo[k].length + ' bills:');
      byNo[k].forEach(function (b) {
        p('     id=' + b.id + '  date=' + dayOf(b.date) +
          '  total=' + b.totalAmount + '  status=' + b.status +
          '  party=' + partyNameOf(b.partyId));
      });
      p('');
    });
  }
  p('');

  /* ---------------- 2b. Bills that are the same sale twice ---------------- */

  /* A double-submitted bill gets its own bill NUMBER, so the check above can
     never see it. What gives it away is the content: same party, same day,
     same total. That is also what a genuine second sale looks like — a shop
     that orders twice in a morning — so these are reported as SUSPECTED and
     their line items are printed for comparison. Identical lines make it a
     duplicate; different goods at the same total make it two real sales. */

  p('=== BILLS THAT LOOK LIKE THE SAME SALE TWICE ===');
  p('(same party, same day, same total — SUSPECTED only, compare the items)');

  var byContent = {};
  bills.forEach(function (b) {
    if (b.status === 'voided') return;   // already cancelled, not a concern
    var k = [b.partyId, dayOf(b.date), r2(b.totalAmount)].join('|');
    if (!byContent[k]) byContent[k] = [];
    byContent[k].push(b);
  });

  var contentDupes = Object.keys(byContent).filter(function (k) {
    return byContent[k].length > 1;
  });

  if (!contentDupes.length) {
    p('  none');
  } else {
    var allLines = readAll('BillItems');
    var allPays = readAll('Payments');
    var itemsById = {};
    readAll('Items').forEach(function (i) { itemsById[i.id] = i.name; });

    contentDupes.forEach(function (k) {
      var g = byContent[k];
      totals.suspected += g.length - 1;
      p('  ' + partyNameOf(g[0].partyId) + ' — ' + g.length + ' bills of ' +
        g[0].totalAmount + ' on ' + dayOf(g[0].date) + ':');

      g.forEach(function (b) {
        var lines = allLines.filter(function (l) { return l.billId === b.id; });
        var paid = allPays.filter(function (x) {
          return x.billId === b.id && !x.reversed;
        }).length;

        p('     Bill ' + b.billNo + '  id=' + b.id +
          '  status=' + b.status + '  payments=' + paid +
          (paid ? '   <-- has payments, do NOT delete without checking' : ''));

        lines.forEach(function (l) {
          p('        ' + (itemsById[l.itemId] || 'Item') + ' — ' +
            l.qty + ' ' + (l.unit || '') + ' @ ' + l.price + ' = ' + l.lineTotal);
        });
      });
      p('');
    });
  }
  p('');

  /* ---------------- 3. Repeated ids ---------------- */

  p('=== REPEATED IDS (should never happen) ===');
  var idProblem = false;
  ['Parties', 'Items', 'Bills', 'BillItems', 'Payments', 'Returns',
   'Cheques', 'PartyAdvances', 'Purchases', 'Expenses'].forEach(function (tab) {
    var seen = {};
    var dup = [];
    readAll(tab).forEach(function (r) {
      var k = String(r.id || '');
      if (!k) return;
      if (seen[k]) { dup.push(k); } else { seen[k] = 1; }
    });
    if (dup.length) {
      idProblem = true;
      totals.blocking += dup.length;
      p('  ' + tab + ': ' + dup.length + ' repeated — ' + dup.slice(0, 10).join(', ') +
        (dup.length > 10 ? ' …' : ''));
    }
  });
  if (!idProblem) p('  none');
  p('');

  /* ---------------- 4. Payments that look double-submitted ---------------- */

  p('=== PAYMENTS THAT LOOK LIKE DOUBLE SUBMITS ===');
  p('(same party, bill, amount, method and day — SUSPECTED only, check before acting)');
  var pays = readAll('Payments');
  var pgroups = {};
  pays.forEach(function (x) {
    if (x.reversed) return;
    var k = [x.partyId, x.billId || '-', r2(x.amount), x.method, dayOf(x.date)].join('|');
    if (!pgroups[k]) pgroups[k] = [];
    pgroups[k].push(x);
  });
  var payDupes = Object.keys(pgroups).filter(function (k) { return pgroups[k].length > 1; });
  if (!payDupes.length) {
    p('  none');
  } else {
    payDupes.forEach(function (k) {
      var g = pgroups[k];
      totals.suspected += g.length - 1;
      var bill = g[0].billId ? getById('Bills', g[0].billId) : null;
      p('  ' + partyNameOf(g[0].partyId) + ' — ' + g.length + ' x ' + g[0].amount +
        ' by ' + g[0].method + ' on ' + dayOf(g[0].date) +
        (bill ? ' against Bill ' + bill.billNo : ' on account'));
      g.forEach(function (x) { p('     id=' + x.id + '  note=' + (x.note || '-')); });
      p('');
    });
  }
  p('');

  /* ---------------- Summary ---------------- */

  p('========================================');
  p('Name/number/id clashes that need fixing : ' + totals.blocking);
  p('Payments that merely look duplicated    : ' + totals.suspected);
  p('');
  p('Nothing was changed by this report.');
  p('Send this log back and the safe fixes can be worked out row by row.');

  var text = out.join('\n');
  Logger.log(text);
  return text;
}

/* -------------------------------------------------------------------------- */

/** How much history hangs off a party — what would be lost by removing it. */
function countPartyUsage(partyId) {
  var bills = readAll('Bills').filter(function (b) { return b.partyId === partyId; }).length;
  var pays = readAll('Payments').filter(function (x) { return x.partyId === partyId; }).length;
  var advs = readAll('PartyAdvances').filter(function (x) { return x.partyId === partyId; }).length;
  return 'bills=' + bills + ' payments=' + pays + ' advances=' + advs +
         (bills + pays + advs === 0 ? '  <-- UNUSED, safe to archive' : '');
}

/** How much history hangs off an item. */
function countItemUsage(itemId) {
  var lines = readAll('BillItems').filter(function (x) { return x.itemId === itemId; }).length;
  var purch = readAll('Purchases').filter(function (x) { return x.itemId === itemId; }).length;
  return 'sold on ' + lines + ' bill lines, purchases=' + purch +
         (lines + purch === 0 ? '  <-- UNUSED, safe to archive' : '');
}

function partyNameOf(id) {
  var p = getById('Parties', id);
  return p ? p.name : '(unknown party)';
}
