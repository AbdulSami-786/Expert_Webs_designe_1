// Record a return against a bill (FR-18 / Plan 3.2).
//
// Several items can come back at once: every item on the bill has its own quantity box, and the
// ones left at zero are simply not returned. Recalculates the bill total and the party's due
// balance, and optionally restocks each item. If the bill was already paid, the money that has to
// go back is worked out for the whole return and refunded once, so the ledger does not keep a
// minus balance.

import { useMemo, useState } from 'react';
import { RotateCcw, Info } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import api from '../../lib/api';
import { Modal, Button, Field, Input, Select, Money } from '../ui';
import { money, todayISO, r2 } from '../../lib/format';
import { billState } from '../../lib/calc';
import { useBackendFeature } from '../../lib/useBackendFeature';
import OutdatedBackend from '../OutdatedBackend';

export default function ReturnModal({ open, onClose, bill, party }) {
  const { data, mutate, methods } = useApp();
  // itemId -> quantity typed ('' or 0 = not returned)
  const [qtys, setQtys] = useState({});
  // itemId -> true when that item is NOT to go back into stock (damaged)
  const [noStock, setNoStock] = useState({});
  const [date, setDate] = useState(todayISO());
  const [note, setNote] = useState('');
  // Hand the money back with the return (only when the customer had paid for these goods).
  const [refundOn, setRefundOn] = useState(true);
  const [refundMethod, setRefundMethod] = useState('Cash');
  const [busy, setBusy] = useState(false);

  const state = useMemo(
    () => (bill ? billState(bill, data) : null),
    [bill, data]
  );

  const itemName = (id) => data.items.find((i) => i.id === id)?.name || 'Item';

  /** One row per item on the bill: what was sold, what already came back, what can still. */
  const rows = useMemo(() => {
    if (!bill) return [];
    const out = [];
    const byItem = {};
    data.billItems.filter((bi) => bi.billId === bill.id).forEach((l) => {
      let r = byItem[l.itemId];
      if (!r) {
        r = { itemId: l.itemId, unit: l.unit, sold: 0, amount: 0 };
        byItem[l.itemId] = r;
        out.push(r);
      }
      r.sold += Number(l.qty) || 0;
      r.amount += (Number(l.qty) || 0) * (Number(l.price) || 0);
    });
    return out.map((r) => {
      const returned = data.returns
        .filter((x) => x.billId === bill.id && x.itemId === r.itemId)
        .reduce((s, x) => s + (Number(x.qty) || 0), 0);
      return {
        ...r,
        // a line sold at two prices returns at their average
        price: r.sold ? r.amount / r.sold : 0,
        returned,
        max: Math.max(0, r2(r.sold - returned)),
      };
    });
  }, [bill, data.billItems, data.returns]);

  // The rows with something typed in.
  const picked = rows
    .map((r) => {
      const q = Number(qtys[r.itemId]) || 0;
      return { ...r, q, value: r2(q * r.price) };
    })
    .filter((r) => r.q > 0);
  const overMax = picked.some((r) => r.q > r.max + 0.0001);
  const value = r2(picked.reduce((s, r) => s + r.value, 0));

  // What the customer has paid beyond what the bill is worth once these goods come off it:
  // this is the money that has to go back to them (otherwise it sits on their ledger as a minus).
  const owedBack = state ? r2(Math.max(0, Math.min(value, state.paid - r2(state.net - value)))) : 0;
  const createsRefund = owedBack > 0;

  // An out-of-date script silently ignores a refund on a return, so it is checked first and the
  // return is not recorded as if it had been refunded.
  const refundSupport = useBackendFeature('addRefund', open && createsRefund);
  const needsRefund = createsRefund && refundOn;
  const refundBlocked = needsRefund && (refundSupport.state === 'old' || refundSupport.state === 'checking');

  const canSubmit = picked.length > 0 && !overMax && !refundBlocked;

  const reset = () => {
    setQtys({}); setNoStock({}); setNote(''); setDate(todayISO()); setRefundOn(true);
  };

  const submit = async () => {
    if (busy) return; // guard: a second click must not record the return twice
    if (!canSubmit) return;
    setBusy(true);
    try {
      const refund = refundOn && owedBack > 0 ? owedBack : 0;
      await mutate(async () => {
        let done = 0;
        try {
          for (let i = 0; i < picked.length; i += 1) {
            const r = picked[i];
            // The whole refund rides on the LAST item: by then the earlier ones are already on the
            // bill, so what the customer is owed back is exactly what was worked out above.
            const last = i === picked.length - 1;
            await api.addReturn({
              billId: bill.id, itemId: r.itemId, qty: r.q,
              valueAdjusted: r.value, restock: !noStock[r.itemId], date, note,
              refundAmount: last ? refund : 0, refundMethod, refundDate: date,
            });
            done += 1;
          }
        } catch (err) {
          if (done > 0) {
            throw new Error(`${done} of ${picked.length} items were recorded, then it stopped: ${err.message}`);
          }
          throw err;
        }
      }, picked.length === 1 ? 'Return recorded' : `Return recorded (${picked.length} items)`);
      reset();
      onClose?.();
    } catch { /* toast shown */ } finally { setBusy(false); }
  };

  if (!bill) return null;

  return (
    <Modal
      open={open}
      wide
      title={`Add Return — Bill ${bill.billNo}`}
      onClose={() => { reset(); onClose?.(); }}
      footer={
        <>
          <Button onClick={() => { reset(); onClose?.(); }}>Cancel</Button>
          <Button variant="primary" icon={RotateCcw} onClick={submit} loading={busy} disabled={!canSubmit}>
            {picked.length > 1 ? `Record Return (${picked.length} items)` : 'Record Return'}
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

      <div style={{ fontWeight: 600, fontSize: 13.5, marginBottom: 6 }}>
        Which items are being returned?
      </div>
      <div className="small muted" style={{ marginBottom: 8 }}>
        Type a quantity for each item that is coming back. Leave the others empty.
      </div>

      <div className="return-rows">
        {rows.map((r) => {
          const q = Number(qtys[r.itemId]) || 0;
          const over = q > r.max + 0.0001;
          return (
            <div key={r.itemId} className={`return-row ${q > 0 ? 'on' : ''}`}>
              <div className="rr-info">
                <div className="rr-name">{itemName(r.itemId)}</div>
                <div className="small muted">
                  Sold {r2(r.sold)} {r.unit} @ {money(r.price)}
                  {r.returned > 0 && ` · ${r2(r.returned)} already returned`}
                </div>
                {q > 0 && !over && (
                  <label className="rr-stock">
                    <input type="checkbox" checked={!noStock[r.itemId]}
                           onChange={(e) => setNoStock((s) => ({ ...s, [r.itemId]: !e.target.checked }))} />
                    Add back to stock
                    {noStock[r.itemId] && <span className="muted"> (damaged — not resold)</span>}
                  </label>
                )}
              </div>
              <div className="rr-qty">
                {r.max > 0 ? (
                  <>
                    <Input type="number" min="0" max={r.max} step="any" value={qtys[r.itemId] ?? ''}
                           placeholder="0" aria-label={`Quantity of ${itemName(r.itemId)} returned`}
                           onChange={(e) => setQtys((s) => ({ ...s, [r.itemId]: e.target.value }))} />
                    <div className={`small ${over ? 'err-text' : 'muted'}`}>
                      {over ? `Only ${r.max} left to return` : `max ${r.max}`}
                    </div>
                  </>
                ) : (
                  <div className="small muted">All returned</div>
                )}
              </div>
              <div className="rr-val">{q > 0 && !over ? money(r2(q * r.price)) : ''}</div>
            </div>
          );
        })}
      </div>

      {picked.length > 0 && (
        <>
          <div className="form-grid" style={{ marginTop: 14 }}>
            <Field label="Return date">
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label="Note">
              <Input value={note} onChange={(e) => setNote(e.target.value)}
                     placeholder="Reason for return (optional)" />
            </Field>
          </div>

          <div style={{
            padding: 12, borderRadius: 'var(--r-sm)',
            background: createsRefund ? 'var(--info-bg)' : 'var(--success-bg)',
            border: `1px solid ${createsRefund ? '#BFDBFE' : '#BBF7D0'}`,
            color: createsRefund ? '#1D4ED8' : '#15803D',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', fontWeight: 700 }}>
              <span>Return value{picked.length > 1 ? ` (${picked.length} items)` : ''}</span>
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
              {needsRefund && refundSupport.state === 'old' && (
                <>
                  <OutdatedBackend what="refunds" onRecheck={refundSupport.recheck} />
                  <div className="small muted">
                    Or untick the refund box above to record the return now without refunding
                    (the customer's ledger will show a minus until you refund it later).
                  </div>
                </>
              )}
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
