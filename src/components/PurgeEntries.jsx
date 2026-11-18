// Settings → "Remove entries by date" (super admin). Shows exactly what would go for a date range before
// anything is deleted, saves a backup file first, and needs "DELETE" typed to go ahead.

import { useMemo, useState } from 'react';
import { Trash2, Eye } from 'lucide-react';
import { useApp } from '../context/AppContext';
import api from '../lib/api';
import { Card, Button, Field, Input } from './ui';
import { purgePlan } from '../lib/calc';
import { downloadBackup } from '../lib/exporters';
import { money, todayISO } from '../lib/format';
import { useBackendFeature } from '../lib/useBackendFeature';
import OutdatedBackend from './OutdatedBackend';

const ROWS = [
  ['bills', 'Sales bills'],
  ['payments', 'Payments received (incl. advance receipts and applied advance)'],
  ['returns', 'Returns'],
  ['cheques', 'Cheques'],
  ['advances', 'Advances'],
  ['purchaseBills', 'Purchase bills'],
  ['loosePurchases', 'Purchases (without a bill)'],
  ['supplierPayments', 'Payments to suppliers'],
  ['supplierReturns', 'Returns to suppliers'],
  ['expenses', 'Expenses'],
  ['employeeTx', 'Staff salary / advance entries'],
  ['stockLoss', 'Stock loss'],
  ['assets', 'Assets'],
];

export default function PurgeEntries() {
  const { data, settings, mutate, toast } = useApp();
  const [from, setFrom] = useState('2026-11-14');
  const [to, setTo] = useState(todayISO());
  const [shown, setShown] = useState(null);       // the range the preview was made for
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const support = useBackendFeature('purgeEntries', true);

  const plan = useMemo(
    () => (shown ? purgePlan(data, shown.from, shown.to) : null),
    [shown, data]
  );

  const counts = plan ? {
    bills: plan.bills.length, payments: plan.payments.length, returns: plan.returns.length,
    cheques: plan.cheques.length, advances: plan.advances.length,
    purchaseBills: plan.purchaseBills.length,
    loosePurchases: plan.purchases.filter((p) => !p.purchaseBillId).length,
    supplierPayments: plan.supplierPayments.length, supplierReturns: plan.supplierReturns.length,
    expenses: plan.expenses.length, employeeTx: plan.employeeTx.length,
    stockLoss: plan.stockLoss.length, assets: plan.assets.length,
  } : {};

  const rangeOk = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;
  const stale = shown && (shown.from !== from || shown.to !== to);
  const canRemove = plan && plan.count > 0 && !stale && typed.trim() === 'DELETE'
    && support.state !== 'old' && support.state !== 'checking';

  const remove = async () => {
    if (busy || !canRemove) return;
    setBusy(true);
    try {
      // The restore point first: a file with everything as it is right now.
      downloadBackup(data, settings.shopName);
      const res = await mutate(() => api.purgeEntries(shown.from, shown.to),
        `Removed ${plan.count} entries dated ${shown.from} to ${shown.to}`);
      setTyped('');
      setShown(null);
      toast(`${res?.count ?? plan.count} entries removed. A backup file was downloaded first.`, 'success', 8000);
    } catch { /* toast shown */ } finally { setBusy(false); }
  };

  return (
    <Card title="Remove entries by date"
          subtitle="Delete every entry between two dates — for clearing test or wrong entries">
      <div style={{
        padding: '9px 12px', marginBottom: 12, background: 'var(--danger-bg)', border: '1px solid #FECACA',
        borderRadius: 'var(--r-sm)', fontSize: 12.5, color: '#991B1B', lineHeight: 1.5,
      }}>
        Permanent. Bills, payments, returns, cheques, advances, purchases, supplier payments, expenses,
        staff entries, stock loss and assets dated in the range are removed; stock and balances go back to
        what they were before those entries. Parties, items, suppliers, staff and the Activity Log stay.
        A backup file is downloaded automatically before anything is removed.
      </div>

      <div className="form-grid">
        <Field label="From (first day)">
          <Input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setTyped(''); }} />
        </Field>
        <Field label="To (last day)">
          <Input type="date" value={to} onChange={(e) => { setTo(e.target.value); setTyped(''); }} />
        </Field>
      </div>
      {from && to && from > to && <div className="small" style={{ color: 'var(--danger)' }}>"From" must not be after "To".</div>}

      <Button icon={Eye} block disabled={!rangeOk} onClick={() => { setShown({ from, to }); setTyped(''); }}>
        Show what would be removed
      </Button>

      {plan && (
        <div style={{ marginTop: 14 }}>
          {plan.count === 0 ? (
            <div className="small muted">Nothing is dated between {shown.from} and {shown.to}.</div>
          ) : (
            <>
              <div style={{ fontWeight: 600, fontSize: 13.5, marginBottom: 6 }}>
                {plan.count} entries dated {shown.from} to {shown.to}
              </div>
              <table className="tbl" style={{ marginBottom: 10 }}>
                <tbody>
                  {ROWS.filter(([k]) => counts[k] > 0).map(([k, label]) => (
                    <tr key={k}><td>{label}</td><td className="r strong">{counts[k]}</td></tr>
                  ))}
                </tbody>
              </table>
              <div className="small" style={{ lineHeight: 1.7, marginBottom: 10 }}>
                {plan.totals.sales > 0 && <div>Sales removed: <strong>{money(plan.totals.sales)}</strong></div>}
                {plan.totals.payments > 0 && <div>Payments removed from your balances: <strong>{money(plan.totals.payments)}</strong></div>}
                {plan.totals.purchases > 0 && <div>Purchases removed: <strong>{money(plan.totals.purchases)}</strong></div>}
                {plan.totals.expenses > 0 && <div>Expenses removed: <strong>{money(plan.totals.expenses)}</strong></div>}
              </div>
              <div className="small muted" style={{ marginBottom: 12, lineHeight: 1.5 }}>
                Bill numbers are not reused. An item that was bought only in this range keeps its last cost price
                (the one before it was never recorded).
              </div>

              {stale && <div className="small" style={{ color: 'var(--danger)', marginBottom: 8 }}>The dates changed — show what would be removed again.</div>}
              {support.state === 'old' && <OutdatedBackend what="removing entries by date" onRecheck={support.recheck} />}

              <Field label="Type DELETE to confirm">
                <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="DELETE" autoComplete="off" />
              </Field>
              <Button variant="danger" icon={Trash2} block loading={busy} disabled={!canRemove} onClick={remove}>
                Download backup and remove {plan.count} entries
              </Button>
            </>
          )}
        </div>
      )}
    </Card>
  );
}
