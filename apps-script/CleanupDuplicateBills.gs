/**
 * ============================================================================
 * Remove duplicate bills — decided from the 23 Sept 2026 report
 * ============================================================================
 *
 * Paste alongside Code.gs. Run previewBillCleanup() first, read the log, take
 * a Backup from the dashboard, and only then run applyBillCleanup().
 *
 * These bills were created seconds apart with consecutive numbers and
 * identical lines — the signature of the double-submit bug that has since been
 * fixed. The shopkeeper confirmed which sale was real in each case.
 *
 *   IMDAAD HUSSAIN — 8 bills of Rs 24,000 (600 pump china small @ 40) on
 *   22 Sept. ONE was a real sale. 2026-0023 is kept; the other seven go.
 *
 *   FARAZ ALI NAWAB SONS — 2 bills of Rs 12,910 with seven matching lines on
 *   22 Sept. 2026-0033 is kept; 2026-0034 goes.
 *
 * Each bill is removed whole: the bill row, its line items, the PartyItemPrices
 * rows it wrote, its payments and any cheque behind them. Leaving any part
 * would be worse than leaving the bill — a payment whose bill is gone still
 * counts in the cash position, and a cheque whose payment is gone is still
 * counted when working out what a bill owes.
 *
 * What this removes from the books, if the numbers below match the report:
 *   Rs 168,000 of IMDAAD sales that never happened, and 4,200 pumps of stock
 *   movement that never happened.
 *   Rs 12,910 of FARAZ sales that never happened.
 *
 * DELETION CANNOT BE UNDONE. The preview exists so the rows can be read once
 * more before that becomes true.
 * ============================================================================
 */

/**
 * The bills to remove, by id. Ids rather than bill numbers, because a number
 * can be edited and an id cannot — this list can never quietly come to mean a
 * different bill.
 */
var DUPLICATE_BILLS_TO_DELETE = [
  // IMDAAD HUSSAIN — keeping 2026-0023 (bil_muccyffqt49nx)
  'bil_mucd0yjqdb4ep',   // 2026-0024
  'bil_mucd12pi2wgp1',   // 2026-0025
  'bil_mucd175g30yq7',   // 2026-0026
  'bil_mucltkhpm4cve',   // 2026-0029
  'bil_mucltou2r8ex4',   // 2026-0030
  'bil_mucw84asrya02',   // 2026-0035
  'bil_mucw893aaw0z7',   // 2026-0036

  // FARAZ ALI NAWAB SONS — keeping 2026-0033 (bil_mucw3efdiefb6)
  'bil_mucw4th6pljdt'    // 2026-0034
];

/** Bills deliberately kept, named here so the preview can show them. */
var DUPLICATE_BILLS_KEPT = [
  'bil_muccyffqt49nx',   // IMDAAD 2026-0023 — the one real sale
  'bil_mucw3efdiefb6'    // FARAZ  2026-0033 — the one real sale
];

/* ========================================================================== */

/** Show exactly what would be removed. Changes nothing. */
function previewBillCleanup() {
  return runBillCleanup(false);
}

/** Remove them. Take a Backup from the dashboard first — this cannot be undone. */
function applyBillCleanup() {
  return runBillCleanup(true);
}

