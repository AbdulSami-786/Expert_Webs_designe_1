// Party Ledger (FR-16 … FR-21 / Plan 5.3).
//
// Due and partially-paid bills sort above paid ones and are coloured by age.
// Each due bill offers Add Payment; every bill offers Add Return.
// Advance balance shows separately from due so "owes you" and "you owe them"
// never get confused. Ledger downloads, and a password-protected read-only
// share link can be generated.
//
// A party can also sell to the shop. "Buy from Party" records a purchase on
// their linked supplier account, and the statement then shows both sides with
// one net balance: positive, they owe the shop; negative, the shop owes them.

import { useEffect, useMemo, useState, Fragment } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  Plus, Download, Share2, Wallet, Send, Phone, Receipt, RotateCcw,
  Pencil, Ban, Copy, Trash2, MoreVertical, Printer, CheckCircle2,
  ChevronRight, ChevronDown, Package, ListOrdered, LayoutList, HandCoins, Search,
  Lock, KeyRound, ShoppingCart, ArrowLeftRight,
} from 'lucide-react';
import { PartyLockScreen, PartyLockModal } from '../components/PartyLock';
import { isLocked, isUnlocked, canOpen, relock } from '../lib/partyLock';
import { useApp } from '../context/AppContext';
import api from '../lib/api';
import {
  Card, Button, Modal, Empty, PageHead, Pill, Money, Field, Input,
  Confirm, BottomSheet, Stat,
} from '../components/ui';
import PaymentModal from '../components/forms/PaymentModal';
import AccountPaymentModal from '../components/forms/AccountPaymentModal';
import EditPaymentModal from '../components/forms/EditPaymentModal';
import PartyItemSearchModal from '../components/forms/PartyItemSearchModal';
import ReturnModal from '../components/forms/ReturnModal';
import PurchaseBillModal from '../components/forms/PurchaseBillModal';
import SupplierPaymentModal from '../components/forms/SupplierPaymentModal';
import BillReceiptModal from '../components/BillReceiptModal';
import {
  deriveBills, partyAdvanceBalance, reorderSuggestion, partyCombinedStatement,
  partyPendingCheques, partyUnappliedCredit, linkedSupplier, supplierBalance, LEDGER_TABS, inLedgerTab,
} from '../lib/calc';
import { money, fmtDate, waLink, shareLink, AGING_META, r2, todayISO } from '../lib/format';
import {
  exportExcel, printReport, raw, escapeHTML, downloadBillPDF,
} from '../lib/exporters';

/**
 * A party with its own password shows a lock screen first. The ledger itself
 * is only mounted once unlocked, so none of its figures reach the screen.
 */
export default function PartyLedger() {
  const { id } = useParams();
  const nav = useNavigate();
  const { data } = useApp();
  const party = data.parties.find((p) => p.id === id);
  // Bumped on unlock/relock so this re-reads the in-memory unlock state.
  const [, setTick] = useState(0);

  // Re-lock when the 10-minute window runs out while the ledger is open.
  useEffect(() => {
    if (!party || !isLocked(party)) return undefined;
    const t = setInterval(() => { if (!isUnlocked(party.id)) setTick((n) => n + 1); }, 15000);
    return () => clearInterval(t);
  }, [party]);

  if (party && !canOpen(party)) {
    return <PartyLockScreen party={party} onUnlocked={() => setTick((n) => n + 1)}
                            onBack={() => nav('/parties')} />;
  }
  return <PartyLedgerView onRelock={() => { relock(id); setTick((n) => n + 1); }} />;
}

