// Hand money back to a party for goods they returned from a bill they had already paid.
// Without this the ledger keeps showing the money as a minus balance (the shop owes it).

import { useEffect, useState } from 'react';
import { Banknote } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import api from '../../lib/api';
import { Modal, Button, Field, Input, Select } from '../ui';
import { money, todayISO, r2 } from '../../lib/format';
import { useBackendFeature } from '../../lib/useBackendFeature';
import OutdatedBackend from '../OutdatedBackend';

export default function RefundModal({ open, onClose, bill, party, max = 0 }) {
  const { methods, mutate } = useApp();
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('Cash');
  const [date, setDate] = useState(todayISO());
  const [busy, setBusy] = useState(false);
  const support = useBackendFeature('addRefund', open);

  // Start on the full amount owed back, every time it opens.
  useEffect(() => {
    if (open) { setAmount(String(r2(max))); setMethod('Cash'); setDate(todayISO()); }
  }, [open, max]);

  if (!bill) return null;
  const n = Number(amount);
  const bad = !(n > 0) || n > max + 0.004 || support.state === 'old';

  const submit = async () => {
    if (busy || bad) return;
    setBusy(true);
    try {
      await mutate(() => api.addRefund({ billId: bill.id, amount: n, method, date }), 'Refund recorded');
      onClose?.();
    } catch { /* toast shown */ } finally { setBusy(false); }
  };

  return (
    <Modal open={open} title={`Refund — Bill ${bill.billNo}`} onClose={onClose}
           footer={(
             <>
               <Button onClick={onClose}>Cancel</Button>
               <Button variant="primary" icon={Banknote} onClick={submit} loading={busy} disabled={bad}>
                 Record refund
               </Button>
             </>
           )}>
      <p style={{ marginTop: 0, fontSize: 14 }}>
        {party?.name || 'The customer'} paid <strong>{money(max)}</strong> more than this bill is worth after the
        return. Handing it back clears the minus on their ledger and takes it out of your till.
      </p>
      {support.state === 'old' && <OutdatedBackend what="refunds" onRecheck={support.recheck} />}
      <div className="form-grid">
        <Field label="Amount handed back"
               error={n > max + 0.004 ? `Cannot be more than ${money(max)}` : ''}>
          <Input type="number" min="0" max={max} step="any" value={amount}
                 onChange={(e) => setAmount(e.target.value)} autoFocus />
        </Field>
        <Field label="Payment method — paid back by">
          <Select value={method} onChange={(e) => setMethod(e.target.value)} options={methods} />
        </Field>
        <Field label="Date">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
