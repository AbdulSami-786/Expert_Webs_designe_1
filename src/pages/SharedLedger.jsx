// Public shared ledger (FR-20 / FR-21).
//
// No login. The party enters the password set by the owner, then sees a
// read-only view of their own bills and balances. Deliberately has NO edit,
// delete, print, download or share controls — that is the whole point of it.

import { useState, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { Lock, ShieldCheck, Receipt } from 'lucide-react';
import BillReceiptModal from '../components/BillReceiptModal';
import api from '../lib/api';
import { Button, Field, Input, Pill, Money, Empty, Card } from '../components/ui';
import { deriveBills } from '../lib/calc';
import { money, fmtDate, AGING_META, r2 } from '../lib/format';

export default function SharedLedger() {
  const { token } = useParams();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [payload, setPayload] = useState(null);

  const open = async (e) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const res = await api.openSharedLedger(token, password);
      setPayload(res);
    } catch (ex) {
      setErr(ex.message || 'Could not open this ledger');
    } finally {
      setBusy(false);
    }
  };

  /* ---------------- Password gate ---------------- */
  if (!payload) {
    return (
      <div className="login-wrap">
        <form className="login-card" onSubmit={open}>
          <div style={{ textAlign: 'center', marginBottom: 20 }}>
            <div style={{
              width: 50, height: 50, borderRadius: 13, background: 'var(--accent)',
              color: '#fff', display: 'grid', placeItems: 'center', margin: '0 auto 12px',
            }}>
              <Lock size={22} />
            </div>
            <h1 className="h1">Your Ledger</h1>
            <p className="muted small" style={{ margin: '5px 0 0' }}>
              Enter the password you were given to view your account.
            </p>
          </div>

          <Field label="Password" error={err}>
            <Input type="password" value={password} autoFocus
                   onChange={(e) => setPassword(e.target.value)}
                   placeholder="Enter password" />
          </Field>

          <Button type="submit" variant="primary" size="lg" block loading={busy}
                  disabled={!password}>
            View Ledger
          </Button>

          <div style={{
            marginTop: 16, fontSize: 11.5, color: 'var(--text-muted)', textAlign: 'center',
          }}>
            This is a read-only view of your own account only.
          </div>
        </form>
      </div>
    );
  }

  return <LedgerView data={payload} />;
}

