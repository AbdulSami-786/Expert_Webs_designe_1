// Items (FR-2 / Plan 3.3) — units, conversion, cost price, stock, low-stock alerts.

import { useMemo, useState } from 'react';
import { Plus, Package, Pencil, Archive, ArchiveRestore, AlertTriangle, Download } from 'lucide-react';
import { useApp } from '../context/AppContext';
import api from '../lib/api';
import {
  Card, Button, Modal, Empty, PageHead, SearchBar, Money, Pill, Confirm, Select,
} from '../components/ui';
import ItemForm from '../components/forms/ItemForm';
import { itemStock } from '../lib/calc';
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
          low: Number(i.lowStockAlert) > 0 && stock <= Number(i.lowStockAlert),
          value: r2(stock * (Number(i.costPrice) || 0)),
        };
      })
      .sort((a, b) => (b.low ? 1 : 0) - (a.low ? 1 : 0) || a.name.localeCompare(b.name));
  }, [data, q, category, showArchived]);

  const totalValue = useMemo(() => r2(rows.reduce((s, r) => s + r.value, 0)), [rows]);

  const doArchive = async () => {
    const it = confirmArchive;
    setConfirmArchive(null);
    await mutate(() => api.archiveItem(it.id),
      it.status === 'archived' ? 'Item restored' : 'Item archived').catch(() => {});
  };

  const onExcel = () => {
    exportExcel('Items',
      ['Item', 'Category', 'Base Unit', 'Alt Unit', 'Conversion', 'Cost Price', 'Stock', 'Low Alert', 'Stock Value'],
      rows.map((i) => [i.name, i.category, i.baseUnit, i.altUnit || '', i.conversionRate || '',
                       Number(i.costPrice).toFixed(2), i.stock, i.lowStockAlert, i.value.toFixed(2)]),
      [`${settings.shopName} — Items`, `Total stock value: ${money(totalValue)}`]);
    toast('Items exported');
  };

  return (
    <>
      <PageHead title="Items"
                subtitle={`${rows.length} items · ${money(totalValue)} stock value at cost`}>
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
            <div className="table-wrap hide-mobile">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Item</th><th>Category</th><th>Units</th>
                    <th className="r">Cost price</th><th className="r">Stock</th>
                    <th className="r">Low alert</th><th className="r">Stock value</th>
                    <th style={{ width: 90 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((i) => (
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
                    <td colSpan={6}>{rows.length} items</td>
                    <td className="r">{money(totalValue)}</td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <div className="mcards" style={{ padding: 12 }}>
              {rows.map((i) => (
                <div key={i.id} className="mcard" onClick={() => setEditing(i)}>
                  <div className="top">
                    <span className="name">{i.name}</span>
                    <span className="amt">{money(i.costPrice)}</span>
                  </div>
                  <div className="meta">
                    {i.low && <Pill status="due" label="Low stock" />}
                    <span style={{ color: i.low ? 'var(--danger)' : undefined, fontWeight: 600 }}>
                      {i.stock} {i.baseUnit}
                    </span>
                    {i.category && <span>{i.category}</span>}
                  </div>
                </div>
              ))}
            </div>
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
