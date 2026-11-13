// Record a payment against a due bill (FR-17).
// Same multi-method split entry used when creating a bill.

import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import api from '../../lib/api';
import { Modal, Button, Field, Input, Select, Money } from '../ui';
import { money, todayISO, r2, uid, fmtDate } from '../../lib/format';
import ChequeFields, { blankCheque } from './ChequeFields';
import { billPaymentRoom } from '../../lib/calc';

export default function PaymentModal({ open, onClose, bill, state, party }) {
  const { methods, mutate } = useApp();
  const [date, setDate] = useState(todayISO());
  const [rows, setRows] = useState([{ key: uid('p'), method: 'Cash', amount: '', cheque: null }]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  // Cheques already waiting at the bank will settle their share once they
  // clear, so they come off what this dialog may still take.
  const pendingCheques = state?.pendingCheques ?? 0;
  const due = state ? billPaymentRoom(state) : 0;

  const total = useMemo(
    () => r2(rows.reduce((s, r) => s + (Number(r.amount) || 0), 0)),
    [rows]
  );
  // Every row is checked on its own when saved, so the rows together must be
  // checked here, before the first one is written.
  const tooMuch = total > due + 0.004;
  const remaining = r2(Math.max(0, due - total));

  const setRow = (key, patch) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const addRow = () => setRows((rs) => [...rs, { key: uid('p'), method: 'Cash', amount: '', cheque: null }]);
  const delRow = (key) => setRows((rs) => (rs.length > 1 ? rs.filter((r) => r.key !== key) : rs));

  const fillFull = (key) => {
    const others = r2(rows.filter((r) => r.key !== key).reduce((s, r) => s + (Number(r.amount) || 0), 0));
    setRow(key, { amount: String(r2(Math.max(0, due - others))) });
  };

  const reset = () => {
    setRows([{ key: uid('p'), method: 'Cash', amount: '', cheque: null }]);
    setNote('');
    setDate(todayISO());
  };

  const submit = async () => {
    if (busy) return; // guard: a second click must not record the payment twice
    const valid = rows.filter((r) => Number(r.amount) > 0);
    if (!valid.length || tooMuch) return;
    setBusy(true);
    try {
      for (const r of valid) {
        await mutate(() => api.addPayment({
          billId: bill.id,
          partyId: bill.partyId,
          method: r.method,
          amount: Number(r.amount),
          date,
          note,
          cheque: r.cheque,
        }));
      }
      reset();
      onClose?.();
    } catch {
      /* toast shown by mutate */
    } finally {
      setBusy(false);
    }
  };

  if (!bill) return null;

  return (
    <Modal
      open={open}
      title={`Add Payment — Bill ${bill.billNo}`}
      onClose={() => { reset(); onClose?.(); }}
      footer={
        <>
          <Button onClick={() => { reset(); onClose?.(); }}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy} disabled={total <= 0 || tooMuch}>
            Record {total > 0 ? money(total) : 'Payment'}
          </Button>
        </>
      }
    >
      <div style={{
        display: 'flex', gap: 16, padding: 12, background: 'var(--bg)',
        borderRadius: 'var(--r-sm)', marginBottom: 16, flexWrap: 'wrap',
      }}>
        <div>
          <div className="small muted">Party</div>
          <div style={{ fontWeight: 600 }}>{party?.name}</div>
        </div>
        <div>
          <div className="small muted">Bill total</div>
          <Money value={state?.net ?? bill.totalAmount} />
        </div>
        <div>
          <div className="small muted">Already paid</div>
          <Money value={state?.paid ?? 0} />
        </div>
        <div>
          <div className="small muted">Balance due</div>
          <span className="money" style={{ color: 'var(--danger)' }}>{money(due)}</span>
        </div>
        {pendingCheques > 0 && (
          <div>
            <div className="small muted">Cheques awaiting clearance</div>
            <span className="money" style={{ color: '#B45309' }}>{money(pendingCheques)}</span>
          </div>
        )}
      </div>

      {tooMuch && (
        <div className="small mb-2" style={{ color: 'var(--danger)', fontWeight: 600 }}>
          Total {money(total)} is more than the {money(due)} left on this bill
          {pendingCheques > 0 ? ` after ${money(pendingCheques)} in uncleared cheques` : ''}.
          Use Payment on the party ledger for the extra — it goes to their other bills or becomes an advance.
        </div>
      )}

      <Field label="Payment date">
        <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </Field>

      <label style={{ fontSize: 12.5, fontWeight: 600, display: 'block', marginBottom: 5 }}>
        Payment method{rows.length > 1 ? 's' : ''}
      </label>

      {rows.map((r) => (
        <div key={r.key} style={{ marginBottom: 10 }}>
          <div className="row" style={{ gap: 7 }}>
            <Select
              value={r.method}
              onChange={(e) => setRow(r.key, {
                method: e.target.value,
                cheque: e.target.value === 'Cheque'
                  ? blankCheque(date)
                  : null,
              })}
              options={methods}
              style={{ width: 132 }}
            />
            <Input type="number" min="0" step="any" placeholder="0"
                   inputMode="decimal" aria-label="Payment amount"
                   value={r.amount} onChange={(e) => setRow(r.key, { amount: e.target.value })} />
            <Button size="sm" onClick={() => fillFull(r.key)}>Full</Button>
            {rows.length > 1 && (
              <button className="btn btn-ghost btn-icon" onClick={() => delRow(r.key)}
                      aria-label="Remove method">
                <Trash2 size={15} color="var(--danger)" />
              </button>
            )}
          </div>

          {r.method === 'Cheque' && (
            <ChequeFields value={r.cheque} onChange={(cheque) => setRow(r.key, { cheque })} />
          )}
        </div>
      ))}

      <Button size="sm" icon={Plus} onClick={addRow}>Add another method</Button>

      <Field label="Note" className="mt-2">
        <Input value={note} onChange={(e) => setNote(e.target.value)}
               placeholder="Optional reference" />
      </Field>

      <div style={{
        padding: 12, borderRadius: 'var(--r-sm)', marginTop: 4,
        background: remaining > 0 ? 'var(--warning-bg)' : 'var(--success-bg)',
        border: `1px solid ${remaining > 0 ? '#FDE68A' : '#BBF7D0'}`,
        color: remaining > 0 ? '#B45309' : '#15803D',
        display: 'flex', alignItems: 'center', fontWeight: 700,
      }}>
        <span>{remaining > 0 ? 'Remaining after this payment' : 'This clears the bill'}</span>
        <span className="spacer" />
        <span>{remaining > 0 ? money(remaining) : money(0)}</span>
      </div>
    </Modal>
  );
}
