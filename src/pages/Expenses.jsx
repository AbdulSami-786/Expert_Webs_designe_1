// Expenses (FR-34) — general business expenses, plus linked Stock Loss entries
// that arrive automatically from the Damaged Stock page (FR-36).

import { useMemo, useState } from 'react';
import { Plus, Wallet, Download, Link2, Save } from 'lucide-react';
import { useApp } from '../context/AppContext';
import api from '../lib/api';
import {
  Card, Button, Modal, Empty, PageHead, SearchBar, Money, Pill, Field, Input,
  Select, Stat, RangePicker, Textarea,
} from '../components/ui';
import { rangeFor, inRange } from '../lib/calc';
import { money, fmtDate, norm, todayISO, r2 } from '../lib/format';
import { exportExcel, printReport } from '../lib/exporters';
import { EXPENSE_CATEGORIES } from '../lib/config';

export default function Expenses() {
  const { data, settings, toast } = useApp();
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('all');
  const [preset, setPreset] = useState('month');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [adding, setAdding] = useState(false);

  const range = useMemo(() => rangeFor(preset, custom), [preset, custom]);

  const categories = useMemo(
    () => [...new Set([...EXPENSE_CATEGORIES, ...data.expenses.map((e) => e.category)])].filter(Boolean).sort(),
    [data.expenses]
  );

  const rows = useMemo(() => {
    const term = norm(q);
    return data.expenses
      .filter((e) => inRange(e.date, range.from, range.to))
      .filter((e) => category === 'all' || e.category === category)
      .filter((e) => !term || norm(e.category).includes(term) || norm(e.note).includes(term))
      .sort((a, b) => new Date(b.date) - new Date(a.date));
  }, [data.expenses, q, category, range]);

  const total = useMemo(() => r2(rows.reduce((s, e) => s + (Number(e.amount) || 0), 0)), [rows]);

  const byCategory = useMemo(() => {
    const m = new Map();
    rows.forEach((e) => m.set(e.category, r2((m.get(e.category) || 0) + (Number(e.amount) || 0))));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  const onExcel = () => {
    exportExcel('Expenses',
      ['Date', 'Category', 'Amount', 'Paid from', 'Note'],
      rows.map((e) => [fmtDate(e.date), e.category, Number(e.amount).toFixed(2), e.method || '', e.note || '']),
      [`${settings.shopName} — Expenses`, `Total: ${money(total)}`]);
    toast('Expenses exported');
  };

  const onPDF = () => printReport({
    title: 'Expenses', subtitle: `${rows.length} entries`, shopName: settings.shopName,
    headers: ['Date', 'Category', 'Paid from', 'Note', { label: 'Amount', align: 'r' }],
    rows: rows.map((e) => [fmtDate(e.date), e.category, e.method || '—', e.note || '—', money(e.amount)]),
    totals: ['', '', '', 'Total', money(total)],
  });

  return (
    <>
      <PageHead title="Expenses" subtitle={`${rows.length} entries · ${money(total)} in the selected period`}>
        <SearchBar value={q} onChange={setQ} placeholder="Search category or note…" />
        <Select value={category} onChange={(e) => setCategory(e.target.value)} style={{ width: 150 }}>
          <option value="all">All categories</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </Select>
        <Button icon={Download} onClick={onExcel}>Excel</Button>
        <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Add Expense</Button>
      </PageHead>

      <div className="mb-2">
        <RangePicker value={preset} onChange={setPreset} custom={custom} onCustomChange={setCustom} />
      </div>

      <div className="grid-2" style={{ gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr)', alignItems: 'start' }}>
        <Card tight>
          {!rows.length ? (
            <Empty icon={Wallet} title="No expenses recorded"
                   message={q || category !== 'all' ? 'Try a different filter or period.' : 'Log rent, utilities, transport and other running costs here.'}
                   action={<Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Add expense</Button>} />
          ) : (
            <>
              <div className="table-wrap hide-mobile">
                <table className="tbl">
                  <thead>
                    <tr><th>Date</th><th>Category</th><th>Paid from</th><th>Note</th><th className="r">Amount</th></tr>
                  </thead>
                  <tbody>
                    {rows.map((e) => (
                      <tr key={e.id}>
                        <td className="nowrap">{fmtDate(e.date)}</td>
                        <td>
                          {e.category}
                          {e.linkedStockLossId && (
                            <Pill status="pending" label="From stock loss" className="mt-0" />
                          )}
                        </td>
                        <td>{e.method || <span className="muted">—</span>}</td>
                        <td className="small muted">{e.note || '—'}</td>
                        <td className="r strong"><Money value={e.amount} /></td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={4}>{rows.length} entries</td>
                      <td className="r">{money(total)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              <div className="mcards" style={{ padding: 12 }}>
                {rows.map((e) => (
                  <div key={e.id} className="mcard">
                    <div className="top">
                      <span className="name">{e.category}</span>
                      <span className="amt">{money(e.amount)}</span>
                    </div>
                    <div className="meta">
                      <span>{fmtDate(e.date)}</span>
                      {e.method && <span>{e.method}</span>}
                      {e.note && <span>{e.note}</span>}
                      {e.linkedStockLossId && <Pill status="pending" label="Stock loss" />}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </Card>

        <Card title="By Category" tight>
          {byCategory.length ? (
            <table className="tbl">
              <tbody>
                {byCategory.map(([cat, amt]) => (
                  <tr key={cat}>
                    <td>{cat}</td>
                    <td style={{ width: '45%' }}>
                      <div style={{ height: 6, background: 'var(--neutral-bg)', borderRadius: 999 }}>
                        <div style={{
                          height: '100%', width: `${total > 0 ? (amt / total) * 100 : 0}%`,
                          background: 'var(--accent)', borderRadius: 999,
                        }} />
                      </div>
                    </td>
                    <td className="r strong"><Money value={amt} /></td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr><td colSpan={2}>Total</td><td className="r">{money(total)}</td></tr>
              </tfoot>
            </table>
          ) : (
            <Empty title="Nothing to summarise" message="Add an expense to see the breakdown." />
          )}
        </Card>
      </div>

      <ExpenseModal open={adding} onClose={() => setAdding(false)} categories={categories} />
    </>
  );
}

function ExpenseModal({ open, onClose, categories }) {
  const { methods, mutate } = useApp();
  const [f, setF] = useState({
    category: 'Rent', amount: '', date: todayISO(), method: 'Cash', note: '',
  });
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));

  const submit = async () => {
    if (busy) return; // guard: block a duplicate submit while saving
    if (!(Number(f.amount) > 0)) return;
    setBusy(true);
    try {
      await mutate(() => api.saveExpense({
        category: f.category, amount: Number(f.amount), date: f.date,
        method: f.method, note: f.note,
      }), 'Expense recorded');
      setF({ category: 'Rent', amount: '', date: todayISO(), method: 'Cash', note: '' });
      onClose();
    } catch { /* toast shown */ } finally { setBusy(false); }
  };

  return (
    <Modal open={open} title="Add Expense" onClose={onClose}
           footer={
             <>
               <Button onClick={onClose}>Cancel</Button>
               <Button variant="primary" icon={Save} onClick={submit} loading={busy}
                       disabled={!(Number(f.amount) > 0)}>Record Expense</Button>
             </>
           }>
      <div className="form-grid">
        <Field label="Category">
          <Select value={f.category} onChange={set('category')}
                  options={categories.filter((c) => c !== 'Stock Loss')} />
        </Field>
        <Field label="Amount">
          <Input type="number" min="0" step="any" value={f.amount} onChange={set('amount')}
                 autoFocus placeholder="0" />
        </Field>
        <Field label="Date">
          <Input type="date" value={f.date} onChange={set('date')} />
        </Field>
        <Field label="Paid from">
          <Select value={f.method} onChange={set('method')}
                  options={methods.filter((m) => m !== 'Cheque')} />
        </Field>
        <Field label="Note" className="full">
          <Textarea value={f.note} onChange={set('note')} rows={2}
                    placeholder="What was this for?" />
        </Field>
      </div>
      <div className="small muted" style={{ display: 'flex', gap: 6 }}>
        <Link2 size={13} style={{ flex: 'none', marginTop: 2 }} />
        Stock Loss expenses are created automatically from the Damaged Stock page — no need to enter them twice.
      </div>
    </Modal>
  );
}
