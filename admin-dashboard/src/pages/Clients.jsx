import { useMemo, useState } from 'react';
import { Plus, Users } from 'lucide-react';
import ClientPanel from './ClientPanel';
import ClientForm from './ClientForm';
import { clientState, daysLeft, fmtDateTime, fmtShort, STATE_LABEL } from '../lib/format';

const ORDER = { expired: 0, locked: 1, soon: 2, active: 3 };

export default function Clients({ data, reload }) {
  const { clients, codes, serverNow } = data;
  const [openId, setOpenId] = useState(null);
  const [adding, setAdding] = useState(false);

  // Server time, not this computer's clock, so a wrong admin clock cannot mislabel anyone.
  const now = serverNow;

  const rows = useMemo(
    () => [...clients].sort((a, b) => ORDER[clientState(a, now)] - ORDER[clientState(b, now)] || a.expiresAt - b.expiresAt),
    [clients, now]
  );
  const counts = useMemo(() => {
    const c = { active: 0, soon: 0, expired: 0, locked: 0 };
    clients.forEach((x) => { c[clientState(x, now)]++; });
    return c;
  }, [clients, now]);

  const open = clients.find((c) => c.id === openId);

  return (
    <>
      <div className="summary">
        {Object.keys(STATE_LABEL).map((k) => (
          <div key={k} className={`stat s-${k}`}>
            <div className="n">{counts[k]}</div>
            <div className="l">{STATE_LABEL[k]}</div>
          </div>
        ))}
      </div>

      <div className="page-head">
        <h1>Clients</h1>
        <div className="grow" />
        <button className="btn primary" onClick={() => setAdding(true)}><Plus size={16} /> Add client</button>
      </div>

      {rows.length === 0 ? (
        <div className="empty">
          <Users size={34} />
          <p>No clients yet. Add your first client to get a Client ID for their dashboard.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Client</th><th>Status</th><th>Expires</th><th>Days left</th><th>Last opened</th></tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const st = clientState(c, now);
                const d = daysLeft(c.expiresAt, now);
                return (
                  <tr key={c.id} onClick={() => setOpenId(c.id)} className="click">
                    <td><strong>{c.name}</strong><div className="muted small mono">{c.id}</div></td>
                    <td><span className={`pill p-${st}`}>{STATE_LABEL[st]}</span></td>
                    <td>{fmtDateTime(c.expiresAt)}</td>
                    <td className={d <= 0 ? 'neg' : d <= c.warnDays ? 'warn' : ''}>{d <= 0 ? 'Expired' : `${d} day${d === 1 ? '' : 's'}`}</td>
                    <td className="muted">{fmtShort(c.lastSeen)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {open && (
        <ClientPanel
          client={open}
          codes={codes.filter((x) => x.clientId === open.id)}
          now={now}
          onClose={() => setOpenId(null)}
          reload={reload}
        />
      )}
      {adding && (
        <ClientForm
          onClose={() => setAdding(false)}
          onSaved={async (created) => { setAdding(false); await reload(); setOpenId(created.id); }}
        />
      )}
    </>
  );
}
