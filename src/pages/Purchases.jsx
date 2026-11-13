// Purchases (FR-37) — stock bought from suppliers. Updates the item's current
// cost price and stock quantity, feeding profit tracking.

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus, ShoppingCart, Download, Save, TrendingUp, Pencil, Trash2, HandCoins, Eye,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import api from '../lib/api';
import {
  Card, Button, Modal, Empty, PageHead, SearchBar, Money, Field, Input,
  Select, Stat, RangePicker, Textarea, TypeAhead, Confirm,
} from '../components/ui';
import ItemForm from '../components/forms/ItemForm';
import PurchaseBillModal from '../components/forms/PurchaseBillModal';
import PurchaseEditModal from '../components/forms/PurchaseEditModal';
import SupplierPaymentModal from '../components/forms/SupplierPaymentModal';
import { rangeFor, inRange, itemStock, lineReceivedQty } from '../lib/calc';
import { money, fmtDate, norm, todayISO, r2 } from '../lib/format';
import { exportExcel } from '../lib/exporters';

export default function Purchases() {
  const { data, settings, toast, mutate } = useApp();
  const [q, setQ] = useState('');
  const [preset, setPreset] = useState('month');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [adding, setAdding] = useState(false);
  const [billing, setBilling] = useState(false);
  const [giving, setGiving] = useState(false);     // advance to a supplier
  const [editing, setEditing] = useState(null);    // purchase being corrected
  const [deleting, setDeleting] = useState(null);  // purchase awaiting confirmation
  const nav = useNavigate();
  // A purchase opens on its own page, like a sales bill.
  const setViewing = (purchaseId) => nav(`/purchase/${purchaseId}`);

  // A search shows the latest purchase of each matching item; ticking this
  // shows every match.
  const [seeAll, setSeeAll] = useState(false);

  const range = useMemo(() => rangeFor(preset, custom), [preset, custom]);

  const matches = useMemo(() => {
    const term = norm(q);
    // How closely a row matches: the item name counts most, then purchase or
    // invoice number, then supplier, then anything else on the row.
    const score = (p) => {
      if (!term) return 0;
      const name = norm(p.item?.name || '');
      if (name === term) return 100;
      if (name.startsWith(term)) return 80;
      if (name.split(' ').some((w) => w.startsWith(term))) return 70;
      if (name.includes(term)) return 60;
      if ([p.bill?.purchaseNo, p.bill?.invoiceNo].some((v) => norm(v || '').includes(term))) return 50;
      if (norm(p.supplierName || '').includes(term)) return 40;
      return 10;
    };
    const billById = new Map((data.purchaseBills || []).map((b) => [b.id, b]));
    return data.purchases
      .map((p) => ({
        ...p,
        item: data.items.find((i) => i.id === p.itemId),
        bill: p.purchaseBillId ? billById.get(p.purchaseBillId) : null,
      }))
      // A cancelled purchase bill never brought its goods in.
      .filter((p) => p.bill?.status !== 'voided')
      .map((p) => (p.bill
        ? { ...p, method: 'Supplier account', note: [p.bill.purchaseNo, p.note].filter(Boolean).join(' · ') }
        : p))
      .filter((p) => inRange(p.date, range.from, range.to))
      // Anything shown on the row can be searched for: item, category,
      // supplier, purchase or invoice number, note, method, amounts, date.
      .filter((p) => !term || norm([
        p.item?.name, p.item?.category, p.supplierName, p.note, p.method,
        p.bill?.purchaseNo, p.bill?.invoiceNo, p.bill?.note,
        p.qty, p.costPrice, r2(p.qty * p.costPrice), fmtDate(p.date), p.date,
      ].filter((v) => v !== undefined && v !== null).join(' ')).includes(term))
      .map((p) => ({ ...p, score: score(p) }))
      // Best match first, then newest. Ids are time-based, so they order two
      // purchases made on the same day by when they were entered.
      .sort((a, b) => b.score - a.score
        || new Date(b.date) - new Date(a.date)
        || String(b.id).localeCompare(String(a.id)));
  }, [data, q, range]);

  // A search shows each matching item once, at its most recent purchase, so
  // two different items both show while a repeat buy of one item does not.
  const latestPerItem = useMemo(() => {
    const newer = (a, b) => new Date(a.date) - new Date(b.date)
      || String(a.id).localeCompare(String(b.id));
    const byItem = new Map();
    for (const p of matches) {
      const key = p.itemId || p.id;
      const cur = byItem.get(key);
      if (!cur) {
        byItem.set(key, { row: p, score: p.score });
      } else {
        if (newer(p, cur.row) > 0) cur.row = p;
        cur.score = Math.max(cur.score, p.score);
      }
    }
    return [...byItem.values()]
      .sort((a, b) => b.score - a.score || newer(b.row, a.row))
      .map((g) => g.row);
  }, [matches]);

  const searching = Boolean(norm(q));
  const rows = searching && !seeAll ? latestPerItem : matches;

  const totals = useMemo(() => ({
    value: r2(rows.reduce((s, p) => s + (Number(p.qty) || 0) * (Number(p.costPrice) || 0), 0)),
    count: rows.length,
    suppliers: new Set(rows.map((p) => p.supplierName).filter(Boolean)).size,
  }), [rows]);

  const doDelete = async () => {
    const p = deleting;
    setDeleting(null);
    await mutate(() => api.deletePurchase(p.id), 'Purchase deleted').catch(() => {});
  };

  // Look up the stored record: the table row carries display-only overrides
  // (method, note) for lines of a purchase bill.
  const rowActions = (p) => (
    <>
      <button className="btn btn-ghost btn-sm" title="Open — edit, print, pay, receiving"
              onClick={() => setViewing(p.id)}>
        <Eye size={14} />
      </button>
      <button className="btn btn-ghost btn-sm" title="Edit purchase"
              onClick={() => setEditing(data.purchases.find((x) => x.id === p.id) || p)}>
        <Pencil size={14} />
      </button>
      <button className="btn btn-ghost btn-sm" title="Delete purchase" onClick={() => setDeleting(p)}>
        <Trash2 size={14} />
      </button>
    </>
  );

  const onExcel = () => {
    exportExcel('Purchases',
      ['Date', 'Item', 'Supplier', 'Qty', 'Cost Price', 'Total', 'Paid from', 'Note'],
      rows.map((p) => [fmtDate(p.date), p.item?.name || '', p.supplierName, p.qty,
                       Number(p.costPrice).toFixed(2),
                       r2(p.qty * p.costPrice).toFixed(2), p.method || '', p.note || '']),
      [`${settings.shopName} — Purchases`, `Total purchased: ${money(totals.value)}`]);
    toast('Purchases exported');
  };

  return (
    <>
      <PageHead title="Purchases"
                subtitle={`${totals.count} purchases · ${money(totals.value)} in the selected period`}>
        <SearchBar value={q} onChange={setQ} placeholder="Search item, supplier, PUR no, note…" />
        <Button icon={Download} onClick={onExcel}>Excel</Button>
        <Button icon={HandCoins} onClick={() => setGiving(true)}>Give Advance</Button>
        <Button icon={Plus} onClick={() => setAdding(true)}>Quick Purchase</Button>
        <Button variant="primary" icon={Plus} onClick={() => setBilling(true)}>Purchase Bill</Button>
      </PageHead>

      <div className="stat-grid">
        <Stat label="Total Purchased" value={money(totals.value)} icon={ShoppingCart} tone="#D9390B" />
        <Stat label="Purchases" value={totals.count} icon={ShoppingCart} tone="#F59E0B" />
        <Stat label="Suppliers" value={totals.suppliers} icon={ShoppingCart} tone="#16A34A" />
      </div>

      <div className="row mb-2" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <RangePicker value={preset} onChange={setPreset} custom={custom} onCustomChange={setCustom} />
        {searching && (
          <>
            <span className="spacer" />
            <span className="small muted">
              {seeAll || latestPerItem.length === matches.length
                ? `${matches.length} match${matches.length === 1 ? '' : 'es'}`
                : `Latest of each item: ${latestPerItem.length} item${latestPerItem.length === 1 ? '' : 's'} `
                  + `(${matches.length} records)`}
            </span>
            <label className="row" style={{ gap: 7, cursor: 'pointer', fontWeight: 600 }}>
              <input type="checkbox" checked={seeAll} onChange={(e) => setSeeAll(e.target.checked)}
                     style={{ width: 17, height: 17 }} />
              See all
            </label>
          </>
        )}
      </div>

      <Card tight>
        {!rows.length ? (
          <Empty icon={ShoppingCart} title="No purchases recorded"
                 message="Record stock coming in from suppliers. This sets each item's cost price, which profit tracking depends on."
                 action={<Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Record a purchase</Button>} />
        ) : (
          <>
            <div className="table-wrap hide-mobile">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Date</th><th>Item</th><th>Supplier</th>
                    <th className="r">Qty</th><th className="r">Cost price</th>
                    <th className="r">Total</th><th>Paid from</th><th>Note</th>
                    <th style={{ width: 116 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => (
                    <tr key={p.id} className="clickable" onClick={() => setViewing(p.id)}>
                      <td className="nowrap">{fmtDate(p.date)}</td>
                      <td style={{ fontWeight: 500 }}>{p.item?.name || 'Item'}</td>
                      <td>{p.supplierName || <span className="muted">—</span>}</td>
                      <td className="r">
                        {p.qty} {p.item?.baseUnit || ''}
                        <NotArrived p={p} />
                      </td>
                      <td className="r"><Money value={p.costPrice} /></td>
                      <td className="r strong"><Money value={r2(p.qty * p.costPrice)} /></td>
                      <td className="small">{p.method || '—'}</td>
                      <td className="small muted">{p.note || '—'}</td>
                      <td className="nowrap" onClick={(e) => e.stopPropagation()}>{rowActions(p)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={5}>{totals.count} purchases</td>
                    <td className="r">{money(totals.value)}</td>
                    <td colSpan={3}></td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <div className="mcards" style={{ padding: 12 }}>
              {rows.map((p) => (
                <div key={p.id} className="mcard" onClick={() => setViewing(p.id)}>
                  <div className="top">
                    <span className="name">{p.item?.name || 'Item'}</span>
                    <span className="amt">{money(r2(p.qty * p.costPrice))}</span>
                  </div>
                  <div className="meta">
                    <span>{p.qty} {p.item?.baseUnit} @ {money(p.costPrice)} <NotArrived p={p} /></span>
                    {p.supplierName && <span>{p.supplierName}</span>}
                    <span>{fmtDate(p.date)}</span>
                    {p.bill && <span>{p.bill.purchaseNo}</span>}
                  </div>
                  <div className="row" style={{ justifyContent: 'flex-end', gap: 4, marginTop: 6 }}
                       onClick={(e) => e.stopPropagation()}>
                    {rowActions(p)}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </Card>

      <PurchaseModal open={adding} onClose={() => setAdding(false)} />
      <PurchaseBillModal open={billing} onClose={() => setBilling(false)} />
      <SupplierPaymentModal open={giving} advance onClose={() => setGiving(false)} />
      <PurchaseEditModal purchase={editing} onClose={() => setEditing(null)} />

      <Confirm
        open={Boolean(deleting)}
        danger
        title="Delete this purchase?"
        message={deleting ? `${deleting.qty} × ${deleting.item?.name || 'item'} @ ${money(deleting.costPrice)}`
          + ` = ${money(r2(deleting.qty * deleting.costPrice))}. The stock comes back out`
          + (deleting.bill
            ? ` and ${deleting.bill.purchaseNo}'s total drops by that amount. If this is its only`
              + ' line, the whole purchase bill is removed; any payment made on it stays on the supplier account.'
            : '.')
          : ''}
        confirmLabel="Delete"
        onConfirm={doDelete}
        onCancel={() => setDeleting(null)}
      />
    </>
  );
}

/** On a line still waiting for goods: how much has arrived so far. */
function NotArrived({ p }) {
  const got = lineReceivedQty(p);
  if (got >= (Number(p.qty) || 0) - 0.0001) return null;
  return (
    <span className={`ld-count ${got > 0 ? 'part' : 'none'}`}>
      {got > 0 ? `${+got.toFixed(3)} received` : 'Not received'}
    </span>
  );
}

function PurchaseModal({ open, onClose }) {
  const { data, activeItems, methods, mutate, toast } = useApp();
  const [f, setF] = useState({
    itemId: '', supplierName: '', qty: '', costPrice: '',
    date: todayISO(), method: 'Cash', note: '',
  });
  const [busy, setBusy] = useState(false);

  // Adding an item without leaving the purchase (same as New Bill). Stock often
  // arrives from a supplier before the item exists in the system at all, so
  // being sent to the Items page to create it first — losing the half-filled
  // purchase — is exactly the wrong moment to interrupt.
  const [showItem, setShowItem] = useState(false);
  const [prefillName, setPrefillName] = useState('');

  const item = data.items.find((i) => i.id === f.itemId);
  const stock = f.itemId ? itemStock(f.itemId, data) : null;

  const suppliers = useMemo(
    () => [...new Set(data.purchases.map((p) => p.supplierName).filter(Boolean))].sort(),
    [data.purchases]
  );

  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));

  const pickItem = (id) => {
    const it = data.items.find((x) => x.id === id);
    setF((x) => ({ ...x, itemId: id, costPrice: x.costPrice || String(it?.costPrice || '') }));
  };

  /** A freshly created item is selected straight away, so the purchase carries on. */
  const onItemAdded = (it) => {
    setShowItem(false);
    if (!it?.id) return;
    // Read the cost price off the new record rather than looking it up in
    // `data`: this runs before the refreshed bootstrap has reached this
    // component, so the item is not in `data.items` yet.
    setF((x) => ({ ...x, itemId: it.id, costPrice: x.costPrice || String(it.costPrice || '') }));
    toast(`Item "${it.name}" added`);
  };

  const lineTotal = r2((Number(f.qty) || 0) * (Number(f.costPrice) || 0));
  const costChanged = item && Number(f.costPrice) && Number(f.costPrice) !== Number(item.costPrice);

  const submit = async () => {
    if (busy) return; // guard: block a duplicate submit while saving
    if (!f.itemId || !(Number(f.qty) > 0)) return;
    setBusy(true);
    try {
      await mutate(() => api.savePurchase({
        itemId: f.itemId, supplierName: f.supplierName, qty: Number(f.qty),
        costPrice: Number(f.costPrice) || 0, date: f.date, method: f.method, note: f.note,
      }), 'Purchase recorded');
      setF({ itemId: '', supplierName: '', qty: '', costPrice: '', date: todayISO(), method: 'Cash', note: '' });
      onClose();
    } catch { /* toast shown */ } finally { setBusy(false); }
  };

  return (
    <>
    {/* One dialog at a time: the purchase is hidden, not unmounted, so the
        half-filled form is still there when the item has been added. Stacking
        two modals would leave the outer one trapping Tab and Escape. */}
    <Modal open={open && !showItem} title="Record Purchase" onClose={onClose}
           footer={
             <>
               <Button onClick={onClose}>Cancel</Button>
               <Button variant="primary" icon={Save} onClick={submit} loading={busy}
                       disabled={!f.itemId || !(Number(f.qty) > 0)}>
                 Record {lineTotal > 0 ? money(lineTotal) : 'Purchase'}
               </Button>
             </>
           }>
      <Field label="Item"
             hint={stock !== null ? `Current stock: ${stock} ${item?.baseUnit || ''}` : undefined}>
        <TypeAhead items={activeItems} value={f.itemId} onChange={pickItem}
                   getLabel={(i) => i.name}
                   getSub={(i) => `${i.category || 'Uncategorised'} · current cost ${money(i.costPrice)}`}
                   placeholder="Search item…" autoFocus
                   onAddNew={(name) => { setPrefillName(name); setShowItem(true); }}
                   addNewLabel="Add new item" />
      </Field>

      <div className="form-grid">
        <Field label="Supplier">
          <Input value={f.supplierName} onChange={set('supplierName')} list="supplier-list"
                 placeholder="Supplier name" />
          <datalist id="supplier-list">
            {suppliers.map((s) => <option key={s} value={s} />)}
          </datalist>
        </Field>
        <Field label="Date">
          <Input type="date" value={f.date} onChange={set('date')} />
        </Field>
        <Field label="Quantity">
          <Input type="number" min="0" step="any" value={f.qty} onChange={set('qty')} placeholder="0" />
        </Field>
        <Field label="Cost price per unit"
               hint={item ? `Current: ${money(item.costPrice)}` : undefined}>
          <Input type="number" min="0" step="any" value={f.costPrice}
                 onChange={set('costPrice')} placeholder="0" />
        </Field>
        <Field label="Paid from">
          <Select value={f.method} onChange={set('method')}
                  options={methods.filter((m) => m !== 'Cheque')} />
        </Field>
        <Field label="Note">
          <Input value={f.note} onChange={set('note')} placeholder="Optional" />
        </Field>
      </div>

      <div style={{
        padding: 12, background: 'var(--bg)', borderRadius: 'var(--r-sm)',
        border: '1px solid var(--border)', display: 'flex', alignItems: 'center',
      }}>
        <span style={{ fontWeight: 700 }}>Purchase total</span>
        <span className="spacer" />
        <span className="money" style={{ fontSize: 17 }}>{money(lineTotal)}</span>
      </div>

      {costChanged && (
        <div className="mt-2" style={{
          padding: '10px 12px', background: 'var(--info-bg)', border: '1px solid #BFDBFE',
          borderRadius: 'var(--r-sm)', fontSize: 12.5, color: '#1D4ED8',
          display: 'flex', gap: 7,
        }}>
          <TrendingUp size={14} style={{ flex: 'none', marginTop: 1 }} />
          <span>
            This updates {item.name}'s cost price from {money(item.costPrice)} to {money(f.costPrice)}.
            Past bills keep their original cost, so historical profit stays accurate.
          </span>
        </div>
      )}
    </Modal>

    <Modal open={showItem} title="Add New Item" onClose={() => setShowItem(false)}>
      <ItemForm initialName={prefillName}
                onSaved={onItemAdded}
                onCancel={() => setShowItem(false)} />
    </Modal>
    </>
  );
}
