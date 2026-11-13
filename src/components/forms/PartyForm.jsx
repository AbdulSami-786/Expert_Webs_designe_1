// Add/edit a party (FR-13). Used inline from New Bill and from the Parties page.

import { useState } from 'react';
import { Save } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import api from '../../lib/api';
import { phoneKey } from '../../lib/localAdapter';
import { Button, Field, Input, Textarea } from '../ui';

export default function PartyForm({ party = null, initialName = '', onSaved, onCancel }) {
  const { data, mutate, settings } = useApp();
  // Text fields are forced to strings: Google Sheets hands a phone number like
  // 03001234567 back as a NUMBER, and calling .trim() on it crashed the form.
  const [f, setF] = useState({
    name: String(party?.name ?? initialName ?? ''),
    phone: String(party?.phone ?? ''),
    address: String(party?.address ?? ''),
    creditLimit: party?.creditLimit ?? '',
    defaultDueDays: party?.defaultDueDays ?? settings.defaultCreditDays,
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));

  // Shown as soon as a number already on another party is typed. The backend
  // enforces the same rule; this just says so before the save is attempted.
  const wantPhone = phoneKey(f.phone);
  const phoneOwner = wantPhone
    ? (data?.parties || []).find((x) => x.id !== party?.id && phoneKey(x.phone) === wantPhone)
    : null;
  const phoneErr = phoneOwner
    ? `This mobile number is already registered on party "${phoneOwner.name}"`
    : '';

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return; // guard: block a duplicate submit while saving
    if (!f.name.trim()) return setErr('Party name is required');
    if (phoneErr) return;
    setErr('');
    setBusy(true);
    try {
      const saved = await mutate(
        () => api.saveParty({
          id: party?.id,
          name: f.name.trim(),
          phone: f.phone.trim(),
          address: f.address.trim(),
          creditLimit: Number(f.creditLimit) || 0,
          defaultDueDays: Number(f.defaultDueDays) || settings.defaultCreditDays,
        }),
        party ? 'Party updated' : undefined
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
        <Field label="Party name" className="full" error={err}>
          <Input value={f.name} onChange={set('name')} autoFocus placeholder="e.g. Ahmed Bhai Kiryana" />
        </Field>

        <Field label="Phone" error={phoneErr}>
          <Input value={f.phone} onChange={set('phone')} placeholder="03xx-xxxxxxx" />
        </Field>

        <Field label="Credit limit" hint="0 means no limit">
          <Input type="number" min="0" step="any" value={f.creditLimit}
                 onChange={set('creditLimit')} placeholder="0" />
        </Field>

        <Field label="Default credit days" hint="Used to set each bill's due date">
          <Input type="number" min="0" value={f.defaultDueDays} onChange={set('defaultDueDays')} />
        </Field>

        <Field label="Address" className="full">
          <Textarea value={f.address} onChange={set('address')} rows={2}
                    placeholder="Shop address or area" />
        </Field>
      </div>

      <div className="row" style={{ justifyContent: 'flex-end', gap: 9 }}>
        {onCancel && <Button type="button" onClick={onCancel}>Cancel</Button>}
        <Button type="submit" variant="primary" icon={Save} loading={busy}>
          {party ? 'Update Party' : 'Add Party'}
        </Button>
      </div>
    </form>
  );
}