function PartyLedgerView({ onRelock }) {
  const { id } = useParams();
  const nav = useNavigate();
  const { data, settings, methods, mutate, toast } = useApp();

  const [lockOpen, setLockOpen] = useState(false);
  const [payFor, setPayFor] = useState(null);
  const [returnFor, setReturnFor] = useState(null);
  const [advanceOpen, setAdvanceOpen] = useState(false);
  // Payment against the whole account, allocated across bills oldest-first
  const [accountPayOpen, setAccountPayOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [sheetFor, setSheetFor] = useState(null);
  const [voidFor, setVoidFor] = useState(null);
  // Which bills have their item breakdown expanded (FR: see what a party bought)
  const [openItems, setOpenItems] = useState({});
  // 'bills' = one row per bill; 'statement' = every single entry, khata style
  const [view, setView] = useState('statement');
  // Which kind of entry the statement shows: all, sales, purchases, …
  const [tab, setTab] = useState('all');
  // Bill whose receipt is open (from the statement's Bill button)
  const [receiptFor, setReceiptFor] = useState(null);
  // Payment being corrected, and the payment/cheque queued for deletion
  const [editPayFor, setEditPayFor] = useState(null);
  const [delPayFor, setDelPayFor] = useState(null);
  const [delChequeFor, setDelChequeFor] = useState(null);
  // Advance queued for deletion — holds the whole record, so the warning can
  // say how much of it has already been spent on bills.
  const [delAdvanceFor, setDelAdvanceFor] = useState(null);
  // An advance receipt whose advance row cannot be found — only the receipt
  // can be removed, so it is confirmed separately and says so.
  const [delOrphanFor, setDelOrphanFor] = useState(null);
  // "What did I charge them for this item last time?"
  const [itemSearchOpen, setItemSearchOpen] = useState(false);
  // Their selling side: buying from them, paying them, and setting one side
  // of the khata off against the other.
  const [buyOpen, setBuyOpen] = useState(false);
  const [payThemOpen, setPayThemOpen] = useState(false);
  const [setOffOpen, setSetOffOpen] = useState(false);
  const [delSupPayFor, setDelSupPayFor] = useState(null);
  const [linking, setLinking] = useState(false);

  const party = data.parties.find((p) => p.id === id);
  const supplier = linkedSupplier(id, data.suppliers);

  const derived = useMemo(() => deriveBills(data.bills, data), [data]);

  /* Due/partial bills first, then paid — each sorted newest first (FR-16) */
  const bills = useMemo(() => {
    const mine = derived.filter((b) => b.partyId === id);
    const rank = (b) => (b.status === 'voided' ? 3 : b.due > 0 ? 0 : 1);
    return mine.sort((a, b) =>
      rank(a) - rank(b) ||
      (rank(a) === 0 ? b.overdueDays - a.overdueDays : 0) ||
      new Date(b.date) - new Date(a.date)
    );
  }, [derived, id]);

  const totals = useMemo(() => {
    const live = bills.filter((b) => b.status !== 'voided');
    // Overpaid money no open bill could take: the party is in credit.
    const credit = partyUnappliedCredit(id, live);
    return {
      billed: r2(live.reduce((s, b) => s + b.net, 0)),
      // Includes the credit, so Total Paid matches the statement's paid column.
      paid: r2(live.reduce((s, b) => s + b.paid, 0) + credit),
      credit,
      due: r2(live.reduce((s, b) => s + b.due, 0)),
      advance: partyAdvanceBalance(id, data.partyAdvances),
      // Cheques the party has handed over that the bank has not cleared.
      // Neither paid nor plainly unpaid, so it is carried separately.
      //
      // Taken from the cheque register, not by summing each bill's share: a
      // cheque received on account belongs to no single bill, and a per-bill
      // sum leaves it out entirely.
      pendingCheques: partyPendingCheques(id, data),
    };
  }, [bills, id, data]);

  // What the shop owes this party for goods bought from them (below zero:
  // money paid to them ahead), and the one figure that settles the account.
  const owedToThem = supplier ? supplierBalance(supplier.id, data) : 0;
  // Same figure as the Suppliers list and the supplier ledger: bills due, less
  // any credit the party holds from overpaying, less what the shop owes them.
  const net = r2(totals.due - (supplier ? totals.credit : 0) - owedToThem);

  const reorder = useMemo(() => reorderSuggestion(id, data.bills), [id, data.bills]);

  /* Every single entry for this party, in date order with a running balance */
  const statement = useMemo(() => partyCombinedStatement(id, data), [id, data]);
  // The tab only hides rows: each one keeps the running balance it has in the
  // full statement, so a filtered line still shows where the account stood.
  const shown = useMemo(() => statement.filter((e) => inLedgerTab(e, tab)), [statement, tab]);
  const tabCount = (t) => statement.filter((e) => inLedgerTab(e, t)).length;
  // One account payment over several bills is one line; opening it lists its
  // parts underneath, each with its own edit and delete.
  const [openGroups, setOpenGroups] = useState({});
  const displayRows = useMemo(() => shown.flatMap((e) => (
    e.parts && openGroups[e.id]
      ? [e, ...e.parts.map((x) => ({ ...x, isPart: true }))]
      : [e]
  )), [shown, openGroups]);

  const shareLink = data.partyLedgerLinks.find((l) => l.partyId === id);

  if (!party) {
    return <Empty title="Party not found" message="This party may have been removed."
                  action={<Button onClick={() => nav('/parties')}>Back to Parties</Button>} />;
  }

  /**
   * What the delete button on a statement line should remove.
   *
   * An advance shows as a receipt line, but the money it represents lives in
   * two rows, so the advance is what has to go. When the advance behind a
   * receipt cannot be identified — amounts edited by hand in the Sheet, a
   * receipt whose advance row was already removed — the receipt itself is
   * still deletable, and offering that beats a greyed-out button with no
   * explanation and no way forward.
   */
  const deleteEntry = (e) => {
    if (!e.isAdvance) return setDelPayFor(e.paymentId);

    const adv = data.partyAdvances.find((a) => a.id === e.advanceId);
    if (adv) return setDelAdvanceFor(adv);
    return setDelOrphanFor(e);
  };

  const itemName = (itemId) => data.items.find((i) => i.id === itemId)?.name || 'Item';

  const linesFor = (billId) => data.billItems.filter((bi) => bi.billId === billId);

  /* ---------------- Exports (FR-20 / FR-52) ---------------- */

  const exportRows = () => bills.map((b) => [
    b.billNo, fmtDate(b.date), b.status,
    b.net.toFixed(2), b.paid.toFixed(2), b.due.toFixed(2),
    b.due > 0 ? fmtDate(b.dueDate) : '',
  ]);

  const onExcel = () => {
    exportExcel(
      `Ledger_${party.name}`,
      ['Bill No', 'Date', 'Status', 'Total', 'Paid', 'Due', 'Due Date'],
      exportRows(),
      [`${settings.shopName} — Party Ledger`, party.name, party.phone || '',
       `Outstanding: ${money(totals.due)}`, ...purchaseMeta]
    );
    toast('Ledger exported');
  };

  const onPDF = () => {
    printReport({
      title: 'Party Ledger',
      subtitle: `${party.name}${party.phone ? ` · ${party.phone}` : ''}`,
      shopName: settings.shopName,
      headers: ['Bill No', 'Date', 'Status',
                { label: 'Total', align: 'r' }, { label: 'Paid', align: 'r' },
                { label: 'Due', align: 'r' }, 'Due Date'],
      rows: bills.map((b) => [
        b.billNo, fmtDate(b.date),
        raw(`<span class="pill pill-${escapeHTML(b.status)}">${escapeHTML(b.status)}</span>`),
        money(b.net), money(b.paid), money(b.due),
        b.due > 0 ? fmtDate(b.dueDate) : '—',
      ]),
      totals: ['', '', 'Total', money(totals.billed), money(totals.paid), money(totals.due), ''],
      meta: [
        ...(totals.advance > 0 ? [`Advance balance: ${money(totals.advance)}`] : []),
        ...purchaseMeta,
      ],
    });
  };

  /** Print the full running statement (FR-52). */
  const onStatementPDF = () => {
    const closing = statement.length ? statement[statement.length - 1].balance : 0;
    printReport({
      title: tab === 'all' ? 'Account Statement'
        : `Account Statement — ${LEDGER_TABS.find((t) => t.value === tab)?.label}`,
      subtitle: `${party.name}${party.phone ? ` · ${party.phone}` : ''}`,
      shopName: settings.shopName,
      headers: ['Date', 'Particulars', 'Method',
                { label: 'Debit', align: 'r' }, { label: 'Credit', align: 'r' },
                { label: 'Balance', align: 'r' }],
      rows: shown.map((e) => [
        fmtDate(e.date),
        e.detail
          ? raw(`${escapeHTML(e.title)}<br/><span style="color:#6B7280;font-size:10px">${escapeHTML(e.detail)}</span>`)
          : e.title,
        e.method || '—',
        e.debit > 0 ? money(e.debit) : '—',
        // Brackets mark a cheque that has not cleared: shown on the statement
        // the party receives, but not deducted from what they owe.
        e.credit > 0 ? money(e.credit) : e.pending > 0 ? `(${money(e.pending)})` : '—',
        money(e.balance),
      ]),
      totals: ['', 'Closing balance', '',
               money(shown.reduce((t, e) => t + e.debit, 0)),
               money(shown.reduce((t, e) => t + e.credit, 0)),
               money(closing)],
    });
  };

  /** Open a purchase from this party, setting up their supplier side the first time. */
  const onBuy = async () => {
    if (linking) return;
    if (supplier) return setBuyOpen(true);
    setLinking(true);
    try {
      const s = await mutate(() => api.linkPartySupplier(id), null);
      if (s?.id) setBuyOpen(true);
    } catch { /* toast shown */ } finally { setLinking(false); }
  };

  const netLabel = net > 0.004 ? `${party.name} owes you`
    : net < -0.004 ? `You owe ${party.name}` : 'Account is settled';
  const purchaseMeta = supplier
    ? [`You owe them (purchases): ${money(owedToThem)}`, `Net: ${netLabel} ${money(Math.abs(net))}`]
    : [];

  const onVoid = async () => {
    const b = voidFor;
    setVoidFor(null);
    // mutate already toasts the reason on failure (e.g. payments still on the bill).
    await mutate(() => api.voidBill(b.id, 'Voided from party ledger'), `Bill ${b.billNo} voided`).catch(() => {});
  };

  const ledgerText = `${settings.shopName}\n${party.name} — Ledger Summary\n\n` +
    `Total billed: ${money(totals.billed)}\nPaid: ${money(totals.paid)}\n` +
    `*Outstanding: ${money(totals.due)}*` +
    (totals.advance > 0 ? `\nAdvance with us: ${money(totals.advance)}` : '') +
    (supplier && Math.abs(owedToThem) > 0.004
      ? `\nWe owe you for purchases: ${money(owedToThem)}`
        + `\n*Net balance: ${money(Math.abs(net))} ${net >= 0 ? 'you owe us' : 'we owe you'}*`
      : '');

  return (
    <>
      <PageHead title={party.name}
                subtitle={[party.phone, party.address].filter(Boolean).join(' · ') || 'Party ledger'}>
        <Button icon={Download} onClick={onExcel}>Excel</Button>
        <Button icon={Printer} onClick={onPDF}>PDF</Button>
        <Button icon={Search} onClick={() => setItemSearchOpen(true)}>Item Prices</Button>
        <Button icon={Share2} onClick={() => setShareOpen(true)}>Share</Button>
        {isLocked(party) && (
          <Button icon={Lock} onClick={onRelock} title="Close and lock this ledger now">Lock now</Button>
        )}
        <Button icon={isLocked(party) ? KeyRound : Lock} onClick={() => setLockOpen(true)}>
          {isLocked(party) ? 'Password' : 'Set Password'}
        </Button>
        <Button icon={Wallet} onClick={() => setAdvanceOpen(true)}>Add Advance</Button>
        <Button icon={ShoppingCart} onClick={onBuy} loading={linking}
                title="Record goods you bought from this party">Buy from Party</Button>
        {supplier && (
          <Button icon={Send} onClick={() => setPayThemOpen(true)}
                  title="Record money you paid this party for goods bought">Pay Party</Button>
        )}
        {supplier && totals.due > 0.004 && owedToThem > 0.004 && (
          <Button icon={ArrowLeftRight} onClick={() => setSetOffOpen(true)}
                  title="Settle sales against purchases without cash">Set Off</Button>
        )}
        <Button variant="primary" icon={HandCoins}
                onClick={() => setAccountPayOpen(true)}>Payment</Button>
        <Button variant="primary" icon={Plus} onClick={() => nav('/bill/new')}>New Bill</Button>
      </PageHead>

      {/* Summary */}
      <div className="stat-grid">
        <Stat label="Total Billed" value={money(totals.billed)} icon={Receipt} tone="#D9390B" />
        <Stat label="Total Paid" value={money(totals.paid)} icon={CheckCircle2} tone="#16A34A" />
        <Stat label="Outstanding" value={money(totals.due)} icon={Receipt} tone="#DC2626"
              note={[
                totals.pendingCheques > 0 ? `${money(totals.pendingCheques)} in uncleared cheques` : '',
                totals.credit > 0 ? `${money(totals.credit)} overpaid — party is in credit` : '',
              ].filter(Boolean).join(' · ') || null}
              noteTone="#EA580C" />
        <Stat label="Advance Balance" value={money(totals.advance)} icon={Wallet} tone="#16A34A" />
        {supplier && (
          <Stat label="You Owe Them (Purchases)" value={money(owedToThem)} icon={ShoppingCart}
                tone="#EA580C" onClick={() => nav(`/supplier/${supplier.id}`)}
                note={owedToThem < -0.004 ? 'Paid ahead — they hold it as advance' : 'Tap for purchase khata'} />
        )}
        {supplier && (
          <Stat label="Net Balance" value={money(Math.abs(net))} icon={ArrowLeftRight}
                tone={net > 0.004 ? '#DC2626' : '#16A34A'} note={netLabel}
                noteTone={net > 0.004 ? '#DC2626' : '#16A34A'} />
        )}
      </div>

      {/* Contact + reorder hint */}
      <div className="row wrap mb-2" style={{ gap: 8 }}>
        {party.phone && (
          <>
            <a className="btn btn-sm" href={`tel:${party.phone}`}><Phone size={13} /> Call</a>
            <a className="btn btn-sm" target="_blank" rel="noreferrer"
               href={waLink(party.phone, ledgerText)}>
              <Send size={13} /> Send ledger on WhatsApp
            </a>
          </>
        )}
        {Number(party.creditLimit) > 0 && (
          <span className={`pill ${totals.due > party.creditLimit ? 'pill-due' : 'pill-neutral'}`}>
            Credit limit {money(party.creditLimit)}
            {totals.due > party.creditLimit ? ' — exceeded' : ''}
          </span>
        )}
        {reorder?.isDue && (
          <span className="pill pill-partial">
            Usually orders every {reorder.avgDays} days — it has been {reorder.sinceDays}
          </span>
        )}
      </div>

      {/* ---------------- View switch ---------------- */}
      <div className="row mb-2" style={{ gap: 8 }}>
        <div className="seg">
          <button className={view === 'statement' ? 'active' : ''}
                  onClick={() => setView('statement')}>
            Full Statement
          </button>
          <button className={view === 'bills' ? 'active' : ''}
                  onClick={() => setView('bills')}>
            Bills Only
          </button>
        </div>
        <span className="small muted">
          {view === 'statement'
            ? (supplier
              ? 'Sales and purchases together, with one running balance — below zero means you owe them'
              : 'Every bill, payment and return as its own entry, with a running balance')
            : 'One row per bill'}
        </span>
      </div>

      {/* ---------------- Full statement (khata) ---------------- */}
      {view === 'statement' && (
        <Card title="Account Statement" tight
              subtitle={`${tab === 'all' ? statement.length : `${shown.length} of ${statement.length}`} entries · closing balance ${money(statement.length ? statement[statement.length - 1].balance : 0)}`}
              actions={<Button size="sm" icon={Printer} onClick={onStatementPDF}>Print</Button>}>
          {statement.length > 0 && (
            <div className="seg" style={{ margin: '10px 12px', flexWrap: 'wrap' }}>
              {LEDGER_TABS
                .filter((t) => supplier || (t.value !== 'purchases' && t.value !== 'paid'))
                .map((t) => (
                  <button key={t.value} className={tab === t.value ? 'active' : ''}
                          onClick={() => setTab(t.value)}>
                    {t.label} <span className="muted small">({tabCount(t.value)})</span>
                  </button>
                ))}
            </div>
          )}
          {statement.length > 0 && !shown.length ? (
            <Empty icon={Receipt} title="Nothing here"
                   message="No entries of this kind for this party." />
          ) : !statement.length ? (
            <Empty icon={Receipt} title="No entries yet"
                   message={`Nothing has been recorded for ${party.name} yet.`}
                   action={<Button variant="primary" onClick={() => nav('/bill/new')}>Create first bill</Button>} />
          ) : (
            <>
              <div className="table-wrap hide-mobile">
                <table className="tbl stmt-tbl">
                  <thead>
                    <tr>
                      <th style={{ width: 96 }}>Date</th>
                      <th>Particulars</th>
                      <th style={{ width: 108 }}>Method</th>
                      <th className="r" style={{ width: 110 }}>Debit (+)</th>
                      <th className="r" style={{ width: 110 }}>Credit (−)</th>
                      <th className="r" style={{ width: 120 }}>Balance</th>
                      {/* Receipt, edit, delete, delete-cheque — icon buttons */}
                      <th style={{ width: 140 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayRows.map((e) => (
                      <tr key={e.isPart ? `part-${e.id}` : e.id}
                          style={e.isPart ? { background: 'var(--neutral-bg)' } : undefined}
                          className={`${e.billId || e.side === 'purchase' || e.parts ? 'clickable' : ''} stmt-${e.type}`}
                          onClick={() => {
                            if (e.parts) setOpenGroups((g) => ({ ...g, [e.id]: !g[e.id] }));
                            else if (e.billId) nav(`/bill/${e.billId}`);
                            else if (e.purchaseBillId) nav(`/purchase/${e.purchaseBillId}`);
                            else if (e.side === 'purchase' && supplier) nav(`/supplier/${supplier.id}`);
                          }}>
                        <td className="nowrap small">{e.isPart ? '' : fmtDate(e.date)}</td>
                        <td style={e.isPart ? { paddingLeft: 28 } : undefined}>
                          <div style={{ fontWeight: e.isPart ? 500 : 600, textDecoration: e.voided ? 'line-through' : 'none' }}>
                            {e.parts && (openGroups[e.id]
                              ? <ChevronDown size={13} style={{ verticalAlign: -2 }} />
                              : <ChevronRight size={13} style={{ verticalAlign: -2 }} />)}{e.parts && ' '}
                            {e.side === 'purchase' && <><Pill status="partial" label="Purchase" />{' '}</>}
                            {e.isPart ? `↳ Bill ${e.billNo || ''}` : e.title}
                          </div>
                          {e.detail && <div className="small muted">{e.detail}</div>}
                        </td>
                        <td className="small">
                          {e.method ? <Pill status="neutral" label={e.method} /> : <span className="muted">—</span>}
                        </td>
                        <td className="r strong">
                          {e.debit > 0 ? <Money value={e.debit} /> : <span className="muted">—</span>}
                        </td>
                        <td className="r strong">
                          {e.credit > 0
                            ? <span className="money pos">{money(e.credit)}</span>
                            : e.pending > 0
                              // Shown but not counted: the cheque is with the
                              // bank, so the balance beside it has not moved.
                              ? <span className="money" style={{ color: '#B45309' }}>
                                  ({money(e.pending)})
                                </span>
                              : e.struck
                                ? <span className="muted small" style={{ textDecoration: 'line-through' }}>
                                    {money(e.originalAmount)}
                                  </span>
                                : <span className="muted">—</span>}
                        </td>
                        <td className="r strong">
                          {/* A part's balance is the joined line's, shown once above. */}
                          {!e.isPart && (
                            <span className="money" style={{ color: e.balance > 0 ? 'var(--danger)' : 'var(--success)' }}>
                              {money(e.balance)}
                            </span>
                          )}
                        </td>
                        <td onClick={(ev) => ev.stopPropagation()}>
                          <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                            {e.billId && (
                              <Button size="sm" icon={Receipt}
                                      onClick={() => setReceiptFor(e.billId)}
                                      title="Open bill receipt" />
                            )}
                            {/* Corrections on the payment behind this line. A
                                reversed payment is already a closed record, so
                                it offers neither. */}
                            {e.paymentId && !e.reversed && (
                              <>
                                {/* An advance receipt has no amount of its own
                                    to edit — it mirrors the advance behind it. */}
                                {!e.isAdvance && (
                                  <Button size="sm" icon={Pencil}
                                          onClick={() => setEditPayFor(e.paymentId)}
                                          title="Edit this payment" />
                                )}
                                {/* An advance line deletes the ADVANCE, not just
                                    this receipt: removing the receipt alone
                                    would leave the party holding a balance with
                                    nothing behind it. */}
                                {/* Never disabled. If the advance behind a
                                    receipt cannot be identified, the receipt
                                    itself is still removable — a dead button
                                    leaves no way out at all. */}
                                <Button size="sm" icon={Trash2}
                                        onClick={() => deleteEntry(e)}
                                        title={e.isAdvance
                                          ? 'Delete this advance'
                                          : 'Delete this payment'} />
                              </>
                            )}
                            {/* Deleting the cheque leaves the payment itself
                                intact, so it is offered separately. */}
                            {e.chequeId && (
                              <Button size="sm" icon={Ban}
                                      onClick={() => setDelChequeFor(e.chequeId)}
                                      title="Delete this cheque record" />
                            )}
                            {e.supplierPaymentId && (
                              <Button size="sm" icon={Trash2}
                                      onClick={() => setDelSupPayFor(e.supplierPaymentId)}
                                      title="Delete this payment to them" />
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={3}>
                        {tab === 'all' ? 'Closing balance' : `Total shown · closing balance`}
                        {statement[statement.length - 1].balance < -0.004 && ' (you owe them)'}
                      </td>
                      <td className="r">{money(shown.reduce((t, e) => t + e.debit, 0))}</td>
                      <td className="r">{money(shown.reduce((t, e) => t + e.credit, 0))}</td>
                      <td className="r" style={{ fontSize: 14 }}>
                        {money(statement[statement.length - 1].balance)}
                      </td>
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* Mobile: each entry as a card */}
              <div className="mcards" style={{ padding: 12 }}>
                {displayRows.map((e) => (
                  <div key={e.isPart ? `part-${e.id}` : e.id} className="mcard"
                       style={e.isPart ? { marginLeft: 18, background: 'var(--neutral-bg)' } : undefined}
                       onClick={() => { if (e.parts) setOpenGroups((g) => ({ ...g, [e.id]: !g[e.id] })); }}>
                    <div className="top">
                      <span className="name" style={{ textDecoration: e.voided ? 'line-through' : 'none' }}>
                        {e.isPart ? `↳ Bill ${e.billNo || ''}` : e.title}
                      </span>
                      <span className="amt" style={{
                        color: e.debit > 0 ? 'var(--danger)'
                             : e.pending > 0 ? '#B45309' : 'var(--success)',
                      }}>
                        {e.debit > 0 ? `+${money(e.debit)}`
                          : e.credit > 0 ? `−${money(e.credit)}`
                          // Bracketed, like the table: received but not cleared,
                          // so it has not reduced the balance.
                          : e.pending > 0 ? `(${money(e.pending)})`
                          : '—'}
                      </span>
                    </div>
                    {e.detail && <div className="small muted">{e.detail}</div>}
                    <div className="meta">
                      <span>{fmtDate(e.date)}</span>
                      {e.method && <Pill status="neutral" label={e.method} />}
                      <span className="spacer" />
                      {e.parts && (
                        <span className="small" style={{ fontWeight: 600 }}>
                          {openGroups[e.id] ? 'Hide bills' : `${e.parts.length} bills`}
                        </span>
                      )}
                      {!e.isPart && <span style={{ fontWeight: 700 }}>Bal {money(e.balance)}</span>}
                    </div>
                    {(e.billId || (e.paymentId && !e.reversed) || e.chequeId || e.supplierPaymentId) && (
                      <div className="row wrap" style={{ gap: 6, marginTop: 8 }}>
                        {e.billId && (
                          <Button size="sm" icon={Receipt}
                                  onClick={(ev) => { ev.stopPropagation(); setReceiptFor(e.billId); }}>
                            View bill
                          </Button>
                        )}
                        {e.paymentId && !e.reversed && (
                          <>
                            {!e.isAdvance && (
                              <Button size="sm" icon={Pencil}
                                      onClick={(ev) => { ev.stopPropagation(); setEditPayFor(e.paymentId); }}>
                                Edit
                              </Button>
                            )}
                            {/* On an advance line this deletes the advance
                                itself, receipt included. */}
                            <Button size="sm" icon={Trash2}
                                    onClick={(ev) => { ev.stopPropagation(); deleteEntry(e); }}>
                              Delete
                            </Button>
                          </>
                        )}
                        {e.chequeId && (
                          <Button size="sm" icon={Ban}
                                  onClick={(ev) => { ev.stopPropagation(); setDelChequeFor(e.chequeId); }}>
                            Delete cheque
                          </Button>
                        )}
                        {e.supplierPaymentId && (
                          <Button size="sm" icon={Trash2}
                                  onClick={(ev) => { ev.stopPropagation(); setDelSupPayFor(e.supplierPaymentId); }}>
                            Delete
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </Card>
      )}

      {/* ---------------- Bills ---------------- */}
      {view === 'bills' && (
      <Card title="Bills" subtitle="Due and partly paid bills are shown first" tight>
        {!bills.length ? (
          <Empty icon={Receipt} title="No bills yet"
                 message={`${party.name} has no bills recorded.`}
                 action={<Button variant="primary" onClick={() => nav('/bill/new')}>Create first bill</Button>} />
        ) : (
          <>
            <div className="table-wrap hide-mobile">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Bill</th>
                    <th>Date</th>
                    <th>Items</th>
                    <th>Status</th>
                    <th>Due date</th>
                    <th className="r">Total</th>
                    <th className="r">Paid</th>
                    <th className="r">Due</th>
                    <th style={{ width: 150 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {bills.map((b) => {
                    const ageCls = b.due > 0 && b.isOverdue ? AGING_META[b.bucket].cls : '';
                    const lines = linesFor(b.id);
                    return (
                      <Fragment key={b.id}>
                      <tr className={`clickable ${ageCls}`} onClick={() => nav(`/bill/${b.id}`)}>
                        <td style={{ fontWeight: 600 }}>{b.billNo}</td>
                        <td className="nowrap">{fmtDate(b.date)}</td>
                        <td onClick={(e) => e.stopPropagation()}>
                          {lines.length ? (
                            <button
                              className="btn btn-sm btn-ghost"
                              onClick={() => setOpenItems((o) => ({ ...o, [b.id]: !o[b.id] }))}
                              title={openItems[b.id] ? 'Hide items' : 'Show what was bought'}
                              style={{ gap: 5 }}
                            >
                              {openItems[b.id] ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                              {lines.length} item{lines.length === 1 ? '' : 's'}
                            </button>
                          ) : (
                            <span className="muted small">—</span>
                          )}
                        </td>
                        <td>
                          <Pill status={b.status} />
                          {b.isOverdue && b.due > 0 && (
                            <div className="small" style={{ color: 'var(--danger)', fontWeight: 600, marginTop: 2 }}>
                              {b.overdueDays}d late
                            </div>
                          )}
                        </td>
                        <td className="nowrap small">{b.due > 0 ? fmtDate(b.dueDate) : <span className="muted">—</span>}</td>
                        <td className="r strong"><Money value={b.net} /></td>
                        <td className="r"><Money value={b.paid} /></td>
                        <td className="r strong">
                          {b.due > 0 ? <span className="money neg">{money(b.due)}</span> : <span className="muted">—</span>}
                        </td>
                        <td onClick={(e) => e.stopPropagation()}>
                          <div className="row-actions">
                            {b.due > 0 && b.status !== 'voided' && (
                              <button className="btn btn-primary btn-sm" onClick={() => setPayFor(b)}>
                                Pay
                              </button>
                            )}
                            {b.status !== 'voided' && (
                              <>
                                <button className="btn btn-ghost btn-sm" title="Add return"
                                        onClick={() => setReturnFor(b)}>
                                  <RotateCcw size={14} />
                                </button>
                                <button className="btn btn-ghost btn-sm" title="Edit bill"
                                        onClick={() => nav(`/bill/${b.id}/edit`)}>
                                  <Pencil size={14} />
                                </button>
                                <button className="btn btn-ghost btn-sm" title="Void bill"
                                        onClick={() => setVoidFor(b)}>
                                  <Ban size={14} color="var(--danger)" />
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>

                      {/* Expanded purchase detail — exactly what this party bought */}
                      {openItems[b.id] && (
                        <tr className="items-detail-row">
                          <td colSpan={9} style={{ padding: 0 }}>
                            <div className="items-detail">
                              <table className="tbl items-detail-tbl">
                                <thead>
                                  <tr>
                                    <th style={{ width: 30 }}>#</th>
                                    <th>Item</th>
                                    <th className="r">Qty</th>
                                    <th>Unit</th>
                                    <th className="r">Rate</th>
                                    <th className="r">Amount</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {lines.map((l, i) => (
                                    <tr key={l.id}>
                                      <td className="muted">{i + 1}</td>
                                      <td style={{ fontWeight: 500 }}>{itemName(l.itemId)}</td>
                                      <td className="r">{l.qty}</td>
                                      <td>{l.unit}</td>
                                      <td className="r"><Money value={l.price} /></td>
                                      <td className="r strong">
                                        <Money value={r2(l.qty * l.price)} />
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                                <tfoot>
                                  <tr>
                                    <td colSpan={5}>
                                      Bill {b.billNo} total
                                      {b.returned > 0 && ` (after ${money(b.returned)} returned)`}
                                    </td>
                                    <td className="r">{money(b.net)}</td>
                                  </tr>
                                </tfoot>
                              </table>

                              <div className="items-detail-actions">
                                <Button size="sm" icon={Receipt}
                                        onClick={() => nav(`/bill/${b.id}`)}>
                                  Open full bill
                                </Button>
                                {b.status !== 'voided' && (
                                  <Button size="sm" icon={Printer}
                                          onClick={() => nav(`/bill/${b.id}`)}>
                                    Print
                                  </Button>
                                )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                      </Fragment>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={5}>Totals</td>
                    <td className="r">{money(totals.billed)}</td>
                    <td className="r">{money(totals.paid)}</td>
                    <td className="r" style={{ color: 'var(--danger)' }}>{money(totals.due)}</td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* Mobile cards — tap opens a bottom sheet of actions */}
            <div className="mcards" style={{ padding: 12 }}>
              {bills.map((b) => (
                <div key={b.id}
                     className={`mcard ${b.due > 0 && b.isOverdue ? AGING_META[b.bucket].mcls : ''}`}
                     onClick={() => setSheetFor(b)}>
                  <div className="top">
                    <span className="name">{b.billNo}</span>
                    <span className="amt">{money(b.net)}</span>
                  </div>
                  <div className="meta">
                    <Pill status={b.status} />
                    <span>{fmtDate(b.date)}</span>
                    {b.due > 0 && (
                      <span style={{ color: 'var(--danger)', fontWeight: 700 }}>
                        {money(b.due)} due{b.isOverdue ? ` · ${b.overdueDays}d late` : ''}
                      </span>
                    )}
                    <span className="spacer" />
                    <MoreVertical size={15} className="muted" />
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </Card>
      )}

      {/* ---------------- Advances ---------------- */}
      {data.partyAdvances.filter((a) => a.partyId === id).length > 0 && (
        <Card title="Advance / Deposit History" tight className="mt-2">
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Date</th><th>Method</th><th>Note</th>
                  <th className="r">Received</th><th className="r">Applied</th><th className="r">Remaining</th>
                  <th style={{ width: 48 }}></th>
                </tr>
              </thead>
              <tbody>
                {data.partyAdvances.filter((a) => a.partyId === id).map((a) => (
                  <tr key={a.id}>
                    <td>{fmtDate(a.dateReceived)}</td>
                    <td>{a.method || 'Cash'}</td>
                    <td className="muted small">{a.note || '—'}</td>
                    <td className="r"><Money value={a.amount} /></td>
                    <td className="r"><Money value={a.applied || 0} /></td>
                    <td className="r strong">
                      <span className="money pos">{money((a.amount || 0) - (a.applied || 0))}</span>
                    </td>
                    <td>
                      <Button size="sm" icon={Trash2}
                              onClick={() => setDelAdvanceFor(a)}
                              title="Delete this advance" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* ---------------- Modals ---------------- */}
      {/* Bill receipt, opened from the statement's Bill button */}
      <BillReceiptModal
        open={Boolean(receiptFor)}
        onClose={() => setReceiptFor(null)}
        bill={receiptFor ? derived.find((b) => b.id === receiptFor) : null}
        lines={receiptFor ? linesFor(receiptFor) : []}
        payments={receiptFor ? data.payments.filter((p) => p.billId === receiptFor) : []}
        cheques={receiptFor ? data.cheques.filter((c) => c.billId === receiptFor) : []}
        returns={receiptFor ? data.returns.filter((r) => r.billId === receiptFor) : []}
        itemName={itemName}
        party={party}
        shopName={settings.shopName}
        onPrint={() => { const id = receiptFor; setReceiptFor(null); nav(`/bill/${id}`); }}
        onPDF={() => {
          const b = derived.find((x) => x.id === receiptFor);
          if (!b) return;
          downloadBillPDF({
            bill: b,
            // printBill reads l.itemName off each line; linesFor returns raw
            // billItems, which carry only itemId, so the names are attached
            // here or every row prints as "Item".
            lines: linesFor(b.id).map((l) => ({ ...l, itemName: itemName(l.itemId) })),
            party,
            payments: data.payments.filter((p) => p.billId === b.id && !p.reversed),
            settings,
            state: b,
          });
        }}
      />

      {/* Price history for any item this party has bought */}
      <PartyItemSearchModal
        open={itemSearchOpen}
        onClose={() => setItemSearchOpen(false)}
        party={party}
        data={data}
      />

      {/* Correct a payment's amount / method / date / note */}
      <EditPaymentModal
        open={Boolean(editPayFor)}
        onClose={() => setEditPayFor(null)}
        payment={editPayFor ? data.payments.find((p) => p.id === editPayFor) : null}
        cheque={editPayFor ? data.cheques.find((c) => c.paymentId === editPayFor) : null}
      />

      {/* Deleting a payment removes any cheque attached to it, so the warning
          says so rather than letting that surface as a surprise afterwards. */}
      <Confirm
        open={Boolean(delPayFor)}
        danger
        title="Delete this payment?"
        confirmLabel="Delete payment"
        message={(() => {
          const p = data.payments.find((x) => x.id === delPayFor);
          if (!p) return '';
          const chq = data.cheques.find((c) => c.paymentId === p.id);
          return `${money(p.amount)} by ${p.method} on ${fmtDate(p.date)} will be `
            + 'removed permanently and the bill will show it as unpaid again.'
            + (chq ? ` The attached cheque ${chq.chequeNo || ''} will be deleted too.` : '')
            + ' This cannot be undone.';
        })()}
        onCancel={() => setDelPayFor(null)}
        onConfirm={async () => {
          const target = delPayFor;
          setDelPayFor(null);
          await mutate(() => api.deletePayment(target), 'Payment deleted').catch(() => {});
        }}
      />

      {/* The payment stays: only the bank instrument is removed. */}
      <Confirm
        open={Boolean(delChequeFor)}
        danger
        title="Delete this cheque record?"
        confirmLabel="Delete cheque"
        message={(() => {
          const c = data.cheques.find((x) => x.id === delChequeFor);
          if (!c) return '';
          return `Cheque ${c.chequeNo || '(no number)'}`
            + `${c.bankName ? ` from ${c.bankName}` : ''} for ${money(c.amount)} will be `
            + 'removed. The payment itself stays and becomes an ordinary '
            + `${c.status === 'cleared' ? 'cleared ' : ''}payment. This cannot be undone.`;
        })()}
        onCancel={() => setDelChequeFor(null)}
        onConfirm={async () => {
          const target = delChequeFor;
          setDelChequeFor(null);
          await mutate(() => api.deleteCheque(target), 'Cheque deleted').catch(() => {});
        }}
      />

      {/* Deleting an advance also removes whatever it already paid for, so any
          bill it settled goes back to unpaid. The warning states that plainly
          rather than letting the shopkeeper discover it on the ledger after. */}
      <Confirm
        open={Boolean(delAdvanceFor)}
        danger
        title="Delete this advance?"
        confirmLabel="Delete advance"
        message={delAdvanceFor
          ? `${money(delAdvanceFor.amount)} received on `
            + `${fmtDate(delAdvanceFor.dateReceived)} will be removed permanently, `
            + 'along with the receipt that recorded it.'
            + (Number(delAdvanceFor.applied) > 0
              ? ` ${money(delAdvanceFor.applied)} of it has already been applied to `
                + 'bills — those payments are removed too, so those bills will '
                + 'show as unpaid again.'
              : '')
            + ' This cannot be undone.'
          : ''}
        onCancel={() => setDelAdvanceFor(null)}
        onConfirm={async () => {
          const target = delAdvanceFor;
          setDelAdvanceFor(null);
          const res = await mutate(() => api.deleteAdvance(target.id), null);
          const n = res?.reopened?.length ?? 0;
          toast(
            `Advance of ${money(target.amount)} deleted`
            + (n ? ` — ${n} bill${n === 1 ? '' : 's'} reopened` : ''),
          );
        }}
      />

      {/* A receipt whose advance row has gone. Only the receipt can be removed,
          and the wording says so rather than implying a balance is being
          corrected. */}
      <Confirm
        open={Boolean(delOrphanFor)}
        danger
        title="Delete this advance receipt?"
        confirmLabel="Delete receipt"
        message={delOrphanFor
          ? `${money(delOrphanFor.originalAmount)} on ${fmtDate(delOrphanFor.date)} `
            + 'will be removed. Its advance record could not be found, so only '
            + 'this receipt line goes. This cannot be undone.'
          : ''}
        onCancel={() => setDelOrphanFor(null)}
        onConfirm={async () => {
          const target = delOrphanFor;
          setDelOrphanFor(null);
          await mutate(
            () => api.deletePayment(target.paymentId, 'Orphaned advance receipt', true),
            'Advance receipt deleted',
          ).catch(() => {});
        }}
      />

      {/* One payment against the whole account, split across bills oldest-first */}
      <AccountPaymentModal
        open={accountPayOpen}
        onClose={(msg) => { setAccountPayOpen(false); if (msg) toast(msg); }}
        party={party}
        bills={bills}
      />

      <PaymentModal
        open={Boolean(payFor)} onClose={() => setPayFor(null)}
        bill={payFor} state={payFor} party={party}
      />

      <ReturnModal
        open={Boolean(returnFor)} onClose={() => setReturnFor(null)}
        bill={returnFor} party={party}
      />

      <AdvanceModal
        open={advanceOpen} onClose={() => setAdvanceOpen(false)}
        party={party} methods={methods} mutate={mutate}
      />

      <ShareModal
        open={shareOpen} onClose={() => setShareOpen(false)}
        party={party} existing={shareLink} mutate={mutate} toast={toast}
      />

      <PartyLockModal open={lockOpen} onClose={() => setLockOpen(false)} party={party} />

      {/* Their selling side — the same dialogs the supplier khata uses */}
      {supplier && (
        <>
          <PurchaseBillModal open={buyOpen} onClose={() => setBuyOpen(false)}
                             supplierId={supplier.id} />
          <SupplierPaymentModal open={payThemOpen} onClose={() => setPayThemOpen(false)}
                                supplierId={supplier.id} />
          <SetOffModal open={setOffOpen} onClose={() => setSetOffOpen(false)}
                       party={party} receivable={totals.due} payable={owedToThem}
                       mutate={mutate} />
        </>
      )}

      <Confirm
        open={Boolean(delSupPayFor)}
        danger
        title="Delete this payment to them?"
        confirmLabel="Delete payment"
        message={(() => {
          const sp = (data.supplierPayments || []).find((x) => x.id === delSupPayFor);
          if (!sp) return '';
          return `${money(sp.amount)} (${sp.method}) on ${fmtDate(sp.date)} will be removed `
            + 'permanently, and you will owe them that much again.'
            + (sp.method === 'Set-off'
              ? ' This was a set-off: the matching Set-off payments on their sale bills stay until you delete those too.'
              : '')
            + ' This cannot be undone.';
        })()}
        onCancel={() => setDelSupPayFor(null)}
        onConfirm={async () => {
          const target = delSupPayFor;
          setDelSupPayFor(null);
          await mutate(() => api.deleteSupplierPayment(target), 'Payment deleted').catch(() => {});
        }}
      />

      <BottomSheet
        open={Boolean(sheetFor)}
        title={sheetFor ? `Bill ${sheetFor.billNo} — ${money(sheetFor.net)}` : ''}
        onClose={() => setSheetFor(null)}
        items={sheetFor ? [
          { label: 'Open bill', icon: Receipt, onClick: () => nav(`/bill/${sheetFor.id}`) },
          ...(sheetFor.due > 0 && sheetFor.status !== 'voided'
            ? [{ label: `Add payment (${money(sheetFor.due)} due)`, icon: Plus, onClick: () => setPayFor(sheetFor) }]
            : []),
          ...(sheetFor.status !== 'voided' ? [
            { label: 'Add return', icon: RotateCcw, onClick: () => setReturnFor(sheetFor) },
            { label: 'Edit bill', icon: Pencil, onClick: () => nav(`/bill/${sheetFor.id}/edit`) },
            { label: 'Void bill', icon: Ban, danger: true, onClick: () => setVoidFor(sheetFor) },
          ] : []),
        ] : []}
      />

      <Confirm
        open={Boolean(voidFor)}
        title="Void this bill?"
        message={`Bill ${voidFor?.billNo} will be marked Voided. It stays in your history with its bill number — nothing is deleted — but it stops counting towards sales and dues.`}
        confirmLabel="Void bill"
        danger
        onConfirm={onVoid}
        onCancel={() => setVoidFor(null)}
      />
    </>
  );
}

/* ==================== Advance modal (Plan 7.2) ==================== */

function AdvanceModal({ open, onClose, party, methods, mutate }) {
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('Cash');
  const [date, setDate] = useState(todayISO());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return; // guard: block a duplicate advance while saving
    if (!(Number(amount) > 0)) return;
    setBusy(true);
    try {
      await mutate(() => api.addAdvance({
        partyId: party.id, amount: Number(amount), method, dateReceived: date, note,
      }), 'Advance recorded');
      setAmount(''); setNote('');
      onClose();
    } catch { /* toast shown */ } finally { setBusy(false); }
  };

  return (
    <Modal open={open} title={`Add Advance — ${party.name}`} onClose={onClose}
           footer={
             <>
               <Button onClick={onClose}>Cancel</Button>
               <Button variant="primary" onClick={submit} loading={busy} disabled={!(Number(amount) > 0)}>
                 Record Advance
               </Button>
             </>
           }>
      <p className="small muted" style={{ marginTop: 0 }}>
        Money received with no bill attached yet. It becomes available to apply against this
        party's next bill.
      </p>
      <Field label="Amount received">
        <Input type="number" min="0" step="any" value={amount} autoFocus
               onChange={(e) => setAmount(e.target.value)} placeholder="0" />
      </Field>
      <div className="form-grid">
        <Field label="Method">
          <select className="select" value={method} onChange={(e) => setMethod(e.target.value)}>
            {methods.filter((m) => m !== 'Cheque').map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </Field>
        <Field label="Date received">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
      </div>
      <Field label="Note">
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
      </Field>
    </Modal>
  );
}

/* ==================== Set-off modal ==================== */

/**
 * Settle sales against purchases without cash. The party's unpaid bills are
 * paid oldest first by a 'Set-off' payment and the same amount is paid to
 * their supplier side, so the net balance does not move — the two halves
 * shrink together.
 */
function SetOffModal({ open, onClose, party, receivable, payable, mutate }) {
  const max = r2(Math.max(0, Math.min(receivable, payable)));
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(todayISO());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) { setAmount(max > 0 ? String(max) : ''); setDate(todayISO()); setNote(''); }
  }, [open, max]);

  const n = Number(amount) || 0;
  const ok = n > 0 && n <= max + 0.004;

  const submit = async () => {
    if (busy || !ok) return;
    setBusy(true);
    try {
      await mutate(() => api.setOffParty({ partyId: party.id, amount: n, date, note }),
        `Set off ${money(n)}`);
      onClose();
    } catch { /* toast shown */ } finally { setBusy(false); }
  };

  return (
    <Modal open={open} title={`Set Off — ${party.name}`} onClose={onClose}
           footer={
             <>
               <Button onClick={onClose}>Cancel</Button>
               <Button variant="primary" onClick={submit} loading={busy} disabled={!ok}>
                 Set off {n > 0 ? money(n) : ''}
               </Button>
             </>
           }>
      <p className="small muted" style={{ marginTop: 0 }}>
        They owe you {money(receivable)} on sales and you owe them {money(payable)} on
        purchases. A set-off cancels the same amount from both sides: their oldest bills
        are marked paid and your purchase dues go down. No cash moves.
      </p>
      <Field label="Amount to set off" hint={`Up to ${money(max)}`}>
        <Input type="number" min="0" step="any" value={amount} autoFocus
               onChange={(e) => setAmount(e.target.value)} placeholder="0" />
      </Field>
      <div className="form-grid">
        <Field label="Date">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Note">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
        </Field>
      </div>
    </Modal>
  );
}

/* ==================== Share link modal (FR-20/21) ==================== */

function ShareModal({ open, onClose, party, existing, mutate, toast }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState(existing?.token || '');

  const url = shareLink(token);

  const create = async () => {
    if (busy) return;
    if (password.length < 6) return toast('Use a password of at least 6 characters', 'error');
    setBusy(true);
    try {
      const res = await mutate(
        () => api.createShareLink(party.id, password),
        'Share link created'
      );
      setToken(res.token);
      setPassword('');
    } catch { /* toast shown */ } finally { setBusy(false); }
  };

  const revoke = async () => {
    setBusy(true);
    try {
      await mutate(() => api.revokeShareLink(party.id), 'Share link revoked');
      setToken('');
    } catch { /* toast shown */ } finally { setBusy(false); }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied');
    } catch {
      toast('Could not copy — select and copy manually', 'error');
    }
  };

  return (
    <Modal open={open} title="Share Ledger" onClose={onClose}>
      <p className="small muted" style={{ marginTop: 0 }}>
        Creates a read-only, password-protected link showing only {party.name}'s bills and
        balances. No edit, print, download or share controls appear on that page.
      </p>

      {token ? (
        <>
          <Field label="Shareable link">
            <div className="input-group">
              <Input value={url} readOnly onFocus={(e) => e.target.select()} />
              <Button icon={Copy} onClick={copy}>Copy</Button>
            </div>
          </Field>
          <div style={{
            padding: '10px 12px', background: 'var(--warning-bg)', border: '1px solid #FDE68A',
            borderRadius: 'var(--r-sm)', fontSize: 12.5, color: '#B45309',
          }}>
            Share the password separately from the link. Anyone with both can view this ledger.
          </div>
          <div className="row mt-2" style={{ justifyContent: 'flex-end' }}>
            <Button variant="danger" icon={Trash2} onClick={revoke} loading={busy}>
              Revoke link
            </Button>
          </div>
        </>
      ) : (
        <>
          <Field label="Set a password" hint="The party enters this to open their ledger">
            <Input type="text" value={password} onChange={(e) => setPassword(e.target.value)}
                   placeholder="At least 6 characters" autoFocus />
          </Field>
          <div className="row" style={{ justifyContent: 'flex-end', gap: 9 }}>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" icon={Share2} onClick={create} loading={busy}>
              Create link
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
