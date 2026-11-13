// Items (FR-2 / Plan 3.3) — units, conversion, cost price, stock, low-stock alerts.

import { useMemo, useState } from 'react';
import { Plus, Package, Pencil, Archive, ArchiveRestore, AlertTriangle, Download } from 'lucide-react';
import { useApp } from '../context/AppContext';
import api from '../lib/api';
import {
  Card, Button, Modal, Empty, PageHead, SearchBar, Money, Pill, Confirm, Select,
} from '../components/ui';
import ItemForm from '../components/forms/ItemForm';
import { itemStock, itemReceived } from '../lib/calc';
import { money, norm, fmtDate, r2 } from '../lib/format';
import { exportExcel } from '../lib/exporters';

export default function Items() {
  const { data, settings, mutate, toast } = useApp();
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('all');
  const [showArchived, setShowArchived] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const [confirmArchive, setConfirmArchive] = useState(null);

  const categories = useMemo(
    () => [...new Set(data.items.map((i) => i.category).filter(Boolean))].sort(),
    [data.items]
  );

  const rows = useMemo(() => {
    const term = norm(q);
    return data.items
      .filter((i) => (showArchived ? i.status === 'archived' : i.status !== 'archived'))
      .filter((i) => category === 'all' || i.category === category)
      .filter((i) => !term || norm(i.name).includes(term) || norm(i.category).includes(term))
      .map((i) => {
        const stock = itemStock(i.id, data);
        return {
          ...i,
          stock,
          received: itemReceived(i.id, data),
          low: Number(i.lowStockAlert) > 0 && stock <= Number(i.lowStockAlert),
          value: r2(stock * (Number(i.costPrice) || 0)),
        };
      })
      .sort((a, b) => (b.low ? 1 : 0) - (a.low ? 1 : 0) || a.name.localeCompare(b.name));
  }, [data, q, category, showArchived]);

  const totalValue = useMemo(() => r2(rows.reduce((s, r) => s + r.value, 0)), [rows]);

  // Items with no stock are shown in their own section, separate from available ones.
  const available = useMemo(() => rows.filter((r) => Number(r.stock) > 0), [rows]);
  const outOfStock = useMemo(() => rows.filter((r) => !(Number(r.stock) > 0)), [rows]);
  const availableValue = useMemo(() => r2(available.reduce((s, r) => s + r.value, 0)), [available]);
  const outOfStockValue = useMemo(() => r2(outOfStock.reduce((s, r) => s + r.value, 0)), [outOfStock]);

  const doArchive = async () => {
    const it = confirmArchive;
    setConfirmArchive(null);
    await mutate(() => api.archiveItem(it.id),
      it.status === 'archived' ? 'Item restored' : 'Item archived').catch(() => {});
  };

  const onExcel = () => {
    exportExcel('Items',
      ['Item', 'Category', 'Base Unit', 'Alt Unit', 'Conversion', 'Cost Price', 'Total Received', 'Available', 'Low Alert', 'Stock Value'],
      rows.map((i) => [i.name, i.category, i.baseUnit, i.altUnit || '', i.conversionRate || '',
                       Number(i.costPrice).toFixed(2), i.received, i.stock, i.lowStockAlert, i.value.toFixed(2)]),
      [`${settings.shopName} — Items`, `Total stock value: ${money(totalValue)}`]);
    toast('Items exported');
  };

  const renderSection = (title, list, listValue, tone) => (
    <div key={title}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px',
        fontWeight: 700, borderBottom: '1px solid var(--border)',
        color: tone === 'danger' ? 'var(--danger)' : undefined,
      }}>
        {title}
        <span className="muted small" style={{ fontWeight: 500 }}>({list.length})</span>
      </div>
      {!list.length ? (
        <div className="muted small" style={{ padding: 16 }}>No items.</div>
      ) : (
        <>
            <div className="table-wrap hide-mobile">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Item</th><th>Category</th><th>Units</th>
                    <th className="r">Cost price</th><th className="r">Total received</th>
                    <th className="r">Available now</th>
                    <th className="r">Low alert</th><th className="r">Stock value</th>
                    <th style={{ width: 90 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((i) => (
                    <tr key={i.id}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{i.name}</div>
                        {i.lastPurchaseDate && (
                          <div className="small muted">Last purchased {fmtDate(i.lastPurchaseDate)}</div>
                        )}
                      </td>
                      <td>{i.category || <span className="muted">—</span>}</td>
                      <td className="small">
                        {i.baseUnit}
                        {i.altUnit && Number(i.conversionRate) > 0 && (
                          <div className="muted">1 {i.altUnit} = {i.conversionRate} {i.baseUnit}</div>
                        )}
                      </td>
                      <td className="r"><Money value={i.costPrice} /></td>
                      <td className="r">
                        <span className="num">{i.received} {i.baseUnit}</span>
                      </td>
                      <td className="r strong">
                        <span className="num" style={{ color: i.low ? 'var(--danger)' : undefined }}>
                          {i.stock} {i.baseUnit}
                        </span>
                        {i.low && (
                          <div>
                            <Pill status="due" label="Low stock" />
                          </div>
                        )}
                      </td>
                      <td className="r muted">{Number(i.lowStockAlert) > 0 ? i.lowStockAlert : '—'}</td>
                      <td className="r strong"><Money value={i.value} /></td>
                      <td>
                        <div className="row-actions">
                          <button className="btn btn-ghost btn-sm" title="Edit" onClick={() => setEditing(i)}>
                            <Pencil size={14} />
                          </button>
                          <button className="btn btn-ghost btn-sm"
                                  title={i.status === 'archived' ? 'Restore' : 'Archive'}
                                  onClick={() => setConfirmArchive(i)}>
                            {i.status === 'archived' ? <ArchiveRestore size={14} /> : <Archive size={14} />}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={7}>{list.length} items</td>
                    <td className="r">{money(listValue)}</td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <div className="mcards" style={{ padding: 12 }}>
              {list.map((i) => (
                <div key={i.id} className="mcard" onClick={() => setEditing(i)}>
                  <div className="top">
                    <span className="name">{i.name}</span>
                    <span className="amt">{money(i.costPrice)}</span>
                  </div>
                  <div className="meta">
                    {i.low && <Pill status="due" label="Low stock" />}
                    <span className="muted">Received {i.received} {i.baseUnit}</span>
                    <span style={{ color: i.low ? 'var(--danger)' : undefined, fontWeight: 600 }}>
                      Available {i.stock} {i.baseUnit}
                    </span>
                    {i.category && <span>{i.category}</span>}
                  </div>
                </div>
              ))}
            </div>
        </>
      )}
    </div>
  );

  return (
    <>
      <PageHead title="Items"
                subtitle={`${available.length} available · ${outOfStock.length} out of stock · ${money(totalValue)} stock value at cost`}>
        <SearchBar value={q} onChange={setQ} placeholder="Search items…" />
        <Select value={category} onChange={(e) => setCategory(e.target.value)} style={{ width: 150 }}>
          <option value="all">All categories</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </Select>
        <Button onClick={() => setShowArchived((s) => !s)}>
          {showArchived ? 'Show active' : 'Show archived'}
        </Button>
        <Button icon={Download} onClick={onExcel}>Excel</Button>
        <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Add Item</Button>
      </PageHead>

      <Card tight>
        {!rows.length ? (
          <Empty icon={Package} title={q ? 'No matching items' : 'No items yet'}
                 message={q ? `Nothing matches "${q}".` : 'Add items to start building bills.'}
                 action={!q ? <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Add your first item</Button> : null} />
        ) : (
          <>
            {renderSection('Available', available, availableValue)}
            {outOfStock.length > 0 && renderSection('Out of stock', outOfStock, outOfStockValue, 'danger')}
          </>
        )}
      </Card>

      <Modal open={adding} title="Add New Item" onClose={() => setAdding(false)}>
        <ItemForm onSaved={() => setAdding(false)} onCancel={() => setAdding(false)} />
      </Modal>

      <Modal open={Boolean(editing)} title={`Edit ${editing?.name || 'Item'}`} onClose={() => setEditing(null)}>
        {editing && <ItemForm item={editing} onSaved={() => setEditing(null)} onCancel={() => setEditing(null)} />}
      </Modal>

      <Confirm
        open={Boolean(confirmArchive)}
        title={confirmArchive?.status === 'archived' ? 'Restore item?' : 'Archive item?'}
        message={confirmArchive?.status === 'archived'
          ? `"${confirmArchive?.name}" will appear in billing dropdowns again.`
          : `"${confirmArchive?.name}" will be hidden from billing dropdowns. Its sales history stays intact — nothing is deleted.`}
        confirmLabel={confirmArchive?.status === 'archived' ? 'Restore' : 'Archive'}
        onConfirm={doArchive}
        onCancel={() => setConfirmArchive(null)}
      />
    </>
  );
}