function runBillCleanup(commit) {
  var out = [];
  var p = function (s) { out.push(s == null ? '' : String(s)); };

  p(commit ? 'DUPLICATE BILL CLEANUP — DELETING' : 'PREVIEW — nothing will be changed');
  p(new Date().toString());
  p('');

  /* ---- The bills being kept, so they can be checked first ---- */

  p('=== KEPT (the real sales) ===');
  DUPLICATE_BILLS_KEPT.forEach(function (id) {
    var b = getById('Bills', id);
    if (!b) { p('  ' + id + ' — NOT FOUND, check before continuing'); return; }
    p('  Bill ' + b.billNo + '  ' + partyNameOf(b.partyId) +
      '  ' + b.totalAmount + '  ' + dayOf(b.date) + '  status=' + b.status);
  });
  p('');

  var totals = { bills: 0, lines: 0, pays: 0, cheques: 0, prices: 0, money: 0, paid: 0 };

  p('=== TO BE ' + (commit ? 'DELETED' : 'DELETED (preview)') + ' ===');

  DUPLICATE_BILLS_TO_DELETE.forEach(function (billId) {
    var bill = getById('Bills', billId);
    if (!bill) {
      p('  ' + billId + ' — not found, already gone');
      p('');
      return;
    }

    var lines = readAll('BillItems').filter(function (l) { return l.billId === billId; });
    var pays = readAll('Payments').filter(function (x) { return x.billId === billId; });
    var payIds = {};
    pays.forEach(function (x) { payIds[x.id] = 1; });
    var cheques = readAll('Cheques').filter(function (c) {
      return c.billId === billId || payIds[c.paymentId];
    });

    // saveBill writes a PartyItemPrices row per line, which is where the price
    // auto-fill on New Bill comes from. Leaving them would keep suggesting a
    // price that came from a sale being erased.
    var prices = readAll('PartyItemPrices').filter(function (pi) {
      return pi.partyId === bill.partyId && pi.date === bill.date
        && lines.some(function (l) {
          return l.itemId === pi.itemId && r2(l.price) === r2(pi.price);
        });
    });

    var paidHere = 0;
    pays.forEach(function (x) { if (!x.reversed) paidHere = r2(paidHere + r2(x.amount)); });

    p('  Bill ' + bill.billNo + '  (' + billId + ')');
    p('     ' + partyNameOf(bill.partyId) + '  ' + bill.totalAmount + '  ' + dayOf(bill.date));
    p('     ' + lines.length + ' line(s), ' + pays.length + ' payment(s) totalling ' +
      paidHere + ', ' + cheques.length + ' cheque(s), ' + prices.length + ' price record(s)');

    totals.bills += 1;
    totals.lines += lines.length;
    totals.pays += pays.length;
    totals.cheques += cheques.length;
    totals.prices += prices.length;
    totals.money = r2(totals.money + r2(bill.totalAmount));
    totals.paid = r2(totals.paid + paidHere);

    if (commit) {
      // Children before the parent, so nothing is ever left pointing at a bill
      // that has already gone.
      cheques.forEach(function (c) { deleteRowById('Cheques', c.id); });
      pays.forEach(function (x) { deleteRowById('Payments', x.id); });
      prices.forEach(function (pi) { deleteRowById('PartyItemPrices', pi.id); });
      lines.forEach(function (l) { deleteRowById('BillItems', l.id); });

      logActivity('bill', billId, 'delete',
        'Deleted duplicate Bill ' + bill.billNo + ' for ' + partyNameOf(bill.partyId) +
        ' (' + bill.totalAmount + ') with ' + pays.length + ' payment(s) — ' +
        'created by the double-submit fault, confirmed duplicate by the shopkeeper',
        bill, null);

      deleteRowById('Bills', billId);
    }
    p('');
  });

  p('========================================');
  p('Bills            : ' + totals.bills);
  p('Line items       : ' + totals.lines);
  p('Payments         : ' + totals.pays + '  (' + totals.paid + ')');
  p('Cheques          : ' + totals.cheques);
  p('Price records    : ' + totals.prices);
  p('');
  p('Sales removed from the books : ' + totals.money);
  p('Payments removed             : ' + totals.paid);
  p('');

  if (commit) {
    SpreadsheetApp.flush();
    clearCache();
    p('Done. Reload the dashboard.');
    p('Run findDuplicates() again to confirm what is left.');
  } else {
    p('Preview only — nothing was changed.');
    p('Check the KEPT bills above are the ones you mean to keep.');
    p('Then take a Backup from the dashboard and run applyBillCleanup().');
  }

  var text = out.join('\n');
  Logger.log(text);
  return text;
}
