// Take one payment against a party's whole account, not against a single bill.
//
// This is how money actually arrives in a wholesale shop: the customer hands
// over a sum for what they owe, without naming an invoice. Recording that
// bill-by-bill forces the shopkeeper to do the allocation arithmetic by hand,
// and the ledger drifts from the cash drawer whenever they get it wrong.
//
// The split is previewed before saving, because an allocation the shopkeeper
// cannot see is one they cannot check against what the customer believes they
// paid. The server repeats the same arithmetic — this preview is for the eyes
// only, never the source of truth.

import { useMemo, useState } from 'react';
import { Info, Wallet } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import api from '../../lib/api';
import { Modal, Button, Field, Input, Select } from '../ui';
import { money, todayISO, r2, fmtDate } from '../../lib/format';
import ChequeFields, { blankCheque } from './ChequeFields';

/**
 * Spread `amount` over `bills` oldest-first, exactly as the backend does.
 *
 * Kept deliberately simple and pure so the preview cannot disagree with the
 * server for any reason other than the data having changed underneath it.
 */
export function allocate(amount, bills) {
  let remaining = r2(Math.max(0, Number(amount) || 0));
  const rows = [];

  for (const b of bills) {
    if (remaining <= 0.004) break;
    if (b.due <= 0.004) continue;
    const use = r2(Math.min(b.due, remaining));
    rows.push({ bill: b, amount: use, clears: use >= r2(b.due) - 0.004 });
    remaining = r2(remaining - use);
  }
  return { rows, advance: r2(remaining) };
}

export default function AccountPaymentModal({ open, onClose, party, bills = [] }) {
  const { methods, mutate } = useApp();
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('Cash');
  const [date, setDate] = useState(todayISO());
  const [note, setNote] = useState('');
  // Details of the cheque when the money came as one; null for any other method.
  const [cheque, setCheque] = useState(null);
  const [busy, setBusy] = useState(false);

  // Oldest first, matching the server's ordering: same date falls back to bill
  // number so two bills written the same day allocate in a stable order.
  const unpaid = useMemo(() => bills
    .filter((b) => b.status !== 'voided' && b.due > 0.004)
    .sort((a, b) => String(a.date).localeCompare(String(b.date))
      || String(a.billNo).localeCompare(String(b.billNo))),
  [bills]);

  const totalDue = useMemo(
    () => r2(unpaid.reduce((s, b) => s + b.due, 0)),
    [unpaid],
  );

  const plan = useMemo(() => allocate(amount, unpaid), [amount, unpaid]);
  const entered = r2(Number(amount) || 0);

  const reset = () => {
    setAmount('');
    setMethod('Cash');
    setDate(todayISO());
    setNote('');
    setCheque(null);
  };

  const submit = async () => {
    if (busy || entered <= 0) return;
    setBusy(true);
    try {
      const res = await mutate(
        () => api.settleParty({
          partyId: party.id,
          amount: entered,
          method,
          date,
          note,
          cheque: method === 'Cheque' ? cheque : undefined,
        }),
        null, // the message below says more than a generic "Saved" would
      );
      const n = res?.applied?.length ?? 0;
      const adv = res?.advance ?? 0;
      onClose(
        `${money(entered)} received — ${n} bill${n === 1 ? '' : 's'} settled`
        + (adv > 0 ? `, ${money(adv)} kept as advance` : ''),
      );
      reset();
    } catch {
      // mutate() has already shown the error. Keep the modal open with the
      // amount still typed in, so the payment can be retried rather than
      // re-entered from scratch.
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => onClose()}
      title={`Payment from ${party?.name || 'party'}`}
      footer={
        <>
          <Button onClick={() => onClose()}>Cancel</Button>
          <Button variant="primary" icon={Wallet} onClick={submit}
                  disabled={busy || entered <= 0}>
            {busy ? 'Saving…' : `Receive ${entered > 0 ? money(entered) : ''}`}
          </Button>
        </>
      }
    >
      <div className="row wrap" style={{ gap: 12 }}>
        <Field label="Amount received" style={{ flex: '1 1 160px' }}>
          <Input type="number" min="0" step="0.01" inputMode="decimal"
                 autoFocus value={amount}
                 onChange={(e) => setAmount(e.target.value)}
                 placeholder="0.00" />
        </Field>
        <Field label="Method" style={{ flex: '1 1 140px' }}>
          <Select value={method} onChange={(e) => {
            setMethod(e.target.value);
            setCheque(e.target.value === 'Cheque' ? (cheque || blankCheque(date)) : null);
          }}>
            {methods.map((m) => <option key={m} value={m}>{m}</option>)}
          </Select>
        </Field>
        <Field label="Date" style={{ flex: '1 1 140px' }}>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
      </div>

      {method === 'Cheque' && (
        <div style={{ marginBottom: 12 }}>
          <ChequeFields value={cheque} onChange={setCheque} />
        </div>
      )}

      <Field label="Note (optional)">
        <Input value={note} onChange={(e) => setNote(e.target.value)}
               placeholder="e.g. cash received at shop" />
      </Field>

      <div className="row" style={{ gap: 8, marginBottom: 10 }}>
        <span className="muted small">Total outstanding</span>
        <span className="spacer" />
        <span className="money" style={{ fontWeight: 700 }}>{money(totalDue)}</span>
      </div>

      {/* Quick fill: settling the account in full is the common case. */}
      {totalDue > 0 && (
        <Button size="sm" onClick={() => setAmount(String(totalDue))}>
          Pay all ({money(totalDue)})
        </Button>
      )}

      {/* ---- Allocation preview ---- */}
      {entered > 0 && (
        <>
          <h3 className="h3" style={{ marginTop: 16, marginBottom: 7 }}>
            How this will be applied
          </h3>

          {!unpaid.length ? (
            <div className="note">
              <Info size={14} />
              <span>
                This party has no unpaid bills, so the whole {money(entered)} will
                be held as an advance against their next bill.
              </span>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Bill</th>
                    <th>Date</th>
                    <th className="r">Due</th>
                    <th className="r">Applied</th>
                    <th className="r">Left</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.rows.map(({ bill, amount: used, clears }) => (
                    <tr key={bill.id}>
                      <td style={{ fontWeight: 600 }}>{bill.billNo}</td>
                      <td className="nowrap small">{fmtDate(bill.date)}</td>
                      <td className="r">{money(bill.due)}</td>
                      <td className="r strong" style={{ color: 'var(--success)' }}>
                        {money(used)}
                      </td>
                      <td className="r" style={{
                        color: clears ? 'var(--success)' : 'var(--danger)',
                        fontWeight: 600,
                      }}>
                        {clears ? 'PAID' : money(r2(bill.due - used))}
                      </td>
                    </tr>
                  ))}
                  {/* Bills the money never reached, so it is clear they stay open. */}
                  {unpaid
                    .filter((b) => !plan.rows.some((r) => r.bill.id === b.id))
                    .map((b) => (
                      <tr key={b.id} className="muted">
                        <td>{b.billNo}</td>
                        <td className="nowrap small">{fmtDate(b.date)}</td>
                        <td className="r">{money(b.due)}</td>
                        <td className="r">—</td>
                        <td className="r">{money(b.due)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}

          {plan.advance > 0 && (
            <div className="note" style={{ marginTop: 10 }}>
              <Wallet size={14} />
              <span>
                <strong>{money(plan.advance)}</strong> is more than this party owes.
                It will be kept as an advance, and offered on their next bill.
              </span>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
