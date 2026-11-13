// Damaged / Expired Stock (FR-36 / Plan 4.6).
//
// Its own log, separate from general Expenses, because it tracks physical stock
// loss rather than cash spending. Each entry reduces stock AND auto-creates a
// linked Expenses entry under "Stock Loss" — one entry, correct accounting.

import { useMemo, useState } from 'react';
import { Plus, Boxes, Download, Link2, Save, AlertTriangle } from 'lucide-react';
import { useApp } from '../context/AppContext';
import api from '../lib/api';
import {
  Card, Button, Modal, Empty, PageHead, SearchBar, Money, Pill, Field, Input,
  Select, Stat, RangePicker, Textarea, TypeAhead,
} from '../components/ui';
import { rangeFor, inRange, itemStock } from '../lib/calc';
import { money, fmtDate, norm, todayISO, r2 } from '../lib/format';
import { exportExcel } from '../lib/exporters';
import { STOCK_LOSS_REASONS } from '../lib/config';

export default function StockLoss() {
  const { data, settings, toast } = useApp();
  const [q, setQ] = useState('');
  const [preset, setPreset] = useState('month');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [adding, setAdding] = useState(false);

  const range = useMemo(() => rangeFor(preset, custom), [preset, custom]);

  const rows = useMemo(() => {
    const term = norm(q);
    return data.stockLoss
      .map((l) => ({ ...l, item: data.items.find((i) => i.id === l.itemId) }))
      .filter((l) => inRange(l.date, range.from, range.to))
      .filter((l) => !term || norm(l.item?.name).includes(term) || norm(l.reason).includes(term))
      .sort((a, b) => new Date(b.date) - new Date(a.date));
  }, [data, q, range]);

  const totals = useMemo(() => ({
    value: r2(rows.reduce((s, l) => s + (Number(l.estimatedValue) || 0), 0)),
    count: rows.length,
    units: r2(rows.reduce((s, l) => s + (Number(l.qty) || 0), 0)),
  }), [rows]);

  const byReason = useMemo(() => {
    const m = new Map();
    rows.forEach((l) => m.set(l.reason, r2((m.get(l.reason) || 0) + (Number(l.estimatedValue) || 0))));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  const onExcel = () => {
    exportExcel('StockLoss',
      ['Date', 'Item', 'Qty', 'Reason', 'Estimated Value', 'Note'],
      rows.map((l) => [fmtDate(l.date), l.item?.name || '', l.qty, l.reason,
                       Number(l.estimatedValue).toFixed(2), l.note || '']),
      [`${settings.shopName} — Damaged / Expired Stock`, `Total value lost: ${money(totals.value)}`]);
    toast('Stock loss log exported');
  };

  return (
    <>
      <PageHead title="Damaged / Expired Stock"
                subtitle={`${totals.count} entries · ${money(totals.value)} lost in the selected period`}>
        <SearchBar value={q} onChange={setQ} placeholder="Search item or reason…" />
        <Button icon={Download} onClick={onExcel}>Excel</Button>
        <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Log Stock Loss</Button>
      </PageHead>

      <div className="stat-grid">
        <Stat label="Value Lost" value={money(totals.value)} icon={AlertTriangle} tone="#DC2626" />
        <Stat label="Entries" value={totals.count} icon={Boxes} tone="#F59E0B" />
        <Stat label="Units Lost" value={totals.units} icon={Boxes} tone="#6B7280" />
      </div>

      <div className="mb-2">
        <RangePicker value={preset} onChange={setPreset} custom={custom} onCustomChange={setCustom} />
      </div>

      <div className="grid-2" style={{ gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr)', alignItems: 'start' }}>
        <Card tight>
          {!rows.length ? (
            <Empty icon={Boxes} title="No stock loss recorded"
                   message="Log damaged or expired goods here. Stock reduces automatically and a matching expense is created for you."
                   action={<Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Log stock loss</Button>} />
          ) : (
            <>
              <div className="table-wrap hide-mobile">
                <table className="tbl">
                  <thead>
                    <tr><th>Date</th><th>Item</th><th className="r">Qty</th><th>Reason</th>
                        <th>Note</th><th className="r">Value lost</th></tr>
                  </thead>
                  <tbody>
                    {rows.map((l) => (
                      <tr key={l.id}>
                        <td className="nowrap">{fmtDate(l.date)}</td>
                        <td style={{ fontWeight: 500 }}>{l.item?.name || 'Item'}</td>
                        <td className="r">{l.qty} {l.item?.baseUnit || ''}</td>
                        <td><Pill status={l.reason === 'Expired' ? 'partial' : 'due'} label={l.reason} /></td>
                        <td className="small muted">{l.note || '—'}</td>
                        <td className="r strong"><Money value={l.estimatedValue} /></td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={5}>{totals.count} entries</td>
                      <td className="r" style={{ color: 'var(--danger)' }}>{money(totals.value)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              <div className="mcards" style={{ padding: 12 }}>
                {rows.map((l) => (
                  <div key={l.id} className="mcard due-30">
                    <div className="top">
                      <span className="name">{l.item?.name || 'Item'}</span>
                      <span className="amt">{money(l.estimatedValue)}</span>
                    </div>
                    <div className="meta">
                      <Pill status={l.reason === 'Expired' ? 'partial' : 'due'} label={l.reason} />
                      <span>{l.qty} {l.item?.baseUnit}</span>
                      <span>{fmtDate(l.date)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </Card>

        <Card title="By Reason" tight>
          {byReason.length ? (
            <table className="tbl">
              <tbody>
                {byReason.map(([reason, amt]) => (
                  <tr key={reason}>
                    <td>{reason}</td>
                    <td className="r strong"><Money value={amt} /></td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr><td>Total</td><td className="r">{money(totals.value)}</td></tr>
              </tfoot>
            </table>
          ) : (
            <Empty title="Nothing logged" message="Entries will be summarised here." />
          )}
        </Card>
      </div>

      <StockLossModal open={adding} onClose={() => setAdding(false)} />
    </>
  );
}

function StockLossModal({ open, onClose }) {
  const { data, activeItems, mutate } = useApp();
  const [f, setF] = useState({
    itemId: '', qty: '', reason: 'Damaged', estimatedValue: '', date: todayISO(), note: '',
  });
  const [busy, setBusy] = useState(false);

  const item = data.items.find((i) => i.id === f.itemId);
  const stock = f.itemId ? itemStock(f.itemId, data) : null;

  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));

  /** Estimated value defaults to qty × the item's current cost price. */
  const pickItem = (id) => {
    const it = data.items.find((x) => x.id === id);
    setF((x) => ({
      ...x, itemId: id,
      estimatedValue: x.qty && it ? String(r2(Number(x.qty) * Number(it.costPrice || 0))) : x.estimatedValue,
    }));
  };

  const setQty = (e) => {
    const qty = e.target.value;
    setF((x) => ({
      ...x, qty,
      estimatedValue: item ? String(r2(Number(qty || 0) * Number(item.costPrice || 0))) : x.estimatedValue,
    }));
  };

  const overStock = stock !== null && Number(f.qty) > stock;

  const submit = async () => {
    if (busy) return; // guard: block a duplicate submit while saving
    if (!f.itemId || !(Number(f.qty) > 0)) return;
    setBusy(true);
    try {
      await mutate(() => api.saveStockLoss({
        itemId: f.itemId, qty: Number(f.qty), reason: f.reason,
        estimatedValue: Number(f.estimatedValue) || 0, date: f.date, note: f.note,
      }), 'Stock loss logged and expense created');
      setF({ itemId: '', qty: '', reason: 'Damaged', estimatedValue: '', date: todayISO(), note: '' });
      onClose();
    } catch { /* toast shown */ } finally { setBusy(false); }
  };

  return (
    <Modal open={open} title="Log Damaged / Expired Stock" onClose={onClose}
           footer={
             <>
               <Button onClick={onClose}>Cancel</Button>
               <Button variant="primary" icon={Save} onClick={submit} loading={busy}
                       disabled={!f.itemId || !(Number(f.qty) > 0)}>Log Stock Loss</Button>
             </>
           }>
      <Field label="Item"
             hint={stock !== null ? `Current stock: ${stock} ${item?.baseUnit || ''}` : undefined}>
        <TypeAhead items={activeItems} value={f.itemId} onChange={pickItem}
                   getLabel={(i) => i.name}
                   getSub={(i) => `${i.category || 'Uncategorised'} · cost ${money(i.costPrice)}`}
                   placeholder="Search item…" autoFocus />
      </Field>

      <div className="form-grid">
        <Field label="Quantity lost"
               error={overStock ? `Only ${stock} ${item?.baseUnit} in stock` : ''}>
          <Input type="number" min="0" step="any" value={f.qty} onChange={setQty} placeholder="0" />
        </Field>
        <Field label="Reason">
          <Select value={f.reason} onChange={set('reason')} options={STOCK_LOSS_REASONS} />
        </Field>
        <Field label="Estimated value lost" hint="Defaults to quantity × cost price">
          <Input type="number" min="0" step="any" value={f.estimatedValue}
                 onChange={set('estimatedValue')} placeholder="0" />
        </Field>
        <Field label="Date">
          <Input type="date" value={f.date} onChange={set('date')} />
        </Field>
        <Field label="Note" className="full">
          <Textarea value={f.note} onChange={set('note')} rows={2} placeholder="What happened?" />
        </Field>
      </div>

      <div style={{
        padding: '10px 12px', background: 'var(--info-bg)', border: '1px solid #BFDBFE',
        borderRadius: 'var(--r-sm)', fontSize: 12.5, color: '#1D4ED8',
        display: 'flex', gap: 7,
      }}>
        <Link2 size={14} style={{ flex: 'none', marginTop: 1 }} />
        <span>
          Saving reduces this item's stock and creates a matching
          <strong> Stock Loss </strong> entry in Expenses automatically.
        </span>
      </div>
    </Modal>
  );
}
