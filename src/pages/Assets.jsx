// Assets (FR-35) — business assets and their value, feeding the Balance Sheet.

import { useMemo, useState } from 'react';
import { Plus, Building2, Download, Save } from 'lucide-react';
import { useApp } from '../context/AppContext';
import api from '../lib/api';
import {
  Card, Button, Modal, Empty, PageHead, SearchBar, Money, Field, Input, Stat, Textarea,
} from '../components/ui';
import { money, fmtDate, norm, todayISO, r2 } from '../lib/format';
import { exportExcel } from '../lib/exporters';

export default function Assets() {
  const { data, settings, toast } = useApp();
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);

  const rows = useMemo(() => {
    const term = norm(q);
    return data.assets
      .filter((a) => !term || norm(a.name).includes(term) || norm(a.note).includes(term))
      .sort((a, b) => Number(b.value) - Number(a.value));
  }, [data.assets, q]);

  const total = useMemo(() => r2(rows.reduce((s, a) => s + (Number(a.value) || 0), 0)), [rows]);

  const onExcel = () => {
    exportExcel('Assets',
      ['Asset', 'Value', 'Date Acquired', 'Note'],
      rows.map((a) => [a.name, Number(a.value).toFixed(2), fmtDate(a.date), a.note || '']),
      [`${settings.shopName} — Assets`, `Total asset value: ${money(total)}`]);
    toast('Assets exported');
  };

  return (
    <>
      <PageHead title="Assets" subtitle={`${rows.length} assets worth ${money(total)}`}>
        <SearchBar value={q} onChange={setQ} placeholder="Search assets…" />
        <Button icon={Download} onClick={onExcel}>Excel</Button>
        <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Add Asset</Button>
      </PageHead>

      <div className="stat-grid">
        <Stat label="Total Asset Value" value={money(total)} icon={Building2} tone="#D9390B" />
        <Stat label="Assets Recorded" value={rows.length} icon={Building2} tone="#16A34A" />
      </div>

      <Card tight>
        {!rows.length ? (
          <Empty icon={Building2} title={q ? 'No matching assets' : 'No assets recorded'}
                 message={q ? `Nothing matches "${q}".` : 'Record vehicles, equipment, fixtures and other business assets. They appear on the Balance Sheet.'}
                 action={!q ? <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Add your first asset</Button> : null} />
        ) : (
          <>
            <div className="table-wrap hide-mobile">
              <table className="tbl">
                <thead>
                  <tr><th>Asset</th><th>Date acquired</th><th>Note</th><th className="r">Value</th></tr>
                </thead>
                <tbody>
                  {rows.map((a) => (
                    <tr key={a.id}>
                      <td style={{ fontWeight: 600 }}>{a.name}</td>
                      <td className="nowrap">{fmtDate(a.date)}</td>
                      <td className="small muted">{a.note || '—'}</td>
                      <td className="r strong"><Money value={a.value} /></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={3}>{rows.length} assets</td>
                    <td className="r">{money(total)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <div className="mcards" style={{ padding: 12 }}>
              {rows.map((a) => (
                <div key={a.id} className="mcard">
                  <div className="top">
                    <span className="name">{a.name}</span>
                    <span className="amt">{money(a.value)}</span>
                  </div>
                  <div className="meta">
                    <span>Acquired {fmtDate(a.date)}</span>
                    {a.note && <span>{a.note}</span>}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </Card>

      <AssetModal open={adding} onClose={() => setAdding(false)} />
    </>
  );
}

function AssetModal({ open, onClose }) {
  const { mutate } = useApp();
  const [f, setF] = useState({ name: '', value: '', date: todayISO(), note: '' });
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));

  const submit = async () => {
    if (busy) return; // guard: block a duplicate submit while saving
    if (!f.name.trim() || !(Number(f.value) > 0)) return;
    setBusy(true);
    try {
      await mutate(() => api.saveAsset({
        name: f.name.trim(), value: Number(f.value), date: f.date, note: f.note,
      }), 'Asset added');
      setF({ name: '', value: '', date: todayISO(), note: '' });
      onClose();
    } catch { /* toast shown */ } finally { setBusy(false); }
  };

  return (
    <Modal open={open} title="Add Asset" onClose={onClose}
           footer={
             <>
               <Button onClick={onClose}>Cancel</Button>
               <Button variant="primary" icon={Save} onClick={submit} loading={busy}
                       disabled={!f.name.trim() || !(Number(f.value) > 0)}>Add Asset</Button>
             </>
           }>
      <Field label="Asset name">
        <Input value={f.name} onChange={set('name')} autoFocus
               placeholder="e.g. Delivery Van (Suzuki Bolan)" />
      </Field>
      <div className="form-grid">
        <Field label="Value">
          <Input type="number" min="0" step="any" value={f.value} onChange={set('value')} placeholder="0" />
        </Field>
        <Field label="Date acquired">
          <Input type="date" value={f.date} onChange={set('date')} />
        </Field>
      </div>
      <Field label="Note">
        <Textarea value={f.note} onChange={set('note')} rows={2} placeholder="Optional details" />
      </Field>
    </Modal>
  );
}
