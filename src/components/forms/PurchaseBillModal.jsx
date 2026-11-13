// New purchase bill — stock bought from a supplier, several items at once.
//
// Saving brings every line into stock, updates each item's cost price, adds the
// total to what the shop owes the supplier, and records whatever was paid on
// the spot as a payment against this bill.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Save, Trash2 } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import api from '../../lib/api';
import { Button, Modal, Field, Input, Select, TypeAhead } from '../ui';
import ItemForm from './ItemForm';
import SupplierForm from './SupplierForm';
import { supplierBalance, itemStock } from '../../lib/calc';
import { money, todayISO, r2 } from '../../lib/format';

let lineSeq = 0;
const blankLine = () => ({ key: ++lineSeq, itemId: '', qty: '', costPrice: '' });
const blankForm = (supplierId = '') => ({
  supplierId, invoiceNo: '', date: todayISO(), note: '',
  lines: [blankLine()], paidNow: '', method: 'Cash',
  // Goods usually come with the bill; ticked for an order still on its way.
  notReceived: false,
});

export default function PurchaseBillModal({ open, onClose, supplierId = '', onSaved }) {
  const { data, activeItems, activeSuppliers, methods, mutate, toast } = useApp();
  const [f, setF] = useState(() => blankForm(supplierId));
  const [busy, setBusy] = useState(false);
  // Which inline "add new" dialog is showing: null, 'supplier', or a line key.
  const [adding, setAdding] = useState(null);
  const [prefill, setPrefill] = useState('');

  // Start fresh each time the dialog opens, preselecting the supplier whose
  // ledger it was opened from.
  useEffect(() => {
    if (open) setF(blankForm(supplierId));
  }, [open, supplierId]);

  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const setLine = (key, patch) =>
    setF((x) => ({ ...x, lines: x.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }));

  // The line whose item search should take the cursor once it has rendered.
  const [focusLineKey, setFocusLineKey] = useState(null);
  const itemInputRef = useRef(null);

  const addLine = () => {
    const line = blankLine();
    setF((x) => ({ ...x, lines: [...x.lines, line] }));
    setFocusLineKey(line.key);
  };

  // Focus the new line's item search after it renders, then forget the request
  // so a later re-render cannot yank the cursor back.
  useEffect(() => {
    if (!focusLineKey) return;
    itemInputRef.current?.focus();
    setFocusLineKey(null);
  }, [focusLineKey]);

  // Ctrl+Shift+A adds a line and puts the cursor in its item search, so a long
  // bill can be typed without reaching for the mouse. Only while this dialog is
  // the one showing — not behind an inline add-supplier / add-item form, where
  // the cursor would land in an input the user cannot see.
  const active = open && !adding;
  useEffect(() => {
    if (!active) return undefined;
    const onKey = (e) => {
      // e.code, not e.key: with Shift held e.key is 'A', and on some layouts a
      // modified key reports something else entirely. e.code is the physical key.
      if (e.code !== 'KeyA' || !e.shiftKey || !(e.ctrlKey || e.metaKey)) return;
      if (e.altKey || e.repeat) return;
      e.preventDefault();
      addLine();         // only touches state setters, so a stale copy is fine
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);

  const pickItem = (key, id, it) => {
    const item = it || data.items.find((x) => x.id === id);
    setLine(key, { itemId: id || '', costPrice: item ? String(item.costPrice || '') : '' });
  };

  const total = useMemo(
    () => r2(f.lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.costPrice) || 0), 0)),
    [f.lines]
  );
  const filled = f.lines.filter((l) => l.itemId && Number(l.qty) > 0);
  const paidNow = Number(f.paidNow) || 0;
  const balance = f.supplierId ? supplierBalance(f.supplierId, data) : 0;
  const payMethods = methods.filter((m) => m !== 'Cheque');

  const canSave = f.supplierId && filled.length > 0 && paidNow >= 0 && paidNow <= total + 0.004;

  const submit = async () => {
    if (busy || !canSave) return;
    setBusy(true);
    try {
      const bill = await mutate(() => api.savePurchaseBill({
        supplierId: f.supplierId,
        invoiceNo: f.invoiceNo,
        date: f.date,
        note: f.note,
        lines: filled.map((l) => ({
          itemId: l.itemId, qty: Number(l.qty), costPrice: Number(l.costPrice) || 0,
        })),
        paidNow,
        method: f.method,
        received: !f.notReceived,
      }), 'Purchase saved');
      setF(blankForm(supplierId));
      onSaved?.(bill);
      onClose();
    } catch { /* toast shown */ } finally { setBusy(false); }
  };

  return (
    <>
      {/* One dialog at a time: this one is hidden, not unmounted, while an
          inline add-new form is open, so the half-filled bill survives. */}
      <Modal open={open && !adding} title="New Purchase Bill" onClose={onClose} wide
             footer={
               <>
                 <Button onClick={onClose}>Cancel</Button>
                 <Button variant="primary" icon={Save} onClick={submit} loading={busy} disabled={!canSave}>
                   Save {total > 0 ? money(total) : 'Purchase'}
                 </Button>
               </>
             }>
        <div className="form-grid">
          <Field label="Supplier" className="full"
                 hint={f.supplierId
                   ? (balance > 0 ? `You currently owe ${money(balance)}`
                     : balance < 0 ? `They hold ${money(-balance)} advance from you — this purchase uses it first`
                     : 'Account is clear')
                   : undefined}>
            <TypeAhead items={activeSuppliers} value={f.supplierId}
                       onChange={(id) => setF((x) => ({ ...x, supplierId: id || '' }))}
                       getLabel={(s) => s.name} getSub={(s) => s.phone || ''}
                       placeholder="Search supplier…" autoFocus={!supplierId}
                       onAddNew={(name) => { setPrefill(name); setAdding('supplier'); }}
                       addNewLabel="Add new supplier" />
          </Field>
          <Field label="Supplier's invoice no." hint="Optional">
            <Input value={f.invoiceNo} onChange={set('invoiceNo')} placeholder="e.g. INV-2231" />
          </Field>
          <Field label="Date">
            <Input type="date" value={f.date} onChange={set('date')} />
          </Field>
        </div>

        {/* A grid, not a table: a table has to sit in a scrolling wrapper, and
            that wrapper clipped the item search list to a sliver. */}
        <div className="pb-lines">
          <div className="pb-line pb-head">
            <span>#</span><span>Item</span><span className="r">Qty</span>
            <span className="r">Cost / unit</span><span className="r">Total</span><span />
          </div>
          {f.lines.map((l, idx) => {
            const item = data.items.find((i) => i.id === l.itemId);
            const lineTotal = r2((Number(l.qty) || 0) * (Number(l.costPrice) || 0));
            return (
              <div key={l.key} className="pb-line">
                <span className="pb-no">{idx + 1}</span>
                <div className="pb-item">
                  <TypeAhead items={activeItems} value={l.itemId}
                             onChange={(id, it) => pickItem(l.key, id, it)}
                             getLabel={(i) => i.name}
                             getSub={(i) => `Stock ${itemStock(i.id, data)} ${i.baseUnit || ''} · cost ${money(i.costPrice)}`}
                             placeholder="Search item…"
                             focusRef={l.key === focusLineKey ? itemInputRef : null}
                             onAddNew={(name) => { setPrefill(name); setAdding(l.key); }}
                             addNewLabel="Add new item" />
                  {item && (
                    <div className="pb-sub">
                      In stock: {itemStock(item.id, data)} {item.baseUnit || ''} · last cost {money(item.costPrice)}
                    </div>
                  )}
                </div>
                <label className="pb-field">
                  <span className="pb-label">Qty{item?.baseUnit ? ` (${item.baseUnit})` : ''}</span>
                  <Input type="number" min="0" step="any" value={l.qty} placeholder="0"
                         onChange={(e) => setLine(l.key, { qty: e.target.value })} />
                </label>
                <label className="pb-field">
                  <span className="pb-label">Cost / unit</span>
                  <Input type="number" min="0" step="any" value={l.costPrice} placeholder="0"
                         onChange={(e) => setLine(l.key, { costPrice: e.target.value })} />
                </label>
                <div className="pb-total">
                  <span className="pb-label">Total</span>
                  <span className="money">{money(lineTotal)}</span>
                </div>
                <button type="button" className="btn btn-ghost btn-sm pb-del" title="Remove item"
                        disabled={f.lines.length === 1}
                        onClick={() => setF((x) => ({ ...x, lines: x.lines.filter((y) => y.key !== l.key) }))}>
                  <Trash2 size={15} />
                </button>
              </div>
            );
          })}
        </div>

        <button type="button" className="pb-add" onClick={addLine}
                title="Add another item (Ctrl+Shift+A)">
          <Plus size={15} /> Add another item <kbd className="kbd-hint">Ctrl+Shift+A</kbd>
        </button>

        <div style={{
          margin: '14px 0', padding: 12, background: 'var(--bg)', borderRadius: 'var(--r-sm)',
          border: '1px solid var(--border)', display: 'flex', alignItems: 'center',
        }}>
          <span style={{ fontWeight: 700 }}>Purchase total</span>
          <span className="spacer" />
          <span className="money" style={{ fontSize: 17 }}>{money(total)}</span>
        </div>

        <div className="form-grid">
          <Field label="Paid now" hint={paidNow > total + 0.004
            ? 'Cannot be more than the bill total'
            : total > 0 ? `Left on account: ${money(r2(total - paidNow))}` : 'Leave 0 to buy on credit'}>
            <Input type="number" min="0" step="any" value={f.paidNow}
                   onChange={set('paidNow')} placeholder="0" />
          </Field>
          <Field label="Paid from">
            <Select value={f.method} onChange={set('method')} options={payMethods} />
          </Field>
          <Field label="Note" className="full">
            <Input value={f.note} onChange={set('note')} placeholder="Optional" />
          </Field>
        </div>

        <label className="row" style={{ gap: 9, alignItems: 'flex-start', cursor: 'pointer', marginTop: 4 }}>
          <input type="checkbox" checked={f.notReceived}
                 onChange={(e) => setF((x) => ({ ...x, notReceived: e.target.checked }))}
                 style={{ width: 17, height: 17, marginTop: 1, flexShrink: 0 }} />
          <span>
            <span style={{ fontWeight: 600 }}>Goods not received yet</span>
            <span className="small muted" style={{ display: 'block' }}>
              Tick if the supplier has not sent the goods. Tick items off from the
              supplier's khata as they arrive, some now and the rest later.
            </span>
          </span>
        </label>
      </Modal>

      <Modal open={adding === 'supplier'} title="Add New Supplier" onClose={() => setAdding(null)}>
        <SupplierForm initialName={prefill}
                      onSaved={(s) => { setAdding(null); if (s?.id) setF((x) => ({ ...x, supplierId: s.id })); }}
                      onCancel={() => setAdding(null)} />
      </Modal>

      <Modal open={adding !== null && adding !== 'supplier'} title="Add New Item" onClose={() => setAdding(null)}>
        <ItemForm initialName={prefill}
                  onSaved={(it) => {
                    const key = adding;
                    setAdding(null);
                    if (it?.id) {
                      pickItem(key, it.id, it);
                      toast(`Item "${it.name}" added`);
                    }
                  }}
                  onCancel={() => setAdding(null)} />
      </Modal>
    </>
  );
}
