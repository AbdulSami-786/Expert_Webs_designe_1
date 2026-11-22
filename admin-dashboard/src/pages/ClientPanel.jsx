import { useEffect, useState } from 'react';
import { Ban, CalendarClock, Copy, KeyRound, Lock, Pencil, Trash2, Unlock } from 'lucide-react';
import Modal from '../components/Modal';
import ClientForm from './ClientForm';
import { call } from '../lib/api';
import {
  clientState, daysLeft, fmtDateTime, fmtShort, fromInputValue, STATE_LABEL, toInputValue,
} from '../lib/format';

const MONTH_CHOICES = [1, 2, 3, 6, 12];

function copy(text, setNote) {
  navigator.clipboard?.writeText(text).then(
    () => { setNote('Copied'); setTimeout(() => setNote(''), 1500); },
    () => setNote('Copy failed — select and copy by hand')
  );
}

export default function ClientPanel({ client, codes, now, onClose, reload }) {
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [editing, setEditing] = useState(false);
  const [expiry, setExpiry] = useState(toInputValue(client.expiresAt));
  const [months, setMonths] = useState(1);
  const [fresh, setFresh] = useState(null);   // the code just generated
  const [log, setLog] = useState([]);

  const st = clientState(client, now);
  const d = daysLeft(client.expiresAt, now);

  // Keep the date picker in step when the server value changes (after Extend / a code being used).
  useEffect(() => { setExpiry(toInputValue(client.expiresAt)); }, [client.expiresAt]);

  const loadLog = () => call('adminLog', { id: client.id }).then(setLog).catch(() => {});
  useEffect(() => { loadLog(); }, [client.id, client.expiresAt, client.locked]); // eslint-disable-line react-hooks/exhaustive-deps

  // One wrapper for every button: shows progress, blocks double-clicks, surfaces the error.
  const run = async (label, fn) => {
    if (busy) return;
    setBusy(label);
    setErr('');
    try { await fn(); await reload(); } catch (e) { setErr(e.message); } finally { setBusy(''); }
  };

  const setExpiryNow = () => run('expiry', () => {
    const at = fromInputValue(expiry);
    if (!at) throw new Error('Pick a valid date and time.');
    return call('adminSetExpiry', { id: client.id, expiresAt: at });
  });

  const makeCode = () => run('code', async () => {
    setFresh(await call('adminCreateCode', { id: client.id, months }));
  });

  const shareText = (c) =>
    `Your ${client.name} dashboard renewal code: ${c.code}\n` +
    `Open the dashboard > "Renew subscription" > enter this code. It adds ${c.months} month${c.months === 1 ? '' : 's'}.`;

  const remove = () => {
    if (!window.confirm(`Delete "${client.name}" and all its codes? Their dashboard will show "not registered" and lock. This cannot be undone.`)) return;
    run('delete', async () => { await call('adminDeleteClient', { id: client.id }); onClose(); });
  };

  return (
    <Modal title={client.name} onClose={onClose} wide>
      <div className="grid2">
        <section className="box">
          <h3>Subscription</h3>
          <div className="kv"><span>Status</span><span className={`pill p-${st}`}>{STATE_LABEL[st]}</span></div>
          <div className="kv"><span>Expires</span><strong>{fmtDateTime(client.expiresAt)}</strong></div>
          <div className="kv"><span>Days left</span><strong>{d <= 0 ? 'Expired' : d}</strong></div>
          <div className="kv"><span>Last opened</span><span>{fmtShort(client.lastSeen)}</span></div>
          <div className="kv">
            <span>Client ID</span>
            <span className="mono">{client.id}
              <button className="btn ghost icon" title="Copy Client ID" onClick={() => copy(client.id, setNote)}><Copy size={14} /></button>
            </span>
          </div>
          {client.contact && <div className="kv"><span>Contact</span><span>{client.contact}</span></div>}
          <div className="row">
            <button className="btn" onClick={() => setEditing(true)}><Pencil size={15} /> Edit details</button>
            <button className="btn danger-o" onClick={remove} disabled={Boolean(busy)}><Trash2 size={15} /> Delete</button>
          </div>
        </section>

        <section className="box">
          <h3><CalendarClock size={16} /> Set expiry date, day and time</h3>
          <input type="datetime-local" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
          <div className="hint">{expiry ? new Date(expiry).toLocaleString('en-GB', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}</div>
          <div className="row">
            <button className="btn primary" onClick={setExpiryNow} disabled={Boolean(busy)}>
              {busy === 'expiry' ? 'Saving…' : 'Save expiry'}
            </button>
            <button className="btn" onClick={() => run('ext', () => call('adminExtend', { id: client.id, months: 1 }))} disabled={Boolean(busy)}>
              +1 month
            </button>
          </div>
          <div className="hint">After this moment the client's dashboard turns into the black "subscription expired" page.</div>

          <h3 style={{ marginTop: 18 }}>{client.locked ? <Unlock size={16} /> : <Lock size={16} />} Close dashboard now</h3>
          {client.locked ? (
            <button className="btn primary" onClick={() => run('lock', () => call('adminSetLocked', { id: client.id, locked: false }))} disabled={Boolean(busy)}>
              <Unlock size={15} /> Re-open dashboard
            </button>
          ) : (
            <button className="btn danger" onClick={() => {
              if (window.confirm(`Close ${client.name}'s dashboard right now? They will see the black page until you re-open it or they renew.`)) {
                run('lock', () => call('adminSetLocked', { id: client.id, locked: true }));
              }
            }} disabled={Boolean(busy)}>
              <Ban size={15} /> Close dashboard
            </button>
          )}
          <div className="hint">Closes it immediately, whatever the expiry date is. A valid renewal code re-opens it.</div>
        </section>
      </div>

      <section className="box">
        <h3><KeyRound size={16} /> Renewal codes</h3>
        <div className="row">
          <select value={months} onChange={(e) => setMonths(Number(e.target.value))}>
            {MONTH_CHOICES.map((m) => <option key={m} value={m}>{m} month{m === 1 ? '' : 's'}</option>)}
          </select>
          <button className="btn primary" onClick={makeCode} disabled={Boolean(busy)}>
            {busy === 'code' ? 'Generating…' : 'Generate code'}
          </button>
        </div>

        {fresh && (
          <div className="code-card">
            <div className="code-big mono">{fresh.code}</div>
            <div className="muted small">Valid once, only for {client.name}. Adds {fresh.months} month{fresh.months === 1 ? '' : 's'}.</div>
            <div className="row">
              <button className="btn" onClick={() => copy(fresh.code, setNote)}><Copy size={15} /> Copy code</button>
              <button className="btn" onClick={() => copy(shareText(fresh), setNote)}><Copy size={15} /> Copy message for WhatsApp</button>
            </div>
          </div>
        )}
        {note && <div className="hint ok">{note}</div>}

        {codes.length > 0 && (
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table>
              <thead><tr><th>Code</th><th>Adds</th><th>Status</th><th>Created</th><th /></tr></thead>
              <tbody>
                {[...codes].sort((a, b) => b.createdAt - a.createdAt).map((c) => (
                  <tr key={c.code}>
                    <td className="mono">{c.code}</td>
                    <td>{c.months} mo</td>
                    <td><span className={`pill c-${c.status}`}>{c.status === 'used' ? `Used ${fmtShort(c.usedAt)}` : c.status}</span></td>
                    <td className="muted">{fmtShort(c.createdAt)}</td>
                    <td>
                      {c.status === 'unused' && (
                        <button className="btn ghost small" disabled={Boolean(busy)}
                                onClick={() => run('revoke', () => call('adminRevokeCode', { code: c.code }))}>Cancel code</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {err && <div className="alert err">{err}</div>}

      <section className="box">
        <h3>Activity</h3>
        {log.length === 0 ? <div className="muted small">Nothing yet.</div> : (
          <ul className="log">
            {log.slice(0, 15).map((l, i) => (
              <li key={i}><span className="muted">{fmtShort(l.at)}</span> <strong>{l.event}</strong> {l.detail && <span className="muted">— {l.detail}</span>}</li>
            ))}
          </ul>
        )}
      </section>

      {editing && (
        <ClientForm client={client} onClose={() => setEditing(false)}
                    onSaved={async () => { setEditing(false); await reload(); }} />
      )}
    </Modal>
  );
}
