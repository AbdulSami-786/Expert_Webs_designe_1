import { useState } from 'react';
import { call } from '../lib/api';
import { fromInputValue, toInputValue } from '../lib/format';
import Modal from '../components/Modal';

/** Add a new client, or edit the details of an existing one (pass `client`). */
export default function ClientForm({ client, onClose, onSaved }) {
  const editing = Boolean(client);
  const [name, setName] = useState(client?.name || '');
  const [contact, setContact] = useState(client?.contact || '');
  const [lockMessage, setLockMessage] = useState(client?.lockMessage || '');
  const [warnDays, setWarnDays] = useState(client?.warnDays || 5);
  const [expires, setExpires] = useState(toInputValue(Date.now() + 30 * 86400000));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const save = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr('');
    try {
      const saved = await call('adminSaveClient', {
        id: client?.id, name, contact, lockMessage, warnDays: Number(warnDays),
        ...(editing ? {} : { expiresAt: fromInputValue(expires) }),
      });
      await onSaved(saved);
    } catch (ex) {
      setErr(ex.message);
      setBusy(false);
    }
  };

  return (
    <Modal title={editing ? 'Edit client' : 'Add client'} onClose={onClose}>
      <form onSubmit={save}>
        <label>Client / shop name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus required />

        <label>Your contact (shown on the expired screen)</label>
        <input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="e.g. WhatsApp 0300 1234567" />

        <label>Custom message on the expired screen (optional)</label>
        <textarea rows={2} value={lockMessage} onChange={(e) => setLockMessage(e.target.value)}
                  placeholder="Leave empty to use the standard message" />

        <label>Show the "expiring soon" popup this many days before expiry</label>
        <input type="number" min={1} max={30} value={warnDays} onChange={(e) => setWarnDays(e.target.value)} />

        {!editing && (
          <>
            <label>First expiry date and time</label>
            <input type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} required />
          </>
        )}

        {err && <div className="alert err">{err}</div>}
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !name.trim()}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}
