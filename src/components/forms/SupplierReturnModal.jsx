// Send goods back to a supplier.
//
// Stock goes down by the quantity, and what the shop owes the supplier goes
// down by the value. Picking the purchase bill limits the return to what that
// bill actually brought in.

import { useEffect, useMemo, useState } from 'react';
import { Save } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import api from '../../lib/api';
import { Button, Modal, Field, Input, Select, TypeAhead } from '../ui';
import { derivePurchaseBills, itemStock } from '../../lib/calc';
import { money, todayISO, r2, fmtDate } from '../../lib/format';

const blank = () => ({
  purchaseBillId: '', itemId: '', qty: '', value: '', date: todayISO(), note: '',
});

// `purchaseBillId` preselects the purchase the goods came on (from its own page).
export default function SupplierReturnModal({ open, onClose, supplierId, purchaseBillId = '' }) {
  const { data, activeItems, mutate } = useApp();
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);
  // True once the value has been typed by hand, so it stops following qty.
  const [valueTouched, setValueTouched] = useState(false);

  useEffect(() => {
    if (open) { setF({ ...blank(), purchaseBillId }); setValueTouched(false); }
  }, [open, purchaseBillId]);

  const bills = useMemo(
    () => derivePurchaseBills(supplierId, data).filter((b) => b.status !== 'voided'),
    [supplierId, data]
  );

  // With a bill picked, only its items can go back, at the price paid on it.
  const billLines = useMemo(
    () => data.purchases.filter((p) => f.purchaseBillId && p.purchaseBillId === f.purchaseBillId),
    [data.purchases, f.purchaseBillId]
  );
  const itemChoices = f.purchaseBillId
    ? activeItems.filter((i) => billLines.some((l) => l.itemId === i.id))
    : activeItems;

  const unitCost = () => {
    const line = billLines.find((l) => l.itemId === f.itemId);
    if (line) return Number(line.costPrice) || 0;
    return Number(data.items.find((i) => i.id === f.itemId)?.costPrice) || 0;
  };

  const leftOnBill = useMemo(() => {
    if (!f.purchaseBillId || !f.itemId) return null;
    const bought = billLines.filter((l) => l.itemId === f.itemId)
      .reduce((s, l) => s + (Number(l.qty) || 0), 0);
    const back = data.supplierReturns
      .filter((r) => r.purchaseBillId === f.purchaseBillId && r.itemId === f.itemId)
      .reduce((s, r) => s + (Number(r.qty) || 0), 0);
    return r2(bought - back);
  }, [billLines, data.supplierReturns, f.purchaseBillId, f.itemId]);

  const setQty = (qty) => setF((x) => ({
    ...x, qty,
    value: valueTouched ? x.value : (Number(qty) > 0 ? String(r2(Number(qty) * unitCost())) : ''),
  }));

  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const qty = Number(f.qty) || 0;
  const tooMany = leftOnBill !== null && qty > leftOnBill + 0.0001;
  const canSave = f.itemId && qty > 0 && !tooMany && Number(f.value) >= 0;

  const submit = async () => {
    if (busy || !canSave) return;
    setBusy(true);
    try {
      await mutate(() => api.addSupplierReturn({
        supplierId, purchaseBillId: f.purchaseBillId, itemId: f.itemId,
        qty, value: Number(f.value) || 0, date: f.date, note: f.note,
      }), 'Return to supplier recorded');
      onClose();
    } catch { /* toast shown */ } finally { setBusy(false); }
  };

  return (
    <Modal open={open} title="Return Goods to Supplier" onClose={onClose}
           footer={
             <>
               <Button onClick={onClose}>Cancel</Button>
               <Button variant="primary" icon={Save} onClick={submit} loading={busy} disabled={!canSave}>
                 Record Return
               </Button>
             </>
           }>
      <div className="form-grid">
        <Field label="From purchase" className="full" hint="Optional — pick it to return at the price you paid">
          <Select value={f.purchaseBillId}
                  onChange={(e) => { setF((x) => ({ ...x, purchaseBillId: e.target.value, itemId: '', qty: '', value: '' })); setValueTouched(false); }}>
            <option value="">Not linked to a purchase bill</option>
            {bills.map((b) => (
              <option key={b.id} value={b.id}>{b.purchaseNo} · {fmtDate(b.date)} · {money(b.total)}</option>
            ))}
          </Select>
        </Field>
        <Field label="Item" className="full"
               hint={f.itemId
                 ? (leftOnBill !== null
                   ? `${leftOnBill} left to return from this purchase`
                   : `In stock: ${itemStock(f.itemId, data)}`)
                 : undefined}>
          <TypeAhead items={itemChoices} value={f.itemId}
                     onChange={(id) => { setF((x) => ({ ...x, itemId: id || '', qty: '', value: '' })); setValueTouched(false); }}
                     getLabel={(i) => i.name} getSub={(i) => `cost ${money(i.costPrice)}`}
                     placeholder="Search item…" />
        </Field>
        <Field label="Quantity" error={tooMany ? `Only ${leftOnBill} left on this purchase` : undefined}>
          <Input type="number" min="0" step="any" value={f.qty} placeholder="0"
                 onChange={(e) => setQty(e.target.value)} />
        </Field>
        <Field label="Value" hint="Taken off what you owe the supplier">
          <Input type="number" min="0" step="any" value={f.value} placeholder="0"
                 onChange={(e) => { setValueTouched(true); set('value')(e); }} />
        </Field>
        <Field label="Date">
          <Input type="date" value={f.date} onChange={set('date')} />
        </Field>
        <Field label="Note">
          <Input value={f.note} onChange={set('note')} placeholder="e.g. damaged in transit" />
        </Field>
      </div>
    </Modal>
  );
}
