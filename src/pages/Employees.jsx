// Employees (FR-31 … FR-33) — salary, advances, bonuses, remaining month balance.

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, UserCog, Pencil, Download, ChevronRight, Save } from 'lucide-react';
import { useApp } from '../context/AppContext';
import api from '../lib/api';
import {
  Card, Button, Modal, Empty, PageHead, SearchBar, Money, Pill, Field, Input, Stat,
} from '../components/ui';
import { employeeMonthBalance } from '../lib/calc';
import { money, norm, fmtDate, todayISO, r2 } from '../lib/format';
import { exportExcel } from '../lib/exporters';

export default function Employees() {
  const { data, settings, toast } = useApp();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);

  const rows = useMemo(() => {
    const term = norm(q);
    return data.employees
      .filter((e) => e.status !== 'archived')
      .filter((e) => !term || norm(e.name).includes(term) || norm(e.role).includes(term))
      .map((e) => ({ ...e, ...employeeMonthBalance(e, data.employeeTx) }))
      .sort((a, b) => b.remaining - a.remaining || a.name.localeCompare(b.name));
  }, [data, q]);

  const totals = useMemo(() => ({
    payroll: r2(rows.reduce((s, e) => s + (Number(e.monthlySalary) || 0), 0)),
    paid: r2(rows.reduce((s, e) => s + e.paid, 0)),
    remaining: r2(rows.reduce((s, e) => s + e.remaining, 0)),
  }), [rows]);

  const onExcel = () => {
    exportExcel('Employees',
      ['Name', 'Role', 'Phone', 'Join Date', 'Monthly Salary', 'Paid This Month', 'Remaining'],
      rows.map((e) => [e.name, e.role, e.phone, fmtDate(e.joinDate),
                       Number(e.monthlySalary).toFixed(2), e.paid.toFixed(2), e.remaining.toFixed(2)]),
      [`${settings.shopName} — Employees`, `Monthly payroll: ${money(totals.payroll)}`]);
    toast('Employees exported');
  };

  return (
    <>
      <PageHead title="Employees"
                subtitle={`${rows.length} staff · ${money(totals.payroll)} monthly payroll`}>
        <SearchBar value={q} onChange={setQ} placeholder="Search name or role…" />
        <Button icon={Download} onClick={onExcel}>Excel</Button>
        <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Add Employee</Button>
      </PageHead>

      <div className="stat-grid">
        <Stat label="Monthly Payroll" value={money(totals.payroll)} icon={UserCog} tone="#D9390B" />
        <Stat label="Paid This Month" value={money(totals.paid)} icon={UserCog} tone="#16A34A" />
        <Stat label="Remaining To Pay" value={money(totals.remaining)} icon={UserCog} tone="#DC2626" />
      </div>

      <Card tight>
        {!rows.length ? (
          <Empty icon={UserCog} title={q ? 'No matching employees' : 'No employees yet'}
                 message={q ? `Nothing matches "${q}".` : 'Add your staff to track salaries, advances and bonuses.'}
                 action={!q ? <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Add your first employee</Button> : null} />
        ) : (
          <>
            <div className="table-wrap hide-mobile">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Name</th><th>Role</th><th>Phone</th><th>Joined</th>
                    <th className="r">Monthly salary</th><th className="r">Paid this month</th>
                    <th className="r">Remaining</th><th style={{ width: 90 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((e) => (
                    <tr key={e.id} className="clickable" onClick={() => nav(`/employee/${e.id}`)}>
                      <td style={{ fontWeight: 600 }}>{e.name}</td>
                      <td>{e.role || <span className="muted">—</span>}</td>
                      <td className="small">{e.phone || <span className="muted">—</span>}</td>
                      <td className="small nowrap">{fmtDate(e.joinDate)}</td>
                      <td className="r"><Money value={e.monthlySalary} /></td>
                      <td className="r"><Money value={e.paid} /></td>
                      <td className="r strong">
                        {e.remaining > 0
                          ? <span className="money neg">{money(e.remaining)}</span>
                          : <Pill status="paid" label="Settled" />}
                      </td>
                      <td onClick={(ev) => ev.stopPropagation()}>
                        <div className="row-actions">
                          <button className="btn btn-ghost btn-sm" title="Edit" onClick={() => setEditing(e)}>
                            <Pencil size={14} />
                          </button>
                          <button className="btn btn-ghost btn-sm" title="Open ledger"
                                  onClick={() => nav(`/employee/${e.id}`)}>
                            <ChevronRight size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={4}>{rows.length} employees</td>
                    <td className="r">{money(totals.payroll)}</td>
                    <td className="r">{money(totals.paid)}</td>
                    <td className="r" style={{ color: 'var(--danger)' }}>{money(totals.remaining)}</td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <div className="mcards" style={{ padding: 12 }}>
              {rows.map((e) => (
                <div key={e.id} className="mcard" onClick={() => nav(`/employee/${e.id}`)}>
                  <div className="top">
                    <span className="name">{e.name}</span>
                    <span className="amt" style={{ color: e.remaining > 0 ? 'var(--danger)' : 'var(--success)' }}>
                      {e.remaining > 0 ? money(e.remaining) : 'Settled'}
                    </span>
                  </div>
                  <div className="meta">
                    {e.role && <span>{e.role}</span>}
                    <span>Salary {money(e.monthlySalary)}</span>
                    <span>Paid {money(e.paid)}</span>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </Card>

      <Modal open={adding} title="Add Employee" onClose={() => setAdding(false)}>
        <EmployeeForm onSaved={() => setAdding(false)} onCancel={() => setAdding(false)} />
      </Modal>

      <Modal open={Boolean(editing)} title={`Edit ${editing?.name || 'Employee'}`} onClose={() => setEditing(null)}>
        {editing && <EmployeeForm employee={editing} onSaved={() => setEditing(null)} onCancel={() => setEditing(null)} />}
      </Modal>
    </>
  );
}

export function EmployeeForm({ employee = null, onSaved, onCancel }) {
  const { mutate } = useApp();
  const [f, setF] = useState({
    name: String(employee?.name ?? ''),
    phone: String(employee?.phone ?? ''),
    role: String(employee?.role ?? ''),
    monthlySalary: employee?.monthlySalary ?? '',
    joinDate: employee?.joinDate ?? todayISO(),
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return; // guard: block a duplicate submit while saving
    if (!f.name.trim()) return setErr('Employee name is required');
    setErr('');
    setBusy(true);
    try {
      const saved = await mutate(() => api.saveEmployee({
        id: employee?.id, name: f.name.trim(), phone: f.phone.trim(),
        role: f.role.trim(), monthlySalary: Number(f.monthlySalary) || 0, joinDate: f.joinDate,
      }), employee ? 'Employee updated' : 'Employee added');
      onSaved?.(saved);
    } catch { /* toast shown */ } finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit}>
      <div className="form-grid">
        <Field label="Full name" className="full" error={err}>
          <Input value={f.name} onChange={set('name')} autoFocus placeholder="e.g. Kashif Ali" />
        </Field>
        <Field label="Role">
          <Input value={f.role} onChange={set('role')} placeholder="e.g. Shop Assistant" />
        </Field>
        <Field label="Phone">
          <Input value={f.phone} onChange={set('phone')} placeholder="03xx-xxxxxxx" />
        </Field>
        <Field label="Monthly salary">
          <Input type="number" min="0" step="any" value={f.monthlySalary}
                 onChange={set('monthlySalary')} placeholder="0" />
        </Field>
        <Field label="Join date">
          <Input type="date" value={f.joinDate} onChange={set('joinDate')} />
        </Field>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 9 }}>
        {onCancel && <Button type="button" onClick={onCancel}>Cancel</Button>}
        <Button type="submit" variant="primary" icon={Save} loading={busy}>
          {employee ? 'Update Employee' : 'Add Employee'}
        </Button>
      </div>
    </form>
  );
}
