// Sold Out — items that have no stock left, kept off the Items page.
// Shows where each one was bought from so it can be reordered in a tap.

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, PackageX, ShoppingCart, Download, CheckCircle2 } from 'lucide-react';
import { useApp } from '../context/AppContext';
import {
  Card, Button, Empty, PageHead, SearchBar, Money, Pill, Select,
} from '../components/ui';
import { itemStock, itemReceived, itemListTotals } from '../lib/calc';
import { money, norm, fmtDate } from '../lib/format';
import { exportExcel } from '../lib/exporters';

export default function SoldOut() {
  const { data, settings, toast } = useApp();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('all');

  // Active items whose stock is zero (or below, if oversold), with who supplied them.
  const all = useMemo(() => {
    const voided = new Set((data.purchaseBills || []).filter((b) => b.status === 'voided').map((b) => b.id));
    const supName = new Map(data.suppliers.map((s) => [s.id, s.name]));
    return data.items
      .filter((i) => i.status !== 'archived')
      .map((i) => ({ ...i, stock: itemStock(i.id, data) }))
      .filter((i) => !(i.stock > 0))
      .map((i) => {
        const buys = data.purchases
          .filter((p) => p.itemId === i.id && !voided.has(p.purchaseBillId))
          .sort((a, b) => String(b.date).localeCompare(String(a.date)));
        const last = buys.find((p) => p.supplierId) || null;
        return {
          ...i,
          received: itemReceived(i.id, data),
          lastBought: buys[0]?.date || i.lastPurchaseDate || '',
          lastSupplierId: last?.supplierId || '',
          suppliers: [...new Set(buys.map((p) => p.supplierId).filter(Boolean))]
            .map((id) => supName.get(id)).filter(Boolean),
        };
      })
      .sort((a, b) => String(b.lastBought).localeCompare(String(a.lastBought)) || a.name.localeCompare(b.name));
  }, [data]);

  const categories = useMemo(() => [...new Set(all.map((i) => i.category).filter(Boolean))].sort(), [all]);

  const rows = useMemo(() => {
    const term = norm(q);
    return all
      .filter((i) => category === 'all' || i.category === category)
      .filter((i) => !term || norm(i.name).includes(term) || norm(i.category).includes(term)
        || i.suppliers.some((s) => norm(s).includes(term)));
  }, [all, q, category]);

  const tot = useMemo(() => itemListTotals(rows), [rows]);

  const onExcel = () => {
    exportExcel('Sold Out Items',
      ['Item', 'Category', 'Total Received', 'Stock', 'Cost Price', 'Last Bought', 'Suppliers'],
      rows.map((i) => [i.name, i.category, i.received, i.stock, Number(i.costPrice).toFixed(2),
                       i.lastBought ? fmtDate(i.lastBought) : '', i.suppliers.join(', ')]),
      [`${settings.shopName} — Sold out items`, `${rows.length} items`,
       `Total received: ${tot.received}`, `Total bought (received x cost): ${money(tot.bought)}`]);
    toast('Sold out items exported');
  };

  const reorder = (i) => (i.lastSupplierId ? nav(`/supplier/${i.lastSupplierId}`) : nav('/suppliers'));

  return (
    <>
      <PageHead title="Sold Out Items"
                subtitle={`${rows.length} item${rows.length === 1 ? '' : 's'} with no stock left`}>
        <SearchBar value={q} onChange={setQ} placeholder="Search item or supplier…" />
        <Select value={category} onChange={(e) => setCategory(e.target.value)} style={{ width: 150 }}>
          <option value="all">All categories</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </Select>
        <Button icon={ArrowLeft} onClick={() => nav('/items')}>Items</Button>
        <Button icon={Download} onClick={onExcel} disabled={!rows.length}>Excel</Button>
      </PageHead>

      <Card tight>
        {!rows.length ? (
          q || category !== 'all'
            ? <Empty icon={PackageX} title="No matching items" message="Nothing sold out matches your search." />
            : <Empty icon={CheckCircle2} title="Nothing is sold out"
                     message="Every item still has stock."
                     action={<Button onClick={() => nav('/items')}>Back to Items</Button>} />
        ) : (
          <>
            <div className="table-wrap hide-mobile">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Item</th><th>Category</th><th>Supplier</th>
                    <th className="r">Total received</th><th className="r">Stock</th>
                    <th className="r">Cost price</th><th>Last bought</th><th style={{ width: 110 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((i) => (
                    <tr key={i.id}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{i.name}</div>
                        <Pill status="due" label={i.stock < 0 ? 'Oversold' : 'Sold out'} />
                      </td>
                      <td>{i.category || <span className="muted">—</span>}</td>
                      <td className="small">
                        {i.suppliers.length ? i.suppliers.join(', ') : <span className="muted">—</span>}
                      </td>
                      <td className="r num">{i.received} {i.baseUnit}</td>
                      <td className="r num" style={{ color: 'var(--danger)', fontWeight: 600 }}>
                        {i.stock} {i.baseUnit}
                      </td>
                      <td className="r"><Money value={i.costPrice} /></td>
                      <td className="nowrap">
                        {i.lastBought ? fmtDate(i.lastBought) : <span className="muted">—</span>}
                      </td>
                      <td>
                        <Button size="sm" icon={ShoppingCart} onClick={() => reorder(i)}
                                title={i.lastSupplierId ? 'Open the supplier you bought it from' : 'Open suppliers'}>
                          Reorder
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={3}>{rows.length} sold out</td>
                    <td className="r num">{tot.received} {tot.unit}</td>
                    <td className="r num">{tot.stock} {tot.unit}</td>
                    <td className="r">
                      {money(tot.bought)}
                      <div className="small muted" style={{ fontWeight: 400 }}>total bought</div>
                    </td>
                    <td colSpan={2}></td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <div className="mcards" style={{ padding: 12 }}>
              {rows.map((i) => (
                <div key={i.id} className="mcard" onClick={() => reorder(i)}>
                  <div className="top">
                    <span className="name">{i.name}</span>
                    <span className="amt">{money(i.costPrice)}</span>
                  </div>
                  <div className="meta">
                    <Pill status="due" label={i.stock < 0 ? 'Oversold' : 'Sold out'} />
                    <span>Received {i.received} {i.baseUnit}</span>
                    {i.suppliers.length > 0 && <span>{i.suppliers.join(', ')}</span>}
                    {i.category && <span>{i.category}</span>}
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
