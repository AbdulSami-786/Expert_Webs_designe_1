// Delete one bill for good: the bill, its item lines, every payment, return and cheque on it.
// The goods go back into stock and the money is reversed, because both are worked out from those
// records. Unlike Void, nothing of the bill is kept (only a line in the Activity Log).

import { useEffect, useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import api from '../../lib/api';
import { Modal, Button, Field, Input } from '../ui';
import { billDeletePlan } from '../../lib/calc';
import { money } from '../../lib/format';
import { useBackendFeature } from '../../lib/useBackendFeature';
import OutdatedBackend from '../OutdatedBackend';

export default function DeleteBillModal({ open, onClose, bill, onDeleted }) {
  const { data, mutate } = useApp();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const support = useBackendFeature('deleteBill', open);

  useEffect(() => { if (open) setTyped(''); }, [open]);

  const plan = useMemo(() => (bill ? billDeletePlan(bill.id, data) : null), [bill, data]);
  if (!bill || !plan) return null;

  const party = data.parties.find((p) => p.id === bill.partyId);
  const matches = typed.trim().toLowerCase() === String(bill.billNo).trim().toLowerCase();
  const blocked = !matches || support.state === 'old' || support.state === 'checking';

  const submit = async () => {
    if (busy || blocked) return;
    setBusy(true);
    try {
      const res = await mutate(() => api.deleteBill(bill.id), `Bill ${bill.billNo} deleted`);
      onClose?.();
      onDeleted?.(res);
    } catch { /* toast shown */ } finally { setBusy(false); }
  };

  const row = (n, label) => (n > 0 ? <li><strong>{n}</strong> {label}</li> : null);

  return (
    <Modal open={open} title={`Delete Bill ${bill.billNo} permanently`} onClose={onClose}
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
        This cannot be undone. Unlike Void, nothing of this bill is kept — it will not appear in any ledger.
        {' '}If you only want it cancelled but kept in the history, use <strong>Void</strong> instead.
      </div>

      <div style={{ fontSize: 14, marginBottom: 6 }}>
        Bill {bill.billNo}{party ? ` (${party.name})` : ''}, {money(bill.totalAmount)}, is removed with:
      </div>
      <ul style={{ margin: '0 0 12px', paddingLeft: 20, lineHeight: 1.7, fontSize: 13.5 }}>
        <li><strong>{plan.lines.length}</strong> item {plan.lines.length === 1 ? 'line' : 'lines'}</li>
        {row(plan.payments.length, plan.payments.length === 1 ? 'payment' : 'payments')}
        {row(plan.returns.length, plan.returns.length === 1 ? 'return' : 'returns')}
        {row(plan.cheques.length, plan.cheques.length === 1 ? 'cheque' : 'cheques')}
      </ul>

      <div style={{ fontSize: 14, marginBottom: 6 }}>What it gives back:</div>
      <ul style={{ margin: '0 0 12px', paddingLeft: 20, lineHeight: 1.7, fontSize: 13.5 }}>
        <li><strong>{plan.restocked}</strong> item {plan.restocked === 1 ? 'quantity goes' : 'quantities go'} back into stock</li>
        {plan.paid > 0 && (
          <li><strong>{money(plan.paid)}</strong> paid on it is taken back out of your Cash / Bank balances</li>
        )}
        {plan.refunded > 0 && (
          <li>The <strong>{money(plan.refunded)}</strong> you had refunded is put back into your balances</li>
        )}
        {plan.advanceUsed > 0 && (
          <li><strong>{money(plan.advanceUsed)}</strong> of {party?.name || 'the party'}&rsquo;s advance that this bill used goes back to their advance balance</li>
        )}
        {plan.setOffs.length > 0 && (
          <li>The set-off against {plan.supplier?.name || 'their supplier account'} is taken back too</li>
        )}
      </ul>

      {support.state === 'old' && <OutdatedBackend what="deleting a bill" onRecheck={support.recheck} />}

      <Field label={`Type the bill number to confirm: ${bill.billNo}`}>
        <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={bill.billNo}
               autoFocus autoComplete="off" />
      </Field>
    </Modal>
  );
}
