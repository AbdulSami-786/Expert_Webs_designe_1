// Daily closing summary (FR-50 / Plan 4.5).
// One tap produces the day's numbers, shareable to WhatsApp as the owner's
// own daily record.

import { useMemo } from 'react';
import { Send, Printer, CalendarCheck } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { Modal, Button, Money } from './ui';
import { deriveBills, accountBalances } from '../lib/calc';
import { money, todayISO, fmtDate, waLink, r2 } from '../lib/format';
import { printReport } from '../lib/exporters';

export default function CloseTodayModal({ open, onClose }) {
  const { data, settings, methods } = useApp();
  const today = todayISO();

  const summary = useMemo(() => {
    const derived = deriveBills(data.bills, data).filter((b) => b.status !== 'voided');
    const todays = derived.filter((b) => b.date === today);

    const sales = r2(todays.reduce((s, b) => s + b.net, 0));

    const todayPays = data.payments.filter((p) => !p.reversed && !p.isOpening && p.date === today);
    const collected = r2(todayPays.reduce((s, p) => s + (Number(p.amount) || 0), 0));

    const byMethod = methods.map((m) => ({
      method: m,
      amount: r2(todayPays.filter((p) => p.method === m).reduce((s, p) => s + (Number(p.amount) || 0), 0)),
    })).filter((x) => x.amount > 0);

    const newCredit = r2(todays.reduce((s, b) => s + b.due, 0));

    const expenses = r2(
      data.expenses.filter((e) => e.date === today).reduce((s, e) => s + (Number(e.amount) || 0), 0)
    );

    const balances = accountBalances(methods, data);
    const cashInHand = r2(balances.reduce((s, b) => s + b.balance, 0));

    const totalOutstanding = r2(derived.reduce((s, b) => s + b.due, 0));

    return { sales, collected, byMethod, newCredit, expenses, cashInHand, totalOutstanding, billCount: todays.length };
  }, [data, methods, today]);

  const text = useMemo(() => [
    `*${settings.shopName} — Daily Summary*`,
    fmtDate(today),
    '',
    `Bills made: ${summary.billCount}`,
    `Total sales: ${money(summary.sales)}`,
    `Collected today: ${money(summary.collected)}`,
    ...summary.byMethod.map((m) => `  • ${m.method}: ${money(m.amount)}`),
    `New credit given: ${money(summary.newCredit)}`,
    `Expenses today: ${money(summary.expenses)}`,
    '',
    `Cash in hand: ${money(summary.cashInHand)}`,
    `Total outstanding: ${money(summary.totalOutstanding)}`,
  ].join('\n'), [summary, settings.shopName, today]);

  const onPrint = () => {
    printReport({
      title: 'Daily Closing Summary',
      subtitle: fmtDate(today),
      shopName: settings.shopName,
      headers: ['Item', { label: 'Amount', align: 'r' }],
      rows: [
        ['Bills made', summary.billCount],
        ['Total sales', money(summary.sales)],
        ['Collected today', money(summary.collected)],
        ...summary.byMethod.map((m) => [`   ${m.method}`, money(m.amount)]),
        ['New credit given', money(summary.newCredit)],
        ['Expenses today', money(summary.expenses)],
        ['Cash in hand', money(summary.cashInHand)],
      ],
      totals: ['Total outstanding', money(summary.totalOutstanding)],
    });
  };

  const Row = ({ label, value, strong, tone }) => (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '9px 0', borderBottom: '1px solid #F1F3F5',
    }}>
      <span style={{ fontWeight: strong ? 700 : 500, color: tone }}>{label}</span>
      <span className="spacer" />
      <Money value={value} className={strong ? '' : 'small'} />
    </div>
  );

  return (
    <Modal
      open={open}
      title="Close Today"
      onClose={onClose}
      footer={
        <>
          <Button icon={Printer} onClick={onPrint}>Print</Button>
          <a className="btn btn-primary" target="_blank" rel="noreferrer"
             href={waLink(settings.phone, text)}>
            <Send size={15} /> Send on WhatsApp
          </a>
        </>
      }
    >
      <div className="row mb-2" style={{ gap: 9 }}>
        <span className="ico" style={{
          width: 34, height: 34, borderRadius: 9, background: 'var(--info-bg)',
          color: '#1D4ED8', display: 'grid', placeItems: 'center', flex: 'none',
        }}>
          <CalendarCheck size={17} />
        </span>
        <div>
          <div style={{ fontWeight: 700 }}>{fmtDate(today)}</div>
          <div className="small muted">
            {summary.billCount} bill{summary.billCount === 1 ? '' : 's'} made today
          </div>
        </div>
      </div>

      <Row label="Total sales" value={summary.sales} strong />
      <Row label="Collected today" value={summary.collected} />
      {summary.byMethod.map((m) => (
        <Row key={m.method} label={`    ${m.method}`} value={m.amount} tone="var(--text-muted)" />
      ))}
      <Row label="New credit given" value={summary.newCredit} tone="var(--danger)" />
      <Row label="Expenses today" value={summary.expenses} />

      <div style={{
        marginTop: 14, padding: 13, background: 'var(--bg)',
        borderRadius: 'var(--r)', border: '1px solid var(--border)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 7 }}>
          <span style={{ fontWeight: 700 }}>Cash in hand</span>
          <span className="spacer" />
          <Money value={summary.cashInHand} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <span style={{ fontWeight: 700 }}>Total outstanding</span>
          <span className="spacer" />
          <span className="money" style={{ color: 'var(--danger)' }}>{money(summary.totalOutstanding)}</span>
        </div>
      </div>
    </Modal>
  );
}
