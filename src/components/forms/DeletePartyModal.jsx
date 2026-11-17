// Delete a party for good: the party, all their bills, payments, returns, cheques and advances.
// The stock on their bills goes back into stock and the money they paid comes back out of the
// cash/bank balances — both are worked out from those records, so removing them is the reversal.

import { useEffect, useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import api from '../../lib/api';
import { Modal, Button, Field, Input } from '../ui';
import { partyDeletePlan } from '../../lib/calc';
import { money } from '../../lib/format';
import { useBackendFeature } from '../../lib/useBackendFeature';
import OutdatedBackend from '../OutdatedBackend';

export default function DeletePartyModal({ open, onClose, party, onDeleted }) {
  const { data, mutate } = useApp();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const support = useBackendFeature('deleteParty', open);

  useEffect(() => { if (open) setTyped(''); }, [open]);

  const plan = useMemo(() => (party ? partyDeletePlan(party.id, data) : null), [party, data]);
  if (!party || !plan) return null;

  const matches = typed.trim().toLowerCase() === String(party.name).trim().toLowerCase();
  const blocked = !matches || support.state === 'old' || support.state === 'checking';

  const submit = async () => {
    if (busy || blocked) return;
    setBusy(true);
    try {
      const res = await mutate(() => api.deleteParty(party.id), `"${party.name}" deleted`);
      onClose?.();
      onDeleted?.(res);
    } catch { /* toast shown */ } finally { setBusy(false); }
  };

  const row = (n, label) => (n > 0 ? <li><strong>{n}</strong> {label}</li> : null);

  return (
    <Modal open={open} title={`Delete ${party.name} permanently`} onClose={onClose}
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
        This cannot be undone. Unlike archiving, nothing of this party is kept.
      </div>

      <div style={{ fontSize: 14, marginBottom: 6 }}>These are removed with the party:</div>
      <ul style={{ margin: '0 0 12px', paddingLeft: 20, lineHeight: 1.7, fontSize: 13.5 }}>
        <li><strong>{plan.bills.length}</strong> {plan.bills.length === 1 ? 'bill' : 'bills'}
          {plan.lines.length > 0 && <> with {plan.lines.length} item {plan.lines.length === 1 ? 'line' : 'lines'}</>}</li>
        {row(plan.payments.length, plan.payments.length === 1 ? 'payment' : 'payments')}
        {row(plan.returns.length, plan.returns.length === 1 ? 'return' : 'returns')}
        {row(plan.cheques.length, plan.cheques.length === 1 ? 'cheque' : 'cheques')}
        {row(plan.advances.length, plan.advances.length === 1 ? 'advance' : 'advances')}
      </ul>

      <div style={{ fontSize: 14, marginBottom: 6 }}>What it gives back:</div>
      <ul style={{ margin: '0 0 12px', paddingLeft: 20, lineHeight: 1.7, fontSize: 13.5 }}>
        <li>
          <strong>{plan.restocked}</strong> item {plan.restocked === 1 ? 'quantity goes' : 'quantities go'} back into stock
        </li>
        <li>
          <strong>{money(plan.paid)}</strong> they paid is taken back out of your Cash / Bank balances
          {plan.refunded > 0 && <>, and the <strong>{money(plan.refunded)}</strong> you refunded is put back</>}
        </li>
        {plan.supplier && (
          <li>
            Their supplier account <strong>{plan.supplier.name}</strong> stays (purchases are not touched);
            it is just no longer linked to this party
            {plan.setOffs.length > 0 && <>, and {plan.setOffs.length} set-off {plan.setOffs.length === 1 ? 'payment' : 'payments'} to it {plan.setOffs.length === 1 ? 'is' : 'are'} reversed</>}
          </li>
        )}
      </ul>

      {support.state === 'old' && <OutdatedBackend what="deleting a party" onRecheck={support.recheck} />}

      <Field label={`Type the party's name to confirm: ${party.name}`}>
        <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={party.name}
               autoFocus autoComplete="off" />
      </Field>
    </Modal>
  );
}
