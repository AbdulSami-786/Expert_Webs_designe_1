// Activity Log (FR-27 / Safety Guide 2.2) — full audit trail of every edit,
// void, and reversal with timestamp and description.

import { useMemo, useState } from 'react';
import {
  ScrollText, Download, Pencil, Ban, Undo2, Plus, Settings as SettingsIcon,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import {
  Card, Button, Empty, PageHead, SearchBar, Pill, Select, RangePicker, Stat,
} from '../components/ui';
import { rangeFor, inRange } from '../lib/calc';
import { fmtDateTime, fmtDate, norm } from '../lib/format';
import { exportExcel } from '../lib/exporters';

const ACTION_META = {
  create:  { label: 'Created',  icon: Plus,   status: 'paid' },
  edit:    { label: 'Edited',   icon: Pencil, status: 'partial' },
  void:    { label: 'Voided',   icon: Ban,    status: 'due' },
  reverse: { label: 'Reversed', icon: Undo2,  status: 'due' },
};

export default function ActivityLog() {
  const { data, settings, toast } = useApp();
  const [q, setQ] = useState('');
  const [action, setAction] = useState('all');
  const [entityType, setEntityType] = useState('all');
  const [preset, setPreset] = useState('month');
  const [custom, setCustom] = useState({ from: '', to: '' });

  const range = useMemo(() => rangeFor(preset, custom), [preset, custom]);

  const entityTypes = useMemo(
    () => [...new Set(data.activityLog.map((l) => l.entityType))].sort(),
    [data.activityLog]
  );

  const rows = useMemo(() => {
    const term = norm(q);
    return data.activityLog
      .filter((l) => inRange(l.timestamp.slice(0, 10), range.from, range.to))
      .filter((l) => action === 'all' || l.action === action)
      .filter((l) => entityType === 'all' || l.entityType === entityType)
      .filter((l) => !term || norm(l.description).includes(term) || norm(l.entityType).includes(term))
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  }, [data.activityLog, q, action, entityType, range]);

  const counts = useMemo(() => ({
    edits: rows.filter((l) => l.action === 'edit').length,
    voids: rows.filter((l) => l.action === 'void').length,
    reversals: rows.filter((l) => l.action === 'reverse').length,
  }), [rows]);

  const onExcel = () => {
    exportExcel('ActivityLog',
      ['Timestamp', 'Action', 'Entity', 'Description', 'User'],
      rows.map((l) => [fmtDateTime(l.timestamp), l.action, l.entityType, l.description, l.user]),
      [`${settings.shopName} — Activity Log`, `${rows.length} entries`]);
    toast('Activity log exported');
  };

  return (
    <>
      <PageHead title="Activity Log"
                subtitle="Every edit, void and reversal is recorded here — nothing is silently changed">
        <SearchBar value={q} onChange={setQ} placeholder="Search descriptions…" />
        <Select value={action} onChange={(e) => setAction(e.target.value)} style={{ width: 130 }}
                options={[
                  { value: 'all', label: 'All actions' },
                  { value: 'create', label: 'Created' },
                  { value: 'edit', label: 'Edited' },
                  { value: 'void', label: 'Voided' },
                  { value: 'reverse', label: 'Reversed' },
                ]} />
        <Select value={entityType} onChange={(e) => setEntityType(e.target.value)} style={{ width: 130 }}>
          <option value="all">All records</option>
          {entityTypes.map((t) => <option key={t} value={t}>{t}</option>)}
        </Select>
        <Button icon={Download} onClick={onExcel}>Excel</Button>
      </PageHead>

      <div className="mb-2">
        <RangePicker value={preset} onChange={setPreset} custom={custom} onCustomChange={setCustom} />
      </div>

      <div className="stat-grid">
        <Stat label="Entries" value={rows.length} icon={ScrollText} tone="#D9390B" />
        <Stat label="Edits" value={counts.edits} icon={Pencil} tone="#F59E0B" />
        <Stat label="Voids" value={counts.voids} icon={Ban} tone="#DC2626" />
        <Stat label="Payment Reversals" value={counts.reversals} icon={Undo2} tone="#DC2626" />
      </div>

      <Card tight>
        {!rows.length ? (
          <Empty icon={ScrollText} title="No activity in this period"
                 message="Edits, voids and reversals will be recorded here as they happen." />
        ) : (
          <>
            <div className="table-wrap hide-mobile">
              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ width: 170 }}>When</th>
                    <th style={{ width: 110 }}>Action</th>
                    <th style={{ width: 110 }}>Record</th>
                    <th>Description</th>
                    <th style={{ width: 90 }}>By</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((l) => {
                    const meta = ACTION_META[l.action] || { label: l.action, icon: ScrollText, status: 'neutral' };
                    return (
                      <tr key={l.id}>
                        <td className="nowrap small">{fmtDateTime(l.timestamp)}</td>
                        <td><Pill status={meta.status} label={meta.label} /></td>
                        <td className="small muted" style={{ textTransform: 'capitalize' }}>{l.entityType}</td>
                        <td>{l.description}</td>
                        <td className="small muted">{l.user}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="mcards" style={{ padding: 12 }}>
              {rows.map((l) => {
                const meta = ACTION_META[l.action] || { label: l.action, status: 'neutral' };
                return (
                  <div key={l.id} className="mcard">
                    <div className="top">
                      <span className="name" style={{ fontSize: 14 }}>{l.description}</span>
                    </div>
                    <div className="meta">
                      <Pill status={meta.status} label={meta.label} />
                      <span style={{ textTransform: 'capitalize' }}>{l.entityType}</span>
                      <span>{fmtDateTime(l.timestamp)}</span>
                    </div>
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
