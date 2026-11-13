// One-time import of the shop's old Excel records ("8 NOV.xlsx") into the app's
// Suppliers module: each supplier's purchase bill, what was already sold from
// it, and (when nothing is there yet) what was paid.
//
// The Excel was converted to "old data/oldData.json", which stays on the shop's
// own computer: it holds supplier names, costs and payments, so it is never
// bundled into the app or committed to git. Settings asks for that file.
//
// It works with what the app ALREADY holds, so nothing is counted twice:
//
//   * Purchases already entered on the Purchases page (supplier typed as text)
//     are MOVED into their supplier's purchase bill — the same rows, so stock
//     does not change. Their supplier names are kept as the supplier names.
//   * Only what the Excel says was bought beyond those rows is added.
//   * What the Excel says was sold becomes old sales bills, each line naming the
//     supplier it came out of, so Sold / Available are right per supplier.
//   * An existing item is reused by name; a missing one is created.
//
// Money is recorded under the method "Old Data" — not Cash or Bank — so the
// Accounts screen (cash and bank balances) is not changed by history.
//
// Safe to run again, also after a failure half-way: suppliers, items and the
// customer are reused by name, the purchase bill carries IMPORT_TAG and the sales
// bill its own note, and each is created only if it is not there yet.

import { billTotals } from './calc';
import { r2 } from './format';

export const IMPORT_TAG = 'Imported from old Excel (8 NOV)';
export const IMPORT_METHOD = 'Old Data';
export const OLD_SALES_PARTY = 'Old Data Sales';

/** Extra spaces collapsed, capitals kept: what a name is shown as. */
const tidy = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');
/** What two names are compared on: same words, any capitals or spacing. */
const key = (s) => tidy(s).toLowerCase();

/** Read the chosen file's text, or throw a message fit for the person choosing it. */
export function parseOldData(text) {
  let d;
  try { d = JSON.parse(text); } catch { throw new Error('That file is not valid JSON.'); }
  const ok = d && Array.isArray(d.suppliers) && d.suppliers.length
    && d.suppliers.every((s) => s && s.name && Array.isArray(s.rows) && Array.isArray(s.payments));
  if (!ok) throw new Error('That is not the old-data file (expected oldData.json with suppliers).');
  return d;
}

/**
 * Work out, without writing anything, what the import would do with the app's
 * current data. Returns { groups, summary, warnings }.
 */
