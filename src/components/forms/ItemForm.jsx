// Add/edit an item (FR-2 / Plan 3.3 multi-unit).

import { useState } from 'react';
import { Save } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import api from '../../lib/api';
import { Button, Field, Input, Select } from '../ui';
import { UNITS } from '../../lib/config';

export default function ItemForm({ item = null, initialName = '', onSaved, onCancel }) {
  const { mutate, data } = useApp();

  const categories = [...new Set(data.items.map((i) => i.category).filter(Boolean))];

  const [f, setF] = useState({
    name: String(item?.name ?? initialName ?? ''),
    baseUnit: item?.baseUnit ?? 'Piece',
    altUnit: item?.altUnit ?? '',
    conversionRate: item?.conversionRate ?? '',
    category: String(item?.category ?? ''),
    costPrice: item?.costPrice ?? '',
    openingStock: item?.openingStock ?? '',
    lowStockAlert: item?.lowStockAlert ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return; // guard: block a duplicate submit while saving
    if (!f.name.trim()) return setErr('Item name is required');
    setErr('');
    setBusy(true);
    try {
      const saved = await mutate(
        () => api.saveItem({
          id: item?.id,
          name: f.name.trim(),
          baseUnit: f.baseUnit,
          altUnit: f.altUnit,
          conversionRate: Number(f.conversionRate) || 0,
          category: f.category.trim(),
          costPrice: Number(f.costPrice) || 0,
          openingStock: Number(f.openingStock) || 0,
          lowStockAlert: Number(f.lowStockAlert) || 0,
        }),
        item ? 'Item updated' : undefined
      );
      onSaved?.(saved);
    } catch {
      /* toast shown by mutate */
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <div className="form-grid">
        <Field label="Item name" className="full" error={err}>
          <Input value={f.name} onChange={set('name')} autoFocus placeholder="e.g. Sugar" />
        </Field>

        <Field label="Base unit" hint="How you normally count this item">
          <Select value={f.baseUnit} onChange={set('baseUnit')} options={UNITS} />
        </Field>

        <Field label="Category">
          <Input value={f.category} onChange={set('category')} list="cat-list"
                 placeholder="e.g. Grocery" />
          <datalist id="cat-list">
            {categories.map((c) => <option key={c} value={c} />)}
          </datalist>
        </Field>

        <Field label="Alternate unit" hint="Optional — e.g. Carton">
          <Select value={f.altUnit} onChange={set('altUnit')}>
            <option value="">None</option>
            {UNITS.filter((u) => u !== f.baseUnit).map((u) => <option key={u} value={u}>{u}</option>)}
          </Select>
        </Field>

        <Field
          label="Conversion rate"
          hint={f.altUnit ? `1 ${f.altUnit} = how many ${f.baseUnit}?` : 'Set an alternate unit first'}
        >
          <Input type="number" min="0" step="any" value={f.conversionRate}
                 onChange={set('conversionRate')} disabled={!f.altUnit} placeholder="e.g. 24" />
        </Field>

        <Field label="Cost price" hint="Used for profit tracking">
          <Input type="number" min="0" step="any" value={f.costPrice}
                 onChange={set('costPrice')} placeholder="0" />
        </Field>

        <Field label="Low stock alert" hint="Warn when stock falls to this level">
          <Input type="number" min="0" step="any" value={f.lowStockAlert}
                 onChange={set('lowStockAlert')} placeholder="0" />
        </Field>

        {!item && (
          <Field label="Opening stock" className="full" hint="Current quantity on hand, if any">
            <Input type="number" min="0" step="any" value={f.openingStock}
                   onChange={set('openingStock')} placeholder="0" />
          </Field>
        )}
      </div>

      <div className="row" style={{ justifyContent: 'flex-end', gap: 9 }}>
        {onCancel && <Button type="button" onClick={onCancel}>Cancel</Button>}
        <Button type="submit" variant="primary" icon={Save} loading={busy}>
          {item ? 'Update Item' : 'Add Item'}
        </Button>
      </div>
    </form>
  );
}
