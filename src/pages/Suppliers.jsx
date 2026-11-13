// Suppliers — the parties the shop BUYS from. Mirrors Parties (who the shop
// sells to): search, add, edit, archive, and what is owed each way.

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus, Truck, Pencil, Archive, ArchiveRestore, Phone, ChevronRight, ShoppingCart, Wallet,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import api from '../lib/api';
import {
  Card, Button, Modal, Empty, PageHead, SearchBar, Pill, Confirm, Stat,
} from '../components/ui';
import SupplierForm from '../components/forms/SupplierForm';
import PurchaseBillModal from '../components/forms/PurchaseBillModal';
import { supplierNetBalance, deriveBills } from '../lib/calc';
import { money, norm, r2 } from '../lib/format';

export default function Suppliers() {
  const { data, mutate } = useApp();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(false);
  const [buying, setBuying] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(null);

  // A supplier who is also a customer shows one net figure — the same one as
  // on their ledger and on the Parties list — not purchases alone.
  const all = useMemo(() => {
    const derived = deriveBills(data.bills, data);
    return data.suppliers.map((s) => ({
      ...s,
      balance: supplierNetBalance(s.id, data, derived),
      purchaseCount: data.purchaseBills.filter((b) => b.supplierId === s.id && b.status !== 'voided').length,
    }));
  }, [data]);

  const rows = useMemo(() => {
    const term = norm(q);
    return all
      .filter((s) => (showArchived ? s.status === 'archived' : s.status !== 'archived'))
      .filter((s) => !term || norm(s.name).includes(term) || norm(s.phone).includes(term))
      .sort((a, b) => b.balance - a.balance || a.name.localeCompare(b.name));
  }, [all, q, showArchived]);

  const totals = useMemo(() => ({
    payable: r2(all.reduce((s, x) => s + Math.max(0, x.balance), 0)),
    advance: r2(all.reduce((s, x) => s + Math.max(0, -x.balance), 0)),
  }), [all]);

  const doArchive = async () => {
    const s = confirmArchive;
    setConfirmArchive(null);
    await mutate(() => api.archiveSupplier(s.id),
      s.status === 'archived' ? 'Supplier restored' : 'Supplier archived');
  };

  const balanceCell = (b) => (b > 0.004
    ? <span className="money neg">{money(b)}</span>
    : b < -0.004
      ? <span className="money pos">{money(-b)} advance</span>
      : <Pill status="paid" label="Clear" />);

  return (
    <>
      <PageHead title="Suppliers"
                subtitle={`${rows.length} ${showArchived ? 'archived' : 'active'} supplier${rows.length === 1 ? '' : 's'} — parties you buy from`}>
        <SearchBar value={q} onChange={setQ} placeholder="Search name or phone…" />
        <Button onClick={() => setShowArchived((s) => !s)}>
          {showArchived ? 'Show active' : 'Show archived'}
        </Button>
        <Button icon={ShoppingCart} onClick={() => setBuying(true)}>New Purchase</Button>
        <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Add Supplier</Button>
      </PageHead>

      <div className="stat-grid">
        <Stat label="You owe suppliers" value={money(totals.payable)} icon={Wallet} tone="#DC2626" />
        <Stat label="Advances with suppliers" value={money(totals.advance)} icon={Wallet} tone="#16A34A" />
        <Stat label="Suppliers" value={all.filter((s) => s.status !== 'archived').length} icon={Truck} tone="#D9390B" />
      </div>

      <Card tight>
        {!rows.length ? (
          <Empty
            icon={Truck}
            title={q ? 'No matching suppliers' : showArchived ? 'No archived suppliers' : 'No suppliers yet'}
            message={q ? `Nothing matches "${q}".` : 'Add the parties you buy stock from to keep their khata.'}
            action={!q && !showArchived
              ? <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Add your first supplier</Button>
              : null}
          />
        ) : (
          <>
            <div className="table-wrap hide-mobile">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Supplier</th>
                    <th>Phone</th>
                    <th className="r">Purchases</th>
                    <th className="r">Balance</th>
                    <th style={{ width: 100 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((s) => (
                    <tr key={s.id} className="clickable" onClick={() => nav(`/supplier/${s.id}`)}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{s.name}</div>
                        {s.address && <div className="small muted">{s.address}</div>}
                      </td>
                      <td>{s.phone || <span className="muted">—</span>}</td>
                      <td className="r">{s.purchaseCount}</td>
                      <td className="r strong">{balanceCell(s.balance)}</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <div className="row-actions">
                          <button className="btn btn-ghost btn-sm" title="Edit" onClick={() => setEditing(s)}>
                            <Pencil size={14} />
                          </button>
                          <button className="btn btn-ghost btn-sm"
                                  title={s.status === 'archived' ? 'Restore' : 'Archive'}
                                  onClick={() => setConfirmArchive(s)}>
                            {s.status === 'archived' ? <ArchiveRestore size={14} /> : <Archive size={14} />}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mcards" style={{ padding: 12 }}>
              {rows.map((s) => (
                <div key={s.id} className="mcard" onClick={() => nav(`/supplier/${s.id}`)}>
                  <div className="top">
                    <span className="name">{s.name}</span>
                    <span className="amt" style={{ color: s.balance > 0.004 ? 'var(--danger)' : 'var(--success)' }}>
                      {s.balance > 0.004 ? money(s.balance)
                        : s.balance < -0.004 ? `${money(-s.balance)} adv` : 'Clear'}
                    </span>
                  </div>
                  <div className="meta">
                    {s.phone && <span><Phone size={12} style={{ verticalAlign: -2 }} /> {s.phone}</span>}
                    <span>{s.purchaseCount} purchase{s.purchaseCount === 1 ? '' : 's'}</span>
                    <span className="spacer" />
                    <ChevronRight size={15} className="muted" />
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </Card>

      <Modal open={adding} title="Add New Supplier" onClose={() => setAdding(false)}>
        <SupplierForm onSaved={() => setAdding(false)} onCancel={() => setAdding(false)} />
      </Modal>

      <Modal open={Boolean(editing)} title={`Edit ${editing?.name || 'Supplier'}`} onClose={() => setEditing(null)}>
        {editing && (
          <SupplierForm supplier={editing} onSaved={() => setEditing(null)} onCancel={() => setEditing(null)} />
        )}
      </Modal>

      <PurchaseBillModal open={buying} onClose={() => setBuying(false)} />

      <Confirm
        open={Boolean(confirmArchive)}
        title={confirmArchive?.status === 'archived' ? 'Restore supplier?' : 'Archive supplier?'}
        message={confirmArchive?.status === 'archived'
          ? `"${confirmArchive?.name}" will appear in purchase dropdowns again.`
          : `"${confirmArchive?.name}" will be hidden from purchase dropdowns. Their khata stays intact — nothing is deleted.`}
        confirmLabel={confirmArchive?.status === 'archived' ? 'Restore' : 'Archive'}
        onConfirm={doArchive}
        onCancel={() => setConfirmArchive(null)}
      />
    </>
  );
}
