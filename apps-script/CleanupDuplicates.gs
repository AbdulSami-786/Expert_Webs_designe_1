/**
 * ============================================================================
 * One-off duplicate cleanup — decided row by row from the 23 Sept 2026 report
 * ============================================================================
 *
 * Paste this alongside Code.gs, run previewCleanup() first, read the log, and
 * only then run applyCleanup().
 *
 * Every id below was chosen deliberately, not by a rule. Nothing here searches
 * for "duplicates" and acts on what it finds — a blind sweep would archive
 * real shops and delete real sales. These are the exact rows the shopkeeper
 * looked at and decided on:
 *
 *   1. Three parties named "testing" — ARCHIVED, not deleted. They carry 7
 *      bills between them, and deleting a party takes its ledger with it.
 *      Archiving hides them from every dropdown while the books stay whole.
 *
 *   2. Two of the three "imran Dhabi G" rows — DELETED. All three share one
 *      phone number, so it is one shop entered three times. The two being
 *      removed hold no bills, payments or advances, so nothing is lost; the
 *      third keeps its bill and stays active.
 *
 *   3. The two Rs 100,000 cheques to hamza food — LEFT ALONE. Confirmed as two
 *      genuine cheques, not a double submit.
 *
 *   4. Bill number 2026-0003 — RENUMBERED, never deleted. Two bills share it:
 *      a voided Rs 500 test and a live Rs 66,362 sale. The voided one takes a
 *      new number so the live bill keeps the number already on the customer's
 *      receipt.
 *
 * Run once. Running twice is harmless — each step checks the current state
 * first and skips work already done.
 * ============================================================================
 */

/** Parties to archive: kept in full, hidden from pickers. */
var CLEANUP_ARCHIVE_PARTIES = [
  'pty_mu88ny16k6k8h',   // "testing"  — 5 bills
  'pty_mu88qszm7yo3v',   // "testing"  — 1 bill, already archived
  'pty_mud2cizga9qe9'    // "testing"  — 1 bill
];

/** Parties to delete: verified to hold no bills, payments or advances. */
var CLEANUP_DELETE_PARTIES = [
  'pty_mucu1ki44k2dp',   // "imran Dhabi G" — empty
  'pty_mucu2zm7hhpdd'    // "imran Dhabi G" — empty
];
// Kept: pty_mucu4gdqlzh48 — the copy holding the 1 bill.

/** The voided bill that gives up the contested number. */
var CLEANUP_RENUMBER_BILL = 'bil_mu74qi2t26dyg';   // voided Rs 500 test, 2026-0003

/* ========================================================================== */

/** Report exactly what applyCleanup() would do. Changes nothing. */
function previewCleanup() {
  return runCleanup(false);
}

/** Carry out the cleanup. Take a Backup from the dashboard first. */
function applyCleanup() {
  return runCleanup(true);
}

function runCleanup(commit) {
  var out = [];
  var p = function (s) { out.push(s == null ? '' : String(s)); };

  p(commit ? 'CLEANUP — APPLYING CHANGES' : 'CLEANUP PREVIEW — nothing will be changed');
  p(new Date().toString());
  p('');

  /* ---- 1. Archive the "testing" parties ---- */

  p('=== ARCHIVE "testing" PARTIES (bills kept) ===');
  CLEANUP_ARCHIVE_PARTIES.forEach(function (id) {
    var party = getById('Parties', id);
    if (!party) { p('  ' + id + ' — not found, skipped'); return; }
    if (party.status === 'archived') {
      p('  "' + party.name + '" (' + id + ') — already archived');
      return;
    }
    var bills = readAll('Bills').filter(function (b) { return b.partyId === id; }).length;
    p('  "' + party.name + '" (' + id + ') — archive, ' + bills + ' bill(s) kept');
    if (commit) {
      updateRow('Parties', party._row, { status: 'archived' });
      logActivity('party', id, 'edit',
        'Archived duplicate party "' + party.name + '" during duplicate cleanup');
    }
  });
  p('');

  /* ---- 2. Delete the empty "imran Dhabi G" rows ---- */

  p('=== DELETE EMPTY "imran Dhabi G" PARTIES ===');
  CLEANUP_DELETE_PARTIES.forEach(function (id) {
    var party = getById('Parties', id);
    if (!party) { p('  ' + id + ' — not found, skipped'); return; }

    // Re-checked at run time rather than trusted from the report: the sheet
    // may have moved on since, and deleting a party that has since been used
    // would strand its bills against an id that no longer resolves.
    var bills = readAll('Bills').filter(function (b) { return b.partyId === id; }).length;
    var pays = readAll('Payments').filter(function (x) { return x.partyId === id; }).length;
    var advs = readAll('PartyAdvances').filter(function (x) { return x.partyId === id; }).length;

    if (bills + pays + advs > 0) {
      p('  "' + party.name + '" (' + id + ') — NOW IN USE (bills=' + bills +
        ' payments=' + pays + ' advances=' + advs + '), NOT deleted');
      return;
    }

    p('  "' + party.name + '" (' + id + ') — delete, holds nothing');
    if (commit) {
      logActivity('party', id, 'delete',
        'Deleted empty duplicate party "' + party.name + '" during duplicate cleanup',
        party, null);
      deleteRowById('Parties', id);
    }
  });
  p('');

  /* ---- 3. Renumber the voided bill ---- */

  p('=== RENUMBER THE CLASHING BILL ===');
  (function () {
    var bill = getById('Bills', CLEANUP_RENUMBER_BILL);
    if (!bill) { p('  ' + CLEANUP_RENUMBER_BILL + ' — not found, skipped'); return; }

    var bills = readAll('Bills');
    var sharing = bills.filter(function (b) {
      return String(b.billNo) === String(bill.billNo);
    });
    if (sharing.length < 2) {
      p('  Bill ' + bill.billNo + ' no longer shares its number — nothing to do');
      return;
    }

    var replacement = nextFreeBillNo(bills, String(bill.billNo));
    p('  Bill ' + bill.billNo + ' (' + bill.status + ', ' + bill.totalAmount + ')');
    p('     -> renumbered to ' + replacement);
    p('     the live bill keeps ' + bill.billNo + ', which is already on the customer’s receipt');

    if (commit) {
      updateRow('Bills', bill._row, { billNo: replacement });
      logActivity('bill', bill.id, 'edit',
        'Renumbered ' + bill.billNo + ' to ' + replacement +
        ' during duplicate cleanup (number was shared with another bill)');
    }
  })();
  p('');

  /* ---- 4. Left alone, on purpose ---- */

  p('=== LEFT ALONE ===');
  p('  hamza food — the two Rs 100,000 cheques of 21 Sept are two genuine');
  p('  cheques, not a double submit. Both kept.');
  p('');

  p('========================================');
  if (commit) {
    SpreadsheetApp.flush();
    clearCache();
    p('Done. Reload the dashboard to see the result.');
    p('Run findDuplicates() again to confirm what is left.');
  } else {
    p('Preview only — nothing was changed.');
    p('Take a Backup from the dashboard, then run applyCleanup().');
  }

  var text = out.join('\n');
  Logger.log(text);
  return text;
}
