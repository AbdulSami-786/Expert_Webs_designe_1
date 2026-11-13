// Screens for the per-party ledger password (see lib/partyLock.js).

import { useEffect, useState } from 'react';
import { Lock, Unlock, ArrowLeft, Save, Trash2 } from 'lucide-react';
import { useApp } from '../context/AppContext';
import api from '../lib/api';
import { tryUnlock, isLocked, relock, markUnlocked } from '../lib/partyLock';
import { Card, Button, Modal, Field, Input } from './ui';

/** Shown instead of a locked party's ledger until the password is entered. */
export function PartyLockScreen({ party, onUnlocked, onBack }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (busy || !pw) return;
    setBusy(true);
    setErr('');
    try {
      if (await tryUnlock(party, pw)) onUnlocked();
      else { setErr('Wrong password'); setPw(''); }
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ maxWidth: 420, margin: '48px auto' }}>
      <Card>
        <form onSubmit={submit} style={{ textAlign: 'center' }}>
          <span className="ico" style={{
            display: 'inline-flex', width: 52, height: 52, borderRadius: 26, alignItems: 'center',
            justifyContent: 'center', background: 'var(--bg)', border: '1px solid var(--border)', marginBottom: 12,
          }}>
            <Lock size={22} />
          </span>
          <h2 className="h2" style={{ marginBottom: 4 }}>{party.name}</h2>
          <p className="small muted" style={{ marginBottom: 16 }}>
            This ledger is locked. Enter its password to open it.
          </p>
          <Field error={err}>
            <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)}
                   placeholder="Party password" autoFocus autoComplete="off" />
          </Field>
          <div className="row" style={{ gap: 8, justifyContent: 'center' }}>
            <Button type="button" icon={ArrowLeft} onClick={onBack}>Back</Button>
            <Button type="submit" variant="primary" icon={Unlock} loading={busy} disabled={!pw}>
              Open Ledger
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

/** Set, change or remove a party's ledger password. */
export function PartyLockModal({ open, onClose, party }) {
  const { mutate } = useApp();
  const locked = isLocked(party);
  const [f, setF] = useState({ current: '', next: '', confirm: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (open) { setF({ current: '', next: '', confirm: '' }); setErr(''); } }, [open]);

  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));

  const run = async (password) => {
    if (busy) return;
    if (password && password.length < 4) return setErr('Use at least 4 characters');
    if (password && password !== f.confirm) return setErr('The two passwords do not match');
    if (locked && !f.current) return setErr('Enter the current password first');
    setErr('');
    setBusy(true);
    // Whoever is typing the new password is already looking at this ledger,
    // so it stays open. Marked before saving: the save refreshes the screen,
    // and a still-locked party would swap the ledger for the lock screen.
    if (password) markUnlocked(party.id);
    try {
      await mutate(() => api.setPartyLock(party.id, password, f.current),
        password ? (locked ? 'Party password changed' : 'Ledger locked with a password') : 'Password removed');
      if (!password) relock(party.id);
      onClose();
    } catch { /* toast shown */ } finally { setBusy(false); }
  };

  return (
    <Modal open={open} title={locked ? `Password — ${party.name}` : `Lock ${party.name}'s ledger`} onClose={onClose}
           footer={
             <>
               {locked && (
                 <Button variant="danger" icon={Trash2} onClick={() => run('')} loading={busy}>
                   Remove password
                 </Button>
               )}
               <span className="spacer" />
               <Button onClick={onClose}>Cancel</Button>
               <Button variant="primary" icon={Save} onClick={() => run(f.next)} loading={busy}
                       disabled={!f.next}>
                 {locked ? 'Change password' : 'Lock ledger'}
               </Button>
             </>
           }>
      <p className="small muted" style={{ marginBottom: 12 }}>
        {locked
          ? 'This ledger asks for a password before it opens. Change it or remove it below.'
          : 'Once locked, this party’s ledger asks for this password every time it is opened. '
            + 'Other parties are not affected.'}
      </p>
      <div className="form-grid">
        {locked && (
          <Field label="Current password" className="full"
                 hint="This party’s password — or your login password if you have forgotten it">
            <Input type="password" value={f.current} onChange={set('current')} autoFocus autoComplete="off" />
          </Field>
        )}
        <Field label={locked ? 'New password' : 'Password'}>
          <Input type="password" value={f.next} onChange={set('next')} autoFocus={!locked} autoComplete="new-password" />
        </Field>
        <Field label="Type it again">
          <Input type="password" value={f.confirm} onChange={set('confirm')} autoComplete="new-password" />
        </Field>
      </div>
      {err && <div className="err">{err}</div>}
    </Modal>
  );
}
