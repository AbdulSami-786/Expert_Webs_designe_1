// Outstanding & Aging (FR-22 … FR-24 / Plan 4.4).
//
// Every party with a non-zero due balance, grouped into aging buckets with
// visible subtotals and distinct colour coding. Filter by days overdue or
// amount range; search by party.

import { useMemo, useState, Fragment } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertCircle, CheckCircle2, Download, Printer, Send, ChevronDown, ChevronRight,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import {
  Card, Button, Empty, PageHead, SearchBar, Pill, Money, Field, Input, Stat,
} from '../components/ui';
import { deriveBills } from '../lib/calc';
import {
  money, fmtDate, norm, AGING_BUCKETS, AGING_META, waLink, r2,
} from '../lib/format';
import { exportExcel, printReport } from '../lib/exporters';

export default function Outstanding() {
  const { data, settings, toast } = useApp();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [minDays, setMinDays] = useState('');
  const [minAmount, setMinAmount] = useState('');
  const [expanded, setExpanded] = useState({});

  /* Group every due bill by party, then by aging bucket */
  const { groups, totals, partyRows } = useMemo(() => {
    const derived = deriveBills(data.bills, data);
    const term = norm(q);

    const dueBills = derived.filter((b) => b.status !== 'voided' && b.due > 0);

    // One row per party with a due balance
    const byParty = new Map();
    dueBills.forEach((b) => {
      const party = data.parties.find((p) => p.id === b.partyId);
      if (!party) return;
      if (term && !norm(party.name).includes(term) && !norm(party.phone).includes(term)) return;

      if (!byParty.has(party.id)) {
        byParty.set(party.id, {
          party, due: 0, bills: [], oldestDays: 0,
          buckets: { '0-7': 0, '8-30': 0, '30+': 0 },
        });
      }
      const g = byParty.get(party.id);
      g.due = r2(g.due + b.due);
      g.bills.push(b);
      g.buckets[b.bucket] = r2(g.buckets[b.bucket] + b.due);
      g.oldestDays = Math.max(g.oldestDays, Math.max(0, b.overdueDays));
    });

    let rows = [...byParty.values()];

    // Filters (FR: due more than X days / amount range)
    if (minDays !== '') rows = rows.filter((r) => r.oldestDays >= Number(minDays));
    if (minAmount !== '') rows = rows.filter((r) => r.due >= Number(minAmount));

    rows.sort((a, b) => b.due - a.due);

    // Bucket subtotals across everything shown
    const bucketTotals = { '0-7': 0, '8-30': 0, '30+': 0 };
    rows.forEach((r) => AGING_BUCKETS.forEach((k) => {
      bucketTotals[k] = r2(bucketTotals[k] + r.buckets[k]);
    }));

    return {
      groups: bucketTotals,
      partyRows: rows,
      totals: {
        due: r2(rows.reduce((s, r) => s + r.due, 0)),
        parties: rows.length,
        bills: rows.reduce((s, r) => s + r.bills.length, 0),
      },
    };
  }, [data, q, minDays, minAmount]);

  const toggle = (id) => setExpanded((e) => ({ ...e, [id]: !e[id] }));

  const onExcel = () => {
    const rows = [];
    partyRows.forEach((r) => {
      r.bills
        .sort((a, b) => b.overdueDays - a.overdueDays)
        .forEach((b) => rows.push([
          r.party.name, r.party.phone || '', b.billNo, fmtDate(b.date),
          fmtDate(b.dueDate), Math.max(0, b.overdueDays),
          AGING_META[b.bucket].label, b.due.toFixed(2),
        ]));
    });
    exportExcel('Outstanding',
      ['Party', 'Phone', 'Bill No', 'Bill Date', 'Due Date', 'Days Overdue', 'Bucket', 'Amount Due'],
      rows,
      [`${settings.shopName} — Outstanding Report`,
       `Total outstanding: ${money(totals.due)}`,
       `0–7 days: ${money(groups['0-7'])} · 8–30 days: ${money(groups['8-30'])} · 30+ days: ${money(groups['30+'])}`]);
    toast('Outstanding report exported');
  };

  const onPDF = () => printReport({
    title: 'Outstanding Report',
    subtitle: `${totals.parties} parties · ${totals.bills} bills`,
    shopName: settings.shopName,
    headers: ['Party', 'Phone', { label: '0–7 days', align: 'r' },
              { label: '8–30 days', align: 'r' }, { label: '30+ days', align: 'r' },
              { label: 'Total Due', align: 'r' }],
    rows: partyRows.map((r) => [
      r.party.name, r.party.phone || '—',
      r.buckets['0-7'] ? money(r.buckets['0-7']) : '—',
      r.buckets['8-30'] ? money(r.buckets['8-30']) : '—',
      r.buckets['30+'] ? money(r.buckets['30+']) : '—',
      money(r.due),
    ]),
    totals: ['Totals', '', money(groups['0-7']), money(groups['8-30']), money(groups['30+']), money(totals.due)],
  });

  return (
    <>
      <PageHead title="Outstanding"
                subtitle={`${totals.parties} ${totals.parties === 1 ? 'party owes' : 'parties owe'} ${money(totals.due)} across ${totals.bills} bills`}>
        <SearchBar value={q} onChange={setQ} placeholder="Search party…" />
        <Button icon={Download} onClick={onExcel}>Excel</Button>
        <Button icon={Printer} onClick={onPDF}>PDF</Button>
      </PageHead>

      {/* Aging bucket subtotals */}
      <div className="stat-grid">
        {AGING_BUCKETS.map((k) => (
          <Stat key={k} label={AGING_META[k].label} value={money(groups[k])}
                icon={AlertCircle} tone={AGING_META[k].color} />
        ))}
        <Stat label="Total Outstanding" value={money(totals.due)} icon={AlertCircle} tone="#111318" />
      </div>

      {/* Filters */}
      <Card className="mb-2">
        <div className="row wrap" style={{ gap: 14, alignItems: 'flex-end' }}>
          <Field label="Overdue more than (days)" className="mb-0" style={{ width: 180 }}>
            <Input type="number" min="0" value={minDays} placeholder="Any"
                   onChange={(e) => setMinDays(e.target.value)} style={{ width: 160 }} />
          </Field>
          <Field label="Amount at least" className="mb-0">
            <Input type="number" min="0" value={minAmount} placeholder="Any"
                   onChange={(e) => setMinAmount(e.target.value)} style={{ width: 160 }} />
          </Field>
          {(minDays !== '' || minAmount !== '' || q) && (
            <Button onClick={() => { setMinDays(''); setMinAmount(''); setQ(''); }}>
              Clear filters
            </Button>
          )}
        </div>
      </Card>

      <Card tight>
        {!partyRows.length ? (
          <Empty icon={CheckCircle2} title="Nothing outstanding"
                 message={q || minDays || minAmount
                   ? 'No party matches these filters.'
                   : 'Every party has cleared their balance. Well collected.'} />
        ) : (
          <>
            {/* Desktop: expandable party rows */}
            <div className="table-wrap hide-mobile">
              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ width: 30 }}></th>
                    <th>Party</th>
                    <th>Phone</th>
                    <th className="r">Oldest</th>
                    <th className="r">0–7 days</th>
                    <th className="r">8–30 days</th>
                    <th className="r">30+ days</th>
                    <th className="r">Total due</th>
                    <th style={{ width: 90 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {partyRows.map((r) => (
                    <Fragment key={r.party.id}>
                      <tr className="clickable" onClick={() => toggle(r.party.id)}>
                        <td>{expanded[r.party.id] ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</td>
                        <td style={{ fontWeight: 600 }}>{r.party.name}</td>
                        <td className="small">{r.party.phone || <span className="muted">—</span>}</td>
                        <td className="r">
                          {r.oldestDays > 0
                            ? <span style={{ color: AGING_META[r.oldestDays <= 7 ? '0-7' : r.oldestDays <= 30 ? '8-30' : '30+'].color, fontWeight: 600 }}>
                                {r.oldestDays}d
                              </span>
                            : <span className="muted">—</span>}
                        </td>
                        {AGING_BUCKETS.map((k) => (
                          <td key={k} className="r">
                            {r.buckets[k] > 0
                              ? <span className="num" style={{ color: AGING_META[k].color, fontWeight: 600 }}>
                                  {money(r.buckets[k])}
                                </span>
                              : <span className="muted">—</span>}
                          </td>
                        ))}
                        <td className="r strong"><span className="money neg">{money(r.due)}</span></td>
                        <td onClick={(e) => e.stopPropagation()}>
                          <div className="row-actions">
                            {r.party.phone && (
                              <a className="btn btn-ghost btn-sm" title="Send reminder"
                                 href={waLink(r.party.phone, reminderText(settings.shopName, r))}
                                 target="_blank" rel="noreferrer">
                                <Send size={14} />
                              </a>
                            )}
                            <button className="btn btn-ghost btn-sm" title="Open ledger"
                                    onClick={() => nav(`/party/${r.party.id}`)}>
                              <ChevronRight size={14} />
                            </button>
                          </div>
                        </td>
                      </tr>

                      {/* Bill-level detail */}
                      {expanded[r.party.id] && r.bills
                        .sort((a, b) => b.overdueDays - a.overdueDays)
                        .map((b) => (
                          <tr key={b.id} className={`clickable ${AGING_META[b.bucket].cls}`}
                              onClick={() => nav(`/bill/${b.id}`)}>
                            <td></td>
                            <td colSpan={2} style={{ paddingLeft: 30 }}>
                              <span style={{ fontWeight: 500 }}>{b.billNo}</span>
                              <span className="small muted"> · {fmtDate(b.date)}</span>
                            </td>
                            <td className="r small">
                              {b.overdueDays > 0 ? `${b.overdueDays}d late` : 'Not due'}
                            </td>
                            <td colSpan={3} className="small muted">
                              Due {fmtDate(b.dueDate)} · <Pill status={b.status} />
                            </td>
                            <td className="r"><Money value={b.due} /></td>
                            <td></td>
                          </tr>
                        ))}
                    </Fragment>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={4}>{totals.parties} parties</td>
                    {AGING_BUCKETS.map((k) => (
                      <td key={k} className="r" style={{ color: AGING_META[k].color }}>
                        {money(groups[k])}
                      </td>
                    ))}
                    <td className="r" style={{ color: 'var(--danger)' }}>{money(totals.due)}</td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* Mobile cards */}
            <div className="mcards" style={{ padding: 12 }}>
              {partyRows.map((r) => {
                const worst = r.buckets['30+'] > 0 ? '30+' : r.buckets['8-30'] > 0 ? '8-30' : '0-7';
                return (
                  <div key={r.party.id} className={`mcard ${AGING_META[worst].mcls}`}
                       onClick={() => nav(`/party/${r.party.id}`)}>
                    <div className="top">
                      <span className="name">{r.party.name}</span>
                      <span className="amt" style={{ color: 'var(--danger)' }}>{money(r.due)}</span>
                    </div>
                    <div className="meta">
                      <Pill status={worst === '30+' ? 'overdue' : 'partial'} label={AGING_META[worst].label} />
                      <span>{r.bills.length} bill{r.bills.length === 1 ? '' : 's'}</span>
                      {r.oldestDays > 0 && <span>{r.oldestDays}d oldest</span>}
                    </div>
                    {r.party.phone && (
                      <a className="btn btn-sm" onClick={(e) => e.stopPropagation()}
                         href={waLink(r.party.phone, reminderText(settings.shopName, r))}
                         target="_blank" rel="noreferrer">
                        <Send size={13} /> Send reminder
                      </a>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </Card>
    </>
  );
}

function reminderText(shopName, r) {
  return `Assalam-o-Alaikum ${r.party.name}, ${shopName} se. Aap ka total ${money(r.due)} ` +
         `outstanding hai (${r.bills.length} bill). Meherbani karke payment clear karwa dein. Shukriya.`;
}
