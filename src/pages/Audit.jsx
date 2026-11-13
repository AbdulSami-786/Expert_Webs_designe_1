// Audit / Account Summary (FR-44 / Plan 7.8) — a financial health check-up
// for any date range: sales, collections, expenses, profit, outstanding.

import { useMemo, useState } from 'react';
import {
  ClipboardList, Download, Printer, TrendingUp, TrendingDown, Wallet, AlertCircle,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import { Card, Button, PageHead, Money, Stat, RangePicker } from '../components/ui';
import { auditSummary, rangeFor, accountBalances, deriveBills, inRange } from '../lib/calc';
import { money, fmtDate, pctChange, r2 } from '../lib/format';
import { exportExcel, printReport } from '../lib/exporters';

export default function Audit() {
  const { data, settings, methods, toast } = useApp();
  const [preset, setPreset] = useState('month');
  const [custom, setCustom] = useState({ from: '', to: '' });

  const range = useMemo(() => rangeFor(preset, custom), [preset, custom]);

  const summary = useMemo(
    () => auditSummary(data, range.from, range.to),
    [data, range]
  );

  // Same window, previous period, for a like-for-like comparison
  const prevSummary = useMemo(() => {
    if (!range.from || !range.to) return null;
    const from = new Date(range.from), to = new Date(range.to);
    const span = Math.max(1, Math.round((to - from) / 86400000) + 1);
    const pTo = new Date(from); pTo.setDate(pTo.getDate() - 1);
    const pFrom = new Date(pTo); pFrom.setDate(pFrom.getDate() - span + 1);
    const iso = (d) => {
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    };
    return auditSummary(data, iso(pFrom), iso(pTo));
  }, [data, range]);

  const balances = useMemo(() => accountBalances(methods, data), [methods, data]);
  const cashInHand = r2(balances.reduce((s, b) => s + b.balance, 0));

  const newCredit = useMemo(() => {
    const derived = deriveBills(data.bills, data)
      .filter((b) => b.status !== 'voided' && inRange(b.date, range.from, range.to));
    return r2(derived.reduce((s, b) => s + b.due, 0));
  }, [data, range]);

  const rangeLabel = range.from && range.to
    ? `${fmtDate(range.from)} — ${fmtDate(range.to)}`
    : 'All time';

  const lines = [
    { label: 'Total sales',            value: summary.sales,       prev: prevSummary?.sales,       tone: '#D9390B' },
    { label: 'Collections received',   value: summary.collections, prev: prevSummary?.collections, tone: '#16A34A' },
    { label: 'Gross profit',           value: summary.grossProfit, prev: prevSummary?.grossProfit, tone: '#16A34A' },
    { label: 'Expenses',               value: summary.expenses,    prev: prevSummary?.expenses,    tone: '#DC2626' },
    { label: 'Salaries paid',          value: summary.salaries,    prev: prevSummary?.salaries,    tone: '#DC2626' },
    { label: 'Net profit after costs', value: summary.netProfit,   prev: prevSummary?.netProfit,   tone: '#111318', strong: true },
  ];

  const onExcel = () => {
    exportExcel('AuditSummary',
      ['Metric', 'This period', 'Previous period', 'Change %'],
      [
        ...lines.map((l) => [
          l.label, l.value.toFixed(2),
          l.prev !== undefined ? l.prev.toFixed(2) : '',
          l.prev !== undefined ? pctChange(l.value, l.prev).toFixed(1) : '',
        ]),
        ['Bills issued', summary.billCount, prevSummary?.billCount ?? '', ''],
        ['New credit given', newCredit.toFixed(2), '', ''],
        ['Outstanding (all time)', summary.outstanding.toFixed(2), '', ''],
        ['Cash in hand (now)', cashInHand.toFixed(2), '', ''],
      ],
      [`${settings.shopName} — Audit / Account Summary`, rangeLabel]);
    toast('Audit summary exported');
  };

  const onPDF = () => printReport({
    title: 'Audit / Account Summary', subtitle: rangeLabel, shopName: settings.shopName,
    headers: ['Metric', { label: 'This period', align: 'r' },
              { label: 'Previous', align: 'r' }, { label: 'Change', align: 'r' }],
    rows: [
      ...lines.map((l) => [
        l.label, money(l.value),
        l.prev !== undefined ? money(l.prev) : '—',
        l.prev !== undefined ? `${pctChange(l.value, l.prev) >= 0 ? '+' : ''}${pctChange(l.value, l.prev).toFixed(1)}%` : '—',
      ]),
      ['Bills issued', summary.billCount, prevSummary?.billCount ?? '—', ''],
      ['New credit given', money(newCredit), '', ''],
      ['Outstanding (all time)', money(summary.outstanding), '', ''],
      ['Cash in hand (now)', money(cashInHand), '', ''],
    ],
  });

  return (
    <>
      <PageHead title="Audit / Account Summary" subtitle={rangeLabel}>
        <Button icon={Download} onClick={onExcel}>Excel</Button>
        <Button icon={Printer} onClick={onPDF}>PDF</Button>
      </PageHead>

      <div className="mb-2">
        <RangePicker value={preset} onChange={setPreset} custom={custom} onCustomChange={setCustom} />
      </div>

      <div className="stat-grid">
        <Stat label="Total Sales" value={money(summary.sales)} icon={TrendingUp} tone="#D9390B"
              delta={prevSummary ? pctChange(summary.sales, prevSummary.sales) : undefined}
              deltaLabel="vs previous" />
        <Stat label="Collections" value={money(summary.collections)} icon={Wallet} tone="#16A34A"
              delta={prevSummary ? pctChange(summary.collections, prevSummary.collections) : undefined}
              deltaLabel="vs previous" />
        <Stat label="Net Profit" value={money(summary.netProfit)} icon={TrendingUp} tone="#16A34A"
              delta={prevSummary ? pctChange(summary.netProfit, prevSummary.netProfit) : undefined}
              deltaLabel="vs previous" />
        <Stat label="Outstanding" value={money(summary.outstanding)} icon={AlertCircle} tone="#DC2626" />
      </div>

      <div className="grid-2">
        <Card title="Financial Summary" tight
              subtitle={prevSummary ? 'Compared with the previous period of the same length' : undefined}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Metric</th>
                <th className="r">This period</th>
                {prevSummary && <th className="r">Previous</th>}
                {prevSummary && <th className="r">Change</th>}
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const delta = l.prev !== undefined ? pctChange(l.value, l.prev) : null;
                return (
                  <tr key={l.label} style={l.strong ? { background: '#FAFBFC' } : undefined}>
                    <td style={{ fontWeight: l.strong ? 700 : 500 }}>{l.label}</td>
                    <td className="r strong">
                      <span className="money" style={{ color: l.tone, fontSize: l.strong ? 15 : undefined }}>
                        {money(l.value)}
                      </span>
                    </td>
                    {prevSummary && (
                      <td className="r muted"><Money value={l.prev} className="small" /></td>
                    )}
                    {prevSummary && (
                      <td className="r">
                        <span style={{
                          fontWeight: 600, fontSize: 12.5,
                          color: delta > 0 ? 'var(--success)' : delta < 0 ? 'var(--danger)' : 'var(--text-muted)',
                        }}>
                          {delta > 0 ? '▲' : delta < 0 ? '▼' : '—'} {Math.abs(delta).toFixed(1)}%
                        </span>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>

        <div className="col">
          <Card title="Position Right Now" tight>
            <table className="tbl">
              <tbody>
                <tr>
                  <td>Bills issued this period</td>
                  <td className="r strong">{summary.billCount}</td>
                </tr>
                <tr>
                  <td>New credit given this period</td>
                  <td className="r strong"><span className="money neg">{money(newCredit)}</span></td>
                </tr>
                <tr>
                  <td>Total outstanding (all time)</td>
                  <td className="r strong"><span className="money neg">{money(summary.outstanding)}</span></td>
                </tr>
                <tr>
                  <td>Cash in hand (all methods)</td>
                  <td className="r strong"><span className="money pos">{money(cashInHand)}</span></td>
                </tr>
              </tbody>
            </table>
          </Card>

          <Card title="Balance by Method" tight>
            <table className="tbl">
              <tbody>
                {balances.map((b) => (
                  <tr key={b.method}>
                    <td>{b.method}</td>
                    <td className="r strong"><Money value={b.balance} /></td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr><td>Total</td><td className="r">{money(cashInHand)}</td></tr>
              </tfoot>
            </table>
          </Card>
        </div>
      </div>
    </>
  );
}
