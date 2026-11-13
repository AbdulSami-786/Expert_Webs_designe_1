// Correct a payment that was recorded wrongly — wrong amount, method, date or
// note.
//
// Deliberately cannot move a payment to a different bill or party. That looks
// like the same kind of fix, but it silently changes two bills' balances at
// once; a payment on the wrong bill is undone with Delete and entered again,
// where both steps are visible in the activity log.

import { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import api from '../../lib/api';
import { Modal, Button, Field, Input, Select } from '../ui';
import { money, r2 } from '../../lib/format';

export default function EditPaymentModal({ open, onClose, payment, cheque }) {
  const { methods, mutate } = useApp();
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('Cash');
  const [date, setDate] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  // Reload the form whenever a different payment is opened: the modal stays
  // mounted between openings, so state from the last one would otherwise
  // linger and be saved onto this payment.
  useEffect(() => {
    if (!payment) return;
    setAmount(String(payment.amount ?? ''));
    setMethod(payment.method || 'Cash');
    setDate((payment.date || '').slice(0, 10));
    setNote(payment.note || '');
  }, [payment]);

  if (!payment) return null;

  const entered = r2(Number(amount) || 0);
  const changed = entered !== r2(payment.amount)
    || method !== payment.method
    || date !== (payment.date || '').slice(0, 10)
    || note !== (payment.note || '');

  const submit = async () => {
    if (busy || entered <= 0) return;
    setBusy(true);
    try {
      await mutate(
        () => api.updatePayment({ id: payment.id, amount: entered, method, date, note }),
        'Payment updated',
      );
      onClose();
    } catch {
      // mutate() showed the error; leave the form open so the correction is
      // not lost and can be adjusted.
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Edit payment"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={Save} onClick={submit}
                  disabled={busy || entered <= 0 || !changed}>
            {busy ? 'Saving…' : 'Save changes'}
          </Button>
        </>
      }
    >
      <div className="row wrap" style={{ gap: 12 }}>
        <Field label="Amount" style={{ flex: '1 1 150px' }}>
          <Input type="number" min="0" step="0.01" inputMode="decimal"
                 autoFocus value={amount}
                 onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Method" style={{ flex: '1 1 140px' }}>
          <Select value={method} onChange={(e) => setMethod(e.target.value)}>
            {methods.map((m) => <option key={m} value={m}>{m}</option>)}
          </Select>
        </Field>
        <Field label="Date" style={{ flex: '1 1 140px' }}>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
      </div>

      <Field label="Note">
        <Input value={note} onChange={(e) => setNote(e.target.value)}
               placeholder="optional" />
      </Field>

      {cheque && (
        <div className="note">
          <span>
            A cheque ({cheque.chequeNo || 'no number'}
            {cheque.bankName ? ` · ${cheque.bankName}` : ''}) is attached to this
            payment. Changing the amount updates the cheque to match, so the
            bill and the cheque register cannot disagree.
          </span>
        </div>
      )}

      <div className="small muted" style={{ marginTop: 10 }}>
        Recorded as {money(payment.amount)} on {(payment.date || '').slice(0, 10)}.
        To move this payment to a different bill, delete it and record it again.
      </div>
    </Modal>
  );
}
