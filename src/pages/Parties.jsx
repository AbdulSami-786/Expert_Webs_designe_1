// Parties list (FR-13 / FR-14) — search, add, edit, archive.

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus, Users, Pencil, Archive, ArchiveRestore, Phone, Send, ChevronRight, Lock,
} from 'lucide-react';
import { canOpen, isLocked } from '../lib/partyLock';
import { useApp } from '../context/AppContext';
import api from '../lib/api';
import {
  Card, Button, Modal, Empty, PageHead, SearchBar, Money, Pill, Confirm,
} from '../components/ui';
import PartyForm from '../components/forms/PartyForm';
import { deriveBills, partyDue, partyUnappliedCredit, partyAdvanceBalance, linkedSupplier, supplierBalance } from '../lib/calc';
import { money, norm, waLink, r2 } from '../lib/format';

export default function Parties() {
  const { data, settings, mutate } = useApp();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(null);

  const derived = useMemo(() => deriveBills(data.bills, data), [data]);

  const rows = useMemo(() => {
    const term = norm(q);
    return data.parties
      .filter((p) => (showArchived ? p.status === 'archived' : p.status !== 'archived'))
      .filter((p) => !term || norm(p.name).includes(term) || norm(p.phone).includes(term))
      .map((p) => {
        // A party that is also a supplier is one khata: what they owe on sales
        // less what the shop owes them on purchases. Below zero, the shop owes
        // them.
        const sup = linkedSupplier(p.id, data.suppliers);
        const owedToThem = sup ? supplierBalance(sup.id, data) : 0;
        return {
          ...p,
          due: r2(partyDue(p.id, derived) - (sup ? partyUnappliedCredit(p.id, derived) : 0) - owedToThem),
        };
      })
      .map((p) => ({
        ...p,
        advance: partyAdvanceBalance(p.id, data.partyAdvances),
        billCount: data.bills.filter((b) => b.partyId === p.id && b.status !== 'voided').length,
        // A password-locked party keeps its figures off this list too, until
        // its ledger has been unlocked.
        hidden: !canOpen(p),
      }))
      // A locked party sorts as if clear, so its position does not hint at
      // what it owes.
      .sort((a, b) => (b.hidden ? 0 : b.due) - (a.hidden ? 0 : a.due) || a.name.localeCompare(b.name));
  }, [data, derived, q, showArchived]);

  const doArchive = async () => {
    const p = confirmArchive;
    setConfirmArchive(null);
    await mutate(
      () => api.archiveParty(p.id),
      p.status === 'archived' ? 'Party restored' : 'Party archived'
    ).catch(() => {});
  };

  return (
    <>
      <PageHead title="Parties" subtitle={`${rows.length} ${showArchived ? 'archived' : 'active'} ${rows.length === 1 ? 'party' : 'parties'}`}>
        <SearchBar value={q} onChange={setQ} placeholder="Search name or phone…" />
        <Button onClick={() => setShowArchived((s) => !s)}>
          {showArchived ? 'Show active' : 'Show archived'}
        </Button>
        <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Add Party</Button>
      </PageHead>

      <Card tight>
        {!rows.length ? (
          <Empty
            icon={Users}
            title={q ? 'No matching parties' : showArchived ? 'No archived parties' : 'No parties yet'}
            message={q ? `Nothing matches "${q}".` : 'Add your first party to start billing.'}
            action={!q && !showArchived
              ? <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Add your first party</Button>
              : null}
          />
        ) : (
          <>
            {/* Desktop table */}
            <div className="table-wrap hide-mobile">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Party</th>
                    <th>Phone</th>
                    <th className="r">Bills</th>
                    <th className="r">Credit limit</th>
                    <th className="r">Advance</th>
                    <th className="r">Outstanding</th>
                    <th style={{ width: 130 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => (
                    <tr key={p.id} className="clickable" onClick={() => nav(`/party/${p.id}`)}>
                      <td>
                        <div style={{ fontWeight: 600 }}>
                          {p.name}
                          {isLocked(p) && <Lock size={12} className="muted" style={{ marginLeft: 6, verticalAlign: -1 }} aria-label="Password locked" />}
                        </div>
                        {p.address && <div className="small muted">{p.address}</div>}
                      </td>
                      <td>{p.phone || <span className="muted">—</span>}</td>
                      <td className="r">{p.hidden ? <span className="muted">—</span> : p.billCount}</td>
                      <td className="r">
                        {p.hidden ? <span className="muted">—</span> : Number(p.creditLimit) > 0
                          ? <span className={p.due > p.creditLimit ? 'money neg' : 'num'}>{money(p.creditLimit)}</span>
                          : <span className="muted">—</span>}
                      </td>
                      <td className="r">
                        {p.hidden ? <span className="muted">—</span> : p.advance > 0
                          ? <span className="money pos">{money(p.advance)}</span>
                          : <span className="muted">—</span>}
                      </td>
                      <td className="r strong">
                        {p.hidden ? <span className="muted small"><Lock size={12} style={{ verticalAlign: -1 }} /> Locked</span> : p.due > 0.004
                          ? <span className="money neg">{money(p.due)}</span>
                          : p.due < -0.004
                            ? <span className="money pos">You owe {money(-p.due)}</span>
                            : <Pill status="paid" label="Clear" />}
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <div className="row-actions">
                          {p.phone && (
                            <a className="btn btn-ghost btn-sm" title="WhatsApp"
                               href={waLink(p.phone, `Assalam-o-Alaikum ${p.name}, ${settings.shopName} se.`)}
                               target="_blank" rel="noreferrer">
                              <Send size={14} />
                            </a>
                          )}
                          <button className="btn btn-ghost btn-sm" title="Edit"
                                  onClick={() => setEditing(p)}>
                            <Pencil size={14} />
                          </button>
                          <button className="btn btn-ghost btn-sm"
                                  title={p.status === 'archived' ? 'Restore' : 'Archive'}
                                  onClick={() => setConfirmArchive(p)}>
                            {p.status === 'archived' ? <ArchiveRestore size={14} /> : <Archive size={14} />}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile cards */}
            <div className="mcards" style={{ padding: 12 }}>
              {rows.map((p) => (
                <div key={p.id} className="mcard" onClick={() => nav(`/party/${p.id}`)}>
                  <div className="top">
                    <span className="name">
                      {p.name}
                      {isLocked(p) && <Lock size={12} className="muted" style={{ marginLeft: 6, verticalAlign: -1 }} />}
                    </span>
                    <span className="amt" style={{ color: p.hidden ? 'var(--text-muted)' : p.due > 0.004 ? 'var(--danger)' : 'var(--success)' }}>
                      {p.hidden ? 'Locked' : p.due > 0.004 ? money(p.due) : p.due < -0.004 ? `You owe ${money(-p.due)}` : 'Clear'}
                    </span>
                  </div>
                  <div className="meta">
                    {p.phone && <span><Phone size={12} style={{ verticalAlign: -2 }} /> {p.phone}</span>}
                    {!p.hidden && <span>{p.billCount} bill{p.billCount === 1 ? '' : 's'}</span>}
                    {!p.hidden && p.advance > 0 && <span style={{ color: 'var(--success)' }}>Advance {money(p.advance)}</span>}
                    <span className="spacer" />
                    <ChevronRight size={15} className="muted" />
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </Card>

      <Modal open={adding} title="Add New Party" onClose={() => setAdding(false)}>
        <PartyForm onSaved={() => setAdding(false)} onCancel={() => setAdding(false)} />
      </Modal>

      <Modal open={Boolean(editing)} title={`Edit ${editing?.name || 'Party'}`} onClose={() => setEditing(null)}>
        {editing && (
          <PartyForm party={editing} onSaved={() => setEditing(null)} onCancel={() => setEditing(null)} />
        )}
      </Modal>

      <Confirm
        open={Boolean(confirmArchive)}
        title={confirmArchive?.status === 'archived' ? 'Restore party?' : 'Archive party?'}
        message={
          confirmArchive?.status === 'archived'
            ? `"${confirmArchive?.name}" will appear in billing dropdowns again.`
            : `"${confirmArchive?.name}" will be hidden from billing dropdowns. All their bills and history stay intact — nothing is deleted.`
        }
        confirmLabel={confirmArchive?.status === 'archived' ? 'Restore' : 'Archive'}
        onConfirm={doArchive}
        onCancel={() => setConfirmArchive(null)}
      />
    </>
  );
}
