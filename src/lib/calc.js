// Derived business math.
//
// Safety Guide 2.3: bill status and running balances are ALWAYS recomputed from
// the underlying Bills/Payments/Returns data, never trusted from a stored field.
// That way a display bug can never silently create a wrong "official" number.

import { r2, daysOverdue, agingBucket, applyRounding, fmtDate, unitFactor } from './format';

/* ========================================================================
   Bill-level math
   ======================================================================== */

/** Sum of line totals before rounding. */
export function billSubtotal(lines = []) {
  return r2(lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.price) || 0), 0));
}

/** Line total for a single bill line. */
export function lineTotal(line) {
  return r2((Number(line.qty) || 0) * (Number(line.price) || 0));
}

/**
 * Compute a bill's totals given its lines and the rounding rule.
 * Returns subtotal, rounded grand total, and the visible round-off line (Plan 3.4).
 */
export function billTotals(lines, roundingRule = 'nearest1') {
  const subtotal = billSubtotal(lines);
  const total = applyRounding(subtotal, roundingRule);
  return { subtotal, roundOff: r2(total - subtotal), total: r2(total) };
}

/** Total non-reversed payments recorded against a bill (FR-26: reversals offset). */
export function billPaid(billId, payments = []) {
  return r2(
    payments
      .filter((p) => p.billId === billId && !p.reversed)
      .reduce((s, p) => s + (Number(p.amount) || 0), 0)
  );
}

/** Total value returned against a bill (FR-18). */
export function billReturned(billId, returns = []) {
  return r2(
    returns
      .filter((r) => r.billId === billId)
      .reduce((s, r) => s + (Number(r.valueAdjusted) || 0), 0)
  );
}

/**
 * Full derived state of one bill: net total after returns, paid, due, status.
 * A pending cheque counts as paid against the bill but NOT as cash (FR-29).
 */
export function billState(bill, { payments = [], returns = [], cheques = [] } = {}) {
  const gross = r2(bill.totalAmount);
  const returned = billReturned(bill.id, returns);
  const net = r2(gross - returned);

  // A cheque is not money until the bank clears it. A bounced one never was
  // (FR-30), and a pending one has not arrived yet — the party still owes it,
  // and the shop cannot spend it. Treating either as paid would close the bill,
  // drop it off Outstanding, and stop anyone chasing a cheque that never
  // cleared. accountBalances() already excludes both from the cash position,
  // so counting them as paid here made the bill and the accounts disagree.
  const uncleared = new Set(
    cheques.filter((c) => c.status !== 'cleared' && c.paymentId).map((c) => c.paymentId)
  );
  const countsAsPaid = (p) => p.billId === bill.id && !p.reversed && !uncleared.has(p.id);

  const paid = r2(
    payments.filter(countsAsPaid).reduce((s, p) => s + (Number(p.amount) || 0), 0)
  );

  // Recorded but not yet cleared. Kept separate from `paid` so screens can show
  // "Rs 1,000 due, Rs 1,000 in an uncleared cheque" rather than implying the
  // party has paid nothing at all.
  const pendingCheques = r2(
    payments
      .filter((p) => p.billId === bill.id && !p.reversed && uncleared.has(p.id))
      .filter((p) => {
        const c = cheques.find((x) => x.paymentId === p.id);
        return c && c.status !== 'bounced';   // bounced is a failure, not a wait
      })
      .reduce((s, p) => s + (Number(p.amount) || 0), 0)
  );

  // Delivery is independent of the money: a bill can be paid but not yet handed
  // over, or delivered and still unpaid. A voided bill has nothing to deliver.
  //
  // Bills written before this field existed have no `delivery` and are read as
  // delivered — their goods went out long ago, and defaulting them to pending
  // would fill the pending list with years of finished sales.
  const delivery = bill.status === 'voided'
    ? 'cancelled'
    : (bill.delivery === 'pending' ? 'pending' : 'delivered');

  return withMoney({
    ...bill,
    gross,
    returned,
    net,
    pendingCheques,
    delivery,
    isPending: delivery === 'pending',
    // Paid beyond this bill's own net (a return after full payment, a bounced
    // cheque re-cleared). deriveBills() carries it onto the party's other bills.
    overpaid: r2(Math.max(0, paid - net)),
    carriedIn: 0,
  }, paid);
}

/** Set a bill's paid figure and everything that follows from it: due, status, ageing. */
function withMoney(state, paid) {
  const due = r2(Math.max(0, state.net - paid));

  let status;
  if (state.status === 'voided') status = 'voided';
  else if (due <= 0.004) status = 'paid';
  else if (paid > 0.004) status = 'partial';
  // Nothing has cleared, but a cheque is sitting with the bank: the bill is
  // genuinely still due, and saying so with its own label stops it looking
  // like the party has simply not paid.
  else if (state.pendingCheques > 0.004) status = 'cheque-pending';
  else status = 'due';

  const overdueDays = status !== 'paid' && status !== 'voided' ? daysOverdue(state.dueDate) : 0;

  return {
    ...state,
    paid: r2(paid),
    due,
    status,
    isOverdue: due > 0 && overdueDays > 0,
    overdueDays,
    bucket: due > 0 ? agingBucket(Math.max(0, overdueDays)) : null,
  };
}

/**
 * Money paid beyond one bill's total settles the same party's other open
 * bills, oldest first — the way a khata reads it.
 *
 * Without this, an overpaid bill clamps to zero due and its extra money
 * vanishes: Outstanding (the sum of bill dues) reads higher than the
 * statement's closing balance (billed − paid) by exactly the overpayment.
 *
 * The overpaid bill keeps paid = its net; each bill that absorbs some of the
 * extra gets it as `carriedIn`. Anything no open bill can take is reported by
 * partyUnappliedCredit().
 */
function carryOverpayments(states) {
  const byParty = new Map();
  states.forEach((s, i) => {
    if (s.status === 'voided') return;
    if (!byParty.has(s.partyId)) byParty.set(s.partyId, []);
    byParty.get(s.partyId).push(i);
  });

  const out = states.slice();
  for (const idx of byParty.values()) {
    let pool = r2(idx.reduce((t, i) => t + (out[i].overpaid || 0), 0));
    if (pool <= 0.004) continue;

    idx.forEach((i) => {
      if (out[i].overpaid > 0) out[i] = withMoney(out[i], out[i].net);
    });

    const open = idx
      .filter((i) => out[i].due > 0.004)
      .sort((a, b) => String(out[a].date).localeCompare(String(out[b].date))
        || String(out[a].billNo).localeCompare(String(out[b].billNo)));
    for (const i of open) {
      if (pool <= 0.004) break;
      const use = r2(Math.min(out[i].due, pool));
      pool = r2(pool - use);
      out[i] = withMoney({ ...out[i], carriedIn: use }, out[i].paid + use);
    }
  }
  return out;
}

/**
 * How much more a bill can take as a payment.
 *
 * `due` leaves cheques out until they clear, which is right for what the party
 * owes, but wrong as a payment limit: a cheque already sitting with the bank
 * will settle its share once it clears. Measured against `due` alone, several
 * cheques could each pass on their own and together exceed the bill — and once
 * enough had cleared to pay it in full, clearing the rest changed nothing and
 * their money vanished from the ledger. Matches billDue() in Code.gs, which
 * already counts pending cheques.
 */
export function billPaymentRoom(state) {
  return r2(Math.max(0, (state?.due || 0) - (state?.pendingCheques || 0)));
}

/** Derive every bill's state in one pass. */
export function deriveBills(bills = [], data = {}) {
  return carryOverpayments(bills.map((b) => billState(b, data)));
}

/**
 * Overpaid money no open bill could absorb: the party is in credit by this
 * much. Takes bills from deriveBills().
 */
export function partyUnappliedCredit(partyId, derivedBills = []) {
  const mine = derivedBills.filter((b) => b.partyId === partyId && b.status !== 'voided');
  return r2(Math.max(0,
    mine.reduce((t, b) => t + (b.overpaid || 0), 0)
    - mine.reduce((t, b) => t + (b.carriedIn || 0), 0)));
}

/* ========================================================================
   Per-line delivery — sales lines delivered, purchase lines received
   ======================================================================== */

