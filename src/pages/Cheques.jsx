// Cheques (FR-28 … FR-30 / Plan 7.1).
//
// Pending cheques are excluded from cash-in-hand until marked Cleared.
// Marking one Bounced automatically reopens the related bill's due balance,
// because billState() ignores payments backed by a bounced cheque.

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CreditCard, Download, CheckCircle2, XCircle, Clock, AlertTriangle, Trash2,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import api from '../lib/api';
import { chequeSiblings } from '../lib/localAdapter';
import {
  Card, Button, Empty, PageHead, SearchBar, Money, Pill, Select, Stat, Confirm,
} from '../components/ui';
import { money, fmtDate, norm, r2, daysBetween } from '../lib/format';
import { exportExcel, printReport, raw, escapeHTML } from '../lib/exporters';

export default function Cheques() {
  const { data, settings, mutate, toast } = useApp();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('all');
  const [bank, setBank] = useState('all');
  const [confirmAction, setConfirmAction] = useState(null);
  // Cheque queued for permanent removal
  const [deleteFor, setDeleteFor] = useState(null);

  const banks = useMemo(
    () => [...new Set(data.cheques.map((c) => c.bankName).filter(Boolean))].sort(),
    [data.cheques]
  );

  const rows = useMemo(() => {
    const term = norm(q);
    return data.cheques
      .map((c) => {
        const party = data.parties.find((p) => p.id === c.partyId);
        const bill = data.bills.find((b) => b.id === c.billId);
        const daysToClear = daysBetween(new Date(), c.dateDue);
        // A cheque saved with no number or bank looks like every other one.
        // The note on its payment often holds those details instead.
        const payNote = data.payments.find((p) => p.id === c.paymentId)?.note || '';
        return {
          ...c,
          party, bill, payNote,
          partyName: party?.name || 'Unknown',
          overdueToClear: c.status === 'pending' && daysToClear < 0,
          daysLate: c.status === 'pending' ? -daysToClear : 0,
        };
      })
      .filter((c) => status === 'all' || c.status === status)
      .filter((c) => bank === 'all' || c.bankName === bank)
      .filter((c) => !term || norm(c.chequeNo).includes(term)
                  || norm(c.partyName).includes(term) || norm(c.bankName).includes(term)
                  || norm(c.accountHolder).includes(term) || norm(c.payNote).includes(term))
      .sort((a, b) => {
        const rank = (x) => (x.status === 'bounced' ? 0 : x.status === 'pending' ? 1 : 2);
        return rank(a) - rank(b) || new Date(b.dateDue) - new Date(a.dateDue);
      });
  }, [data, q, status, bank]);

  const totals = useMemo(() => {
    const sum = (s) => r2(data.cheques.filter((c) => c.status === s)
      .reduce((t, c) => t + (Number(c.amount) || 0), 0));
    return {
      pending: sum('pending'), cleared: sum('cleared'), bounced: sum('bounced'),
      pendingCount: data.cheques.filter((c) => c.status === 'pending').length,
    };
  }, [data.cheques]);

  /**
   * Remove a cheque record outright.
   *
   * The payment it backs is deliberately left in place: deleting the bank
   * instrument must not quietly erase the money. A payment whose cheque is
   * gone counts as ordinary money of its method, which is why a pending
   * cheque's bill reads as paid once the record is deleted.
   */
  const deleteChequeNow = async () => {
    const c = deleteFor;
    setDeleteFor(null);
    await mutate(() => api.deleteCheque(c.id), `Cheque ${c.chequeNo || ''} deleted`).catch(() => {});
  };

  // Rows of the same physical cheque, which change status together.
  const confirmSiblings = confirmAction ? chequeSiblings(data.cheques, confirmAction.cheque) : [];

  const setStatusFor = async () => {
    const { cheque, newStatus } = confirmAction;
    setConfirmAction(null);
    await mutate(() => api.setChequeStatus(cheque.id, newStatus),
      `Cheque ${cheque.chequeNo} marked ${newStatus}`).catch(() => {});
  };

  const onExcel = () => {
    exportExcel('Cheques',
      ['Cheque No', 'Bank', 'Account holder', 'Party', 'Bill', 'Issued', 'Clears On', 'Status', 'Amount', 'Note'],
      rows.map((c) => [c.chequeNo, c.bankName, c.accountHolder || '', c.partyName, c.bill?.billNo || '',
                       fmtDate(c.dateIssued), fmtDate(c.dateDue), c.status,
                       Number(c.amount).toFixed(2), c.note || '']),
      [`${settings.shopName} — Cheques`,
       `Pending ${money(totals.pending)} · Cleared ${money(totals.cleared)} · Bounced ${money(totals.bounced)}`]);
    toast('Cheques exported');
  };

  const onPDF = () => printReport({
    title: 'Cheque Report', subtitle: `${rows.length} cheques`, shopName: settings.shopName,
    headers: ['Cheque No', 'Bank', 'Account holder', 'Party', 'Issued', 'Clears On', 'Status', { label: 'Amount', align: 'r' }],
    rows: rows.map((c) => [c.chequeNo, c.bankName, c.accountHolder || '', c.partyName, fmtDate(c.dateIssued),
      fmtDate(c.dateDue), raw(`<span class="pill pill-${c.status === 'cleared' ? 'paid' : c.status === 'bounced' ? 'due' : 'partial'}">${escapeHTML(c.status)}</span>`),
      money(c.amount)]),
  });

  return (
    <>
      <PageHead title="Cheques"
                subtitle={`${totals.pendingCount} pending clearance worth ${money(totals.pending)}`}>
        <SearchBar value={q} onChange={setQ} placeholder="Cheque no, party, bank…" />
        <Select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 140 }}
                options={[
                  { value: 'all', label: 'All statuses' },
                  { value: 'pending', label: 'Pending' },
                  { value: 'cleared', label: 'Cleared' },
                  { value: 'bounced', label: 'Bounced' },
                ]} />
        <Select value={bank} onChange={(e) => setBank(e.target.value)} style={{ width: 140 }}>
          <option value="all">All banks</option>
          {banks.map((b) => <option key={b} value={b}>{b}</option>)}
        </Select>
        <Button icon={Download} onClick={onExcel}>Excel</Button>
      </PageHead>

      <div className="stat-grid">
        <Stat label="Pending Clearance" value={money(totals.pending)} icon={Clock} tone="#F59E0B" />
        <Stat label="Cleared" value={money(totals.cleared)} icon={CheckCircle2} tone="#16A34A" />
        <Stat label="Bounced" value={money(totals.bounced)} icon={XCircle} tone="#DC2626" />
      </div>

      {totals.pending > 0 && (
        <div style={{
          padding: '10px 13px', background: 'var(--info-bg)', border: '1px solid #BFDBFE',
          borderRadius: 'var(--r)', marginBottom: 16, fontSize: 13, color: '#1D4ED8',
          display: 'flex', gap: 8, alignItems: 'center',
        }}>
          <AlertTriangle size={15} style={{ flex: 'none' }} />
          <span>
            {money(totals.pending)} in pending cheques is <strong>not</strong> counted as cash in hand
            until you mark each one Cleared.
          </span>
        </div>
      )}

      <Card tight>
        {!rows.length ? (
          <Empty icon={CreditCard} title={q || status !== 'all' ? 'No matching cheques' : 'No cheques yet'}
                 message={q || status !== 'all'
                   ? 'Try a different filter.'
                   : 'Cheques recorded as a payment method will appear here.'} />
        ) : (
          <>
            <div className="table-wrap hide-mobile">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Cheque No</th><th>Bank</th><th>Account holder</th><th>Party</th><th>Bill</th>
                    <th>Issued</th><th>Clears on</th><th>Status</th>
                    <th className="r">Amount</th><th style={{ width: 150 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => (
                    <tr key={c.id} className={c.status === 'bounced' ? 'age-30' : c.overdueToClear ? 'age-8' : ''}>
                      <td style={{ fontWeight: 600 }}>
                        {c.chequeNo || '—'}
                        {!c.chequeNo && c.payNote && (
                          <div className="small muted" style={{ fontWeight: 400 }}>{c.payNote}</div>
                        )}
                      </td>
                      <td>{c.bankName || '—'}</td>
                      <td>{c.accountHolder || '—'}</td>
                      <td className="clickable" onClick={() => c.party && nav(`/party/${c.party.id}`)}>
                        {c.partyName}
                      </td>
                      <td className="clickable" onClick={() => c.bill && nav(`/bill/${c.bill.id}`)}>
                        {c.bill?.billNo || '—'}
                      </td>
                      <td className="nowrap small">{fmtDate(c.dateIssued)}</td>
                      <td className="nowrap small">
                        {fmtDate(c.dateDue)}
                        {c.overdueToClear && (
                          <div style={{ color: 'var(--danger)', fontWeight: 600 }}>
                            {c.daysLate}d past
                          </div>
                        )}
                      </td>
                      <td>
                        <Pill status={c.status === 'cleared' ? 'cleared' : c.status === 'bounced' ? 'bounced' : 'partial'}
                              label={c.status === 'pending' ? 'Pending' : c.status === 'cleared' ? 'Cleared' : 'Bounced'} />
                      </td>
                      <td className="r strong"><Money value={c.amount} /></td>
                      <td>
                        <div className="row-actions">
                          {c.status !== 'cleared' && (
                            <button className="btn btn-success btn-sm"
                                    onClick={() => setConfirmAction({ cheque: c, newStatus: 'cleared' })}>
                              Cleared
                            </button>
                          )}
                          {c.status !== 'bounced' && (
                            <button className="btn btn-danger btn-sm"
                                    onClick={() => setConfirmAction({ cheque: c, newStatus: 'bounced' })}>
                              Bounced
                            </button>
                          )}
                          {c.status !== 'pending' && (
                            <button className="btn btn-ghost btn-sm" title="Back to pending"
                                    onClick={() => setConfirmAction({ cheque: c, newStatus: 'pending' })}>
                              <Clock size={14} />
                            </button>
                          )}
                          <button className="btn btn-ghost btn-sm" title="Delete this cheque record"
                                  onClick={() => setDeleteFor(c)}>
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mcards" style={{ padding: 12 }}>
              {rows.map((c) => (
                <div key={c.id} className={`mcard ${c.status === 'bounced' ? 'due-30' : c.overdueToClear ? 'due-8' : ''}`}>
                  <div className="top">
                    <span className="name">{c.chequeNo || c.payNote || 'Cheque'}</span>
                    <span className="amt">{money(c.amount)}</span>
                  </div>
                  <div className="meta">
                    <Pill status={c.status === 'cleared' ? 'cleared' : c.status === 'bounced' ? 'bounced' : 'partial'}
                          label={c.status === 'pending' ? 'Pending' : c.status === 'cleared' ? 'Cleared' : 'Bounced'} />
                    <span>{c.partyName}</span>
                    <span>{c.bankName}</span>
                    {c.accountHolder && <span>{c.accountHolder}</span>}
                    <span>Clears {fmtDate(c.dateDue)}</span>
                  </div>
                  <div className="row" style={{ gap: 7 }}>
                    {c.status !== 'cleared' && (
                      <Button size="sm" variant="success" style={{ flex: 1 }}
                              onClick={() => setConfirmAction({ cheque: c, newStatus: 'cleared' })}>
                        Cleared
                      </Button>
                    )}
                    {c.status !== 'bounced' && (
                      <Button size="sm" variant="danger" style={{ flex: 1 }}
                              onClick={() => setConfirmAction({ cheque: c, newStatus: 'bounced' })}>
                        Bounced
                      </Button>
                    )}
                    <Button size="sm" icon={Trash2} title="Delete this cheque record"
                            onClick={() => setDeleteFor(c)} />
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </Card>

      <Confirm
        open={Boolean(confirmAction)}
        title={
          confirmAction?.newStatus === 'bounced' ? 'Mark cheque as bounced?'
          : confirmAction?.newStatus === 'cleared' ? 'Mark cheque as cleared?'
          : 'Move cheque back to pending?'
        }
        message={(
          confirmAction?.newStatus === 'bounced'
            ? `Cheque ${confirmAction?.cheque.chequeNo} for ${money(confirmAction?.cheque.amount)} will be marked Bounced. The related bill's due balance reopens automatically and ${confirmAction?.cheque.partyName} is flagged.`
            : confirmAction?.newStatus === 'cleared'
            ? `Cheque ${confirmAction?.cheque.chequeNo} for ${money(confirmAction?.cheque.amount)} will count towards cash in hand from now on.`
            : `Cheque ${confirmAction?.cheque.chequeNo} goes back to Pending and stops counting as cash.`
        ) + (confirmSiblings.length > 1
          ? ` This cheque is split across ${confirmSiblings.length} bills (${money(
              confirmSiblings.reduce((t, c) => t + (Number(c.amount) || 0), 0))} in total); all of them change together.`
          : '')
        }
        confirmLabel={confirmAction?.newStatus === 'bounced' ? 'Mark bounced' : 'Confirm'}
        danger={confirmAction?.newStatus === 'bounced'}
        onConfirm={setStatusFor}
        onCancel={() => setConfirmAction(null)}
      />

      {/* Deleting the record leaves the payment behind, which changes what the
          bill reads as paid. The warning says so outright rather than letting
          that turn up as a surprise on the ledger afterwards. */}
      <Confirm
        open={Boolean(deleteFor)}
        danger
        title="Delete this cheque record?"
        confirmLabel="Delete cheque"
        message={deleteFor
          ? `Cheque ${deleteFor.chequeNo || '(no number)'}`
            + `${deleteFor.bankName ? ` from ${deleteFor.bankName}` : ''}`
            + ` for ${money(deleteFor.amount)} will be removed permanently. `
            + 'The payment behind it stays and becomes an ordinary payment'
            + (deleteFor.status !== 'cleared'
              ? ', so the bill it belongs to will read as paid.'
              : '.')
            + ' This cannot be undone.'
          : ''}
        onConfirm={deleteChequeNow}
        onCancel={() => setDeleteFor(null)}
      />
    </>
  );
}