function LedgerView({ data }) {
  // Which bill the party is viewing. Read-only: no edit, print or download
  // controls appear on this page (FR-21).
  const [receiptFor, setReceiptFor] = useState(null);

  const bills = useMemo(() => {
    const derived = deriveBills(data.bills, data);
    const rank = (b) => (b.status === 'voided' ? 2 : b.due > 0 ? 0 : 1);
    return derived.sort((a, b) =>
      rank(a) - rank(b) ||
      (rank(a) === 0 ? b.overdueDays - a.overdueDays : 0) ||
      new Date(b.date) - new Date(a.date)
    );
  }, [data]);

  const totals = useMemo(() => {
    const live = bills.filter((b) => b.status !== 'voided');
    const advance = r2((data.partyAdvances || [])
      .reduce((s, a) => s + (Number(a.amount) || 0) - (Number(a.applied) || 0), 0));
    return {
      billed: r2(live.reduce((s, b) => s + b.net, 0)),
      // Overpaid money no open bill could take still counts as paid.
      paid: r2(live.reduce((s, b) => s + b.paid + (b.overpaid || 0) - (b.carriedIn || 0), 0)),
      due: r2(live.reduce((s, b) => s + b.due, 0)),
      advance,
    };
  }, [bills, data.partyAdvances]);

  /**
   * The backend attaches itemName to each shared bill line, since this page has
   * no access to the Items table. Resolve within the bill currently open so two
   * bills containing the same item can never cross over.
   */
  const itemName = (id) => {
    const lines = (data.billItems || []).filter((bi) => bi.billId === receiptFor);
    return lines.find((bi) => bi.itemId === id)?.itemName || 'Item';
  };

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      {/* Header */}
      <div style={{ background: 'var(--primary)', color: '#fff', padding: '22px 20px 26px' }}>
        <div style={{ maxWidth: 860, margin: '0 auto' }}>
          <div className="small" style={{ color: '#94A3B8', marginBottom: 3 }}>
            {data.shopName}
          </div>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>{data.party?.name}</h1>
          <div className="small" style={{ color: '#94A3B8', marginTop: 3 }}>
            Account statement
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 860, margin: '-14px auto 0', padding: '0 16px 40px' }}>
        {/* Summary */}
        <div className="card" style={{ padding: 18, marginBottom: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))', gap: 16 }}>
            <div>
              <div className="small muted">Total billed</div>
              <div className="money" style={{ fontSize: 18 }}>{money(totals.billed)}</div>
            </div>
            <div>
              <div className="small muted">Total paid</div>
              <div className="money" style={{ fontSize: 18, color: 'var(--success)' }}>{money(totals.paid)}</div>
            </div>
            <div>
              <div className="small muted">Balance due</div>
              <div className="money" style={{ fontSize: 18, color: totals.due > 0 ? 'var(--danger)' : 'var(--success)' }}>
                {money(totals.due)}
              </div>
            </div>
            {totals.advance > 0 && (
              <div>
                <div className="small muted">Advance with shop</div>
                <div className="money" style={{ fontSize: 18, color: 'var(--success)' }}>{money(totals.advance)}</div>
              </div>
            )}
          </div>
        </div>

        {/* Bills */}
        <div className="card" style={{ overflow: 'hidden' }}>
          <div className="card-head">
            <h2 className="h2">Your Bills</h2>
          </div>

          {!bills.length ? (
            <Empty icon={Receipt} title="No bills yet"
                   message="There are no bills on your account." />
          ) : (
            <>
              <div className="table-wrap hide-mobile">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Bill</th><th>Date</th><th>Status</th><th>Due date</th>
                      <th className="r">Total</th><th className="r">Paid</th><th className="r">Due</th>
                      <th style={{ width: 78 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {bills.map((b) => (
                      <tr key={b.id} className={b.due > 0 && b.isOverdue ? AGING_META[b.bucket].cls : ''}>
                        <td style={{ fontWeight: 600 }}>{b.billNo}</td>
                        <td className="nowrap">{fmtDate(b.date)}</td>
                        <td><Pill status={b.status} /></td>
                        <td className="nowrap small">
                          {b.due > 0 ? fmtDate(b.dueDate) : <span className="muted">—</span>}
                        </td>
                        <td className="r strong"><Money value={b.net} /></td>
                        <td className="r"><Money value={b.paid} /></td>
                        <td className="r strong">
                          {b.due > 0
                            ? <span className="money neg">{money(b.due)}</span>
                            : <span className="muted">—</span>}
                        </td>
                        <td>
                          <Button size="sm" icon={Receipt} onClick={() => setReceiptFor(b.id)}>
                            Bill
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={4}>Totals</td>
                      <td className="r">{money(totals.billed)}</td>
                      <td className="r">{money(totals.paid)}</td>
                      <td className="r" style={{ color: 'var(--danger)' }}>{money(totals.due)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              <div className="mcards" style={{ padding: 12 }}>
                {bills.map((b) => (
                  <div key={b.id}
                       className={`mcard ${b.due > 0 && b.isOverdue ? AGING_META[b.bucket].mcls : ''}`}>
                    <div className="top">
                      <span className="name">{b.billNo}</span>
                      <span className="amt">{money(b.net)}</span>
                    </div>
                    <div className="meta">
                      <Pill status={b.status} />
                      <span>{fmtDate(b.date)}</span>
                      {b.due > 0 && (
                        <span style={{ color: 'var(--danger)', fontWeight: 700 }}>
                          {money(b.due)} due
                        </span>
                      )}
                    </div>
                    <Button size="sm" icon={Receipt} onClick={() => setReceiptFor(b.id)}>
                      View bill
                    </Button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Read-only receipt: no print, edit or download controls (FR-21) */}
        <BillReceiptModal
          open={Boolean(receiptFor)}
          onClose={() => setReceiptFor(null)}
          bill={receiptFor ? bills.find((b) => b.id === receiptFor) : null}
          lines={(data.billItems || []).filter((bi) => bi.billId === receiptFor)}
          payments={(data.payments || []).filter((p) => p.billId === receiptFor)}
          cheques={(data.cheques || []).filter((c) => c.billId === receiptFor)}
          returns={(data.returns || []).filter((r) => r.billId === receiptFor)}
          itemName={itemName}
          party={data.party}
          shopName={data.shopName}
          readOnly
        />

        <div style={{
          marginTop: 18, textAlign: 'center', fontSize: 12,
          color: 'var(--text-muted)', display: 'flex',
          alignItems: 'center', justifyContent: 'center', gap: 6,
        }}>
          <ShieldCheck size={14} />
          Read-only view · {data.shopName}
        </div>
      </div>
    </div>
  );
}
