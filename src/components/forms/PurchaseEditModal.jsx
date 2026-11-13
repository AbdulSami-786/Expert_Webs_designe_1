// Fix a purchase that was entered wrongly — wrong item, quantity or cost.
//
// A line of a supplier purchase bill keeps the bill's supplier, date and
// payment; only what was bought can change here, and the bill total follows.
// A quick purchase (no bill) can have every field corrected.

import { useEffect, useMemo, useState } from 'react';
import { Save } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import api from '../../lib/api';
import { Button, Modal, Field, Input, Select, TypeAhead } from '../ui';
import { money, r2 } from '../../lib/format';

export default function PurchaseEditModal({ purchase, onClose }) {
  const { data, activeItems, methods, mutate } = useApp();
  const [f, setF] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!purchase) return;
    setF({
      itemId: purchase.itemId, qty: String(purchase.qty ?? ''), costPrice: String(purchase.costPrice ?? ''),
      supplierName: purchase.supplierName || '', date: purchase.date || '',
      method: purchase.method || 'Cash', note: purchase.note || '',
    });
  }, [purchase]);

  const bill = purchase?.purchaseBillId
    ? (data.purchaseBills || []).find((b) => b.id === purchase.purchaseBillId)
    : null;

  // Keep the purchase's own item selectable even if it has since been archived.
  const itemChoices = useMemo(() => {
    const own = data.items.find((i) => i.id === purchase?.itemId);
    return own && !activeItems.some((i) => i.id === own.id) ? [own, ...activeItems] : activeItems;
  }, [data.items, activeItems, purchase]);

  const suppliers = useMemo(
    () => [...new Set(data.purchases.map((p) => p.supplierName).filter(Boolean))].sort(),
    [data.purchases]
  );

  if (!purchase || !f) return null;

  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const total = r2((Number(f.qty) || 0) * (Number(f.costPrice) || 0));
  const valid = f.itemId && Number(f.qty) > 0 && Number(f.costPrice) >= 0 && f.costPrice !== '';

  const submit = async () => {
    if (busy || !valid) return;
    setBusy(true);
    try {
      await mutate(() => api.updatePurchase({
        id: purchase.id, itemId: f.itemId, qty: Number(f.qty), costPrice: Number(f.costPrice),
        note: f.note,
        ...(bill ? {} : { supplierName: f.supplierName, date: f.date, method: f.method }),
      }), 'Purchase updated');
      onClose();
    } catch { /* toast shown */ } finally { setBusy(false); }
  };

  return (
    <Modal open title={bill ? `Edit line — ${bill.purchaseNo}` : 'Edit Purchase'} onClose={onClose}
           footer={
             <>
               <Button onClick={onClose}>Cancel</Button>
               <Button variant="primary" icon={Save} onClick={submit} loading={busy} disabled={!valid}>
                 Save {total > 0 ? money(total) : ''}
               </Button>
             </>
           }>
      {bill && (
        <p className="small muted mb-2">
          Part of purchase {bill.purchaseNo}. Its supplier, date and payment stay as they are;
          the bill total is worked out again from its lines.
        </p>
      )}

      <Field label="Item">
        <TypeAhead items={itemChoices} value={f.itemId}
                   onChange={(id) => setF((x) => ({ ...x, itemId: id }))}
                   getLabel={(i) => i.name}
                   getSub={(i) => `${i.category || 'Uncategorised'} · current cost ${money(i.costPrice)}`}
                   placeholder="Search item…" />
      </Field>

      <div className="form-grid">
        <Field label="Quantity">
          <Input type="number" min="0" step="any" value={f.qty} onChange={set('qty')} autoFocus />
        </Field>
        <Field label="Cost price per unit">
          <Input type="number" min="0" step="any" value={f.costPrice} onChange={set('costPrice')} />
        </Field>
        {!bill && (
          <>
            <Field label="Supplier">
              <Input value={f.supplierName} onChange={set('supplierName')} list="supplier-edit-list"
                     placeholder="Supplier name" />
              <datalist id="supplier-edit-list">
                {suppliers.map((s) => <option key={s} value={s} />)}
              </datalist>
            </Field>
            <Field label="Date">
              <Input type="date" value={f.date} onChange={set('date')} />
            </Field>
            <Field label="Paid from">
              <Select value={f.method} onChange={set('method')}
                      options={methods.filter((m) => m !== 'Cheque')} />
            </Field>
          </>
        )}
        <Field label="Note">
          <Input value={f.note} onChange={set('note')} placeholder="Optional" />
        </Field>
      </div>

      <div style={{
        padding: 12, background: 'var(--bg)', borderRadius: 'var(--r-sm)',
        border: '1px solid var(--border)', display: 'flex', alignItems: 'center',
      }}>
        <span style={{ fontWeight: 700 }}>Line total</span>
        <span className="spacer" />
        <span className="money" style={{ fontSize: 17 }}>{money(total)}</span>
      </div>
    </Modal>
  );
}
