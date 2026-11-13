// Profit Report (FR-39 / Plan 7.5) — gross profit by day, month, item and party,
// using the cost price captured at the time of each sale (FR-38).

import { useMemo, useState } from 'react';
import {
  TrendingUp, Download, Printer, Package, Users, Calendar,
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { useApp } from '../context/AppContext';
import {
  Card, Button, Empty, PageHead, Money, Stat, RangePicker, Select,
} from '../components/ui';
import { rangeFor, inRange, lineProfit } from '../lib/calc';
import { money, fmtDate, r2, unitFactor } from '../lib/format';
import { exportExcel, printReport } from '../lib/exporters';

export default function ProfitReport() {
  const { data, settings, toast } = useApp();
  const [preset, setPreset] = useState('month');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [groupBy, setGroupBy] = useState('item');

  const range = useMemo(() => rangeFor(preset, custom), [preset, custom]);

  /* Bill lines in range, excluding voided bills, with profit per line */
  const lines = useMemo(() => {
    const live = data.bills.filter(
      (b) => b.status !== 'voided' && inRange(b.date, range.from, range.to)
    );
    const byId = new Map(live.map((b) => [b.id, b]));
    return data.billItems
      .filter((bi) => byId.has(bi.billId))
      .map((bi) => {
        const bill = byId.get(bi.billId);
        const revenue = r2((Number(bi.qty) || 0) * (Number(bi.price) || 0));
        const item = data.items.find((i) => i.id === bi.itemId);
        // Cost is held per base unit; the line may be sold in the alternate unit.
        const cost = r2((Number(bi.qty) || 0) * (Number(bi.costPriceAtSale) || 0) * unitFactor(item, bi.unit));
        return {
          ...bi, bill,
          itemName: item?.name || 'Item',
          partyName: data.parties.find((p) => p.id === bill.partyId)?.name || 'Unknown',
          partyId: bill.partyId,
          date: bill.date,
          revenue, cost, profit: r2(revenue - cost),
          margin: revenue > 0 ? ((revenue - cost) / revenue) * 100 : 0,
        };
      });
  }, [data, range]);

  const totals = useMemo(() => {
    const revenue = r2(lines.reduce((s, l) => s + l.revenue, 0));
    const cost = r2(lines.reduce((s, l) => s + l.cost, 0));
    const profit = r2(revenue - cost);
    return { revenue, cost, profit, margin: revenue > 0 ? (profit / revenue) * 100 : 0 };
  }, [lines]);

  /* Grouped breakdown */
  const grouped = useMemo(() => {
    const key = groupBy === 'item' ? 'itemId' : groupBy === 'party' ? 'partyId' : 'date';
    const label = groupBy === 'item' ? 'itemName' : groupBy === 'party' ? 'partyName' : 'date';

    const m = new Map();
    lines.forEach((l) => {
      const k = l[key];
      if (!m.has(k)) m.set(k, { label: l[label], revenue: 0, cost: 0, profit: 0, qty: 0 });
      const g = m.get(k);
      g.revenue = r2(g.revenue + l.revenue);
      g.cost = r2(g.cost + l.cost);
      g.profit = r2(g.profit + l.profit);
      g.qty = r2(g.qty + (Number(l.qty) || 0));
    });

    return [...m.values()]
      .map((g) => ({ ...g, margin: g.revenue > 0 ? (g.profit / g.revenue) * 100 : 0 }))
      .sort((a, b) => groupBy === 'day'
        ? new Date(a.label) - new Date(b.label)
        : b.profit - a.profit);
  }, [lines, groupBy]);

  /* Daily trend for the chart */
  const trend = useMemo(() => {
    const m = new Map();
    lines.forEach((l) => {
      m.set(l.date, r2((m.get(l.date) || 0) + l.profit));
    });
    return [...m.entries()]
      .sort((a, b) => new Date(a[0]) - new Date(b[0]))
      .slice(-30)
      .map(([date, profit]) => ({
        date: new Date(date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }),
        profit,
      }));
  }, [lines]);

  const groupLabel = groupBy === 'item' ? 'Item' : groupBy === 'party' ? 'Party' : 'Date';

  const onExcel = () => {
    exportExcel(`Profit_by_${groupBy}`,
      [groupLabel, 'Qty', 'Revenue', 'Cost', 'Profit', 'Margin %'],
      grouped.map((g) => [
        groupBy === 'day' ? fmtDate(g.label) : g.label,
        g.qty, g.revenue.toFixed(2), g.cost.toFixed(2), g.profit.toFixed(2), g.margin.toFixed(1),
      ]),
      [`${settings.shopName} — Profit Report`,
       `Revenue ${money(totals.revenue)} · Cost ${money(totals.cost)} · Profit ${money(totals.profit)}`]);
    toast('Profit report exported');
  };

  const onPDF = () => printReport({
    title: 'Profit Report', subtitle: `By ${groupLabel.toLowerCase()}`,
    shopName: settings.shopName,
    headers: [groupLabel, { label: 'Qty', align: 'r' }, { label: 'Revenue', align: 'r' },
              { label: 'Cost', align: 'r' }, { label: 'Profit', align: 'r' },
              { label: 'Margin', align: 'r' }],
    rows: grouped.map((g) => [
      groupBy === 'day' ? fmtDate(g.label) : g.label,
      g.qty, money(g.revenue), money(g.cost), money(g.profit), `${g.margin.toFixed(1)}%`,
    ]),
    totals: ['Totals', '', money(totals.revenue), money(totals.cost),
             money(totals.profit), `${totals.margin.toFixed(1)}%`],
  });

  return (
    <>
      <PageHead title="Profit Report"
                subtitle="Gross profit uses the cost price captured at the time of each sale">
        <Select value={groupBy} onChange={(e) => setGroupBy(e.target.value)} style={{ width: 150 }}
                options={[
                  { value: 'item',  label: 'By item' },
                  { value: 'party', label: 'By party' },
                  { value: 'day',   label: 'By day' },
                ]} />
        <Button icon={Download} onClick={onExcel}>Excel</Button>
        <Button icon={Printer} onClick={onPDF}>PDF</Button>
      </PageHead>

      <div className="mb-2">
        <RangePicker value={preset} onChange={setPreset} custom={custom} onCustomChange={setCustom} />
      </div>

      <div className="stat-grid">
        <Stat label="Revenue" value={money(totals.revenue)} icon={TrendingUp} tone="#D9390B" />
        <Stat label="Cost of Goods" value={money(totals.cost)} icon={Package} tone="#DC2626" />
        <Stat label="Gross Profit" value={money(totals.profit)} icon={TrendingUp} tone="#16A34A" />
        <Stat label="Margin" value={`${totals.margin.toFixed(1)}%`} icon={TrendingUp} tone="#F59E0B" />
      </div>

      {trend.length > 1 && (
        <Card title="Profit Trend" subtitle="Last 30 days with sales" className="mb-2">
          <div style={{ width: '100%', height: 220 }}>
            <ResponsiveContainer>
              <BarChart data={trend} margin={{ top: 6, right: 8, left: -14, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#F1F3F5" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#6B7280' }}
                       axisLine={false} tickLine={false} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 11, fill: '#6B7280' }} axisLine={false} tickLine={false}
                       tickFormatter={(v) => v >= 1000 ? `${Math.round(v / 1000)}k` : v} />
                <Tooltip formatter={(v) => [money(v), 'Profit']}
                         contentStyle={{ borderRadius: 8, border: '1px solid #E5E7EB', fontSize: 12.5 }} />
                <Bar dataKey="profit" fill="#16A34A" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}

      <Card title={`Profit by ${groupLabel}`} tight>
        {!grouped.length ? (
          <Empty icon={TrendingUp} title="No sales in this period"
                 message="Change the date range, or record a bill to see profit." />
        ) : (
          <>
            <div className="table-wrap hide-mobile">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{groupLabel}</th>
                    <th className="r">Qty sold</th>
                    <th className="r">Revenue</th>
                    <th className="r">Cost</th>
                    <th className="r">Profit</th>
                    <th className="r">Margin</th>
                  </tr>
                </thead>
                <tbody>
                  {grouped.map((g, i) => (
                    <tr key={i}>
                      <td style={{ fontWeight: 600 }}>
                        {groupBy === 'day' ? fmtDate(g.label) : g.label}
                      </td>
                      <td className="r">{g.qty}</td>
                      <td className="r"><Money value={g.revenue} /></td>
                      <td className="r"><Money value={g.cost} /></td>
                      <td className="r strong">
                        <span className="money" style={{ color: g.profit >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                          {money(g.profit)}
                        </span>
                      </td>
                      <td className="r">
                        <span style={{ fontWeight: 600, color: g.margin >= 15 ? 'var(--success)' : g.margin >= 5 ? 'var(--warning)' : 'var(--danger)' }}>
                          {g.margin.toFixed(1)}%
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={2}>Totals</td>
                    <td className="r">{money(totals.revenue)}</td>
                    <td className="r">{money(totals.cost)}</td>
                    <td className="r" style={{ color: 'var(--success)' }}>{money(totals.profit)}</td>
                    <td className="r">{totals.margin.toFixed(1)}%</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <div className="mcards" style={{ padding: 12 }}>
              {grouped.map((g, i) => (
                <div key={i} className="mcard">
                  <div className="top">
                    <span className="name">{groupBy === 'day' ? fmtDate(g.label) : g.label}</span>
                    <span className="amt" style={{ color: g.profit >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                      {money(g.profit)}
                    </span>
                  </div>
                  <div className="meta">
                    <span>Revenue {money(g.revenue)}</span>
                    <span>Cost {money(g.cost)}</span>
                    <span style={{ fontWeight: 600 }}>{g.margin.toFixed(1)}% margin</span>
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
