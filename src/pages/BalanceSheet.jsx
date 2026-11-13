// Balance Sheet (FR-43 / Plan 7.8) — auto-generated Owns vs Owes snapshot,
// read directly from existing data with no duplicate bookkeeping.

import { useMemo } from 'react';
import { Scale, Download, Printer, TrendingUp, TrendingDown } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { Card, Button, PageHead, Money, Stat } from '../components/ui';
import { balanceSheet } from '../lib/calc';
import { money, fmtDate, r2 } from '../lib/format';
import { exportExcel, printReport, raw, escapeHTML } from '../lib/exporters';

export default function BalanceSheet() {
  const { data, settings, methods, toast } = useApp();

  const sheet = useMemo(
    () => balanceSheet({ ...data, methods }),
    [data, methods]
  );

  const onExcel = () => {
    const rows = [
      ['OWNS (Assets)', ''],
      ...sheet.owns.map((x) => [x.label, x.value.toFixed(2)]),
      ['Total Owns', sheet.totalOwns.toFixed(2)],
      ['', ''],
      ['OWES (Liabilities)', ''],
      ...sheet.owes.map((x) => [x.label, x.value.toFixed(2)]),
      ['Total Owes', sheet.totalOwes.toFixed(2)],
      ['', ''],
      ['NET WORTH', sheet.net.toFixed(2)],
    ];
    exportExcel('BalanceSheet', ['Item', 'Amount'], rows,
      [`${settings.shopName} — Balance Sheet`, `As at ${fmtDate(new Date())}`]);
    toast('Balance sheet exported');
  };

  const onPDF = () => printReport({
    title: 'Balance Sheet', subtitle: `As at ${fmtDate(new Date())}`,
    shopName: settings.shopName,
    headers: ['Item', { label: 'Amount', align: 'r' }],
    rows: [
      [raw('<strong>OWNS (Assets)</strong>'), ''],
      ...sheet.owns.map((x) => [raw(`&nbsp;&nbsp;${escapeHTML(x.label)}`), money(x.value)]),
      [raw('<strong>Total Owns</strong>'), raw(`<strong>${money(sheet.totalOwns)}</strong>`)],
      ['', ''],
      [raw('<strong>OWES (Liabilities)</strong>'), ''],
      ...sheet.owes.map((x) => [raw(`&nbsp;&nbsp;${escapeHTML(x.label)}`), money(x.value)]),
      [raw('<strong>Total Owes</strong>'), raw(`<strong>${money(sheet.totalOwes)}</strong>`)],
    ],
    totals: ['NET WORTH', money(sheet.net)],
  });

  const Section = ({ title, rows, total, totalLabel, tone }) => (
    <Card title={title} tight>
      <table className="tbl">
        <tbody>
          {rows.map((x) => (
            <tr key={x.label}>
              <td>{x.label}</td>
              <td className="r strong"><Money value={x.value} /></td>
            </tr>
          ))}
          {!rows.length && (
            <tr><td colSpan={2} className="muted tc" style={{ padding: 22 }}>Nothing recorded</td></tr>
          )}
        </tbody>
        <tfoot>
          <tr>
            <td>{totalLabel}</td>
            <td className="r" style={{ fontSize: 15, color: tone }}>{money(total)}</td>
          </tr>
        </tfoot>
      </table>
    </Card>
  );

  return (
    <>
      <PageHead title="Balance Sheet"
                subtitle={`Auto-generated from your data · As at ${fmtDate(new Date())}`}>
        <Button icon={Download} onClick={onExcel}>Excel</Button>
        <Button icon={Printer} onClick={onPDF}>PDF</Button>
      </PageHead>

      <div className="stat-grid">
        <Stat label="Total Owns" value={money(sheet.totalOwns)} icon={TrendingUp} tone="#16A34A" />
        <Stat label="Total Owes" value={money(sheet.totalOwes)} icon={TrendingDown} tone="#DC2626" />
        <Stat label="Net Worth" value={money(sheet.net)} icon={Scale} tone="#D9390B" />
      </div>

      <div className="grid-2">
        <Section title="Owns" rows={sheet.owns} total={sheet.totalOwns}
                 totalLabel="Total Owns" tone="var(--success)" />
        <Section title="Owes" rows={sheet.owes} total={sheet.totalOwes}
                 totalLabel="Total Owes" tone="var(--danger)" />
      </div>

      <Card title="Cash & Bank Breakdown" tight className="mt-2">
        <table className="tbl">
          <thead>
            <tr><th>Payment method</th><th className="r">Balance</th></tr>
          </thead>
          <tbody>
            {sheet.balances.map((b) => (
              <tr key={b.method}>
                <td>{b.method}</td>
                <td className="r strong">
                  <span className="money" style={{ color: b.balance < 0 ? 'var(--danger)' : undefined }}>
                    {money(b.balance)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>Total cash & bank</td>
              <td className="r">{money(r2(sheet.balances.reduce((s, b) => s + b.balance, 0)))}</td>
            </tr>
          </tfoot>
        </table>
      </Card>

      <div style={{
        marginTop: 16, padding: '13px 15px', background: 'var(--surface)',
        border: '1px solid var(--border)', borderRadius: 'var(--r)',
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      }}>
        <Scale size={20} color="var(--accent)" />
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontWeight: 700 }}>Net worth of the business</div>
          <div className="small muted">What you own minus what you owe, from live data.</div>
        </div>
        <span className="money" style={{ fontSize: 24, color: sheet.net >= 0 ? 'var(--success)' : 'var(--danger)' }}>
          {money(sheet.net)}
        </span>
      </div>
    </>
  );
}
