// Dashboard (Design Brief 3.3 desktop composition / 4.3 mobile composition).
//
// Row 1: stat cards  ·  Row 2: due alerts + aging | reorder + low stock
// Row 3: top parties + sales trend chart
// Mobile: big glanceable numbers, horizontally scrollable alert cards, recent feed.

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  TrendingUp, Wallet, AlertCircle, Receipt, ArrowRight, Clock,
  PackageX, RefreshCw, Trophy, CheckCircle2, Send, CalendarCheck, Download,
} from 'lucide-react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { useApp } from '../context/AppContext';
import {
  Card, Stat, Pill, Money, Button, Empty, RangePicker, PageHead,
} from '../components/ui';
import {
  deriveBills, partyDue, reorderSuggestion, accountBalances, itemStock,
  rangeFor, inRange, grossProfit, collectedPayments,
} from '../lib/calc';
import {
  money, fmtDate, pctChange, waLink, AGING_META, r2, daysOverdue,
} from '../lib/format';
import { downloadBackup } from '../lib/exporters';
import CloseTodayModal from '../components/CloseTodayModal';

export default function Dashboard() {
  const { data, settings, methods, toast, isAdmin } = useApp();
  const nav = useNavigate();
  const [preset, setPreset] = useState('month');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [closeToday, setCloseToday] = useState(false);

  const range = useMemo(() => rangeFor(preset, custom), [preset, custom]);

  const derived = useMemo(() => deriveBills(data.bills, data), [data]);

  /* ---------------- Stats for the selected range (FR-45) ---------------- */
  const stats = useMemo(() => {
    const live = derived.filter((b) => b.status !== 'voided');
    const inR = live.filter((b) => inRange(b.date, range.from, range.to));

    const sales = r2(inR.reduce((s, b) => s + b.net, 0));

    // Opening balances are a starting float, not collections from customers.
    const collections = r2(
      collectedPayments(data.payments, data.cheques)
        .filter((p) => inRange(p.date, range.from, range.to))
        .reduce((s, p) => s + (Number(p.amount) || 0), 0)
    );

    // Cash in hand = sum of every payment-method balance (pending cheques excluded)
    const balances = accountBalances(methods, data);
    const cashInHand = r2(balances.reduce((s, b) => s + b.balance, 0));

    const outstanding = r2(live.reduce((s, b) => s + b.due, 0));

    const billIds = new Set(inR.map((b) => b.id));
    const profit = grossProfit(data.billItems.filter((bi) => billIds.has(bi.billId)), data.bills, data.items);

    const newCredit = r2(inR.reduce((s, b) => s + (b.due > 0 ? b.due : 0), 0));

    return { sales, collections, cashInHand, outstanding, profit, newCredit, billCount: inR.length };
  }, [derived, data, range, methods]);

  /* ---------------- This month vs last month (FR-46) ---------------- */
  const comparison = useMemo(() => {
    const thisM = rangeFor('month');
    const lastM = rangeFor('lastMonth');
    const live = derived.filter((b) => b.status !== 'voided');

    const salesIn = (r) => r2(live.filter((b) => inRange(b.date, r.from, r.to)).reduce((s, b) => s + b.net, 0));
    const collIn = (r) => r2(
      collectedPayments(data.payments, data.cheques).filter((p) => inRange(p.date, r.from, r.to))
        .reduce((s, p) => s + (Number(p.amount) || 0), 0)
    );
    const expIn = (r) => r2(
      data.expenses.filter((e) => inRange(e.date, r.from, r.to))
        .reduce((s, e) => s + (Number(e.amount) || 0), 0)
    );
    const profitIn = (r) => {
      const ids = new Set(live.filter((b) => inRange(b.date, r.from, r.to)).map((b) => b.id));
      return grossProfit(data.billItems.filter((bi) => ids.has(bi.billId)), data.bills, data.items);
    };

    return [
      { label: 'Sales',       curr: salesIn(thisM),  prev: salesIn(lastM) },
      { label: 'Collections', curr: collIn(thisM),   prev: collIn(lastM) },
      { label: 'Expenses',    curr: expIn(thisM),    prev: expIn(lastM) },
      { label: 'Profit',      curr: profitIn(thisM), prev: profitIn(lastM) },
    ].map((x) => ({ ...x, delta: pctChange(x.curr, x.prev) }));
  }, [derived, data]);

  /* ---------------- Overdue alerts (FR-24) ---------------- */
  const overdue = useMemo(() => {
    return derived
      .filter((b) => b.status !== 'voided' && b.due > 0 && b.isOverdue)
      .map((b) => ({ ...b, party: data.parties.find((p) => p.id === b.partyId) }))
      .sort((a, b) => b.overdueDays - a.overdueDays)
      .slice(0, 6);
  }, [derived, data.parties]);

  /* ---------------- Aging summary ---------------- */
  const aging = useMemo(() => {
    const buckets = { '0-7': 0, '8-30': 0, '30+': 0 };
    derived.forEach((b) => {
      if (b.status === 'voided' || b.due <= 0) return;
      buckets[b.bucket] = r2((buckets[b.bucket] || 0) + b.due);
    });
    return buckets;
  }, [derived]);

  /* ---------------- Reorder suggestions (FR-47) ---------------- */
  const reorders = useMemo(() => {
    return data.parties
      .filter((p) => p.status !== 'archived')
      .map((p) => ({ party: p, sug: reorderSuggestion(p.id, data.bills) }))
      .filter((x) => x.sug && x.sug.isDue)
      .sort((a, b) => b.sug.overdueBy - a.sug.overdueBy)
      .slice(0, 5);
  }, [data.parties, data.bills]);

  /* ---------------- Low stock (FR-49) ---------------- */
  const lowStock = useMemo(() => {
    return data.items
      .filter((i) => i.status !== 'archived' && Number(i.lowStockAlert) > 0)
      .map((i) => ({ item: i, stock: itemStock(i.id, data) }))
      .filter((x) => x.stock <= Number(x.item.lowStockAlert))
      .sort((a, b) => a.stock - b.stock)
      .slice(0, 5);
  }, [data]);

  /* ---------------- Top parties (FR-48) ---------------- */
  const topParties = useMemo(() => {
    const totals = new Map();
    derived
      .filter((b) => b.status !== 'voided' && inRange(b.date, range.from, range.to))
      .forEach((b) => totals.set(b.partyId, r2((totals.get(b.partyId) || 0) + b.net)));

    return [...totals.entries()]
      .map(([partyId, revenue]) => ({
        party: data.parties.find((p) => p.id === partyId),
        revenue,
        due: partyDue(partyId, derived),
      }))
      .filter((x) => x.party)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);
  }, [derived, data.parties, range]);

  /* ---------------- Sales trend ---------------- */
  const trend = useMemo(() => {
    const days = 14;
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const p = (n) => String(n).padStart(2, '0');
      const iso = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
      const total = r2(
        derived.filter((b) => b.status !== 'voided' && b.date === iso)
          .reduce((s, b) => s + b.net, 0)
      );
      out.push({ date: d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }), sales: total });
    }
    return out;
  }, [derived]);

  /* ---------------- Recent bills (mobile feed) ---------------- */
  const recent = useMemo(
    () => [...derived].sort((a, b) => new Date(b.date) - new Date(a.date) || b.billNo.localeCompare(a.billNo)).slice(0, 8),
    [derived]
  );

  const partyName = (id) => data.parties.find((p) => p.id === id)?.name || 'Unknown';

  return (
    <>
      <PageHead title="Dashboard" subtitle={`Showing ${rangeLabel(preset, range)}`}>
        <RangePicker value={preset} onChange={setPreset} custom={custom} onCustomChange={setCustom} />
      </PageHead>

      {/* Mobile-only quick actions */}
      <div className="hide-mobile" style={{ display: 'none' }} />
      <div className="row hide-desktop mb-2" style={{ gap: 8 }}>
        <Button icon={CalendarCheck} onClick={() => setCloseToday(true)} style={{ flex: 1 }}>Close Today</Button>
        {isAdmin && (
          <Button icon={Download} onClick={() => { downloadBackup(data, settings.shopName); toast('Backup downloaded'); }} style={{ flex: 1 }}>
            Backup
          </Button>
        )}
      </div>

      {/* ---------------- Row 1: stat cards ---------------- */}
      <div className="stat-grid">
        <Stat label="Sales" value={money(stats.sales)} icon={TrendingUp} tone="#D9390B"
              delta={comparison[0].delta} deltaLabel="vs last month" />
        <Stat label="Cash in Hand" value={money(stats.cashInHand)} icon={Wallet} tone="#16A34A"
              onClick={() => nav('/accounts')} />
        <Stat label="Total Outstanding" value={money(stats.outstanding)} icon={AlertCircle} tone="#DC2626"
              onClick={() => nav('/outstanding')} />
        <Stat label="Bills" value={stats.billCount} icon={Receipt} tone="#F59E0B"
              onClick={() => nav('/bills')} />
      </div>

      {/* ---------------- Mobile: swipeable alert cards ---------------- */}
      <div className="hide-desktop mb-2">
        <div className="hscroll">
          <div className="card"><div className="card-body">
            <div className="stat-label"><Clock size={13} /> Overdue</div>
            <div className="stat-value" style={{ fontSize: 20 }}>{overdue.length}</div>
            <div className="small muted">{money(aging['30+'] + aging['8-30'])} aged over 7 days</div>
          </div></div>
          <div className="card"><div className="card-body">
            <div className="stat-label"><RefreshCw size={13} /> Reorder soon</div>
            <div className="stat-value" style={{ fontSize: 20 }}>{reorders.length}</div>
            <div className="small muted">Parties past their usual cycle</div>
          </div></div>
          <div className="card"><div className="card-body">
            <div className="stat-label"><PackageX size={13} /> Low stock</div>
            <div className="stat-value" style={{ fontSize: 20 }}>{lowStock.length}</div>
            <div className="small muted">Items at or below threshold</div>
          </div></div>
        </div>
      </div>

      {/* ---------------- Row 2 ---------------- */}
      <div className="grid-2 mb-2 dash-row-2" style={{ alignItems: 'start' }}>
        <div className="col">
          <Card title="Overdue Payments" tight
                subtitle={overdue.length ? `${overdue.length} bill${overdue.length === 1 ? '' : 's'} past due date` : undefined}
                actions={<Button size="sm" onClick={() => nav('/outstanding')}>View all</Button>}>
            {overdue.length ? overdue.map((b) => (
              <div className="alert-row" key={b.id}>
                <span className="ico danger"><AlertCircle size={15} /></span>
                <div className="body">
                  <div className="t">{partyName(b.partyId)}</div>
                  <div className="s">
                    Bill {b.billNo} · due {fmtDate(b.dueDate)} · {b.overdueDays} day{b.overdueDays === 1 ? '' : 's'} late
                  </div>
                </div>
                <Money value={b.due} />
                <a className="btn btn-ghost btn-sm" title="Send WhatsApp reminder"
                   href={waLink(b.party?.phone, reminderText(settings.shopName, partyName(b.partyId), b))}
                   target="_blank" rel="noreferrer">
                  <Send size={14} />
                </a>
              </div>
            )) : (
              <Empty icon={CheckCircle2} title="Nothing overdue"
                     message="Every credit bill is within its due date." />
            )}
          </Card>

          <Card title="Aging Summary" tight>
            <table className="tbl">
              <tbody>
                {Object.entries(aging).map(([bucket, amt]) => {
                  const meta = AGING_META[bucket];
                  const total = aging['0-7'] + aging['8-30'] + aging['30+'];
                  const pct = total > 0 ? (amt / total) * 100 : 0;
                  return (
                    <tr key={bucket}>
                      <td style={{ width: 110 }}>
                        <Pill status={bucket === '30+' ? 'overdue' : 'partial'} label={meta.label} />
                      </td>
                      <td>
                        <div style={{ height: 7, background: 'var(--neutral-bg)', borderRadius: 999 }}>
                          <div style={{ height: '100%', width: `${pct}%`, background: meta.color, borderRadius: 999, transition: 'width .3s' }} />
                        </div>
                      </td>
                      <td className="r strong" style={{ width: 120 }}><Money value={amt} /></td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={2}>Total outstanding</td>
                  <td className="r"><Money value={stats.outstanding} /></td>
                </tr>
              </tfoot>
            </table>
          </Card>
        </div>

        <div className="col">
          <Card title="Likely to Reorder" tight
                subtitle="Based on each party's own ordering pattern">
            {reorders.length ? reorders.map(({ party, sug }) => (
              <div className="alert-row" key={party.id}>
                <span className="ico info"><RefreshCw size={15} /></span>
                <div className="body">
                  <div className="t">{party.name}</div>
                  <div className="s">
                    Usually orders every {sug.avgDays} days — it has been {sug.sinceDays}
                  </div>
                </div>
                <a className="btn btn-sm" target="_blank" rel="noreferrer"
                   href={waLink(party.phone, `Assalam-o-Alaikum ${party.name}, ${settings.shopName} se. Koi order banana hai?`)}>
                  <Send size={13} /> Follow up
                </a>
              </div>
            )) : (
              <Empty icon={CheckCircle2} title="No reorders due"
                     message="Every party is within their usual ordering cycle." />
            )}
          </Card>

          <Card title="Low Stock" tight
                actions={<Button size="sm" onClick={() => nav('/items')}>Manage items</Button>}>
            {lowStock.length ? lowStock.map(({ item, stock }) => (
              <div className="alert-row" key={item.id}>
                <span className="ico warning"><PackageX size={15} /></span>
                <div className="body">
                  <div className="t">{item.name}</div>
                  <div className="s">Threshold {item.lowStockAlert} {item.baseUnit}</div>
                </div>
                <span className="num" style={{ color: stock <= 0 ? 'var(--danger)' : 'var(--warning)' }}>
                  {stock} {item.baseUnit}
                </span>
              </div>
            )) : (
              <Empty icon={CheckCircle2} title="Stock levels are healthy"
                     message="No item has fallen to its low-stock threshold." />
            )}
          </Card>
        </div>
      </div>

      {/* ---------------- This month vs last month ---------------- */}
      <Card title="This Month vs Last Month" className="mb-2">
        <div className="stat-grid" style={{ marginBottom: 0 }}>
          {comparison.map((c) => (
            <div key={c.label} style={{ padding: '2px 0' }}>
              <div className="stat-label">{c.label}</div>
              <div className="stat-value" style={{ fontSize: 20 }}>{money(c.curr)}</div>
              <div className={`stat-delta ${c.delta > 0 ? 'up' : c.delta < 0 ? 'down' : ''}`}>
                {c.delta > 0 ? '▲' : c.delta < 0 ? '▼' : '—'} {Math.abs(c.delta).toFixed(1)}%
                <span className="muted">was {money(c.prev)}</span>
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* ---------------- Row 3: top parties + trend ---------------- */}
      <div className="grid-2">
        <Card title="Top Parties" subtitle="Ranked by revenue in the selected period" tight>
          {topParties.length ? (
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ width: 34 }}>#</th>
                    <th>Party</th>
                    <th className="r">Revenue</th>
                    <th className="r">Due</th>
                  </tr>
                </thead>
                <tbody>
                  {topParties.map((t, i) => (
                    <tr key={t.party.id} className="clickable" onClick={() => nav(`/party/${t.party.id}`)}>
                      <td>
                        {i === 0
                          ? <Trophy size={14} color="#F59E0B" />
                          : <span className="muted small">{i + 1}</span>}
                      </td>
                      <td style={{ fontWeight: 500 }}>{t.party.name}</td>
                      <td className="r strong"><Money value={t.revenue} /></td>
                      <td className="r">
                        {t.due > 0
                          ? <span style={{ color: 'var(--danger)', fontWeight: 600 }}>{money(t.due)}</span>
                          : <span className="muted">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="No sales in this period"
                   message="Change the date range or create a bill to see rankings."
                   action={<Button variant="primary" onClick={() => nav('/bill/new')}>New Bill</Button>} />
          )}
        </Card>

        <Card title="Sales Trend" subtitle="Last 14 days">
          <div style={{ width: '100%', height: 232 }}>
            <ResponsiveContainer>
              <LineChart data={trend} margin={{ top: 6, right: 8, left: -14, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#F1F3F5" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#6B7280' }}
                       axisLine={false} tickLine={false} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 11, fill: '#6B7280' }} axisLine={false} tickLine={false}
                       tickFormatter={(v) => v >= 1000 ? `${Math.round(v / 1000)}k` : v} />
                <Tooltip
                  formatter={(v) => [money(v), 'Sales']}
                  contentStyle={{ borderRadius: 8, border: '1px solid #E5E7EB', fontSize: 12.5 }}
                />
                <Line type="monotone" dataKey="sales" stroke="#D9390B" strokeWidth={2}
                      dot={{ r: 2.5, fill: '#D9390B' }} activeDot={{ r: 4.5 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      {/* ---------------- Mobile: recent bills feed ---------------- */}
      <div className="hide-desktop mt-2">
        <h2 className="h2 mb-1">Recent Bills</h2>
        <div className="mcards">
          {recent.map((b) => (
            <div key={b.id} className={`mcard ${b.due > 0 ? `due-${b.bucket === '30+' ? 30 : b.bucket === '8-30' ? 8 : 0}` : ''}`}
                 onClick={() => nav(`/bill/${b.id}`)}>
              <div className="top">
                <span className="name">{partyName(b.partyId)}</span>
                <span className="amt">{money(b.net)}</span>
              </div>
              <div className="meta">
                <Pill status={b.status} />
                <span>{b.billNo}</span>
                <span>{fmtDate(b.date)}</span>
                {b.due > 0 && <span style={{ color: 'var(--danger)', fontWeight: 600 }}>{money(b.due)} due</span>}
              </div>
            </div>
          ))}
        </div>
      </div>

      <CloseTodayModal open={closeToday} onClose={() => setCloseToday(false)} />
    </>
  );
}

function rangeLabel(preset, range) {
  if (preset === 'all') return 'all time';
  if (preset === 'today') return 'today';
  if (preset === 'week') return 'this week';
  if (preset === 'month') return 'this month';
  if (range.from && range.to) return `${fmtDate(range.from)} — ${fmtDate(range.to)}`;
  return 'a custom range';
}

function reminderText(shopName, partyName, bill) {
  return `Assalam-o-Alaikum ${partyName}, ${shopName} se. Bill ${bill.billNo} ka ${money(bill.due)} ` +
         `${daysOverdue(bill.dueDate)} din se due hai. Meherbani karke payment clear karwa dein. Shukriya.`;
}
