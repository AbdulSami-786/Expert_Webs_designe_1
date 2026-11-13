// Add/edit a supplier — a party the shop BUYS from. Used from the Suppliers
// page and inline from a purchase bill.

import { useState } from 'react';
import { Save } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import api from '../../lib/api';
import { Button, Field, Input, Textarea } from '../ui';

export default function SupplierForm({ supplier = null, initialName = '', onSaved, onCancel }) {
  const { mutate } = useApp();
  const [f, setF] = useState({
    name: String(supplier?.name ?? initialName ?? ''),
    phone: String(supplier?.phone ?? ''),
    address: String(supplier?.address ?? ''),
    openingBalance: supplier?.openingBalance ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return; // guard: block a duplicate submit while saving
    if (!f.name.trim()) return setErr('Supplier name is required');
    setErr('');
    setBusy(true);
    try {
      const saved = await mutate(
        () => api.saveSupplier({
          id: supplier?.id,
          name: f.name.trim(),
          phone: f.phone.trim(),
          address: f.address.trim(),
          openingBalance: Number(f.openingBalance) || 0,
        }),
        supplier ? 'Supplier updated' : 'Supplier added'
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
        <Field label="Supplier name" className="full" error={err}>
          <Input value={f.name} onChange={set('name')} autoFocus placeholder="e.g. City Wholesale Supply" />
        </Field>

        <Field label="Phone">
          <Input value={f.phone} onChange={set('phone')} placeholder="03xx-xxxxxxx" />
        </Field>

        <Field label="Opening balance"
               hint="What you already owe them. Enter a minus amount if they hold an advance from you.">
          <Input type="number" step="any" value={f.openingBalance}
                 onChange={set('openingBalance')} placeholder="0" />
        </Field>

        <Field label="Address" className="full">
          <Textarea value={f.address} onChange={set('address')} rows={2}
                    placeholder="Market or area" />
        </Field>
      </div>

      <div className="row" style={{ justifyContent: 'flex-end', gap: 9 }}>
        {onCancel && <Button type="button" onClick={onCancel}>Cancel</Button>}
        <Button type="submit" variant="primary" icon={Save} loading={busy}>
          {supplier ? 'Update Supplier' : 'Add Supplier'}
        </Button>
      </div>
    </form>
  );
}
