// Accounts (FR-40 / Plan 7.9) — one row per payment method with a running
// current balance. Pending cheques stay out until cleared.

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Landmark, ChevronRight, Download, Wallet, AlertTriangle, ArrowRightLeft, Save, Trash2,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import api from '../lib/api';
import {
  Card, Button, Empty, PageHead, Money, Stat, Modal, Confirm, Field, Input, Select, Textarea,
} from '../components/ui';
import { accountBalances } from '../lib/calc';
import { money, fmtDate, todayISO, r2 } from '../lib/format';
import { exportExcel } from '../lib/exporters';
import { useBackendFeature } from '../lib/useBackendFeature';

export default function Accounts() {
  const { data, settings, methods, mutate, toast } = useApp();
  const nav = useNavigate();
  const [transferring, setTransferring] = useState(false);
  const [undoing, setUndoing] = useState(null);

  const transfers = useMemo(
    () => [...(data.transfers || [])].sort((a, b) => String(b.date).localeCompare(String(a.date))
      || String(b.id).localeCompare(String(a.id))),
    [data.transfers]
  );

  const doUndo = async () => {
    const t = undoing;
    try {
      await mutate(() => api.deleteTransfer(t.id), 'Transfer deleted');
    } catch { /* toast shown */ } finally { setUndoing(null); }
  };

  const balances = useMemo(() => accountBalances(methods, data), [methods, data]);

  const totals = useMemo(() => ({
    balance: r2(balances.reduce((s, b) => s + b.balance, 0)),
    in: r2(balances.reduce((s, b) => s + b.in, 0)),
    out: r2(balances.reduce((s, b) => s + b.out, 0)),
  }), [balances]);

  // Money sitting in cheques that have not cleared yet
  const pendingCheques = useMemo(
    () => r2(data.cheques.filter((c) => c.status === 'pending')
      .reduce((s, c) => s + (Number(c.amount) || 0), 0)),
    [data.cheques]
  );

  const onExcel = () => {
    exportExcel('Accounts',
      ['Method', 'Money In', 'Money Out', 'Current Balance'],
      balances.map((b) => [b.method, b.in.toFixed(2), b.out.toFixed(2), b.balance.toFixed(2)]),
      [`${settings.shopName} — Account Balances`, `Total: ${money(totals.balance)}`]);
    toast('Account balances exported');
  };

  return (
    <>
      <PageHead title="Accounts"
                subtitle="Running balance per payment method — click any row for its full statement">
        <Button icon={Download} onClick={onExcel}>Excel</Button>
        <Button variant="primary" icon={ArrowRightLeft} onClick={() => setTransferring(true)}>
          Transfer Money
        </Button>
      </PageHead>

      <div className="stat-grid">
        <Stat label="Total Cash in Hand" value={money(totals.balance)} icon={Wallet} tone="#16A34A" />
        <Stat label="Total Money In" value={money(totals.in)} icon={Landmark} tone="#D9390B" />
        <Stat label="Total Money Out" value={money(totals.out)} icon={Landmark} tone="#DC2626" />
      </div>

      {pendingCheques > 0 && (
        <div style={{
          padding: '10px 13px', background: 'var(--warning-bg)', border: '1px solid #FDE68A',
          borderRadius: 'var(--r)', marginBottom: 16, fontSize: 13, color: '#B45309',
          display: 'flex', gap: 8, alignItems: 'center',
        }}>
          <AlertTriangle size={15} style={{ flex: 'none' }} />
          <span>
            A further <strong>{money(pendingCheques)}</strong> is held in cheques awaiting
            clearance. It is deliberately excluded from these balances until cleared.
          </span>
        </div>
      )}

      <Card tight>
        <div className="table-wrap hide-mobile">
          <table className="tbl">
            <thead>
              <tr>
                <th>Payment method</th>
                <th className="r">Money in</th>
                <th className="r">Money out</th>
                <th className="r">Current balance</th>
                <th style={{ width: 50 }}></th>
              </tr>
            </thead>
            <tbody>
              {balances.map((b) => (
                <tr key={b.method} className="clickable"
                    onClick={() => nav(`/account/${encodeURIComponent(b.method)}`)}>
                  <td style={{ fontWeight: 600 }}>{b.method}</td>
                  <td className="r"><span className="money pos">{money(b.in)}</span></td>
                  <td className="r"><span className="money neg">{money(b.out)}</span></td>
                  <td className="r strong">
                    <span className="money" style={{ fontSize: 15, color: b.balance < 0 ? 'var(--danger)' : undefined }}>
                      {money(b.balance)}
                    </span>
                  </td>
                  <td><ChevronRight size={15} className="muted" /></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Total</td>
                <td className="r">{money(totals.in)}</td>
                <td className="r">{money(totals.out)}</td>
                <td className="r" style={{ fontSize: 15 }}>{money(totals.balance)}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>

        <div className="mcards" style={{ padding: 12 }}>
          {balances.map((b) => (
            <div key={b.method} className="mcard"
                 onClick={() => nav(`/account/${encodeURIComponent(b.method)}`)}>
              <div className="top">
                <span className="name">{b.method}</span>
                <span className="amt" style={{ color: b.balance < 0 ? 'var(--danger)' : 'var(--success)' }}>
                  {money(b.balance)}
                </span>
              </div>
              <div className="meta">
                <span style={{ color: 'var(--success)' }}>In {money(b.in)}</span>
                <span style={{ color: 'var(--danger)' }}>Out {money(b.out)}</span>
                <span className="spacer" />
                <ChevronRight size={15} className="muted" />
              </div>
            </div>
          ))}
        </div>
      </Card>

      {transfers.length > 0 && (
        <>
          <h3 style={{ margin: '22px 0 10px', fontSize: 15 }}>Recent transfers</h3>
          <Card tight>
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Date</th><th>From</th><th>To</th><th>Note</th>
                    <th className="r">Amount</th><th style={{ width: 50 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {transfers.slice(0, 15).map((t) => (
                    <tr key={t.id}>
                      <td className="nowrap">{fmtDate(t.date)}</td>
                      <td style={{ fontWeight: 600 }}>{t.fromMethod}</td>
                      <td style={{ fontWeight: 600 }}>{t.toMethod}</td>
                      <td className="small muted">{t.note || '—'}</td>
                      <td className="r strong"><Money value={t.amount} /></td>
                      <td>
                        <div className="row-actions">
                          <button className="btn btn-ghost btn-sm" title="Delete this transfer"
                                  onClick={() => setUndoing(t)}>
                            <Trash2 size={14} color="var(--danger)" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      <TransferModal open={transferring} onClose={() => setTransferring(false)}
                     methods={methods} balances={balances} />

      <Confirm open={Boolean(undoing)} title="Delete this transfer?" danger confirmLabel="Delete"
               message={undoing
                 ? `${money(undoing.amount)} goes back to ${undoing.fromMethod} and leaves ${undoing.toMethod}.`
                 : ''}
               onConfirm={doUndo} onCancel={() => setUndoing(null)} />
    </>
  );
}

function TransferModal({ open, onClose, methods, balances }) {
  const { mutate } = useApp();
  const support = useBackendFeature('saveTransfer', open);
  // Cheques are not an account money can be held in until they clear.
  const choices = methods.filter((m) => m !== 'Cheque');
  const blank = () => ({
    from: choices[0] || 'Cash', to: choices.find((m) => m !== (choices[0] || 'Cash')) || '',
    amount: '', date: todayISO(), note: '',
  });
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const available = balances.find((b) => b.method === f.from)?.balance ?? 0;
  const amount = Number(f.amount) || 0;

  let problem = '';
  if (f.from === f.to) problem = 'Choose two different accounts.';
  else if (amount > r2(available)) problem = `${f.from} only has ${money(available)}.`;
  const valid = amount > 0 && f.from && f.to && !problem;
  const outdated = support.state === 'old';

  const submit = async () => {
    if (busy || !valid || outdated) return;
    setBusy(true);
    try {
      await mutate(() => api.saveTransfer({
        fromMethod: f.from, toMethod: f.to, amount, date: f.date, note: f.note,
      }), `${money(amount)} moved from ${f.from} to ${f.to}`);
      setF(blank());
      onClose();
    } catch { /* toast shown */ } finally { setBusy(false); }
  };

  return (
    <Modal open={open} title="Transfer Money" onClose={onClose}
           footer={
             <>
               <Button onClick={onClose}>Cancel</Button>
               <Button variant="primary" icon={Save} onClick={submit} loading={busy}
                       disabled={!valid || outdated}>
                 Transfer
               </Button>
             </>
           }>
      {outdated && (
        <div style={{
          padding: '10px 13px', background: 'var(--warning-bg)', border: '1px solid #FDE68A',
          borderRadius: 'var(--r)', marginBottom: 14, fontSize: 13, color: '#B45309',
        }}>
          Your Google Sheet script is out of date and cannot save transfers yet. Paste the latest
          Code.gs into Apps Script and deploy a new version.
        </div>
      )}
      <div className="form-grid">
        <Field label="From" hint={`Available: ${money(available)}`}>
          <Select value={f.from} onChange={set('from')} options={choices} />
        </Field>
        <Field label="To" hint="Money arrives in this account">
          <Select value={f.to} onChange={set('to')} options={choices} />
        </Field>
      </div>
      <div className="form-grid">
        <Field label="Amount">
          <Input type="number" min="0" step="any" value={f.amount} onChange={set('amount')}
                 autoFocus placeholder="0" />
        </Field>
        <Field label="Date">
          <Input type="date" value={f.date} onChange={set('date')} />
        </Field>
      </div>
      {problem && amount > 0 && (
        <div style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 10 }}>{problem}</div>
      )}
      <Field label="Note">
        <Textarea value={f.note} onChange={set('note')} rows={2} placeholder="Optional — e.g. deposited in bank" />
      </Field>
    </Modal>
  );
}
