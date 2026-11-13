// Returns log (Plan 3.2) — every return recorded against its original bill.

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { RotateCcw, Plus, Download, Search } from 'lucide-react';
import { useApp } from '../context/AppContext';
import {
  Card, Button, Empty, PageHead, SearchBar, Money, Pill, Modal, Field, Select, Stat,
} from '../components/ui';
import ReturnModal from '../components/forms/ReturnModal';
import { deriveBills } from '../lib/calc';
import { money, fmtDate, norm, r2 } from '../lib/format';
import { exportExcel } from '../lib/exporters';

export default function Returns() {
  const { data, settings, toast } = useApp();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [pickOpen, setPickOpen] = useState(false);
  const [pickedBill, setPickedBill] = useState(null);

  const rows = useMemo(() => {
    const term = norm(q);
    return data.returns
      .map((r) => {
        const bill = data.bills.find((b) => b.id === r.billId);
        const party = bill ? data.parties.find((p) => p.id === bill.partyId) : null;
        const item = data.items.find((i) => i.id === r.itemId);
        return { ...r, bill, party, itemName: item?.name || 'Item', unit: item?.baseUnit || '' };
      })
      .filter((r) => !term
        || norm(r.party?.name).includes(term)
        || norm(r.itemName).includes(term)
        || norm(r.bill?.billNo).includes(term))
      .sort((a, b) => new Date(b.date) - new Date(a.date));
  }, [data, q]);

  const totals = useMemo(() => ({
    count: rows.length,
    value: r2(rows.reduce((s, r) => s + (Number(r.valueAdjusted) || 0), 0)),
    restocked: rows.filter((r) => r.restock).length,
  }), [rows]);

  const onExcel = () => {
    exportExcel('Returns',
      ['Date', 'Bill No', 'Party', 'Item', 'Qty', 'Restocked', 'Value', 'Note'],
      rows.map((r) => [fmtDate(r.date), r.bill?.billNo || '', r.party?.name || '',
                       r.itemName, r.qty, r.restock ? 'Yes' : 'No',
                       Number(r.valueAdjusted).toFixed(2), r.note || '']),
      [`${settings.shopName} — Returns`, `Total value: ${money(totals.value)}`]);
    toast('Returns exported');
  };

  return (
    <>
      <PageHead title="Returns" subtitle={`${totals.count} returns · ${money(totals.value)} adjusted`}>
        <SearchBar value={q} onChange={setQ} placeholder="Party, item, or bill no…" />
        <Button icon={Download} onClick={onExcel}>Excel</Button>
        <Button variant="primary" icon={Plus} onClick={() => setPickOpen(true)}>Add Return</Button>
      </PageHead>

      <div className="stat-grid">
        <Stat label="Total Returns" value={totals.count} icon={RotateCcw} tone="#F59E0B" />
        <Stat label="Value Adjusted" value={money(totals.value)} icon={RotateCcw} tone="#DC2626" />
        <Stat label="Restocked" value={`${totals.restocked} of ${totals.count}`} icon={RotateCcw} tone="#16A34A" />
      </div>

      <Card tight>
        {!rows.length ? (
          <Empty icon={RotateCcw} title={q ? 'No matching returns' : 'No returns yet'}
                 message={q ? `Nothing matches "${q}".` : 'Returns recorded against a bill will appear here.'}
                 action={!q ? <Button variant="primary" icon={Plus} onClick={() => setPickOpen(true)}>Record a return</Button> : null} />
        ) : (
          <>
            <div className="table-wrap hide-mobile">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Date</th><th>Bill</th><th>Party</th><th>Item</th>
                    <th className="r">Qty</th><th>Restocked</th><th>Note</th>
                    <th className="r">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="clickable" onClick={() => r.bill && nav(`/bill/${r.bill.id}`)}>
                      <td className="nowrap">{fmtDate(r.date)}</td>
                      <td style={{ fontWeight: 600 }}>{r.bill?.billNo || '—'}</td>
                      <td>{r.party?.name || '—'}</td>
                      <td>{r.itemName}</td>
                      <td className="r">{r.qty} {r.unit}</td>
                      <td>{r.restock ? <Pill status="paid" label="Yes" /> : <Pill status="voided" label="No" />}</td>
                      <td className="small muted">{r.note || '—'}</td>
                      <td className="r strong"><Money value={r.valueAdjusted} /></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={7}>{totals.count} returns</td>
                    <td className="r">{money(totals.value)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <div className="mcards" style={{ padding: 12 }}>
              {rows.map((r) => (
                <div key={r.id} className="mcard" onClick={() => r.bill && nav(`/bill/${r.bill.id}`)}>
                  <div className="top">
                    <span className="name">{r.itemName}</span>
                    <span className="amt">{money(r.valueAdjusted)}</span>
                  </div>
                  <div className="meta">
                    <span>{r.party?.name}</span>
                    <span>{r.bill?.billNo}</span>
                    <span>{r.qty} {r.unit}</span>
                    <span>{fmtDate(r.date)}</span>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </Card>

      <BillPicker open={pickOpen} onClose={() => setPickOpen(false)}
                  onPick={(b) => { setPickOpen(false); setPickedBill(b); }} />

      <ReturnModal open={Boolean(pickedBill)} onClose={() => setPickedBill(null)}
                   bill={pickedBill}
                   party={pickedBill ? data.parties.find((p) => p.id === pickedBill.partyId) : null} />
    </>
  );
}

/** Choose which bill the return is against. */
function BillPicker({ open, onClose, onPick }) {
  const { data } = useApp();
  const [q, setQ] = useState('');

  const bills = useMemo(() => {
    const derived = deriveBills(data.bills, data).filter((b) => b.status !== 'voided');
    const term = norm(q);
    return derived
      .map((b) => ({ ...b, partyName: data.parties.find((p) => p.id === b.partyId)?.name || '' }))
      .filter((b) => !term || norm(b.billNo).includes(term) || norm(b.partyName).includes(term))
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 40);
  }, [data, q]);

  return (
    <Modal open={open} title="Which bill is the return against?" onClose={onClose}>
      <SearchBar value={q} onChange={setQ} placeholder="Search bill number or party…" style={{ marginBottom: 12 }} />
      {bills.length ? (
        <div style={{ maxHeight: 400, overflowY: 'auto' }}>
          {bills.map((b) => (
            <div key={b.id} className="typeahead-opt" onClick={() => onPick(b)}
                 style={{ borderBottom: '1px solid #F1F3F5', borderRadius: 0 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{b.billNo} — {b.partyName}</div>
                <div className="sub">{fmtDate(b.date)} · {money(b.net)}</div>
              </div>
              <div className="spacer" />
              <Pill status={b.status} />
            </div>
          ))}
        </div>
      ) : (
        <Empty icon={Search} title="No bills found" message={`Nothing matches "${q}".`} />
      )}
    </Modal>
  );
}
