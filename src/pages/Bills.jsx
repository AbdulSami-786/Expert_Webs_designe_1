// All bills — searchable by bill number, party, date range, or item (Plan 3.5).

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Receipt, Plus, Download, Printer } from 'lucide-react';
import { useApp } from '../context/AppContext';
import {
  Card, Button, Empty, PageHead, SearchBar, Pill, Money, RangePicker, Select,
} from '../components/ui';
import { deriveBills, rangeFor, inRange, billDelivery } from '../lib/calc';
import { money, fmtDate, norm, AGING_META, r2 } from '../lib/format';
import { exportExcel, printReport, raw, escapeHTML } from '../lib/exporters';

export default function Bills() {
  const { data, settings, toast } = useApp();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('all');
  const [preset, setPreset] = useState('month');
  const [custom, setCustom] = useState({ from: '', to: '' });

  const range = useMemo(() => rangeFor(preset, custom), [preset, custom]);

  const rows = useMemo(() => {
    // Delivery read item by item, so a bill with some items sent shows as
    // partly delivered rather than simply not delivered.
    const derived = deriveBills(data.bills, data).map((b) => {
      const d = billDelivery(b, data.billItems);
      return { ...b, deliveryPill: d.state === 'partial' ? 'part-delivered' : d.state === 'pending' ? 'not-delivered' : null };
    });
    const term = norm(q);

    return derived
      .filter((b) => inRange(b.date, range.from, range.to))
      // The one dropdown covers both money and delivery. They are different
      // things, but the shopkeeper thinks of it as "show me which bills", and
      // the delivery values cannot collide with the status values.
      .filter((b) => {
        if (status === 'all') return true;
        if (status === 'not-delivered') return b.delivery === 'pending';
        if (status === 'part-delivered') return b.deliveryPill === 'part-delivered';
        if (status === 'delivered') return b.delivery === 'delivered';
        return b.status === status;
      })
      .filter((b) => {
        if (!term) return true;
        const party = data.parties.find((p) => p.id === b.partyId);
        if (norm(b.billNo).includes(term)) return true;
        if (norm(party?.name).includes(term)) return true;
        // search by item purchased
        return data.billItems
          .filter((bi) => bi.billId === b.id)
          .some((bi) => norm(data.items.find((i) => i.id === bi.itemId)?.name).includes(term));
      })
      .map((b) => ({ ...b, partyName: data.parties.find((p) => p.id === b.partyId)?.name || 'Unknown' }))
      .sort((a, b) => new Date(b.date) - new Date(a.date) || b.billNo.localeCompare(a.billNo));
  }, [data, q, status, range]);

  const totals = useMemo(() => {
    const live = rows.filter((b) => b.status !== 'voided');
    return {
      count: live.length,
      billed: r2(live.reduce((s, b) => s + b.net, 0)),
      paid: r2(live.reduce((s, b) => s + b.paid, 0)),
      due: r2(live.reduce((s, b) => s + b.due, 0)),
    };
  }, [rows]);

  const onExcel = () => {
    exportExcel('Bills',
      ['Bill No', 'Date', 'Party', 'Status', 'Total', 'Paid', 'Due', 'Due Date'],
      rows.map((b) => [b.billNo, fmtDate(b.date), b.partyName, b.status,
                       b.net.toFixed(2), b.paid.toFixed(2), b.due.toFixed(2),
                       b.due > 0 ? fmtDate(b.dueDate) : '']),
      [`${settings.shopName} — Bills`, `${totals.count} bills`, `Total ${money(totals.billed)}`]);
    toast('Bills exported');
  };

  const onPDF = () => printReport({
    title: 'Bills', subtitle: rangeText(preset, range), shopName: settings.shopName,
    headers: ['Bill No', 'Date', 'Party', 'Status',
              { label: 'Total', align: 'r' }, { label: 'Paid', align: 'r' }, { label: 'Due', align: 'r' }],
    rows: rows.map((b) => [b.billNo, fmtDate(b.date), b.partyName,
      raw(`<span class="pill pill-${escapeHTML(b.status)}">${escapeHTML(b.status)}</span>`),
      money(b.net), money(b.paid), money(b.due)]),
    totals: ['', '', '', 'Totals', money(totals.billed), money(totals.paid), money(totals.due)],
  });

  return (
    <>
      <PageHead title="All Bills" subtitle={`${totals.count} bills · ${money(totals.billed)} billed · ${money(totals.due)} outstanding`}>
        <SearchBar value={q} onChange={setQ} placeholder="Bill no, party, or item…" />
        <Select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 155 }}
                options={[
                  { value: 'all', label: 'All statuses' },
                  { value: 'due', label: 'Due' },
                  { value: 'partial', label: 'Partial' },
                  // Still owed, but a cheque is sitting with the bank.
                  { value: 'cheque-pending', label: 'Cheque Pending' },
                  { value: 'paid', label: 'Paid' },
                  { value: 'voided', label: 'Voided' },
                  { value: 'not-delivered', label: 'Not Delivered (incl. partly)' },
                  { value: 'part-delivered', label: 'Partly Delivered' },
                  { value: 'delivered', label: 'Delivered' },
                ]} />
        <Button icon={Download} onClick={onExcel}>Excel</Button>
        <Button icon={Printer} onClick={onPDF}>PDF</Button>
        <Button variant="primary" icon={Plus} onClick={() => nav('/bill/new')}>New Bill</Button>
      </PageHead>

      <div className="mb-2">
        <RangePicker value={preset} onChange={setPreset} custom={custom} onCustomChange={setCustom} />
      </div>

      <Card tight>
        {!rows.length ? (
          <Empty icon={Receipt} title="No bills found"
                 message={q ? `Nothing matches "${q}" in this period.` : 'No bills in the selected period.'}
                 action={<Button variant="primary" icon={Plus} onClick={() => nav('/bill/new')}>Create a bill</Button>} />
        ) : (
          <>
            <div className="table-wrap hide-mobile">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Bill</th><th>Date</th><th>Party</th><th>Status</th><th>Due date</th>
                    <th className="r">Total</th><th className="r">Paid</th><th className="r">Due</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((b) => (
                    <tr key={b.id}
                        className={`clickable ${b.due > 0 && b.isOverdue ? AGING_META[b.bucket].cls : ''}`}
                        onClick={() => nav(`/bill/${b.id}`)}>
                      <td style={{ fontWeight: 600 }}>{b.billNo}</td>
                      <td className="nowrap">{fmtDate(b.date)}</td>
                      <td>{b.partyName}</td>
                      <td>
                        <Pill status={b.status} />
                        {/* Only shown when undelivered: a pill on every
                            delivered bill would be noise on the common case. */}
                        {b.status !== 'voided' && b.deliveryPill && (
                          <div style={{ marginTop: 3 }}>
                            <Pill status={b.deliveryPill} />
                          </div>
                        )}
                        {b.isOverdue && b.due > 0 && (
                          <div className="small" style={{ color: 'var(--danger)', fontWeight: 600, marginTop: 2 }}>
                            {b.overdueDays}d late
                          </div>
                        )}
                      </td>
                      <td className="nowrap small">{b.due > 0 ? fmtDate(b.dueDate) : <span className="muted">—</span>}</td>
                      <td className="r strong"><Money value={b.net} /></td>
                      <td className="r"><Money value={b.paid} /></td>
                      <td className="r strong">
                        {b.due > 0 ? <span className="money neg">{money(b.due)}</span> : <span className="muted">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={5}>{totals.count} bills</td>
                    <td className="r">{money(totals.billed)}</td>
                    <td className="r">{money(totals.paid)}</td>
                    <td className="r" style={{ color: 'var(--danger)' }}>{money(totals.due)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <div className="mcards" style={{ padding: 12 }}>
              {rows.map((b) => (
                <div key={b.id}
                     className={`mcard ${b.due > 0 && b.isOverdue ? AGING_META[b.bucket].mcls : ''}`}
                     onClick={() => nav(`/bill/${b.id}`)}>
                  <div className="top">
                    <span className="name">{b.partyName}</span>
                    <span className="amt">{money(b.net)}</span>
                  </div>
                  <div className="meta">
                    <Pill status={b.status} />
                    {b.status !== 'voided' && b.deliveryPill && <Pill status={b.deliveryPill} />}
                    <span>{b.billNo}</span>
                    <span>{fmtDate(b.date)}</span>
                    {b.due > 0 && (
                      <span style={{ color: 'var(--danger)', fontWeight: 700 }}>{money(b.due)} due</span>
                    )}
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

function rangeText(preset, range) {
  if (preset === 'all') return 'All time';
  if (range.from && range.to) return `${fmtDate(range.from)} — ${fmtDate(range.to)}`;
  return preset;
}
