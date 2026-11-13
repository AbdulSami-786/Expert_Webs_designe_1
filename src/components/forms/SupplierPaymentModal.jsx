// Pay a supplier — on account, or against one purchase bill.
//
// Paying more than is owed is allowed on purpose: the extra is an advance the
// supplier holds, and the next purchase bill uses it up.
//
// With `advance`, the same dialog records money given to a supplier before any
// goods arrive. It is marked as an advance so the khata says so, and it never
// belongs to one purchase bill. Opened without a `supplierId` (from the
// Purchases page), it asks which supplier first.

import { useEffect, useMemo, useState } from 'react';
import { Save } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import api from '../../lib/api';
import { Button, Modal, Field, Input, Select } from '../ui';
import { supplierBalance, derivePurchaseBills } from '../../lib/calc';
import { money, todayISO, r2, fmtDate } from '../../lib/format';

const blank = (purchaseBillId = '', supplierId = '') => ({
  supplierId, purchaseBillId, amount: '', method: 'Cash', date: todayISO(), note: '',
});

export default function SupplierPaymentModal({
  open, onClose, supplierId: fixedSupplierId = '', purchaseBillId = '', advance = false,
}) {
  const { data, methods, mutate } = useApp();
  const [f, setF] = useState(() => blank(purchaseBillId, fixedSupplierId));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setF(blank(advance ? '' : purchaseBillId, fixedSupplierId));
  }, [open, purchaseBillId, fixedSupplierId, advance]);

  const supplierId = fixedSupplierId || f.supplierId;
  const activeSuppliers = useMemo(
    () => data.suppliers.filter((s) => s.status !== 'archived')
      .sort((a, b) => a.name.localeCompare(b.name)),
    [data.suppliers]
  );

  const balance = supplierBalance(supplierId, data);
  const openBills = useMemo(
    () => derivePurchaseBills(supplierId, data).filter((b) => b.status !== 'voided' && b.due > 0),
    [supplierId, data]
  );
  const bill = openBills.find((b) => b.id === f.purchaseBillId);

  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const amount = Number(f.amount) || 0;
  const extra = r2(amount - Math.max(0, balance));

  const submit = async () => {
    if (busy || !(amount > 0) || !supplierId) return;
    setBusy(true);
    try {
      await mutate(() => api.addSupplierPayment({
        supplierId, purchaseBillId: advance ? '' : f.purchaseBillId, amount,
        method: f.method, date: f.date, note: f.note, isAdvance: advance,
      }), advance ? 'Advance to supplier recorded' : 'Payment to supplier recorded');
      onClose();
    } catch { /* toast shown */ } finally { setBusy(false); }
  };

  return (
    <Modal open={open} title={advance ? 'Give Advance to Supplier' : 'Pay Supplier'} onClose={onClose}
           footer={
             <>
               <Button onClick={onClose}>Cancel</Button>
               <Button variant="primary" icon={Save} onClick={submit} loading={busy}
                       disabled={!(amount > 0) || !supplierId}>
                 {advance ? 'Give' : 'Pay'} {amount > 0 ? money(amount) : ''}
               </Button>
             </>
           }>
      {!fixedSupplierId && (
        <Field label="Supplier">
          <Select value={f.supplierId} onChange={set('supplierId')}>
            <option value="">Select a supplier…</option>
            {activeSuppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
      )}

      {supplierId && (
      <div style={{
        padding: 12, marginBottom: 12, background: 'var(--bg)', borderRadius: 'var(--r-sm)',
        border: '1px solid var(--border)', display: 'flex', alignItems: 'center',
      }}>
        <span>{balance >= 0 ? 'You owe this supplier' : 'Advance they hold'}</span>
        <span className="spacer" />
        <span className={`money ${balance > 0 ? 'neg' : 'pos'}`} style={{ fontSize: 16 }}>
          {money(Math.abs(balance))}
        </span>
      </div>
      )}

      {advance && supplierId && balance > 0.004 && (
        <p className="small muted mb-2">
          You still owe this supplier {money(balance)}. An advance first clears that,
          and only the rest is held by the supplier as an advance.
        </p>
      )}

      <div className="form-grid">
        {!advance && (
        <Field label="Against purchase" className="full"
               hint={bill ? `${money(bill.due)} still due on this purchase` : 'On account settles the oldest dues first'}>
          <Select value={f.purchaseBillId} onChange={set('purchaseBillId')}>
            <option value="">On account (no particular bill)</option>
            {openBills.map((b) => (
              <option key={b.id} value={b.id}>
                {b.purchaseNo} · {fmtDate(b.date)} · due {money(b.due)}
              </option>
            ))}
          </Select>
        </Field>
        )}
        <Field label="Amount"
               hint={!advance && amount > 0 && extra > 0.004
                 ? `${money(extra)} will be held by the supplier as an advance`
                 : undefined}>
          <Input type="number" min="0" step="any" value={f.amount} onChange={set('amount')}
                 placeholder="0" autoFocus />
        </Field>
        <Field label="Paid from">
          <Select value={f.method} onChange={set('method')}
                  options={methods.filter((m) => m !== 'Cheque')} />
        </Field>
        <Field label="Date">
          <Input type="date" value={f.date} onChange={set('date')} />
        </Field>
        <Field label="Note">
          <Input value={f.note} onChange={set('note')}
                 placeholder={advance ? 'e.g. advance for next order' : 'Optional'} />
        </Field>
      </div>
    </Modal>
  );
}
