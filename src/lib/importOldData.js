// One-time import of the shop's old Excel records ("8 NOV.xlsx") into the app:
// suppliers, the items bought from each, one purchase bill per supplier, what
// was paid to them, and what has already been sold (as old sales bills to a
// single "Old Data Sales" customer, so Sold / Available come out right).
//
// The Excel was converted to "old data/oldData.json", which stays on the shop's
// own computer: it holds supplier names, costs and payments, so it is never
// bundled into the app or committed to git. Settings asks for that file.
// Everything goes through the normal api.* calls, so it works on local storage and on the Sheets backend,
// and every record is logged like any other entry.
//
// Safe to run again, also after a failure half-way: suppliers, items and the
// customer are reused by name, and each purchase bill, payment and old sales
// bill is created only if it is not there yet. (Writes are never retried by the
// app on its own, so a dropped connection stops here and a second run finishes.)
//
// Money is recorded under the method "Old Data" — not Cash or Bank — so the
// Accounts screen (cash and bank balances) is not changed by history.

import { billTotals } from './calc';
import { norm, r2 } from './format';

export const IMPORT_TAG = 'Imported from old Excel (8 NOV)';
export const IMPORT_METHOD = 'Old Data';
export const OLD_SALES_PARTY = 'Old Data Sales';

/** Read the chosen file's text, or throw a message fit for the person choosing it. */
export function parseOldData(text) {
  let d;
  try { d = JSON.parse(text); } catch { throw new Error('That file is not valid JSON.'); }
  const ok = d && Array.isArray(d.suppliers) && d.suppliers.length
    && d.suppliers.every((s) => s && s.name && Array.isArray(s.rows) && Array.isArray(s.payments));
  if (!ok) throw new Error('That is not the old-data file (expected oldData.json with suppliers).');
  return d;
}

/** What the import will create, for the confirmation screen. */
export function previewOldData(oldData) {
  const sups = oldData.suppliers;
  const names = new Set();
  sups.forEach((s) => s.rows.forEach((r) => names.add(norm(r.item))));
  const bought = sups.reduce((a, s) => a + s.rows.reduce((x, r) => x + r.qty * r.cost, 0), 0);
  const paid = sups.reduce((a, s) => a + s.payments.reduce((x, p) => x + p.amount, 0), 0);
  const revenue = sups.reduce((a, s) => a + s.rows.reduce((x, r) => x + r.revenue, 0), 0);
  return {
    suppliers: sups.length,
    items: names.size,
    lines: sups.reduce((a, s) => a + s.rows.length, 0),
    payments: sups.reduce((a, s) => a + s.payments.length, 0),
    bought: r2(bought), paid: r2(paid), revenue: r2(revenue),
    asOf: oldData.asOf,
  };
}

/**
 * Run the import.
 * @param api       the app's api object
 * @param data      current app data (to reuse what already exists)
 * @param settings  app settings (rounding rule for the old sales bills)
 * @param oldData   the parsed oldData.json (see parseOldData)
 * @param onStep    (text) => void, for progress
 */
export async function importOldData({ api, data, settings, oldData, onStep = () => {} }) {
  const key = (s) => norm(s).toLowerCase();
  const supByName = new Map((data.suppliers || []).map((s) => [key(s.name), s]));
  const itemByName = new Map((data.items || []).map((i) => [key(i.name), i]));
  const billDone = new Set((data.purchaseBills || [])
    .filter((b) => b.note === IMPORT_TAG).map((b) => b.supplierId));
  const payKey = (supplierId, p) => `${supplierId}|${p.date}|${r2(p.amount)}|${p.note}`;
  const payDone = new Set((data.supplierPayments || [])
    .map((p) => `${p.supplierId}|${p.date}|${r2(p.amount)}|${p.note}`));
  const salesDone = new Set((data.bills || [])
    .filter((b) => String(b.note || '').startsWith(IMPORT_TAG)).map((b) => b.note));

  const result = { suppliers: 0, skipped: [], items: 0, purchases: 0, payments: 0, sales: 0 };
  const total = oldData.suppliers.length;
  let n = 0;

  let party = (data.parties || []).find((p) => key(p.name) === key(OLD_SALES_PARTY));

  for (const s of oldData.suppliers) {
    n += 1;
    const at = `(${n}/${total}) ${s.name}`;
    onStep(`${at}: supplier`);
    let sup = supByName.get(key(s.name));
    if (!sup) {
      sup = await api.saveSupplier({ name: s.name, address: s.address || '', phone: '', openingBalance: 0 });
      supByName.set(key(s.name), sup);
      result.suppliers += 1;
    }

    // Items (one per distinct name; the cost of the latest row becomes its cost price).
    const lines = [];
    let made = 0;
    for (const r of s.rows) {
      made += 1;
      const k = key(r.item);
      let item = itemByName.get(k);
      if (!item) {
        onStep(`${at}: item ${made}/${s.rows.length}`);
        item = await api.saveItem({
          name: norm(r.item), baseUnit: 'Piece', category: s.category || '',
          costPrice: r.cost, openingStock: 0, lowStockAlert: 0,
        });
        itemByName.set(k, item);
        result.items += 1;
      }
      lines.push({ itemId: item.id, qty: r.qty, costPrice: r.cost, row: r });
    }

    if (billDone.has(sup.id)) {
      result.skipped.push(s.name);
    } else {
      onStep(`${at}: purchase bill`);
      await api.savePurchaseBill({
        supplierId: sup.id, date: s.purchaseDate, invoiceNo: '', note: IMPORT_TAG,
        lines: lines.map((l) => ({ itemId: l.itemId, qty: l.qty, costPrice: l.costPrice })),
        paidNow: 0, received: true,
      });
      result.purchases += 1;
    }

    for (const p of s.payments) {
      const pay = { date: p.date || s.purchaseDate, amount: p.amount, note: p.note };
      if (payDone.has(payKey(sup.id, pay))) continue;
      onStep(`${at}: payment ${pay.amount}`);
      await api.addSupplierPayment({ supplierId: sup.id, ...pay, method: IMPORT_METHOD });
      result.payments += 1;
    }

    // What was already sold, as one fully-paid old sales bill per supplier.
    const sold = lines.filter((l) => l.row.sold > 0);
    const salesNote = `${IMPORT_TAG} — ${s.name}`;
    if (sold.length && !salesDone.has(salesNote)) {
      onStep(`${at}: old sales`);
      if (!party) {
        party = await api.saveParty({ name: OLD_SALES_PARTY, phone: '', address: 'Sales recorded before this app' });
      }
      const sale = sold.map((l) => ({
        itemId: l.itemId, qty: l.row.sold, unit: 'Piece',
        price: r2(l.row.revenue / l.row.sold), costPriceAtSale: l.costPrice,
        supplierId: sup.id,   // sold from this supplier's stock
      }));
      const billTotal = billTotals(sale.map((x) => ({ qty: x.qty, price: x.price })), settings?.roundingRule).total;
      await api.saveBill({
        partyId: party.id, date: oldData.asOf, note: salesNote, delivery: 'delivered',
        lines: sale,
        payments: billTotal > 0 ? [{ method: IMPORT_METHOD, amount: billTotal }] : [],
      });
      result.sales += 1;
    }
  }
  return result;
}
