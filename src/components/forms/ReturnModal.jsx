// Record a return against a bill (FR-18 / Plan 3.2).
//
// Recalculates the bill total and the party's due balance, and optionally
// restocks the item. If the bill was already fully paid, the return leaves a
// refund-due (credit note) balance visible on the ledger.

import { useMemo, useState } from 'react';
import { RotateCcw, Info } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import api from '../../lib/api';
import { Modal, Button, Field, Input, Select, Money } from '../ui';
import { money, todayISO, r2 } from '../../lib/format';
import { billState } from '../../lib/calc';

export default function ReturnModal({ open, onClose, bill, party }) {
  const { data, mutate, methods } = useApp();
  const [itemId, setItemId] = useState('');
  const [qty, setQty] = useState('');
  const [restock, setRestock] = useState(true);
  const [date, setDate] = useState(todayISO());
  const [note, setNote] = useState('');
  // Hand the money back with the return (only when the customer had paid for these goods).
  const [refundOn, setRefundOn] = useState(true);
  const [refundMethod, setRefundMethod] = useState('Cash');
  const [busy, setBusy] = useState(false);

  const lines = useMemo(
    () => (bill ? data.billItems.filter((bi) => bi.billId === bill.id) : []),
    [bill, data.billItems]
  );

  const state = useMemo(
    () => (bill ? billState(bill, data) : null),
    [bill, data]
  );

  const line = lines.find((l) => l.itemId === itemId);
  const itemName = (id) => data.items.find((i) => i.id === id)?.name || 'Item';

  /** Already-returned quantity for this line, so we cannot over-return. */
  const alreadyReturned = useMemo(() => {
    if (!bill || !itemId) return 0;
    return data.returns
      .filter((r) => r.billId === bill.id && r.itemId === itemId)
      .reduce((s, r) => s + (Number(r.qty) || 0), 0);
  }, [bill, itemId, data.returns]);

  const maxQty = line ? r2(Number(line.qty) - alreadyReturned) : 0;
  const value = line ? r2((Number(qty) || 0) * Number(line.price)) : 0;
  const overMax = Number(qty) > maxQty;

  // What the customer has paid beyond what the bill is worth once these goods come off it:
  // this is the money that has to go back to them (otherwise it sits on their ledger as a minus).
  const owedBack = state ? r2(Math.max(0, Math.min(value, state.paid - r2(state.net - value)))) : 0;
  const createsRefund = owedBack > 0;

  const reset = () => { setItemId(''); setQty(''); setNote(''); setRestock(true); setDate(todayISO()); setRefundOn(true); };

  const submit = async () => {
    if (busy) return; // guard: a second click must not record the return twice
    if (!itemId || !(Number(qty) > 0) || overMax) return;
    setBusy(true);
    try {
      await mutate(() => api.addReturn({
        billId: bill.id, itemId, qty: Number(qty),
        valueAdjusted: value, restock, date, note,
        refundAmount: refundOn && owedBack > 0 ? owedBack : 0, refundMethod, refundDate: date,
      }), 'Return recorded');
      reset();
      onClose?.();
    } catch { /* toast shown */ } finally { setBusy(false); }
  };

  if (!bill) return null;

  return (
    <Modal
      open={open}
      title={`Add Return — Bill ${bill.billNo}`}
      onClose={() => { reset(); onClose?.(); }}
      footer={
        <>
          <Button onClick={() => { reset(); onClose?.(); }}>Cancel</Button>
          <Button variant="primary" icon={RotateCcw} onClick={submit} loading={busy}
                  disabled={!itemId || !(Number(qty) > 0) || overMax}>
            Record Return
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
          <Money value={state?.net} />
        </div>
        <div>
          <div className="small muted">Currently due</div>
          <Money value={state?.due} />
        </div>
      </div>

      <Field label="Which item is being returned?">
        <Select value={itemId} onChange={(e) => { setItemId(e.target.value); setQty(''); }}>
          <option value="">Select an item from this bill…</option>
          {lines.map((l) => (
            <option key={l.id} value={l.itemId}>
              {itemName(l.itemId)} — {l.qty} {l.unit} @ {money(l.price)}
            </option>
          ))}
        </Select>
      </Field>

      {line && (
        <>
          <div className="form-grid">
            <Field label="Quantity returned"
                   hint={`Max ${maxQty} ${line.unit}${alreadyReturned > 0 ? ` (${alreadyReturned} already returned)` : ''}`}
                   error={overMax ? `Cannot return more than ${maxQty} ${line.unit}` : ''}>
              <Input type="number" min="0" max={maxQty} step="any" value={qty}
                     onChange={(e) => setQty(e.target.value)} autoFocus placeholder="0" />
            </Field>

            <Field label="Return date">
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
          </div>

          <Field label="Note">
            <Input value={note} onChange={(e) => setNote(e.target.value)}
                   placeholder="Reason for return (optional)" />
          </Field>

          <label style={{
            display: 'flex', alignItems: 'center', gap: 9, padding: '11px 12px',
            border: '1px solid var(--border)', borderRadius: 'var(--r-sm)',
            cursor: 'pointer', marginBottom: 14,
          }}>
            <input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)}
                   style={{ width: 17, height: 17, accentColor: 'var(--accent)' }} />
            <div>
              <div style={{ fontWeight: 600, fontSize: 13.5 }}>Add back to stock</div>
              <div className="small muted">
                Untick if the goods came back damaged and cannot be resold.
              </div>
            </div>
          </label>

          <div style={{
            padding: 12, borderRadius: 'var(--r-sm)',
            background: createsRefund ? 'var(--info-bg)' : 'var(--success-bg)',
            border: `1px solid ${createsRefund ? '#BFDBFE' : '#BBF7D0'}`,
            color: createsRefund ? '#1D4ED8' : '#15803D',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', fontWeight: 700 }}>
              <span>Return value</span>
              <span className="spacer" />
              <span>{money(value)}</span>
            </div>
            {createsRefund && value > 0 && (
              <div className="small" style={{ marginTop: 6, display: 'flex', gap: 6 }}>
                <Info size={13} style={{ flex: 'none', marginTop: 1 }} />
                {party?.name} has already paid {money(owedBack)} of this, so that money has to go back to them.
              </div>
            )}
          </div>

          {!createsRefund && state && value > 0 && (
            <div className="small muted" style={{ marginTop: 12, display: 'flex', gap: 6 }}>
              <Info size={13} style={{ flex: 'none', marginTop: 1 }} />
              {state.paid > 0.004
                ? `No refund needed: ${party?.name || 'the customer'} still owes money on this bill, so the return just reduces what they owe.`
                : 'This bill is unpaid, so there is no money to hand back — the return just reduces what they owe.'}
            </div>
          )}

          {createsRefund && (
            <div style={{ marginTop: 12, padding: '11px 12px', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 9, cursor: 'pointer' }}>
                <input type="checkbox" checked={refundOn} onChange={(e) => setRefundOn(e.target.checked)}
                       style={{ width: 17, height: 17, accentColor: 'var(--accent)' }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>Refund {money(owedBack)} to {party?.name} now</div>
                  <div className="small muted">
                    {refundOn
                      ? 'The money goes out of your till and their ledger stays at 0.'
                      : 'Not handed back yet: their ledger will show a minus (you owe them). Refund it later from the bill.'}
                  </div>
                </div>
              </label>
              {refundOn && (
                <div style={{ marginTop: 10, maxWidth: 260 }}>
                  <label className="small muted" style={{ display: 'block', marginBottom: 3 }}>
                    Payment method — paid back by
                  </label>
                  <Select value={refundMethod} onChange={(e) => setRefundMethod(e.target.value)} options={methods} />
                </div>
              )}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
