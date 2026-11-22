// Delete an archived supplier for good: the supplier, all their purchase bills, payments and returns.
// Stock and money are worked out from those records, so removing them takes the stock back out and
// puts the money they were paid back into the cash/bank balances.

import { useEffect, useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import api from '../../lib/api';
import { Modal, Button, Field, Input } from '../ui';
import { supplierDeletePlan } from '../../lib/calc';
import { money } from '../../lib/format';
import { useBackendFeature } from '../../lib/useBackendFeature';
import OutdatedBackend from '../OutdatedBackend';

export default function DeleteSupplierModal({ open, onClose, supplier }) {
  const { data, mutate } = useApp();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const support = useBackendFeature('deleteSupplier', open);

  useEffect(() => { if (open) setTyped(''); }, [open]);

  const plan = useMemo(() => (supplier ? supplierDeletePlan(supplier.id, data) : null), [supplier, data]);
  if (!supplier || !plan) return null;

  const linked = Boolean(supplier.partyId);
  const matches = typed.trim().toLowerCase() === String(supplier.name).trim().toLowerCase();
  const blocked = linked || !matches || support.state === 'old' || support.state === 'checking';

  const submit = async () => {
    if (busy || blocked) return;
    setBusy(true);
    try {
      await mutate(() => api.deleteSupplier(supplier.id), `"${supplier.name}" deleted`);
      onClose?.();
    } catch { /* toast shown */ } finally { setBusy(false); }
  };

  const row = (n, label) => (n > 0 ? <li><strong>{n}</strong> {label}</li> : null);

  return (
    <Modal open={open} title={`Delete ${supplier.name} permanently`} onClose={onClose}
           footer={(
             <>
               <Button onClick={onClose}>Cancel</Button>
               <Button variant="danger" icon={Trash2} onClick={submit} loading={busy} disabled={blocked}>
                 Delete permanently
               </Button>
             </>
           )}>
      <div style={{
        padding: '10px 13px', marginBottom: 12, background: 'var(--danger-bg)',
        border: '1px solid #FECACA', borderRadius: 'var(--r-sm)', fontSize: 13, color: '#991B1B',
      }}>
        This cannot be undone. Unlike archiving, nothing of this supplier is kept.
      </div>

      {linked && (
        <div style={{ fontSize: 13.5, marginBottom: 12, color: '#991B1B' }}>
          This supplier is linked to a party. Disconnect them from the supplier&apos;s page first.
        </div>
      )}

      <div style={{ fontSize: 14, marginBottom: 6 }}>These are removed with the supplier:</div>
      <ul style={{ margin: '0 0 12px', paddingLeft: 20, lineHeight: 1.7, fontSize: 13.5 }}>
        <li><strong>{plan.purchaseBills.length}</strong> purchase {plan.purchaseBills.length === 1 ? 'bill' : 'bills'}
          {plan.purchases.length > 0 && <> with {plan.purchases.length} item {plan.purchases.length === 1 ? 'line' : 'lines'}</>}</li>
        {row(plan.payments.length, plan.payments.length === 1 ? 'payment' : 'payments')}
        {row(plan.returns.length, plan.returns.length === 1 ? 'return' : 'returns')}
      </ul>

      <div style={{ fontSize: 14, marginBottom: 6 }}>What it changes:</div>
      <ul style={{ margin: '0 0 12px', paddingLeft: 20, lineHeight: 1.7, fontSize: 13.5 }}>
        <li>
          <strong>{plan.stockOut}</strong> item {plan.stockOut === 1 ? 'quantity goes' : 'quantities go'} out of stock
          (what they supplied is no longer counted)
        </li>
        <li>
          <strong>{money(plan.paid)}</strong> paid to them is put back into your Cash / Bank balances
        </li>
      </ul>

      {support.state === 'old' && <OutdatedBackend what="deleting a supplier" onRecheck={support.recheck} />}

      <Field label={`Type the supplier's name to confirm: ${supplier.name}`}>
        <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={supplier.name}
               autoFocus autoComplete="off" />
      </Field>
    </Modal>
  );
}