/** A stored quantity counts only when one was actually written. */
function storedQty(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * How much of one bill line has gone out to the customer.
 *
 * Lines written before per-line delivery existed carry no `deliveredQty`. They
 * follow the bill's own delivery flag: a pending bill delivered none of it, any
 * other bill delivered all of it — exactly what that bill meant at the time.
 */
export function lineDeliveredQty(line, bill) {
  const qty = Number(line?.qty) || 0;
  const stored = storedQty(line?.deliveredQty);
  if (stored === null) return bill?.delivery === 'pending' ? 0 : qty;
  return Math.min(qty, Math.max(0, stored));
}

/**
 * Whether a set of lines is fully, partly or not at all handed over.
 * `doneOf` reads how much of one line is done.
 */
function progressOf(lines, doneOf) {
  let total = 0;
  let done = 0;
  lines.forEach((l) => {
    total += Number(l.qty) || 0;
    done += doneOf(l);
  });
  total = r2(total);
  done = r2(done);
  const state = !lines.length || done >= total - 0.0001 ? 'full'
    : done > 0.0001 ? 'partial' : 'none';
  return { state, done, total, left: r2(Math.max(0, total - done)) };
}

/**
 * Delivery progress of one sales bill: 'delivered', 'partial' or 'pending'.
 * A voided bill has nothing to deliver and reads 'cancelled'.
 */
export function billDelivery(bill, billItems = []) {
  if (!bill) return { state: 'pending', done: 0, total: 0, left: 0 };
  const lines = billItems.filter((bi) => bi.billId === bill.id);
  const p = progressOf(lines, (l) => lineDeliveredQty(l, bill));
  if (bill.status === 'voided') return { ...p, state: 'cancelled' };
  return { ...p, state: p.state === 'full' ? 'delivered' : p.state === 'partial' ? 'partial' : 'pending' };
}

/**
 * How much of one purchase line has arrived from the supplier.
 *
 * Purchases written before this existed carry no `receivedQty` and are read as
 * fully received — the stock they added has long been on the shelf.
 */
export function lineReceivedQty(line) {
  const qty = Number(line?.qty) || 0;
  const stored = storedQty(line?.receivedQty);
  if (stored === null) return qty;
  return Math.min(qty, Math.max(0, stored));
}

/** Receiving progress of a set of purchase lines: 'received', 'partial' or 'pending'. */
export function purchaseReceipt(lines = []) {
  const p = progressOf(lines, lineReceivedQty);
  return { ...p, state: p.state === 'full' ? 'received' : p.state === 'partial' ? 'partial' : 'pending' };
}

/* ========================================================================
   Party-level math
   ======================================================================== */

/** A party's outstanding due across all non-voided bills. */
export function partyDue(partyId, derivedBills = []) {
  return r2(
    derivedBills
      .filter((b) => b.partyId === partyId && b.status !== 'voided')
      .reduce((s, b) => s + b.due, 0)
  );
}

/**
 * What one party has paid for one item, every time, newest first.
 *
 * The question this answers is asked across the counter: the customer wants a
 * price, and the shopkeeper needs to know what they charged them last time
 * before quoting. Getting it wrong either loses margin or starts an argument.
 *
 * Built from bill lines rather than the PartyItemPrices tab, because a bill
 * line still knows its bill — so the answer can carry the bill number, the
 * quantity and whether that sale was later voided. PartyItemPrices holds only
 * price/unit/date, which cannot show any of that.
 *
 * Voided bills are included but flagged, not dropped: "we quoted 95 on a bill
 * that was cancelled" is real history, and hiding it makes a price look like it
 * came from nowhere.
 */
export function partyItemPriceHistory(partyId, itemId, { bills = [], billItems = [] } = {}) {
  const mine = new Map(
    bills.filter((b) => b.partyId === partyId).map((b) => [b.id, b])
  );

  return billItems
    .filter((bi) => bi.itemId === itemId && mine.has(bi.billId))
    .map((bi) => {
      const bill = mine.get(bi.billId);
      return {
        billId: bill.id,
        billNo: bill.billNo,
        date: bill.date,
        qty: Number(bi.qty) || 0,
        unit: bi.unit || '',
        price: r2(bi.price),
        lineTotal: r2((Number(bi.qty) || 0) * (Number(bi.price) || 0)),
        voided: bill.status === 'voided',
      };
    })
    .sort((a, b) => new Date(b.date) - new Date(a.date)
      || String(b.billNo).localeCompare(String(a.billNo)));
}

/**
 * Every item this party has ever bought, with its price history attached.
 *
 * One pass over the party's bill lines rather than one lookup per item: a
 * ledger search runs this on every keystroke, and a party with a long history
 * would otherwise re-scan the whole bill-item table for each match.
 */
export function partyItemSummary(partyId, { bills = [], billItems = [], items = [] } = {}) {
  const mine = new Map(
    bills.filter((b) => b.partyId === partyId).map((b) => [b.id, b])
  );
  const byItem = new Map();

  for (const bi of billItems) {
    const bill = mine.get(bi.billId);
    if (!bill) continue;

    if (!byItem.has(bi.itemId)) byItem.set(bi.itemId, []);
    byItem.get(bi.itemId).push({
      billId: bill.id,
      billNo: bill.billNo,
      date: bill.date,
      qty: Number(bi.qty) || 0,
      unit: bi.unit || '',
      price: r2(bi.price),
      lineTotal: r2((Number(bi.qty) || 0) * (Number(bi.price) || 0)),
      voided: bill.status === 'voided',
    });
  }

  const out = [];
  for (const [itemId, rows] of byItem) {
    rows.sort((a, b) => new Date(b.date) - new Date(a.date)
      || String(b.billNo).localeCompare(String(a.billNo)));

    // Only sales that stood are summarised. A voided bill's price still shows
    // in the history rows, but averaging it in would quietly move the number
    // the shopkeeper is about to quote.
    const live = rows.filter((r) => !r.voided);
    const item = items.find((i) => i.id === itemId);
    const prices = live.map((r) => r.price);

    out.push({
      itemId,
      name: item?.name || 'Item',
      unit: item?.baseUnit || rows[0]?.unit || '',
      status: item?.status || 'active',
      costPrice: r2(item?.costPrice || 0),
      rows,
      times: live.length,
      last: live[0] || null,
      previous: live[1] || null,
      totalQty: r2(live.reduce((s, r) => s + r.qty, 0)),
      totalValue: r2(live.reduce((s, r) => s + r.lineTotal, 0)),
      minPrice: prices.length ? Math.min(...prices) : 0,
      maxPrice: prices.length ? Math.max(...prices) : 0,
      lastDate: live[0]?.date || rows[0]?.date || '',
    });
  }

  return out.sort((a, b) => new Date(b.lastDate) - new Date(a.lastDate));
}

/**
 * Money this party has handed over in cheques that the bank has not cleared.
 *
 * Kept apart from both `due` and `paid` because it is neither yet: the shop
 * cannot spend it, and the party has done their part. Shown on its own so a
 * ledger reading "Rs 50,000 outstanding" can add "Rs 30,000 of that is sitting
 * in cheques" instead of implying the customer has paid nothing.
 *
 * Bounced cheques are excluded — those are a failure, not a wait, and their
 * amount has already reopened as ordinary due.
 */
export function partyPendingCheques(partyId, { cheques = [] } = {}) {
  // Read from the cheque register rather than by summing each bill's share.
  // A cheque taken on account — an advance, or a payment against the whole
  // account — belongs to no single bill, so a per-bill sum silently leaves it
  // out and the ledger under-reports what is sitting with the bank.
  return r2(
    cheques
      .filter((c) => c.partyId === partyId
        && c.status !== 'cleared'
        && c.status !== 'bounced')
      .reduce((s, c) => s + (Number(c.amount) || 0), 0)
  );
}

/** Unapplied advance/deposit balance for a party (Plan 7.2). */
export function partyAdvanceBalance(partyId, advances = []) {
  return r2(
    advances
      .filter((a) => a.partyId === partyId)
      .reduce((s, a) => s + (Number(a.amount) || 0) - (Number(a.applied) || 0), 0)
  );
}

/** Revenue for a party over a set of derived bills. */
export function partyRevenue(partyId, derivedBills = []) {
  return r2(
    derivedBills
      .filter((b) => b.partyId === partyId && b.status !== 'voided')
      .reduce((s, b) => s + b.net, 0)
  );
}

/**
 * Reorder suggestion (FR-47 / Plan 4.1): compare a party's own average order
 * interval against days since their last order. Adapts per party.
 */
export function reorderSuggestion(partyId, bills = []) {
  const list = bills
    .filter((b) => b.partyId === partyId && b.status !== 'voided')
    .map((b) => new Date(b.date))
    .filter((d) => !isNaN(d))
    .sort((a, b) => a - b);

  if (list.length < 2) return null;

  let gaps = 0;
  for (let i = 1; i < list.length; i++) gaps += (list[i] - list[i - 1]) / 86400000;
  const avgDays = gaps / (list.length - 1);
  if (avgDays <= 0) return null;

  const last = list[list.length - 1];
  const sinceDays = Math.round((Date.now() - last) / 86400000);
  const overdueBy = Math.round(sinceDays - avgDays);

  return {
    partyId,
    avgDays: Math.round(avgDays),
    sinceDays,
    overdueBy,
    isDue: overdueBy >= 0,
    lastOrder: last,
  };
}

/* ========================================================================
   Stock, profit, accounts
   ======================================================================== */

/**
 * Current stock for an item, derived from purchases in, sales out,
 * returns restocked, and stock loss (Plan 7.5 / FR-36).
 */
export function itemStock(itemId, {
  purchases = [], billItems = [], bills = [], returns = [], stockLoss = [], items = [],
  purchaseBills = [], supplierReturns = [],
} = {}) {
  const voided = new Set(bills.filter((b) => b.status === 'voided').map((b) => b.id));
  const voidedPurchase = new Set(
    purchaseBills.filter((b) => b.status === 'voided').map((b) => b.id)
  );

  // Opening stock entered when the item was created counts as stock on hand.
  const item = items.find((i) => i.id === itemId);
  const opening = Number(item?.openingStock) || 0;

  // A cancelled purchase bill never brought its goods in.
  const inQty = purchases
    .filter((p) => p.itemId === itemId && !voidedPurchase.has(p.purchaseBillId))
    .reduce((s, p) => s + (Number(p.qty) || 0), 0);

  // Goods sent back to a supplier have left the shop.
  const sentBackQty = supplierReturns
    .filter((r) => r.itemId === itemId)
    .reduce((s, r) => s + (Number(r.qty) || 0), 0);

  // A line sold in the alternate unit (Bag) takes its base-unit quantity (KG)
  // off the shelf, not its own count.
  const outQty = billItems
    .filter((bi) => bi.itemId === itemId && !voided.has(bi.billId))
    .reduce((s, bi) => s + (Number(bi.qty) || 0) * unitFactor(item, bi.unit), 0);

  // A return is entered in the unit the line was sold in, so it goes back on
  // the shelf converted the same way.
  const unitOfSale = (r) => billItems.find((bi) => bi.billId === r.billId && bi.itemId === r.itemId)?.unit;
  const backQty = returns
    .filter((r) => r.itemId === itemId && r.restock)
    .reduce((s, r) => s + (Number(r.qty) || 0) * unitFactor(item, unitOfSale(r)), 0);

  const lostQty = stockLoss
    .filter((l) => l.itemId === itemId)
    .reduce((s, l) => s + (Number(l.qty) || 0), 0);

  return r2(opening + inQty - outQty + backQty - lostQty - sentBackQty);
}

/** Profit per bill line uses costPriceAtSale captured at billing (FR-38). */
export function lineProfit(bi, item = null) {
  const qty = Number(bi.qty) || 0;
  // costPriceAtSale is per BASE unit; the line's price and qty are in the unit
  // it was sold in, so cost per line unit is cost x conversion.
  const cost = (Number(bi.costPriceAtSale) || 0) * unitFactor(item, bi.unit);
  return r2((Number(bi.price) || 0) * qty - cost * qty);
}

/** Gross profit across bill lines, excluding voided bills. */
export function grossProfit(billItems = [], bills = [], items = []) {
  const voided = new Set(bills.filter((b) => b.status === 'voided').map((b) => b.id));
  const byId = new Map(items.map((i) => [i.id, i]));
  return r2(
    billItems
      .filter((bi) => !voided.has(bi.billId))
      .reduce((s, bi) => s + lineProfit(bi, byId.get(bi.itemId)), 0)
  );
}

/**
 * Payments that count as money COLLECTED from customers: not reversed, not an
 * opening float, and not a cheque the bank has yet to clear (or that bounced).
 * The same rule accountBalances() and billState() already follow, so
 * "collections" can never exceed what actually reached the till or the bank.
 */
export function collectedPayments(payments = [], cheques = []) {
  const uncleared = new Set(
    cheques.filter((c) => c.status !== 'cleared' && c.paymentId).map((c) => c.paymentId)
  );
  return payments.filter((p) => !p.reversed && !p.isOpening && !uncleared.has(p.id));
}

/**
 * Running balance per payment method (FR-40 / Plan 7.9).
 * Pending cheques are excluded from cash until cleared (FR-29).
 */
export function accountBalances(methods = [], {
  payments = [], expenses = [], employeeTx = [], cheques = [], supplierPayments = [],
} = {}) {
  const pendingOrBounced = new Set(
    cheques.filter((c) => c.status !== 'cleared' && c.paymentId).map((c) => c.paymentId)
  );

  return methods.map((m) => {
    const inflow = payments
      .filter((p) => p.method === m && !p.reversed && !pendingOrBounced.has(p.id))
      .reduce((s, p) => s + (Number(p.amount) || 0), 0);

    // A stock-loss write-off is an expense for the profit figures, but no money
    // left any account: the goods were damaged, not paid for again. Counting it
    // here (its blank method read as Cash) drained the cash balance.
    const outExp = expenses
      .filter((e) => !e.linkedStockLossId && (e.method || 'Cash') === m)
      .reduce((s, e) => s + (Number(e.amount) || 0), 0);

    const outSal = employeeTx
      .filter((t) => (t.method || 'Cash') === m && t.type !== 'bonus_accrual')
      .reduce((s, t) => s + (Number(t.amount) || 0), 0);

    // Money paid to suppliers for stock.
    const outSup = supplierPayments
      .filter((sp) => (sp.method || 'Cash') === m)
      .reduce((s, sp) => s + (Number(sp.amount) || 0), 0);

    const out = outExp + outSal + outSup;
    return { method: m, in: r2(inflow), out: r2(out), balance: r2(inflow - out) };
  });
}

/** Full chronological transaction history for one method, with running balance. */
export function accountLedger(method, {
  payments = [], expenses = [], employeeTx = [], cheques = [], parties = [], employees = [],
  supplierPayments = [], suppliers = [],
} = {}) {
  const pending = new Set(
    cheques.filter((c) => c.status !== 'cleared' && c.paymentId).map((c) => c.paymentId)
  );
  const partyName = (id) => parties.find((p) => p.id === id)?.name || 'Unknown party';
  const empName = (id) => employees.find((e) => e.id === id)?.name || 'Employee';
  const supplierName = (id) => suppliers.find((s) => s.id === id)?.name || 'Supplier';

  const rows = [];

  payments
    .filter((p) => p.method === method && !p.reversed && !pending.has(p.id))
    .forEach((p) => rows.push({
      id: p.id, date: p.date, direction: 'in', amount: r2(p.amount),
      desc: p.isOpening ? (p.note || 'Opening balance')
          : p.isAdvance ? `Advance from ${partyName(p.partyId)}`
          : `Payment from ${partyName(p.partyId)}`,
      relatedType: p.isOpening ? 'opening' : 'payment', relatedId: p.billId,
    }));

  expenses
    .filter((e) => !e.linkedStockLossId && (e.method || 'Cash') === method)   // write-offs are non-cash
    .forEach((e) => rows.push({
      id: e.id, date: e.date, direction: 'out', amount: r2(e.amount),
      desc: `${e.category}${e.note ? ` — ${e.note}` : ''}`, relatedType: 'expense', relatedId: e.id,
    }));

  employeeTx
    .filter((t) => (t.method || 'Cash') === method)
    .forEach((t) => rows.push({
      id: t.id, date: t.date, direction: 'out', amount: r2(t.amount),
      desc: `${t.type === 'salary' ? 'Salary' : t.type === 'advance' ? 'Advance' : 'Bonus'} — ${empName(t.employeeId)}`,
      relatedType: 'salary', relatedId: t.employeeId,
    }));

  supplierPayments
    .filter((sp) => (sp.method || 'Cash') === method)
    .forEach((sp) => rows.push({
      id: sp.id, date: sp.date, direction: 'out', amount: r2(sp.amount),
      desc: `${sp.isAdvance ? 'Advance to supplier' : 'Paid to supplier'} ${supplierName(sp.supplierId)}${sp.note ? ` — ${sp.note}` : ''}`,
      relatedType: 'supplier', relatedId: sp.supplierId,
    }));

  rows.sort((a, b) => new Date(a.date) - new Date(b.date) || String(a.id).localeCompare(String(b.id)));

  let bal = 0;
  return rows.map((rw) => {
    bal = r2(bal + (rw.direction === 'in' ? rw.amount : -rw.amount));
    return { ...rw, runningBalance: bal };
  });
}

/* ========================================================================
   Accounting suite
   ======================================================================== */

/** Stock value at current cost price. */
export function stockValue(items = [], data = {}) {
  return r2(
    // An oversold item (negative stock, goods still in transit) is not an asset
    // worth less than nothing — it must not pull the shop's stock value down.
    items.reduce((s, it) => s + Math.max(0, itemStock(it.id, data)) * (Number(it.costPrice) || 0), 0)
  );
}

/** Unpaid salary for the current month, per employee (FR-33). */
export function employeeMonthBalance(emp, employeeTx = [], monthISO = null) {
  const now = monthISO ? new Date(monthISO) : new Date();
  const y = now.getFullYear(), m = now.getMonth();

  const paid = employeeTx
    .filter((t) => {
      if (t.employeeId !== emp.id) return false;
      if (t.type === 'bonus') return false; // bonus is extra, not against salary
      const d = new Date(t.date);
      return d.getFullYear() === y && d.getMonth() === m;
    })
    .reduce((s, t) => s + (Number(t.amount) || 0), 0);

  const salary = Number(emp.monthlySalary) || 0;
  return { salary, paid: r2(paid), remaining: r2(Math.max(0, salary - paid)) };
}

/** Balance Sheet: Owns vs Owes (FR-43). */
export function balanceSheet(data) {
  const {
    items = [], assets = [], parties = [], employees = [], employeeTx = [],
    methods = [], bills = [],
  } = data;

  const balances = accountBalances(methods, data);
  const cashAndBank = r2(balances.reduce((s, b) => s + b.balance, 0));
  const derived = deriveBills(bills, data);
  const receivables = r2(parties.reduce((s, p) => s + partyDue(p.id, derived), 0));
  const stock = stockValue(items, data);
  const assetValue = r2(assets.reduce((s, a) => s + (Number(a.value) || 0), 0));

  const unpaidSalaries = r2(
    employees
      .filter((e) => e.status !== 'archived')
      .reduce((s, e) => s + employeeMonthBalance(e, employeeTx).remaining, 0)
  );

  // A supplier balance is one number that can land on either side: owed to
  // them (payable), or money already paid ahead that they hold (an advance).
  const supplierBalances = (data.suppliers || []).map((s) => supplierBalance(s.id, data));
  const payables = r2(supplierBalances.reduce((s, b) => s + Math.max(0, b), 0));
  const supplierAdvances = r2(supplierBalances.reduce((s, b) => s + Math.max(0, -b), 0));

  const owns = [
    { label: 'Cash & Bank Balances', value: cashAndBank },
    { label: 'Stock Value (at cost)', value: stock },
    { label: 'Receivables (party dues)', value: receivables },
    { label: 'Advances paid to suppliers', value: supplierAdvances },
    { label: 'Assets', value: assetValue },
  ];
  const owes = [
    { label: 'Payables (supplier dues)', value: payables },
    { label: 'Unpaid Salaries (this month)', value: unpaidSalaries },
  ];

  const totalOwns = r2(owns.reduce((s, x) => s + x.value, 0));
  const totalOwes = r2(owes.reduce((s, x) => s + x.value, 0));

  return { owns, owes, totalOwns, totalOwes, net: r2(totalOwns - totalOwes), balances };
}

/** Audit / Account summary for a date range (FR-44). */
export function auditSummary(data, from, to) {
  const { bills = [], payments = [], expenses = [], billItems = [], employeeTx = [] } = data;
  const inRange = (d) => {
    const x = new Date(d);
    return (!from || x >= new Date(from)) && (!to || x <= new Date(to + 'T23:59:59'));
  };

  const rangeBills = bills.filter((b) => b.status !== 'voided' && inRange(b.date));
  const derived = deriveBills(rangeBills, data);
  const billIds = new Set(rangeBills.map((b) => b.id));

  const sales = r2(derived.reduce((s, b) => s + b.net, 0));
  // Opening balances are a starting float, not collections from customers.
  const collections = r2(
    collectedPayments(payments, data.cheques || []).filter((p) => inRange(p.date))
      .reduce((s, p) => s + (Number(p.amount) || 0), 0)
  );
  const expenseTotal = r2(
    expenses.filter((e) => inRange(e.date)).reduce((s, e) => s + (Number(e.amount) || 0), 0)
  );
  const salaryTotal = r2(
    employeeTx.filter((t) => inRange(t.date)).reduce((s, t) => s + (Number(t.amount) || 0), 0)
  );
  const profit = grossProfit(billItems.filter((bi) => billIds.has(bi.billId)), bills, data.items || []);

  // Outstanding is a position, not a flow: it is what is owed right now across
  // EVERY bill, the same figure the Dashboard, Outstanding page and Balance
  // Sheet show. Summing only the bills dated inside the chosen range made this
  // row read lower than all of them (and contradicted its "all time" label).
  const allDerived = deriveBills(bills.filter((b) => b.status !== 'voided'), data);
  const outstanding = r2(allDerived.reduce((s, b) => s + b.due, 0));

  return {
    sales, collections, expenses: expenseTotal, salaries: salaryTotal,
    grossProfit: profit, netProfit: r2(profit - expenseTotal - salaryTotal),
    outstanding, billCount: rangeBills.length,
  };
}

/** Ledger Book rows: classic debit/credit running balance (FR-42). */
export function ledgerBook(data, partyId = null, from = null, to = null) {
  const { bills = [], payments = [], parties = [], returns = [] } = data;
  const inRange = (d) => {
    const x = new Date(d);
    return (!from || x >= new Date(from)) && (!to || x <= new Date(to + 'T23:59:59'));
  };
  const pname = (id) => parties.find((p) => p.id === id)?.name || 'Unknown';

  const rows = [];

  bills
    .filter((b) => b.status !== 'voided' && (!partyId || b.partyId === partyId) && inRange(b.date))
    .forEach((b) => rows.push({
      date: b.date, ref: b.billNo, party: pname(b.partyId), partyId: b.partyId,
      desc: `Sale — Bill ${b.billNo}`, debit: r2(b.totalAmount), credit: 0,
    }));

  payments
    // Opening balances are a starting float, not money received from a party,
    // so they never appear as ledger entries.
    .filter((p) => !p.reversed && !p.isOpening && (!partyId || p.partyId === partyId) && inRange(p.date))
    .forEach((p) => rows.push({
      date: p.date, ref: p.method, party: pname(p.partyId), partyId: p.partyId,
      desc: `Payment received — ${p.method}`, debit: 0, credit: r2(p.amount),
    }));

  returns
    .filter((rt) => inRange(rt.date))
    .forEach((rt) => {
      const bill = bills.find((b) => b.id === rt.billId);
      if (!bill) return;
      if (partyId && bill.partyId !== partyId) return;
      rows.push({
        date: rt.date, ref: bill.billNo, party: pname(bill.partyId), partyId: bill.partyId,
        desc: `Return against Bill ${bill.billNo}`, debit: 0, credit: r2(rt.valueAdjusted),
      });
    });

  rows.sort((a, b) => new Date(a.date) - new Date(b.date));

  let bal = 0;
  return rows.map((rw) => {
    bal = r2(bal + rw.debit - rw.credit);
    return { ...rw, balance: bal };
  });
}

/* ========================================================================
   Date range helper used across dashboard + reports (FR-45)
   ======================================================================== */

export function rangeFor(preset, custom = {}) {
  const now = new Date();
  const iso = (d) => {
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const start = new Date(now), end = new Date(now);

  switch (preset) {
    case 'today':
      break;
    case 'week': {
      const dow = (start.getDay() + 6) % 7; // Monday start
      start.setDate(start.getDate() - dow);
      break;
    }
    case 'month':
      start.setDate(1);
      break;
    case 'lastMonth': {
      start.setMonth(start.getMonth() - 1, 1);
      end.setDate(0);
      break;
    }
    case 'all':
      return { from: null, to: null, label: 'All time' };
    case 'custom':
      return { from: custom.from || null, to: custom.to || null, label: 'Custom' };
    default:
      break;
  }
  return { from: iso(start), to: iso(end), label: preset };
}

export function inRange(date, from, to) {
  const x = new Date(date);
  if (isNaN(x)) return false;
  if (from && x < new Date(from)) return false;
  if (to && x > new Date(to + 'T23:59:59')) return false;
  return true;
}

/* ========================================================================
   Party statement — every single entry, in date order
   ======================================================================== */

/**
 * Full running statement for ONE party: every bill, every payment (with the
 * method it came through), every return, advance and reversal, as its own
 * dated line with a running balance. This is the traditional khata view.
 *
 * Sign convention, from the shop's point of view:
 *   debit  = the party owes MORE (a sale)
 *   credit = the party owes LESS (a payment, return, or applied advance)
 *   balance = cumulative amount the party still owes
 *
 * A reversed payment is NOT hidden. The original line stays, and an offsetting
 * debit line is added, so the statement always explains how the balance moved
 * (Safety Guide 2.1 — nothing is silently removed).
 */
/** A date in any shape reduced to YYYY-MM-DD, or '' if it is not one. */
function dayOf(v) {
  if (!v) return '';
  const s = String(v);
  // Already a plain or ISO date: take the first ten characters rather than
  // parsing, so a timezone cannot shift the day.
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[0];
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * The advance a receipt row belongs to.
 *
 * Nothing links the two: addAdvance writes a PartyAdvances row and a Payments
 * receipt as separate records with their own ids. So they are matched on what
 * they have in common — and loosely, because the pair is written from one
 * action and cannot legitimately disagree:
 *
 *   1. party + amount + the same calendar day. Dates survive a round trip
 *      through Sheets in more than one shape ('2026-09-19', an ISO timestamp,
 *      a real Date), so the day is compared, never the raw string.
 *   2. failing that, party + amount alone. A receipt whose stored date drifted
 *      is still obviously the receipt for the one advance of that size.
 *
 * Returning null only when there is genuinely no candidate matters: the UI
 * disables its delete button on null, and a false negative leaves the
 * shopkeeper looking at a greyed-out button with no way forward.
 */
function advanceIdFor(payment, partyAdvances = [], claimed = new Set()) {
  const mine = partyAdvances.filter((a) => a.partyId === payment.partyId);
  if (!mine.length) return null;

  // Prefer an advance no earlier receipt has already taken. Two identical
  // advances produce two identical receipts, and without this both lines point
  // at the same row — deleting one then leaves the other's receipt orphaned.
  const free = mine.filter((a) => !claimed.has(a.id));
  const pool = free.length ? free : mine;

  const sameAmount = pool.filter((a) => r2(a.amount) === r2(payment.amount));
  if (sameAmount.length === 1) return sameAmount[0].id;
  if (sameAmount.length > 1) {
    const sameDay = sameAmount.find((a) => dayOf(a.dateReceived) === dayOf(payment.date));
    return (sameDay || sameAmount[0]).id;
  }

  // No advance of that amount. The receipt still belongs to one of them — the
  // amounts can disagree when a row was edited by hand in the Sheet — so fall
  // back to the same day, then to whatever is left. Returning null here would
  // grey out the delete button and leave the shopkeeper with no way to remove
  // the advance at all, which is worse than picking the likeliest row and
  // showing them its amount in the confirmation.
  const sameDay = pool.find((a) => dayOf(a.dateReceived) === dayOf(payment.date));
  return (sameDay || pool[0]).id;
}

/** When a time-based id (`pay_<base36 ms><5 random>`) was created, or NaN. */
function idTime(id) {
  const m = /^[a-z]+_([0-9a-z]+)$/.exec(String(id || ''));
  if (!m || m[1].length <= 5) return NaN;
  return parseInt(m[1].slice(0, -5), 36);
}

/**
 * Which payments are parts of one account payment, as paymentId -> group key.
 *
 * Newer parts carry the groupId settleParty gave them. Older ones were written
 * without it, so parts saved in the same instant — same day, method and note,
 * against different bills, within two seconds — are taken to be one receipt.
 * Only groups of two or more are returned.
 */
function paymentGroups(payments) {
  const out = new Map();
  const byKey = new Map();
  const add = (key, id) => {
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(id);
  };

  const loose = [];
  for (const p of payments) {
    if (p.groupId) add(`g:${p.groupId}`, p.id);
    else if (p.billId && !p.isAdvance && Number.isFinite(idTime(p.id))) loose.push(p);
  }

  loose.sort((a, b) => idTime(a.id) - idTime(b.id));
  let run = [];
  const flush = () => {
    if (run.length > 1) run.forEach((p) => add(`t:${run[0].id}`, p.id));
    run = [];
  };
  for (const p of loose) {
    const prev = run[run.length - 1];
    const joins = prev
      && p.date === prev.date && p.method === prev.method
      && String(p.note || '') === String(prev.note || '')
      && !run.some((x) => x.billId === p.billId)
      && idTime(p.id) - idTime(prev.id) <= 2000;
    if (!joins) flush();
    run.push(p);
  }
  flush();

  for (const [key, ids] of byKey) {
    if (ids.length > 1) ids.forEach((id) => out.set(id, key));
  }
  return out;
}

/**
 * Join the statement lines of one account payment into a single line:
 * "Bill 2026-0001: Rs 500 · Bill 2026-0002: Rs 500 = Rs 1,000".
 *
 * Only parts in the same state are joined — a reversed part, or one whose
 * cheque bounced, stays its own line so its effect stays visible. The parts
 * ride along in `parts`, so a screen can still open each one to edit or
 * delete it.
 */
function mergePaymentGroups(rows) {
  const groups = new Map();
  const out = [];
  const seenInfo = new Set();

  for (const r of rows) {
    // An overpayment kept as advance stays its own line: deleting it removes
    // the advance balance too, which only its own line can do.
    if (r.groupKey && r.paymentId && !r.isAdvance) {
      const k = `${r.groupKey}|${r.type}|${r.struck ? 1 : 0}|${r.date}`;
      if (!groups.has(k)) {
        groups.set(k, []);
        out.push({ __group: k });
      }
      groups.get(k).push(r);
      continue;
    }
    // One "cheque cleared" / "bounced" line per receipt, not one per part.
    if (r.groupKey && r.info) {
      const k = `${r.groupKey}|${r.title}|${r.date}`;
      if (seenInfo.has(k)) continue;
      seenInfo.add(k);
    }
    out.push(r);
  }

  return out.map((r) => {
    if (!r.__group) return r;
    const parts = groups.get(r.__group);
    if (parts.length === 1) return parts[0];

    const lead = parts[0];
    const total = r2(parts.reduce((t, x) => t + (x.originalAmount || 0), 0));
    const pieces = parts.map((x) => `Bill ${x.billNo || '?'}: ${money2(x.originalAmount)}`);
    const notes = [...new Set(parts.map((x) => x.noteText).filter(Boolean))];

    return {
      id: `grp-${parts[0].id}`,
      date: lead.date,
      type: lead.type,
      title: lead.title,
      detail: [pieces.join(', ') + ` = ${money2(total)}`, lead.chequeText, ...notes]
        .filter(Boolean).join(' · '),
      method: lead.method,
      ref: lead.ref,
      debit: 0,
      credit: r2(parts.reduce((t, x) => t + (x.credit || 0), 0)),
      pending: r2(parts.reduce((t, x) => t + (x.pending || 0), 0)),
      originalAmount: total,
      struck: lead.struck,
      reversed: parts.every((x) => x.reversed),
      paymentId: null,
      chequeId: null,
      billId: null,
      parts,
    };
  });
}

export function partyStatement(partyId, data = {}, from = null, to = null) {
  const {
    bills = [], payments = [], returns = [], billItems = [],
    items = [], cheques = [], partyAdvances = [],
  } = data;

  const within = (d) => inRange(d, from, to);
  const itemName = (id) => items.find((i) => i.id === id)?.name || 'Item';

  // Advances already spoken for by an earlier receipt, so two identical
  // advances map to two different rows rather than both to the first.
  const claimedAdvances = new Set();
  const claimAdvance = (pay, advances, claimed) => {
    const id = advanceIdFor(pay, advances, claimed);
    if (id) claimed.add(id);
    return id;
  };

  const myBills = bills.filter((b) => b.partyId === partyId);
  const billById = new Map(myBills.map((b) => [b.id, b]));

  const rows = [];

  /* ---- Bills raised (debit) ---- */
  myBills.forEach((b) => {
    if (!within(b.date)) return;
    const lines = billItems.filter((bi) => bi.billId === b.id);
    const summary = lines.length
      ? lines.map((l) => `${itemName(l.itemId)} ${l.qty}${l.unit ? ' ' + l.unit : ''}`).join(', ')
      : '';

    if (b.status === 'voided') {
      // A voided bill never counted, but it must still be visible in history.
      rows.push({
        id: `bill-${b.id}`, date: b.date, type: 'void', billId: b.id,
        ref: b.billNo, title: `Bill ${b.billNo} — VOIDED`,
        detail: b.voidReason || 'Cancelled', method: '',
        debit: 0, credit: 0, voided: true,
      });
      return;
    }

    rows.push({
      id: `bill-${b.id}`, date: b.date, type: 'bill', billId: b.id,
      ref: b.billNo, title: `Bill ${b.billNo}`,
      detail: summary, method: '',
      debit: r2(b.totalAmount), credit: 0,
    });
  });

  /* ---- Payments received (credit), and reversals (debit back) ---- */
  const groupOf = paymentGroups(payments.filter((p) => p.partyId === partyId && !p.isOpening));
  payments
    .filter((p) => p.partyId === partyId && !p.isOpening)
    .forEach((p) => {
      const bill = p.billId ? billById.get(p.billId) : null;
      const chq = cheques.find((c) => c.paymentId === p.id);

      let detail = bill ? `Against Bill ${bill.billNo}` : 'On account';
      if (p.isAdvance) detail = 'Advance received (not against a bill)';
      if (chq) {
        detail += ` · Cheque ${chq.chequeNo || ''}${chq.bankName ? ' / ' + chq.bankName : ''}`.trimEnd();
        if (chq.accountHolder) detail += ` (A/c ${chq.accountHolder})`;
        // When the money is expected, or when it actually arrived. "Awaiting
        // clearance" on its own tells the shopkeeper nothing about whether to
        // chase it today or next week, and a cleared cheque that does not say
        // when leaves the ledger unable to answer "has this been paid?".
        if (chq.status === 'pending') {
          detail += chq.dateDue
            ? ` — clears ${fmtDate(chq.dateDue)}`
            : ' — awaiting clearance';
        }
        if (chq.status === 'cleared' && chq.statusChangedAt) {
          detail += ` — cleared ${fmtDate(chq.statusChangedAt)}`;
        }
        if (chq.status === 'bounced') {
          detail += chq.statusChangedAt
            ? ` — BOUNCED ${fmtDate(chq.statusChangedAt)}`
            : ' — BOUNCED';
        }
      }
      if (p.note) detail += ` · ${p.note}`;

      // A cheque only settles the balance once the bank clears it. A bounced
      // one never will; a pending one has not yet. Both stay visible as their
      // own line — the party needs to see the cheque was received — but
      // neither reduces what is owed until it clears.
      const bounced = chq && chq.status === 'bounced';
      const awaiting = chq && chq.status !== 'cleared' && !bounced;

      if (within(p.date)) {
        rows.push({
          id: `pay-${p.id}`, date: p.date,
          type: awaiting ? 'cheque-pending' : (p.isAdvance ? 'advance' : 'payment'),
          // The records behind this line, so a screen can offer Edit/Delete
          // without parsing them back out of the composite `id`.
          paymentId: p.id,
          chequeId: chq ? chq.id : null,
          isAdvance: Boolean(p.isAdvance),
          // The advance this receipt records, so the statement can delete the
          // whole thing rather than refusing and sending the user elsewhere.
          advanceId: p.isAdvance ? claimAdvance(p, partyAdvances, claimedAdvances) : null,
          reversed: Boolean(p.reversed),
          billId: p.billId || null, ref: p.method,
          title: awaiting
            ? `Cheque received — ${chq.bankName || p.method}`
            : (p.isAdvance ? 'Advance received' : `Payment — ${p.method}`),
          detail, method: p.method,
          debit: 0,
          // An advance is credited when it is SPENT, not when it arrives.
          //
          // Receiving one does not reduce what the party owes — the money sits
          // with the shop until a bill consumes it, and that consumption is its
          // own 'Advance' payment row which carries the credit. Crediting the
          // receipt as well counts the same rupees twice, so the statement's
          // closing balance drifts below what the bills actually say is owed.
          //
          // The line still appears, showing the amount received, because the
          // party needs to see their money arriving on their own statement.
          credit: (p.reversed || bounced || awaiting || p.isAdvance) ? 0 : r2(p.amount),
          struck: Boolean(p.reversed || bounced),
          // Shown in its own column rather than as a credit, so the ledger
          // reads "received, not yet cleared" instead of "not paid".
          pending: awaiting ? r2(p.amount) : 0,
          originalAmount: r2(p.amount),
          // For joining the parts of one account payment back into one line.
          groupKey: groupOf.get(p.id) || null,
          billNo: bill ? bill.billNo : '',
          chequeText: chq
            ? `Cheque ${chq.chequeNo || ''}${chq.bankName ? ' / ' + chq.bankName : ''}`.trimEnd()
            : '',
          noteText: p.note || '',
        });
      }

      // Reversal shown as its own dated line so the balance change is explained.
      if (p.reversed && within(p.reversedAt || p.date)) {
        rows.push({
          id: `rev-${p.id}`, date: (p.reversedAt || p.date).slice(0, 10), type: 'reversal',
          billId: p.billId || null, ref: p.method,
          title: `Payment reversed — ${p.method}`,
          detail: p.reverseReason || 'Entered in error',
          method: p.method, debit: 0, credit: 0, info: true,
        });
      }

      // When it clears, the credit lands on the payment row above. Without a
      // dated line saying so, the balance would appear to change on the day the
      // cheque was written rather than the day the money arrived.
      if (chq && chq.status === 'cleared' && chq.statusChangedAt &&
          chq.statusChangedAt.slice(0, 10) !== p.date && within(chq.statusChangedAt)) {
        rows.push({
          id: `clr-${p.id}`, date: chq.statusChangedAt.slice(0, 10), type: 'info',
          billId: p.billId || null, ref: chq.chequeNo || p.method,
          title: `Cheque cleared — ${chq.bankName || p.method}`,
          detail: `Cheque ${chq.chequeNo || ''} cleared the bank`.trim(),
          method: p.method, debit: 0, credit: 0, info: true,
          groupKey: groupOf.get(p.id) || null,
        });
      }

      if (bounced && within(chq.statusChangedAt || p.date)) {
        rows.push({
          id: `bnc-${p.id}`, date: (chq.statusChangedAt || p.date).slice(0, 10), type: 'bounced',
          billId: p.billId || null, ref: chq.chequeNo || p.method,
          title: `Cheque bounced — ${chq.bankName || p.method}`,
          detail: `Cheque ${chq.chequeNo || ''} returned unpaid, amount reopened`.trim(),
          method: p.method, debit: 0, credit: 0, info: true,
          groupKey: groupOf.get(p.id) || null,
        });
      }
    });

  /* ---- Returns (credit) ---- */
  returns.forEach((rt) => {
    const bill = billById.get(rt.billId);
    if (!bill || !within(rt.date)) return;
    rows.push({
      id: `ret-${rt.id}`, date: rt.date, type: 'return', billId: rt.billId,
      ref: bill.billNo,
      title: `Return against Bill ${bill.billNo}`,
      detail: `${itemName(rt.itemId)} × ${rt.qty}${rt.restock ? ' (restocked)' : ''}${rt.note ? ' · ' + rt.note : ''}`,
      method: '', debit: 0, credit: r2(rt.valueAdjusted),
    });
  });

  /* ---- Advance applied to a bill (credit already counted via Payments) ---- */
  partyAdvances
    .filter((a) => a.partyId === partyId && Number(a.applied) > 0)
    .forEach((a) => {
      if (!within(a.dateReceived)) return;
      rows.push({
        id: `advapp-${a.id}`, date: a.dateReceived, type: 'info',
        ref: '', title: 'Advance applied to billing',
        detail: `${money2(a.applied)} of the ${money2(a.amount)} advance has been used`,
        method: a.method || '', debit: 0, credit: 0, info: true,
      });
    });

  const merged = mergePaymentGroups(rows);

  /* ---- Order by date, then by a sensible within-day sequence ---- */
  const typeOrder = {
    bill: 0, payment: 1, advance: 1, 'cheque-pending': 1,
    return: 2, reversal: 3, bounced: 3, void: 4, info: 5,
  };
  rows.length = 0;
  rows.push(...merged);
  rows.sort((a, b) =>
    new Date(a.date) - new Date(b.date) ||
    (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9) ||
    String(a.id).localeCompare(String(b.id))
  );

  let balance = 0;
  return rows.map((r) => {
    balance = r2(balance + r.debit - r.credit);
    return { ...r, balance };
  });
}

/* ========================================================================
   Suppliers — the buying side
   ======================================================================== */

/*
 * A supplier account is kept the way a supplier khata is kept on paper: one
 * running balance of what the shop owes them.
 *
 *   + opening balance (owed before this system was used)
 *   + every purchase bill that was not cancelled
 *   − every payment made to them
 *   − the value of goods sent back to them
 *
 * Positive means the shop owes the supplier. Negative means the shop has paid
 * ahead and the supplier is holding that money as an advance, which the next
 * purchase bill uses up. No separate advance record is needed: overpaying is
 * simply a balance below zero.
 */

/** What the shop owes one supplier (negative = advance held by the supplier). */
export function supplierBalance(supplierId, {
  suppliers = [], purchaseBills = [], supplierPayments = [], supplierReturns = [],
} = {}) {
  const opening = Number(suppliers.find((s) => s.id === supplierId)?.openingBalance) || 0;
  const bought = purchaseBills
    .filter((b) => b.supplierId === supplierId && b.status !== 'voided')
    .reduce((s, b) => s + (Number(b.totalAmount) || 0), 0);
  const paid = supplierPayments
    .filter((p) => p.supplierId === supplierId)
    .reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const returned = supplierReturns
    .filter((r) => r.supplierId === supplierId)
    .reduce((s, r) => s + (Number(r.value) || 0), 0);
  return r2(opening + bought - paid - returned);
}

/**
 * What the whole account with one supplier comes to. For a supplier that is
 * also a customer (linked to a party) the shop's sales to them are netted in —
 * the same figure as Net Balance on the party ledger and the last line of the
 * supplier ledger — so every screen shows one number for one account.
 *
 * Positive: the shop owes them. Negative: they owe the shop (an advance held
 * by them, or what they owe on sales). A supplier with no linked party is just
 * supplierBalance.
 *
 * `derivedBills` is deriveBills(data.bills, data); pass it when working out
 * many suppliers so it is computed once.
 */
export function supplierNetBalance(supplierId, data = {}, derivedBills = null) {
  const own = supplierBalance(supplierId, data);
  const partyId = (data.suppliers || []).find((s) => s.id === supplierId)?.partyId;
  if (!partyId || !(data.parties || []).some((p) => p.id === partyId)) return own;
  const derived = derivedBills || deriveBills(data.bills, data);
  return r2(own - partySalesPosition(partyId, derived));
}

/**
 * What a party owes the shop on sales, for netting against purchases: bills
 * still due, less any overpaid money no open bill could absorb (the party is
 * in credit). Counting the credit keeps the net equal to the ledger's closing
 * balance, which also shows it.
 */
export function partySalesPosition(partyId, derivedBills = []) {
  return r2(partyDue(partyId, derivedBills) - partyUnappliedCredit(partyId, derivedBills));
}

/**
 * Every purchase bill of one supplier with paid / due / status worked out.
 *
 * Money is matched to bills the way a shopkeeper would: a payment or return
 * made against a particular bill settles that bill first. Everything else — a
 * payment on account, or whatever was left over — settles the opening balance
 * and then the oldest bill still open. So paying at the time of purchase always
 * shows that bill as paid, and a lump sum clears the oldest dues first.
 */
export function derivePurchaseBills(supplierId, {
  suppliers = [], purchaseBills = [], supplierPayments = [], supplierReturns = [],
} = {}) {
  const bills = purchaseBills
    .filter((b) => b.supplierId === supplierId)
    .sort((a, b) => String(a.date).localeCompare(String(b.date))
      || String(a.purchaseNo).localeCompare(String(b.purchaseNo)));

  const open = new Map();
  bills.forEach((b) => {
    open.set(b.id, b.status === 'voided' ? 0 : r2(b.totalAmount));
  });
  const settled = new Map(bills.map((b) => [b.id, 0]));
  const returnedOn = new Map(bills.map((b) => [b.id, 0]));

  let pool = 0;
  const settle = (billId, amount) => {
    const left = open.get(billId) || 0;
    const use = r2(Math.min(left, amount));
    open.set(billId, r2(left - use));
    settled.set(billId, r2(settled.get(billId) + use));
    return r2(amount - use);
  };

  supplierPayments
    .filter((p) => p.supplierId === supplierId)
    .forEach((p) => {
      const amt = r2(p.amount);
      pool = r2(pool + (p.purchaseBillId && open.has(p.purchaseBillId)
        ? settle(p.purchaseBillId, amt) : amt));
    });

  supplierReturns
    .filter((r) => r.supplierId === supplierId)
    .forEach((r) => {
      const amt = r2(r.value);
      if (r.purchaseBillId && returnedOn.has(r.purchaseBillId)) {
        returnedOn.set(r.purchaseBillId, r2(returnedOn.get(r.purchaseBillId) + amt));
        pool = r2(pool + settle(r.purchaseBillId, amt));
      } else {
        pool = r2(pool + amt);
      }
    });

  // Unmatched money clears the opening balance first, then the oldest bills.
  // A negative opening balance is an advance from before, and counts as money
  // already paid.
  const opening = Number(suppliers.find((s) => s.id === supplierId)?.openingBalance) || 0;
  pool = opening < 0 ? r2(pool - opening) : r2(pool - Math.min(pool, opening));
  for (const b of bills) {
    if (pool <= 0.004) break;
    pool = settle(b.id, pool);
  }

  return bills.map((b) => {
    const total = r2(b.totalAmount);
    const due = b.status === 'voided' ? 0 : r2(open.get(b.id));
    let status;
    if (b.status === 'voided') status = 'voided';
    else if (due <= 0.004) status = 'paid';
    else if (due < total - 0.004) status = 'partial';
    else status = 'due';
    return {
      ...b, total, due, status,
      paid: r2(settled.get(b.id) - returnedOn.get(b.id)),
      returned: r2(returnedOn.get(b.id)),
    };
  }).reverse();
}

/** The item lines of one purchase bill. */
export function purchaseBillLines(purchaseBillId, { purchases = [] } = {}) {
  return purchases.filter((p) => p.purchaseBillId === purchaseBillId);
}

/**
 * Full running statement for one supplier, oldest first.
 *
 *   debit  = the shop owes MORE (a purchase, or the opening balance)
 *   credit = the shop owes LESS (a payment, or goods sent back)
 *   balance = what the shop owes; below zero is an advance with the supplier
 *
 * A cancelled purchase bill stays visible but moves nothing.
 */
export function supplierStatement(supplierId, data = {}, from = null, to = null) {
  const {
    suppliers = [], purchaseBills = [], supplierPayments = [], supplierReturns = [],
    purchases = [], items = [],
  } = data;
  const supplier = suppliers.find((s) => s.id === supplierId);
  const itemName = (id) => items.find((i) => i.id === id)?.name || 'Item';
  const billById = new Map(purchaseBills.map((b) => [b.id, b]));
  const rows = [];

  const opening = r2(supplier?.openingBalance);
  if (opening) {
    rows.push({
      id: `open-${supplierId}`, date: dayOf(supplier.createdAt) || '0000-01-01', type: 'opening',
      title: 'Opening balance', detail: opening > 0 ? 'Owed before this record began' : 'Advance before this record began',
      debit: opening > 0 ? opening : 0, credit: opening < 0 ? -opening : 0,
    });
  }

  purchaseBills.filter((b) => b.supplierId === supplierId).forEach((b) => {
    const lines = purchases.filter((p) => p.purchaseBillId === b.id);
    const summary = lines.map((l) => `${itemName(l.itemId)} ${l.qty} @ ${money2(l.costPrice)}`).join(', ');
    const ref = b.invoiceNo ? `${b.purchaseNo} · Inv ${b.invoiceNo}` : b.purchaseNo;
    rows.push(b.status === 'voided'
      ? {
          id: `pb-${b.id}`, date: b.date, type: 'void', purchaseBillId: b.id,
          title: `Purchase ${ref} — CANCELLED`, detail: b.voidReason || summary,
          debit: 0, credit: 0, voided: true,
        }
      : {
          id: `pb-${b.id}`, date: b.date, type: 'purchase', purchaseBillId: b.id,
          title: `Purchase ${ref}`, detail: [summary, b.note].filter(Boolean).join(' · '),
          debit: r2(b.totalAmount), credit: 0,
        });
  });

  supplierPayments.filter((p) => p.supplierId === supplierId).forEach((p) => {
    const bill = p.purchaseBillId ? billById.get(p.purchaseBillId) : null;
    rows.push({
      id: `sp-${p.id}`, date: p.date, type: 'payment', paymentId: p.id,
      title: p.isAdvance ? `Advance given — ${p.method}` : `Paid — ${p.method}`,
      detail: [p.isAdvance ? 'Advance to supplier' : bill ? `Against purchase ${bill.purchaseNo}` : 'On account',
               p.note].filter(Boolean).join(' · '),
      isAdvance: Boolean(p.isAdvance),
      method: p.method, debit: 0, credit: r2(p.amount),
    });
  });

  supplierReturns.filter((r) => r.supplierId === supplierId).forEach((r) => {
    const bill = r.purchaseBillId ? billById.get(r.purchaseBillId) : null;
    rows.push({
      id: `sr-${r.id}`, date: r.date, type: 'return', returnId: r.id,
      title: bill ? `Returned to supplier — purchase ${bill.purchaseNo}` : 'Returned to supplier',
      detail: `${itemName(r.itemId)} × ${r.qty}${r.note ? ` · ${r.note}` : ''}`,
      debit: 0, credit: r2(r.value),
    });
  });

  const order = { opening: 0, purchase: 1, void: 1, payment: 2, return: 3 };
  rows.sort((a, b) => String(a.date).localeCompare(String(b.date))
    || (order[a.type] ?? 9) - (order[b.type] ?? 9)
    || String(a.id).localeCompare(String(b.id)));

  let balance = 0;
  return rows
    .map((r) => { balance = r2(balance + r.debit - r.credit); return { ...r, balance }; })
    .filter((r) => r.type === 'opening' || inRange(r.date, from, to));
}

/* ========================================================================
   A party who also sells to the shop
   ======================================================================== */

/*
 * Some customers are suppliers too. Their buying side lives in an ordinary
 * Suppliers row carrying the party's id, so purchases, stock, cost prices and
 * supplier payments all work exactly as for any supplier. The party ledger then
 * reads both sides as one khata:
 *
 *   net = what they owe on sales − what the shop owes them on purchases
 *
 * Positive: the party owes the shop. Negative: the shop owes the party.
 */

/** The supplier record that is this party's buying side, if any. */
export function linkedSupplier(partyId, suppliers = []) {
  return suppliers.find((s) => s.partyId && s.partyId === partyId) || null;
}

/**
 * One running statement covering both sides, oldest first.
 *
 * The sales rows are partyStatement's own. The purchase rows are the linked
 * supplier's statement with the sign flipped to the party's point of view:
 * buying from them is a credit (they are owed for it, so they owe less), and
 * paying them or sending goods back is a debit.
 */
export function partyCombinedStatement(partyId, data = {}, from = null, to = null) {
  const sales = partyStatement(partyId, data, from, to);
  const sup = linkedSupplier(partyId, data.suppliers);
  if (!sup) return sales;

  const purchaseRows = supplierStatement(sup.id, data, from, to).map((r) => {
    const { balance, paymentId, returnId, ...rest } = r;
    return {
      ...rest,
      // Distinct names, so the ledger's buttons for a sale payment can never
      // be pointed at a supplier payment.
      supplierPaymentId: paymentId || null,
      supplierReturnId: returnId || null,
      side: 'purchase',
      type: r.type === 'void' ? 'void' : `sup-${r.type}`,
      title: r.type === 'purchase' ? r.title.replace(/^Purchase /, 'Bought from them — ')
        : r.type === 'payment' ? r.title.replace(/^(Paid|Advance given)/, (m) =>
            (m === 'Paid' ? 'Paid to them' : 'Advance given to them'))
        : r.type === 'return' ? r.title.replace(/^Returned to supplier/, 'Goods returned to them')
        : r.type === 'opening' ? 'Opening balance (purchases)'
        : r.title,
      debit: r.credit,
      credit: r.debit,
    };
  });

  const typeOrder = {
    'sup-opening': -1, bill: 0, 'sup-purchase': 0, void: 4,
    payment: 1, advance: 1, 'cheque-pending': 1, 'sup-payment': 1,
    return: 2, 'sup-return': 2, reversal: 3, bounced: 3, info: 5,
  };
  const rows = [...sales.map(({ balance, ...r }) => r), ...purchaseRows];
  rows.sort((a, b) =>
    String(dayOf(a.date)).localeCompare(String(dayOf(b.date))) ||
    (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9) ||
    String(a.id).localeCompare(String(b.id))
  );

  let balance = 0;
  return rows.map((r) => {
    balance = r2(balance + r.debit - r.credit);
    return { ...r, balance };
  });
}

/**
 * The same combined statement, from the supplier's side: what the shop owes
 * them, with their purchases from the shop netted in. Sales rows are the
 * party's own statement with the sign flipped — a sale to them reduces what
 * the shop owes, money received from them raises it again.
 *
 * A supplier with no linked party gets its plain statement.
 */
export function supplierCombinedStatement(supplierId, data = {}, from = null, to = null) {
  const purchases = supplierStatement(supplierId, data, from, to);
  const sup = (data.suppliers || []).find((s) => s.id === supplierId);
  const partyId = sup?.partyId;
  if (!partyId || !(data.parties || []).some((p) => p.id === partyId)) return purchases;

  const salesRows = partyStatement(partyId, data, from, to).map((r) => {
    const { balance, ...rest } = r;
    return {
      ...rest,
      side: 'sale',
      type: `sale-${r.type}`,
      debit: r.credit,
      credit: r.debit,
      // Uncleared cheques stay shown in brackets, on the side they reduce.
      pendingSide: r.pending > 0 ? 'debit' : undefined,
    };
  });

  const order = {
    opening: -1, purchase: 0, 'sale-bill': 0, void: 4, 'sale-void': 4,
    payment: 1, 'sale-payment': 1, 'sale-advance': 1, 'sale-cheque-pending': 1,
    return: 2, 'sale-return': 2, 'sale-reversal': 3, 'sale-bounced': 3, 'sale-info': 5,
  };
  const rows = [...purchases.map(({ balance, ...r }) => ({ ...r, side: 'purchase' })), ...salesRows];
  rows.sort((a, b) =>
    String(dayOf(a.date)).localeCompare(String(dayOf(b.date))) ||
    (order[a.type] ?? 9) - (order[b.type] ?? 9) ||
    String(a.id).localeCompare(String(b.id))
  );

  let balance = 0;
  return rows.map((r) => {
    balance = r2(balance + r.debit - r.credit);
    return { ...r, balance };
  });
}

/**
 * Filter tabs for a ledger. Each statement row belongs to exactly one, apart
 * from 'all' (everything) and 'cheques' (any line about a cheque, whichever
 * other tab it sits in).
 */
export const LEDGER_TABS = [
  { value: 'all', label: 'All' },
  { value: 'sales', label: 'Sales' },
  { value: 'purchases', label: 'Purchases' },
  { value: 'received', label: 'Received' },
  { value: 'paid', label: 'Paid' },
  { value: 'returns', label: 'Returns' },
  { value: 'cheques', label: 'Cheques' },
];

/**
 * Which tab a statement row belongs to. Works on the party statement, the
 * supplier statement and both combined ones: purchase-side rows carry
 * side 'purchase' (or a 'sup-' type), sales-side rows everything else.
 */
export function ledgerTabOf(row, { supplierView = false } = {}) {
  const t = String(row?.type || '');
  const purchaseSide = row?.side === 'purchase' || t.startsWith('sup-')
    || (supplierView && row?.side !== 'sale');
  const base = t.replace(/^(sup|sale)-/, '');
  if (base === 'opening') return 'other';
  if (purchaseSide) {
    if (base === 'purchase' || base === 'void') return 'purchases';
    if (base === 'payment') return 'paid';
    if (base === 'return') return 'returns';
    return 'other';
  }
  if (base === 'bill' || base === 'void') return 'sales';
  if (base === 'return') return 'returns';
  // Payments, advances, cheques waiting or bounced, reversals, and the info
  // lines that explain them are all money coming in.
  return 'received';
}

/** Does a statement row belong on the given tab? */
export function inLedgerTab(row, tab, opts) {
  if (!tab || tab === 'all') return true;
  if (tab === 'cheques') {
    const t = String(row?.type || '');
    return Boolean(row?.chequeId) || /cheque-pending|bounced/.test(t)
      || (/info/.test(t) && /^Cheque/.test(row?.title || ''));
  }
  return ledgerTabOf(row, opts) === tab;
}

/** Local currency helper so this module has no import cycle with format.js. */
function money2(n) {
  const v = Number(n) || 0;
  return 'Rs ' + v.toLocaleString('en-PK', { maximumFractionDigits: 2 });
}
