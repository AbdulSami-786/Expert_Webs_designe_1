// Per-method transaction history (FR-41) — a mini bank statement with a
// running balance, in chronological order.

import { useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Download, Printer, Landmark, ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { Card, Button, Empty, PageHead, Money, Stat, Pill } from '../components/ui';
import { accountLedger, accountBalances } from '../lib/calc';
import { money, fmtDate, r2 } from '../lib/format';
import { exportExcel, printReport } from '../lib/exporters';

export default function AccountLedger() {
  const { method: raw } = useParams();
  const method = decodeURIComponent(raw || '');
  const nav = useNavigate();
  const { data, settings, methods, toast } = useApp();

  const rows = useMemo(() => accountLedger(method, data), [method, data]);

  const summary = useMemo(() => {
    const b = accountBalances([method], data)[0];
    return b || { in: 0, out: 0, balance: 0 };
  }, [method, data]);

  // Newest first for display; running balance was computed oldest-first
  const display = useMemo(() => [...rows].reverse(), [rows]);

  if (!methods.includes(method)) {
    return <Empty icon={Landmark} title="Unknown payment method"
                  message={`"${method}" is not a configured payment method.`}
                  action={<Button onClick={() => nav('/accounts')}>Back to Accounts</Button>} />;
  }

  const onExcel = () => {
    exportExcel(`Account_${method}`,
      ['Date', 'Description', 'In', 'Out', 'Running Balance'],
      rows.map((r) => [fmtDate(r.date), r.desc,
                       r.direction === 'in' ? r.amount.toFixed(2) : '',
                       r.direction === 'out' ? r.amount.toFixed(2) : '',
                       r.runningBalance.toFixed(2)]),
      [`${settings.shopName} — ${method} Statement`, `Closing balance: ${money(summary.balance)}`]);
    toast('Statement exported');
  };

  const onPDF = () => printReport({
    title: `${method} Statement`, subtitle: `${rows.length} transactions`,
    shopName: settings.shopName,
    headers: ['Date', 'Description', { label: 'In', align: 'r' },
              { label: 'Out', align: 'r' }, { label: 'Balance', align: 'r' }],
    rows: rows.map((r) => [fmtDate(r.date), r.desc,
      r.direction === 'in' ? money(r.amount) : '—',
      r.direction === 'out' ? money(r.amount) : '—',
      money(r.runningBalance)]),
    totals: ['', 'Closing balance', money(summary.in), money(summary.out), money(summary.balance)],
  });

  return (
    <>
      <PageHead title={method} subtitle="Every transaction through this method, with a running balance">
        <Button icon={ArrowLeft} onClick={() => nav('/accounts')}>Back</Button>
        <Button icon={Download} onClick={onExcel}>Excel</Button>
        <Button icon={Printer} onClick={onPDF}>PDF</Button>
      </PageHead>

      <div className="stat-grid">
        <Stat label="Money In" value={money(summary.in)} icon={ArrowDownLeft} tone="#16A34A" />
        <Stat label="Money Out" value={money(summary.out)} icon={ArrowUpRight} tone="#DC2626" />
        <Stat label="Current Balance" value={money(summary.balance)} icon={Landmark} tone="#D9390B" />
      </div>

      <Card tight>
        {!display.length ? (
          <Empty icon={Landmark} title="No transactions yet"
                 message={`Nothing has moved through ${method}.`} />
        ) : (
          <>
            <div className="table-wrap hide-mobile">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Date</th><th>Description</th><th>Type</th>
                    <th className="r">In</th><th className="r">Out</th><th className="r">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {display.map((r) => (
                    <tr key={r.id}>
                      <td className="nowrap">{fmtDate(r.date)}</td>
                      <td>{r.desc}</td>
                      <td>
                        <Pill status={r.direction === 'in' ? 'paid' : 'due'}
                              label={r.relatedType === 'payment' ? 'Payment'
                                   : r.relatedType === 'expense' ? 'Expense'
                                   : r.relatedType === 'salary' ? 'Salary'
                                   : r.relatedType === 'supplier' ? 'Supplier'
                                   : r.relatedType === 'opening' ? 'Opening' : 'Transfer'} />
                      </td>
                      <td className="r">
                        {r.direction === 'in'
                          ? <span className="money pos">{money(r.amount)}</span>
                          : <span className="muted">—</span>}
                      </td>
                      <td className="r">
                        {r.direction === 'out'
                          ? <span className="money neg">{money(r.amount)}</span>
                          : <span className="muted">—</span>}
                      </td>
                      <td className="r strong"><Money value={r.runningBalance} /></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={3}>{display.length} transactions</td>
                    <td className="r">{money(summary.in)}</td>
                    <td className="r">{money(summary.out)}</td>
                    <td className="r" style={{ fontSize: 15 }}>{money(summary.balance)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <div className="mcards" style={{ padding: 12 }}>
              {display.map((r) => (
                <div key={r.id} className="mcard">
                  <div className="top">
                    <span className="name">{r.desc}</span>
                    <span className="amt" style={{ color: r.direction === 'in' ? 'var(--success)' : 'var(--danger)' }}>
                      {r.direction === 'in' ? '+' : '−'}{money(r.amount)}
                    </span>
                  </div>
                  <div className="meta">
                    <span>{fmtDate(r.date)}</span>
                    <span className="spacer" />
                    <span>Balance {money(r.runningBalance)}</span>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </Card>
    </>
  );
}
