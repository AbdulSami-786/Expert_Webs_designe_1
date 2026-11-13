// Per-employee ledger (FR-32/33) — salary, advances, bonuses with an automatic
// remaining-balance calculation for the current month.

import { useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Plus, ArrowLeft, Download, UserCog, Save } from 'lucide-react';
import { useApp } from '../context/AppContext';
import api from '../lib/api';
import {
  Card, Button, Modal, Empty, PageHead, Money, Pill, Field, Input, Select, Stat,
} from '../components/ui';
import { employeeMonthBalance } from '../lib/calc';
import { money, fmtDate, todayISO, r2 } from '../lib/format';
import { exportExcel } from '../lib/exporters';

const TYPES = [
  { value: 'salary',  label: 'Salary payment' },
  { value: 'advance', label: 'Advance' },
  { value: 'bonus',   label: 'Bonus' },
];

export default function EmployeeLedger() {
  const { id } = useParams();
  const nav = useNavigate();
  const { data, settings, toast } = useApp();
  const [adding, setAdding] = useState(false);

  const emp = data.employees.find((e) => e.id === id);

  const tx = useMemo(
    () => data.employeeTx
      .filter((t) => t.employeeId === id)
      .sort((a, b) => new Date(b.date) - new Date(a.date)),
    [data.employeeTx, id]
  );

  const month = useMemo(() => (emp ? employeeMonthBalance(emp, data.employeeTx) : null), [emp, data.employeeTx]);

  const lifetime = useMemo(() => {
    const sum = (type) => r2(tx.filter((t) => t.type === type).reduce((s, t) => s + (Number(t.amount) || 0), 0));
    return { salary: sum('salary'), advance: sum('advance'), bonus: sum('bonus'),
             total: r2(tx.reduce((s, t) => s + (Number(t.amount) || 0), 0)) };
  }, [tx]);

  if (!emp) {
    return <Empty icon={UserCog} title="Employee not found"
                  action={<Button onClick={() => nav('/employees')}>Back to Employees</Button>} />;
  }

  const onExcel = () => {
    exportExcel(`Employee_${emp.name}`,
      ['Date', 'Type', 'Amount', 'Method', 'Note'],
      tx.map((t) => [fmtDate(t.date), t.type, Number(t.amount).toFixed(2), t.method || '', t.note || '']),
      [`${settings.shopName} — ${emp.name} Ledger`, emp.role || '',
       `Monthly salary: ${money(emp.monthlySalary)}`,
       `Remaining this month: ${money(month.remaining)}`]);
    toast('Ledger exported');
  };

  return (
    <>
      <PageHead title={emp.name}
                subtitle={[emp.role, emp.phone, `Joined ${fmtDate(emp.joinDate)}`].filter(Boolean).join(' · ')}>
        <Button icon={ArrowLeft} onClick={() => nav('/employees')}>Back</Button>
        <Button icon={Download} onClick={onExcel}>Excel</Button>
        <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Add Entry</Button>
      </PageHead>

      <div className="stat-grid">
        <Stat label="Monthly Salary" value={money(emp.monthlySalary)} icon={UserCog} tone="#D9390B" />
        <Stat label="Paid This Month" value={money(month.paid)} icon={UserCog} tone="#16A34A" />
        <Stat label="Remaining This Month" value={money(month.remaining)} icon={UserCog} tone="#DC2626" />
        <Stat label="Paid All Time" value={money(lifetime.total)} icon={UserCog} tone="#6B7280" />
      </div>

      <Card title="Transaction History" tight
            subtitle={`${tx.length} entries · Salary ${money(lifetime.salary)} · Advances ${money(lifetime.advance)} · Bonuses ${money(lifetime.bonus)}`}>
        {!tx.length ? (
          <Empty icon={UserCog} title="No entries yet"
                 message={`Record ${emp.name}'s first salary payment, advance or bonus.`}
                 action={<Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Add entry</Button>} />
        ) : (
          <>
            <div className="table-wrap hide-mobile">
              <table className="tbl">
                <thead>
                  <tr><th>Date</th><th>Type</th><th>Method</th><th>Note</th><th className="r">Amount</th></tr>
                </thead>
                <tbody>
                  {tx.map((t) => (
                    <tr key={t.id}>
                      <td className="nowrap">{fmtDate(t.date)}</td>
                      <td>
                        <Pill status={t.type === 'salary' ? 'paid' : t.type === 'bonus' ? 'cleared' : 'partial'}
                              label={t.type === 'salary' ? 'Salary' : t.type === 'bonus' ? 'Bonus' : 'Advance'} />
                      </td>
                      <td>{t.method || 'Cash'}</td>
                      <td className="small muted">{t.note || '—'}</td>
                      <td className="r strong"><Money value={t.amount} /></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={4}>Total paid all time</td>
                    <td className="r">{money(lifetime.total)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <div className="mcards" style={{ padding: 12 }}>
              {tx.map((t) => (
                <div key={t.id} className="mcard">
                  <div className="top">
                    <span className="name">
                      {t.type === 'salary' ? 'Salary' : t.type === 'bonus' ? 'Bonus' : 'Advance'}
                    </span>
                    <span className="amt">{money(t.amount)}</span>
                  </div>
                  <div className="meta">
                    <span>{fmtDate(t.date)}</span>
                    <span>{t.method || 'Cash'}</span>
                    {t.note && <span>{t.note}</span>}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </Card>

      <TxModal open={adding} onClose={() => setAdding(false)} employee={emp} month={month} />
    </>
  );
}

function TxModal({ open, onClose, employee, month }) {
  const { methods, mutate } = useApp();
  const [f, setF] = useState({
    type: 'salary', amount: '', date: todayISO(), method: 'Cash', note: '',
  });
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));

  const submit = async () => {
    if (busy) return; // guard: block a duplicate submit while saving
    if (!(Number(f.amount) > 0)) return;
    setBusy(true);
    try {
      await mutate(() => api.addEmployeeTx({
        employeeId: employee.id, type: f.type, amount: Number(f.amount),
        date: f.date, method: f.method, note: f.note,
      }), 'Entry recorded');
      setF({ type: 'salary', amount: '', date: todayISO(), method: 'Cash', note: '' });
      onClose();
    } catch { /* toast shown */ } finally { setBusy(false); }
  };

  return (
    <Modal open={open} title={`Add Entry — ${employee.name}`} onClose={onClose}
           footer={
             <>
               <Button onClick={onClose}>Cancel</Button>
               <Button variant="primary" icon={Save} onClick={submit} loading={busy}
                       disabled={!(Number(f.amount) > 0)}>
                 Record Entry
               </Button>
             </>
           }>
      <div className="form-grid">
        <Field label="Type">
          <Select value={f.type} onChange={set('type')} options={TYPES} />
        </Field>
        <Field label="Amount"
               hint={f.type === 'salary' ? `${money(month.remaining)} remaining this month` : undefined}>
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
          <Input value={f.note} onChange={set('note')} placeholder="Optional" />
        </Field>
      </div>

      {f.type === 'salary' && Number(f.amount) > month.remaining && month.remaining > 0 && (
        <div style={{
          padding: '10px 12px', background: 'var(--warning-bg)', border: '1px solid #FDE68A',
          borderRadius: 'var(--r-sm)', fontSize: 12.5, color: '#B45309',
        }}>
          This is more than the {money(month.remaining)} still owed for this month.
        </div>
      )}
    </Modal>
  );
}
