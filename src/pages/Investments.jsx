// Investments — money the owner (or a partner) puts into the business.
//
// Each entry counts as money IN on the payment method you choose, exactly like an
// opening balance: it raises that account's balance (and so Cash in Hand) and shows
// on the account's statement. It is not a sale and not income, so it never touches
// the profit figures.

import { useMemo, useState } from 'react';
import { Plus, PiggyBank, Download, Save, Trash2 } from 'lucide-react';
import { useApp } from '../context/AppContext';
import api from '../lib/api';
import {
  Card, Button, Modal, Confirm, Empty, PageHead, SearchBar, Money, Field, Input, Select, Stat, Textarea,
} from '../components/ui';
import { money, fmtDate, norm, todayISO, r2 } from '../lib/format';
import { exportExcel } from '../lib/exporters';

export default function Investments() {
  const { data, settings, methods, mutate, toast } = useApp();
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState(null);

  const rows = useMemo(() => {
    const term = norm(q);
    return (data.investments || [])
      .filter((v) => !term || norm(v.investor).includes(term) || norm(v.note).includes(term)
        || norm(v.method).includes(term))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  }, [data.investments, q]);

  const total = useMemo(() => r2(rows.reduce((s, v) => s + (Number(v.amount) || 0), 0)), [rows]);

  // How much went into each payment method
  const byMethod = useMemo(() => {
    const m = new Map();
    rows.forEach((v) => m.set(v.method || 'Cash', r2((m.get(v.method || 'Cash') || 0) + (Number(v.amount) || 0))));
    return [...m.entries()];
  }, [rows]);

  const onExcel = () => {
    exportExcel('Investments',
      ['Date', 'Investor', 'Into', 'Amount', 'Note'],
      rows.map((v) => [fmtDate(v.date), v.investor || '', v.method || 'Cash', Number(v.amount).toFixed(2), v.note || '']),
      [`${settings.shopName} — Investments`, `Total invested: ${money(total)}`]);
    toast('Investments exported');
  };

  const doDelete = async () => {
    const v = deleting;
    try {
      await mutate(() => api.deleteInvestment(v.id), 'Investment deleted');
    } catch { /* toast shown */ } finally { setDeleting(null); }
  };

  const delBtn = (v) => (
    <button className="btn btn-ghost btn-sm" title="Delete this investment" onClick={() => setDeleting(v)}>
      <Trash2 size={14} color="var(--danger)" />
    </button>
  );

  return (
    <>
      <PageHead title="Investments" subtitle={`${rows.length} ${rows.length === 1 ? 'entry' : 'entries'} · ${money(total)} put into the business`}>
        <SearchBar value={q} onChange={setQ} placeholder="Search investor or note…" />
        <Button icon={Download} onClick={onExcel}>Excel</Button>
        <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Add Investment</Button>
      </PageHead>

      <div className="stat-grid">
        <Stat label="Total Invested" value={money(total)} icon={PiggyBank} tone="#16A34A" />
        <Stat label="Entries" value={rows.length} icon={PiggyBank} tone="#D9390B" />
        {byMethod.map(([m, amt]) => (
          <Stat key={m} label={`Into ${m}`} value={money(amt)} icon={PiggyBank} tone="#2563EB" />
        ))}
      </div>

      <Card tight>
        {!rows.length ? (
          <Empty icon={PiggyBank} title={q ? 'No matching investments' : 'No investments recorded'}
                 message={q ? `Nothing matches "${q}".`
                   : 'Record the money you put into the business — it counts as money in on the method you pick, like an opening balance, and raises Cash in Hand.'}
                 action={!q ? <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Add your first investment</Button> : null} />
        ) : (
          <>
            <div className="table-wrap hide-mobile">
              <table className="tbl">
                <thead>
                  <tr><th>Date</th><th>Investor</th><th>Into</th><th>Note</th><th className="r">Amount</th><th style={{ width: 50 }}></th></tr>
                </thead>
                <tbody>
                  {rows.map((v) => (
                    <tr key={v.id}>
                      <td className="nowrap">{fmtDate(v.date)}</td>
                      <td style={{ fontWeight: 600 }}>{v.investor || <span className="muted">—</span>}</td>
                      <td>{v.method || 'Cash'}</td>
                      <td className="small muted">{v.note || '—'}</td>
                      <td className="r strong"><Money value={v.amount} /></td>
                      <td><div className="row-actions">{delBtn(v)}</div></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={4}>{rows.length} {rows.length === 1 ? 'entry' : 'entries'}</td>
                    <td className="r">{money(total)}</td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <div className="mcards" style={{ padding: 12 }}>
              {rows.map((v) => (
                <div key={v.id} className="mcard">
                  <div className="top">
                    <span className="name">{v.investor || 'Investment'}</span>
                    <span className="amt" style={{ color: 'var(--success)' }}>{money(v.amount)}</span>
                  </div>
                  <div className="meta">
                    <span>{fmtDate(v.date)}</span>
                    <span>Into {v.method || 'Cash'}</span>
                    {v.note && <span>{v.note}</span>}
                    <span className="spacer" />
                    <div className="row-actions" style={{ opacity: 1 }}>{delBtn(v)}</div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </Card>

      <InvestmentModal open={adding} onClose={() => setAdding(false)} methods={methods} />

      <Confirm open={Boolean(deleting)} title="Delete this investment?" danger confirmLabel="Delete"
               message={deleting
                 ? `${money(deleting.amount)} will be taken out of ${deleting.method || 'Cash'}, so that account's balance (and Cash in Hand) goes down by the same amount.`
                 : ''}
               onConfirm={doDelete} onCancel={() => setDeleting(null)} />
    </>
  );
}

function InvestmentModal({ open, onClose, methods }) {
  const { mutate } = useApp();
  const choices = methods.filter((m) => m !== 'Cheque');
  const blank = () => ({ investor: '', amount: '', method: 'Cash', date: todayISO(), note: '' });
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const valid = Number(f.amount) > 0;

  const submit = async () => {
    if (busy || !valid) return;
    setBusy(true);
    try {
      await mutate(() => api.saveInvestment({
        investor: f.investor.trim(), amount: Number(f.amount), method: f.method, date: f.date, note: f.note,
      }), 'Investment added');
      setF(blank());
      onClose();
    } catch { /* toast shown */ } finally { setBusy(false); }
  };

  return (
    <Modal open={open} title="Add Investment" onClose={onClose}
           footer={
             <>
               <Button onClick={onClose}>Cancel</Button>
               <Button variant="primary" icon={Save} onClick={submit} loading={busy} disabled={!valid}>
                 Add Investment
               </Button>
             </>
           }>
      <Field label="Investor" hint="Who put the money in (optional)">
        <Input value={f.investor} onChange={set('investor')} autoFocus placeholder="e.g. Owner, Ahmed (partner)" />
      </Field>
      <div className="form-grid">
        <Field label="Amount">
          <Input type="number" min="0" step="any" value={f.amount} onChange={set('amount')} placeholder="0" />
        </Field>
        <Field label="Put into" hint="Adds to this account's balance">
          <Select value={f.method} onChange={set('method')} options={choices} />
        </Field>
        <Field label="Date">
          <Input type="date" value={f.date} onChange={set('date')} />
        </Field>
      </div>
      <Field label="Note">
        <Textarea value={f.note} onChange={set('note')} rows={2} placeholder="Optional — e.g. opening capital" />
      </Field>
    </Modal>
  );
}