export function planOldData({ data, oldData }) {
  const itemByName = new Map((data.items || []).map((i) => [key(i.name), i]));
  const supByName = new Map((data.suppliers || []).map((s) => [key(s.name), s]));

  // Purchases still outside the Suppliers module, by item.
  const standalone = (data.purchases || []).filter((p) => !p.purchaseBillId && !p.supplierId);
  const byItem = new Map();
  standalone.forEach((p) => {
    if (!byItem.has(p.itemId)) byItem.set(p.itemId, []);
    byItem.get(p.itemId).push(p);
  });
  // Every purchase that names a supplier, moved or not: after a first run the rows
  // are linked, and their names must still decide what the supplier is called.
  const namedByItem = new Map();
  (data.purchases || []).filter((p) => tidy(p.supplierName)).forEach((p) => {
    if (!namedByItem.has(p.itemId)) namedByItem.set(p.itemId, []);
    namedByItem.get(p.itemId).push(p);
  });

  /* ---- 1) One group per supplier, named the way the shop already names them. ----
     Each Excel section takes the supplier name most often typed on the shop's
     existing purchases of the same items; only a section with none keeps its own. */
  const groups = new Map();
  const groupFor = (name, seed = {}) => {
    const k = key(name);
    if (!groups.has(k)) {
      groups.set(k, {
        name: tidy(name), existing: supByName.get(k) || null, address: seed.address || '',
        category: seed.category || '', rows: [], payments: [], adopt: [], date: '',
        newLines: [], sales: [], createItems: [], excel: [],
      });
    }
    return groups.get(k);
  };

  oldData.suppliers.forEach((s) => {
    const votes = new Map();
    s.rows.forEach((r) => {
      const it = itemByName.get(key(r.item));
      (namedByItem.get(it?.id) || []).forEach((p) => {
        if (p.supplierName) votes.set(tidy(p.supplierName), (votes.get(tidy(p.supplierName)) || 0) + 1);
      });
    });
    const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || s.name;
    const g = groupFor(best, { address: s.address, category: s.category });
    g.rows.push(...s.rows.map((r) => ({ ...r, category: s.category })));
    g.payments.push(...s.payments);
    g.excel.push(s.name);
    if (!g.date || String(s.purchaseDate) < g.date) g.date = s.purchaseDate;
  });

  /* ---- 2) Per group: what to move in, what to add, what was sold. ---- */
  const claimed = new Set();
  const warnings = [];
  let openingItems = 0;

  groups.forEach((g) => {
    const perItem = new Map();
    g.rows.forEach((r) => {
      const k = key(r.item);
      if (!perItem.has(k)) perItem.set(k, { name: tidy(r.item), category: r.category, rows: [] });
      perItem.get(k).rows.push(r);
    });

    perItem.forEach((e, k) => {
      const item = itemByName.get(k);
      if (!item) g.createItems.push({ name: e.name, category: e.category, costPrice: e.rows[e.rows.length - 1].cost });
      else if (Number(item.openingStock) > 0) openingItems += 1;

      // This supplier's existing purchase rows of the item move in as they are.
      const mine = (item ? byItem.get(item.id) || [] : [])
        .filter((p) => key(p.supplierName || '') === key(g.name) && !claimed.has(p.id));
      mine.forEach((p) => { claimed.add(p.id); g.adopt.push(p); });
      const have = r2(mine.reduce((s, p) => s + (Number(p.qty) || 0), 0));

      // Only what the Excel says was bought beyond those rows is new.
      const bought = r2(e.rows.reduce((s, r) => s + r.qty, 0));
      const spent = e.rows.reduce((s, r) => s + r.qty * r.cost, 0);
      const more = r2(Math.max(0, bought - have));
      if (more > 0) g.newLines.push({ itemKey: k, name: e.name, qty: more, costPrice: r2(spent / bought) });
      if (have > bought + 0.0001) warnings.push(`${e.name}: the app already has ${have} bought, the sheet says ${bought}`);

      e.rows.filter((r) => r.sold > 0).forEach((r) => g.sales.push({
        itemKey: k, name: e.name, qty: r.sold,
        price: r2(r.revenue / r.sold), costPrice: r.cost,
      }));
    });
  });

  /* ---- 3) Purchases left over (items not in the Excel) go to their own supplier. ---- */
  let loose = 0;
  let noSupplier = 0;
  standalone.forEach((p) => {
    if (claimed.has(p.id)) return;
    if (!tidy(p.supplierName)) { noSupplier += 1; return; }
    groupFor(p.supplierName).adopt.push(p);
    loose += 1;
  });

  // A group that moves existing rows in is already "paid" through them; one
  // starting from nothing keeps the payments the Excel lists.
  const list = [...groups.values()].filter((g) => g.adopt.length || g.newLines.length || g.sales.length);
  list.forEach((g) => { if (g.adopt.length) g.payments = []; });

  const sum = (f) => r2(list.reduce((s, g) => s + f(g), 0));
  const summary = {
    suppliers: list.length,
    newSuppliers: list.filter((g) => !g.existing).length,
    moved: list.reduce((s, g) => s + g.adopt.length, 0),
    movedLoose: loose,
    added: list.reduce((s, g) => s + g.newLines.length, 0),
    newItems: list.reduce((s, g) => s + g.createItems.length, 0),
    sales: list.reduce((s, g) => s + g.sales.length, 0),
    payments: list.reduce((s, g) => s + g.payments.length, 0),
    paid: sum((g) => g.payments.reduce((t, p) => t + p.amount, 0)),
    soldValue: sum((g) => g.sales.reduce((t, x) => t + x.qty * x.price, 0)),
    addedValue: sum((g) => g.newLines.reduce((t, x) => t + x.qty * x.costPrice, 0)),
    noSupplier,
    asOf: oldData.asOf,
  };
  if (openingItems) {
    warnings.push(`${openingItems} item${openingItems === 1 ? ' has' : 's have'} opening stock typed in, `
      + 'which is counted in addition to the purchases — their stock will read higher than the sheet.');
  }
  if (noSupplier) {
    warnings.push(`${noSupplier} purchase row${noSupplier === 1 ? ' has' : 's have'} no supplier name and stay${noSupplier === 1 ? 's' : ''} on the Purchases page.`);
  }
  return { groups: list, summary, warnings };
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
  const { groups } = planOldData({ data, oldData });
  const supByName = new Map((data.suppliers || []).map((s) => [key(s.name), s]));
  const itemByName = new Map((data.items || []).map((i) => [key(i.name), i]));
  const billDone = new Set((data.purchaseBills || [])
    .filter((b) => b.note === IMPORT_TAG).map((b) => b.supplierId));
  const payDone = new Set((data.supplierPayments || [])
    .map((p) => `${p.supplierId}|${p.date}|${r2(p.amount)}|${p.note}`));
  const salesDone = new Set((data.bills || [])
    .filter((b) => String(b.note || '').startsWith(IMPORT_TAG)).map((b) => b.note));

  const result = {
    suppliers: 0, moved: 0, items: 0, purchases: 0, payments: 0, sales: 0, skipped: [],
  };
  let party = (data.parties || []).find((p) => key(p.name) === key(OLD_SALES_PARTY));
  let n = 0;

  const ensureItem = async (name, category, costPrice) => {
    const k = key(name);
    let item = itemByName.get(k);
    if (!item) {
      item = await api.saveItem({
        name: tidy(name), baseUnit: 'Piece', category: category || '',
        costPrice, openingStock: 0, lowStockAlert: 0,
      });
      itemByName.set(k, item);
      result.items += 1;
    }
    return item;
  };

  for (const g of groups) {
    n += 1;
    const at = `(${n}/${groups.length}) ${g.name}`;

    onStep(`${at}: supplier`);
    let sup = supByName.get(key(g.name));
    if (!sup) {
      sup = await api.saveSupplier({ name: g.name, address: g.address || '', phone: '', openingBalance: 0 });
      supByName.set(key(g.name), sup);
      result.suppliers += 1;
    }

    // Items the sheet has and the app does not yet.
    let made = 0;
    for (const it of g.createItems) {
      made += 1;
      onStep(`${at}: item ${made}/${g.createItems.length}`);
      await ensureItem(it.name, it.category, it.costPrice);
    }

    // Purchase bill. A bill already tagged for this supplier means the sheet's
    // extra lines went in on an earlier run, so they are not added again.
    const again = billDone.has(sup.id);
    const newLines = [];
    if (!again) {
      for (const l of g.newLines) {
        newLines.push({ itemId: (await ensureItem(l.name, '', l.costPrice)).id, qty: l.qty, costPrice: l.costPrice });
      }
    }
    const date = g.date || (g.adopt[0] ? String(g.adopt[0].date).slice(0, 10) : undefined);

    if (g.adopt.length) {
      onStep(`${at}: moving ${g.adopt.length} purchase rows`);
      await api.adoptPurchases({
        supplierId: sup.id, purchaseIds: g.adopt.map((p) => p.id), newLines,
        note: IMPORT_TAG, method: IMPORT_METHOD, date,
      });
      result.moved += g.adopt.length;
      result.purchases += 1;
    } else if (newLines.length) {
      onStep(`${at}: purchase bill`);
      await api.savePurchaseBill({
        supplierId: sup.id, date: g.date, invoiceNo: '', note: IMPORT_TAG,
        lines: newLines, paidNow: 0, received: true,
      });
      result.purchases += 1;
    } else if (again) {
      result.skipped.push(g.name);
    }

    // Payments from the sheet — only for a supplier that had nothing in the app. One whose
    // purchases were moved in before is already recorded as paid, so it gets none.
    const movedBefore = (data.supplierPayments || []).some((x) => x.supplierId === sup.id
      && String(x.note || '').startsWith('Paid - recorded before'));
    for (const p of movedBefore ? [] : g.payments) {
      const pay = { date: p.date || g.date, amount: p.amount, note: p.note };
      if (payDone.has(`${sup.id}|${pay.date}|${r2(pay.amount)}|${pay.note}`)) continue;
      onStep(`${at}: payment ${pay.amount}`);
      await api.addSupplierPayment({ supplierId: sup.id, ...pay, method: IMPORT_METHOD });
      result.payments += 1;
    }

    // What was already sold, as one fully-paid old sales bill, drawn from this supplier.
    const salesNote = `${IMPORT_TAG} — ${g.name}`;
    if (g.sales.length && !salesDone.has(salesNote)) {
      onStep(`${at}: old sales`);
      if (!party) {
        party = await api.saveParty({ name: OLD_SALES_PARTY, phone: '', address: 'Sales recorded before this app' });
      }
      const lines = [];
      for (const x of g.sales) {
        const item = itemByName.get(x.itemKey) || await ensureItem(x.name, '', x.costPrice);
        lines.push({
          itemId: item.id, qty: x.qty, unit: 'Piece', price: x.price,
          costPriceAtSale: x.costPrice, supplierId: sup.id,
        });
      }
      const total = billTotals(lines.map((x) => ({ qty: x.qty, price: x.price })), settings?.roundingRule).total;
      await api.saveBill({
        partyId: party.id, date: oldData.asOf, note: salesNote, delivery: 'delivered', lines,
        payments: total > 0 ? [{ method: IMPORT_METHOD, amount: total }] : [],
      });
      result.sales += 1;
    }
  }
  return result;
}
