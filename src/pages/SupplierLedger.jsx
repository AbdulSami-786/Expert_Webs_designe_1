// One supplier's khata: what the shop owes them, every purchase bill, every
// payment and every return, with a running balance.

import { useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, ShoppingCart, Wallet, Undo2, Pencil, Download, Printer, Trash2, Ban, Truck, Phone,
  HandCoins, ListChecks, Receipt, Link2,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import api from '../lib/api';
import {
  Card, Button, Modal, Empty, PageHead, Pill, Confirm, Stat, RangePicker, Money, Field, Input,
  SearchBar, Select,
} from '../components/ui';
import AccountPaymentModal from '../components/forms/AccountPaymentModal';
import PurchaseEditModal from '../components/forms/PurchaseEditModal';
import SupplierForm from '../components/forms/SupplierForm';
import PurchaseBillModal from '../components/forms/PurchaseBillModal';
import SupplierPaymentModal from '../components/forms/SupplierPaymentModal';
import SupplierReturnModal from '../components/forms/SupplierReturnModal';
import LineDeliveryModal, { DeliveredCount } from '../components/forms/LineDeliveryModal';
import {
  supplierBalance, derivePurchaseBills, supplierCombinedStatement, purchaseBillLines, rangeFor,
  purchaseReceipt, lineReceivedQty, LEDGER_TABS, inLedgerTab, supplierNetBalance, deriveBills,
} from '../lib/calc';
import { money, fmtDate, r2, norm } from '../lib/format';
import { exportExcel, printReport } from '../lib/exporters';

export default function SupplierLedger() {
  const { id } = useParams();
  const nav = useNavigate();
  const { data, settings, mutate, toast } = useApp();

  const [preset, setPreset] = useState('all');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [dialog, setDialog] = useState(null);       // 'buy' | 'pay' | 'advance' | 'return' | 'edit'
  const [payBillId, setPayBillId] = useState('');
  const [openBillId, setOpenBillId] = useState(null); // purchase bill shown in detail
  const [q, setQ] = useState('');
  const [editLine, setEditLine] = useState(null);   // purchase line being corrected
  const [deleteLine, setDeleteLine] = useState(null);
  const [voiding, setVoiding] = useState(null);
  const [voidReason, setVoidReason] = useState('');
  const [deleting, setDeleting] = useState(null);   // statement row to delete
  const [receiving, setReceiving] = useState(false); // ticking off goods that arrived
  const [tab, setTab] = useState('all');             // which kind of entry the ledger shows
  const [linkTo, setLinkTo] = useState('');          // party chosen in the link bar
  const [busy, setBusy] = useState(false);
  const [receiveOpen, setReceiveOpen] = useState(false); // money in from them as a customer

  const supplier = data.suppliers.find((s) => s.id === id);
  const range = useMemo(() => rangeFor(preset, custom), [preset, custom]);

  // `ownBalance` is purchases alone (what Pay Supplier works from); `balance`
  // is the whole account, with sales to a linked customer netted in.
  const ownBalance = supplierBalance(id, data);
  const balance = supplierNetBalance(id, data);
  const bills = useMemo(() => derivePurchaseBills(id, data), [id, data]);
  // Purchases, payments and returns — and, when this supplier is also a
  // customer, their sales too, so both ledgers hold the same entries.
  const allRows = useMemo(() => supplierCombinedStatement(id, data, range.from, range.to), [id, data, range]);
  const linkedParty = supplier?.partyId ? data.parties.find((p) => p.id === supplier.partyId) : null;
  const tabOpts = { supplierView: true };

  // Not linked yet: a party of the same name is almost certainly the same
  // business, so it is offered first.
  const key = (x) => String(x || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const sameNameParty = !linkedParty && supplier
    ? data.parties.find((p) => key(p.name) === key(supplier.name)
        && !data.suppliers.some((x) => x.partyId === p.id))
    : null;
  const freeParties = useMemo(() => data.parties
    .filter((p) => p.status !== 'archived' && !data.suppliers.some((x) => x.partyId === p.id))
    .sort((a, b) => String(a.name).localeCompare(String(b.name))), [data.parties, data.suppliers]);

  // Their sales bills, for receiving a payment from them right here.
  const partyBills = useMemo(() => (linkedParty
    ? deriveBills(data.bills, data).filter((b) => b.partyId === linkedParty.id)
    : []), [linkedParty, data]);

  // Looked up by id so the detail view shows fresh totals after a line is
  // edited, and closes by itself if deleting its last line removed the bill.
  const openBill = bills.find((b) => b.id === openBillId) || null;
  const setOpenBill = (b) => setOpenBillId(b ? b.id : null);

  // One search over both lists: a bill matches on its number, invoice, note,
  // date, amounts or any item on it; a ledger entry on its text or amounts.
  const term = norm(q);
  const shownBills = useMemo(() => {
    if (!term) return bills;
    const nameOf = (itemId) => data.items.find((i) => i.id === itemId)?.name || '';
    return bills.filter((b) => norm([
      b.purchaseNo, b.invoiceNo, b.note, b.voidReason, fmtDate(b.date), b.date, b.total, b.due,
      ...purchaseBillLines(b.id, data).map((l) => `${nameOf(l.itemId)} ${l.qty} ${l.costPrice}`),
    ].filter((v) => v !== undefined && v !== null).join(' ')).includes(term));
  }, [bills, term, data]);
  const tabRows = useMemo(() => allRows.filter((r) => inLedgerTab(r, tab, tabOpts)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allRows, tab]);
  const rows = useMemo(() => (!term ? tabRows : tabRows.filter((r) => norm([
    r.title, r.detail, r.debit, r.credit, r.date ? fmtDate(r.date) : '', r.date,
  ].filter(Boolean).join(' ')).includes(term))), [tabRows, term]);

  const totals = useMemo(() => ({
    bought: r2(bills.filter((b) => b.status !== 'voided').reduce((s, b) => s + b.total, 0)),
    paid: r2(data.supplierPayments.filter((p) => p.supplierId === id)
      .reduce((s, p) => s + (Number(p.amount) || 0), 0)),
    returned: r2(data.supplierReturns.filter((r) => r.supplierId === id)
      .reduce((s, r) => s + (Number(r.value) || 0), 0)),
  }), [bills, data, id]);

  if (!supplier) {
    return (
      <Card>
        <Empty icon={Truck} title="Supplier not found"
               action={<Button onClick={() => nav('/suppliers')}>Back to suppliers</Button>} />
      </Card>
    );
  }

  const balanceLabel = balance > 0.004 ? 'You owe'
    : balance < -0.004 ? (linkedParty ? 'They owe you' : 'Advance they hold') : 'Account clear';

  const headers = linkedParty
    ? ['Date', 'Entry', 'Detail', 'You owe more (+)', 'You owe less (−)', 'Balance']
    : ['Date', 'Entry', 'Detail', 'Purchased (+)', 'Paid / Returned (−)', 'Balance'];
  const exportRows = rows.map((r) => [
    r.type === 'opening' ? '' : fmtDate(r.date), r.title, r.detail || '',
    r.debit ? r.debit.toFixed(2) : '', r.credit ? r.credit.toFixed(2) : '', r.balance.toFixed(2),
  ]);

  const onExcel = () => {
    exportExcel(`Supplier ${supplier.name}`, headers, exportRows,
      [`${settings.shopName} — Supplier ledger: ${supplier.name}`, `${balanceLabel}: ${money(Math.abs(balance))}`]);
    toast('Ledger exported');
  };

  const onPrint = () => printReport({
    title: `Supplier Ledger — ${supplier.name}`,
    subtitle: [supplier.phone, supplier.address].filter(Boolean).join(' · '),
    shopName: settings.shopName,
    headers: headers.map((h, i) => (i >= 3 ? { label: h, align: 'r' } : h)),
    rows: exportRows,
    meta: [`${balanceLabel}: ${money(Math.abs(balance))}`],
  });

  const doVoid = async () => {
    const b = voiding;
    setVoiding(null);
    await mutate(() => api.voidPurchaseBill(b.id, voidReason), `Purchase ${b.purchaseNo} cancelled`)
      .catch(() => {});
    setVoidReason('');
    setOpenBill(null);
  };

  const doDelete = async () => {
    const r = deleting;
    setDeleting(null);
    if (r.type === 'payment') {
      await mutate(() => api.deleteSupplierPayment(r.paymentId), 'Payment deleted').catch(() => {});
    } else if (r.type === 'return') {
      await mutate(() => api.deleteSupplierReturn(r.returnId), 'Return deleted').catch(() => {});
    }
  };

  const doDeleteLine = async () => {
    const l = deleteLine;
    setDeleteLine(null);
    await mutate(() => api.deletePurchase(l.id), 'Purchase line deleted').catch(() => {});
  };

  const linkParty = async (partyId) => {
    if (!partyId || busy) return null;
    setBusy(true);
    try {
      await mutate(() => api.linkPartySupplier(partyId, supplier.id), 'Linked — their sales now show here');
      setLinkTo('');
      return partyId;
    } catch { return null; } finally { setBusy(false); }
  };

  /**
   * Sell to this supplier. Selling needs a party, so the first sale links one:
   * the party of the same name if there is one, otherwise a new party made
   * from this supplier's details.
   */
  const onSell = async () => {
    if (linkedParty) return nav(`/bill/new?party=${linkedParty.id}`);
    if (busy) return;
    let partyId = sameNameParty?.id;
    if (!partyId) {
      setBusy(true);
      try {
        const p = await mutate(() => api.saveParty({
          name: supplier.name, phone: supplier.phone || '', address: supplier.address || '',
        }), null);
        partyId = p?.id;
      } catch { partyId = null; } finally { setBusy(false); }
    }
    if (partyId && await linkParty(partyId)) nav(`/bill/new?party=${partyId}`);
  };

  const openLines = openBill ? purchaseBillLines(openBill.id, data) : [];

  /** One purchase bill on paper: its lines, total, paid and due. */
  const printPurchase = (b) => {
    const ls = purchaseBillLines(b.id, data);
    const unitOf = (itemId) => data.items.find((i) => i.id === itemId)?.baseUnit || '';
    printReport({
      title: `Purchase ${b.purchaseNo}`,
      subtitle: [supplier.name, supplier.phone].filter(Boolean).join(' · '),
      shopName: settings.shopName,
      headers: ['Item', { label: 'Qty', align: 'r' }, { label: 'Cost', align: 'r' },
                { label: 'Total', align: 'r' }],
      rows: ls.map((l) => [
        data.items.find((i) => i.id === l.itemId)?.name || 'Item',
        `${l.qty} ${unitOf(l.itemId)}`.trim(), money(l.costPrice), money(r2(l.qty * l.costPrice)),
      ]),
      totals: ['Total', '', '', money(b.total)],
      meta: [
        `Date: ${fmtDate(b.date)}`,
        ...(b.invoiceNo ? [`Supplier invoice: ${b.invoiceNo}`] : []),
        `Paid: ${money(b.paid)}`, `Due: ${money(b.due)}`,
        ...(b.status === 'voided' ? ['CANCELLED'] : []),
        ...(b.note ? [`Note: ${b.note}`] : []),
      ],
    });
  };
  const itemName = (itemId) => data.items.find((i) => i.id === itemId)?.name || 'Item';

  return (
    <>
      <PageHead title={supplier.name}
                subtitle={[supplier.phone, supplier.address, supplier.status === 'archived' ? 'Archived' : '']
                  .filter(Boolean).join(' · ') || 'Supplier'}>
        <Button icon={ArrowLeft} onClick={() => nav('/suppliers')}>Suppliers</Button>
        {/* This supplier is also a customer: their full khata nets both sides. */}
        {supplier.partyId && data.parties.some((p) => p.id === supplier.partyId) && (
          <Button icon={HandCoins} onClick={() => nav(`/party/${supplier.partyId}`)}>
            Party Ledger (net)
          </Button>
        )}
        <Button icon={Pencil} onClick={() => setDialog('edit')}>Edit</Button>
        <Button icon={Download} onClick={onExcel}>Excel</Button>
        <Button icon={Printer} onClick={onPrint}>Print</Button>
      </PageHead>

      <div className="row mb-2" style={{ gap: 8, flexWrap: 'wrap' }}>
        <Button variant="primary" icon={ShoppingCart} onClick={() => setDialog('buy')}>New Purchase</Button>
        <Button icon={Wallet} onClick={() => { setPayBillId(''); setDialog('pay'); }}>Pay Supplier</Button>
        <Button icon={HandCoins} onClick={() => setDialog('advance')}>Give Advance</Button>
        <Button icon={Undo2} onClick={() => setDialog('return')}>Return Goods</Button>
        <Button icon={Receipt} onClick={onSell} loading={busy}
                title="Sell goods to this supplier">New Sale</Button>
        {linkedParty && (
          <Button icon={Wallet} onClick={() => setReceiveOpen(true)}
                  title="Money received from them for goods you sold them">Receive Payment</Button>
        )}
        {supplier.phone && (
          <a className="btn" href={`tel:${supplier.phone}`}><Phone size={15} /> Call</a>
        )}
        <span className="spacer" />
        <SearchBar value={q} onChange={setQ} placeholder="Search item, PUR no, invoice, note…"
                   style={{ minWidth: 240 }} />
      </div>

      {/* Not linked to a party: offer it, so their sales show on this page. */}
      {!linkedParty && (
        <Card tight>
          <div className="row wrap" style={{ gap: 8, padding: '10px 12px', alignItems: 'center' }}>
            <Link2 size={16} />
            <span className="small" style={{ flex: '1 1 240px' }}>
              {sameNameParty
                ? <>Party <strong>{sameNameParty.name}</strong> has the same name. Link them to see sales and purchases together.</>
                : 'Do you also sell to this supplier? Link them to their party to see sales and purchases together.'}
            </span>
            {sameNameParty ? (
              <Button size="sm" variant="primary" icon={Link2} loading={busy}
                      onClick={() => linkParty(sameNameParty.id)}>Link</Button>
            ) : (
              <>
                <Select value={linkTo} onChange={(e) => setLinkTo(e.target.value)} style={{ width: 200 }}>
                  <option value="">Choose a party…</option>
                  {freeParties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>
                <Button size="sm" variant="primary" icon={Link2} loading={busy} disabled={!linkTo}
                        onClick={() => linkParty(linkTo)}>Link</Button>
              </>
            )}
          </div>
        </Card>
      )}

      <div className="stat-grid">
        {/* One figure for the whole account. Also a customer: their sales are
            netted in, so this matches the Suppliers list, the party ledger's
            Net Balance and the last line of the ledger below. */}
        <Stat label={balanceLabel} value={money(Math.abs(balance))}
              icon={linkedParty ? HandCoins : Wallet}
              tone={balance > 0.004 ? '#DC2626' : '#16A34A'}
              note={linkedParty
                ? (balance > 0.004 ? `You owe ${linkedParty.name}`
                  : balance < -0.004 ? `${linkedParty.name} owes you` : 'Account is settled')
                  + (Math.abs(ownBalance - balance) > 0.004
                    ? ` · purchases alone: ${ownBalance > 0.004 ? `you owe ${money(ownBalance)}`
                      : ownBalance < -0.004 ? `advance ${money(-ownBalance)}` : 'clear'}`
                    : '')
                : undefined}
              onClick={linkedParty ? () => nav(`/party/${linkedParty.id}`) : undefined} />
        <Stat label="Total purchased" value={money(totals.bought)} icon={ShoppingCart} tone="#D9390B" />
        <Stat label="Total paid" value={money(totals.paid)} icon={Wallet} tone="#16A34A" />
        <Stat label="Returned to supplier" value={money(totals.returned)} icon={Undo2} tone="#F59E0B" />
      </div>

      <Card title="Purchase bills" subtitle="Payments made against a bill settle that bill; other payments settle the oldest first" tight>
        {bills.length > 0 && !shownBills.length ? (
          <Empty icon={ShoppingCart} title="No matching purchases" message={`Nothing matches "${q}".`} />
        ) : !bills.length ? (
          <Empty icon={ShoppingCart} title="No purchases yet"
                 message="Record stock bought from this supplier."
                 action={<Button variant="primary" icon={ShoppingCart} onClick={() => setDialog('buy')}>New Purchase</Button>} />
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Purchase</th><th>Date</th><th>Invoice</th>
                  <th className="r">Total</th><th className="r">Paid</th><th className="r">Due</th>
                  <th>Status</th><th style={{ width: 90 }}></th>
                </tr>
              </thead>
              <tbody>
                {shownBills.map((b) => (
                  <tr key={b.id} className="clickable" onClick={() => nav(`/purchase/${b.id}`)}>
                    <td className="strong">{b.purchaseNo}</td>
                    <td className="nowrap">{fmtDate(b.date)}</td>
                    <td>{b.invoiceNo || <span className="muted">—</span>}</td>
                    <td className="r"><Money value={b.total} /></td>
                    <td className="r"><Money value={b.paid} /></td>
                    <td className="r strong">{b.due > 0 ? <span className="money neg">{money(b.due)}</span> : '—'}</td>
                    <td>
                      <Pill status={b.status} label={b.status === 'voided' ? 'Cancelled' : undefined} />
                      {b.status !== 'voided' && (() => {
                        const r = purchaseReceipt(purchaseBillLines(b.id, data)).state;
                        return r === 'received' ? null : (
                          <div style={{ marginTop: 3 }}>
                            <Pill status={r === 'partial' ? 'part-received' : 'not-received'} />
                          </div>
                        );
                      })()}
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      {b.status !== 'voided' && b.due > 0 && (
                        <Button size="sm" onClick={() => { setPayBillId(b.id); setDialog('pay'); }}>Pay</Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="mt-2 mb-2">
        <RangePicker value={preset} onChange={setPreset} custom={custom} onCustomChange={setCustom}
                     presets={[{ value: 'all', label: 'All time' }, { value: 'month', label: 'This month' },
                               { value: 'lastMonth', label: 'Last month' }]} />
      </div>

      <Card title="Ledger" tight
            subtitle={linkedParty
              ? `Purchases and sales to ${linkedParty.name} together — balance is what you owe them, net`
              : 'Purchases add to what you owe; payments and returns reduce it'}>
        <div className="seg" style={{ margin: '10px 12px', flexWrap: 'wrap' }}>
          {LEDGER_TABS
            .map((t) => (
              <button key={t.value} className={tab === t.value ? 'active' : ''}
                      onClick={() => setTab(t.value)}>
                {t.label} <span className="muted small">({allRows.filter((r) => inLedgerTab(r, t.value, tabOpts)).length})</span>
              </button>
            ))}
        </div>
        {!rows.length ? (
          <Empty icon={Truck} title="No entries"
                 message={(tab === 'sales' || tab === 'received') && !linkedParty
                   ? 'Nothing sold to this supplier yet. Use New Sale, or link their party above.'
                   : 'Nothing recorded in this period.'} />
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Date</th><th>Entry</th>
                  <th className="r">{headers[3]}</th><th className="r">{headers[4]}</th>
                  <th className="r">Balance</th><th style={{ width: 44 }}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} style={r.voided ? { opacity: 0.55 } : undefined}
                      className={(r.side === 'sale' && r.billId) || r.purchaseBillId ? 'clickable' : ''}
                      onClick={() => {
                        if (r.side === 'sale' && r.billId) nav(`/bill/${r.billId}`);
                        else if (r.purchaseBillId) nav(`/purchase/${r.purchaseBillId}`);
                      }}>
                    <td className="nowrap">{r.type === 'opening' ? '—' : fmtDate(r.date)}</td>
                    <td>
                      <div style={{ fontWeight: 600, textDecoration: r.voided || r.struck ? 'line-through' : 'none' }}>
                        {r.side === 'sale' && <><Pill status="paid" label="Sale" />{' '}</>}
                        {r.title}
                      </div>
                      {r.detail && <div className="small muted">{r.detail}</div>}
                    </td>
                    <td className="r">
                      {r.debit ? <Money value={r.debit} />
                        // Cheque from them not yet cleared: shown, not counted.
                        : r.pending > 0 ? <span className="money" style={{ color: '#B45309' }}>({money(r.pending)})</span>
                        : ''}
                    </td>
                    <td className="r">{r.credit ? <Money value={r.credit} /> : ''}</td>
                    <td className="r strong">
                      <span className={`money ${r.balance > 0.004 ? 'neg' : r.balance < -0.004 ? 'pos' : ''}`}>
                        {money(Math.abs(r.balance))}{r.balance < -0.004 ? ' adv' : ''}
                      </span>
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      {(r.type === 'payment' || r.type === 'return') && (
                        <button className="btn btn-ghost btn-sm" title="Delete this entry"
                                onClick={() => setDeleting(r)}>
                          <Trash2 size={14} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ---- Purchase bill detail ---- */}
      {/* Hidden, not closed, while one of its lines is being edited or deleted:
          stacking two dialogs would leave the outer one trapping Tab and Escape. */}
      <Modal open={Boolean(openBill) && !editLine && !deleteLine && !receiving}
             title={openBill ? `Purchase ${openBill.purchaseNo}` : ''}
             onClose={() => setOpenBill(null)}
             footer={openBill && openBill.status !== 'voided' ? (
               <>
                 <Button icon={Ban} variant="danger" onClick={() => setVoiding(openBill)}>Cancel purchase</Button>
                 <span className="spacer" />
                 <Button icon={Printer} onClick={() => printPurchase(openBill)}>Print</Button>
                 <Button icon={ListChecks} onClick={() => setReceiving(true)}>Receiving</Button>
                 {openBill.due > 0 && (
                   <Button variant="primary" icon={Wallet}
                           onClick={() => { setPayBillId(openBill.id); setOpenBill(null); setDialog('pay'); }}>
                     Pay {money(openBill.due)}
                   </Button>
                 )}
               </>
             ) : openBill ? (
               <Button icon={Printer} onClick={() => printPurchase(openBill)}>Print</Button>
             ) : null}>
        {openBill && (
          <>
            <div className="small muted mb-2">
              {fmtDate(openBill.date)}
              {openBill.invoiceNo ? ` · Supplier invoice ${openBill.invoiceNo}` : ''}
              {openBill.note ? ` · ${openBill.note}` : ''}
              {openBill.status === 'voided' ? ` · CANCELLED${openBill.voidReason ? ` — ${openBill.voidReason}` : ''}` : ''}
            </div>
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Item</th><th className="r">Qty</th><th className="r">Cost</th><th className="r">Total</th>
                    {openBill.status !== 'voided' && <th className="r">Received</th>}
                    {openBill.status !== 'voided' && <th style={{ width: 76 }}></th>}
                  </tr>
                </thead>
                <tbody>
                  {openLines.map((l) => (
                    <tr key={l.id}>
                      <td>{itemName(l.itemId)}</td>
                      <td className="r">{l.qty}</td>
                      <td className="r"><Money value={l.costPrice} /></td>
                      <td className="r strong"><Money value={r2(l.qty * l.costPrice)} /></td>
                      {openBill.status !== 'voided' && (
                        <td className="r nowrap"><DeliveredCount done={lineReceivedQty(l)} qty={Number(l.qty) || 0} /></td>
                      )}
                      {openBill.status !== 'voided' && (
                        <td className="nowrap">
                          <button className="btn btn-ghost btn-sm" title="Edit this line"
                                  onClick={() => setEditLine(l)}>
                            <Pencil size={14} />
                          </button>
                          <button className="btn btn-ghost btn-sm" title="Delete this line"
                                  onClick={() => setDeleteLine(l)}>
                            <Trash2 size={14} />
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr><td colSpan={3}>Total</td><td className="r">{money(openBill.total)}</td></tr>
                  <tr><td colSpan={3}>Paid</td><td className="r">{money(openBill.paid)}</td></tr>
                  {openBill.returned > 0 && (
                    <tr><td colSpan={3}>Returned</td><td className="r">{money(openBill.returned)}</td></tr>
                  )}
                  <tr><td colSpan={3}>Due</td><td className="r">{money(openBill.due)}</td></tr>
                </tfoot>
              </table>
            </div>
          </>
        )}
      </Modal>

      <Modal open={Boolean(voiding)} title="Cancel this purchase?" onClose={() => setVoiding(null)}
             footer={
               <>
                 <Button onClick={() => setVoiding(null)}>Keep it</Button>
                 <Button variant="danger" icon={Ban} onClick={doVoid}>Cancel purchase</Button>
               </>
             }>
        <p className="small">
          {voiding?.purchaseNo} will stop counting: its items come out of stock and its total comes
          off what you owe. It stays visible, struck through. Any payment made against it stays and
          counts toward this supplier's other bills, or as an advance.
        </p>
        <Field label="Reason">
          <Input value={voidReason} onChange={(e) => setVoidReason(e.target.value)}
                 placeholder="e.g. entered twice" autoFocus />
        </Field>
      </Modal>

      <PurchaseEditModal purchase={editLine} onClose={() => setEditLine(null)} />

      <LineDeliveryModal open={receiving && Boolean(openBill)} onClose={() => setReceiving(false)}
                         title={openBill ? `Goods received — ${openBill.purchaseNo}` : ''} verb="Received"
                         lines={openLines.map((l) => ({
                           id: l.id, name: itemName(l.itemId), qty: Number(l.qty) || 0,
                           unit: data.items.find((i) => i.id === l.itemId)?.baseUnit || '',
                           done: lineReceivedQty(l),
                         }))}
                         onSave={(changes) => mutate(
                           () => api.setPurchaseReceipt(openBill.id,
                             changes.map((c) => ({ id: c.id, receivedQty: c.qty }))),
                           'Receiving updated',
                         )} />
      <Confirm
        open={Boolean(deleteLine)}
        danger
        title="Delete this line?"
        message={deleteLine && openBill
          ? `${itemName(deleteLine.itemId)} ${deleteLine.qty} @ ${money(deleteLine.costPrice)}. `
            + (openLines.length > 1
              ? `The stock comes back out and ${openBill.purchaseNo}'s total drops by ${money(r2(deleteLine.qty * deleteLine.costPrice))}.`
              : `This is the only line, so purchase ${openBill.purchaseNo} is removed. `
                + "Any payment made on it stays on this supplier's account.")
          : ''}
        confirmLabel="Delete"
        onConfirm={doDeleteLine}
        onCancel={() => setDeleteLine(null)}
      />

      <Confirm
        open={Boolean(deleting)}
        danger
        title={deleting?.type === 'payment'
          ? (deleting.isAdvance ? 'Delete this advance?' : 'Delete this payment?')
          : 'Delete this return?'}
        message={deleting ? `${deleting.title} — ${money(deleting.credit)}. `
          + (deleting.type === 'payment'
            ? 'The money goes back into your account balance and the supplier balance goes up again.'
            : 'The items go back into stock and the supplier balance goes up again.') : ''}
        confirmLabel="Delete"
        onConfirm={doDelete}
        onCancel={() => setDeleting(null)}
      />

      <Modal open={dialog === 'edit'} title={`Edit ${supplier.name}`} onClose={() => setDialog(null)}>
        {dialog === 'edit' && (
          <SupplierForm supplier={supplier} onSaved={() => setDialog(null)} onCancel={() => setDialog(null)} />
        )}
      </Modal>
      <PurchaseBillModal open={dialog === 'buy'} supplierId={id} onClose={() => setDialog(null)} />
      <SupplierPaymentModal open={dialog === 'pay'} supplierId={id} purchaseBillId={payBillId}
                            onClose={() => setDialog(null)} />
      <SupplierPaymentModal open={dialog === 'advance'} supplierId={id} advance
                            onClose={() => setDialog(null)} />
      <SupplierReturnModal open={dialog === 'return'} supplierId={id} onClose={() => setDialog(null)} />
      {linkedParty && (
        <AccountPaymentModal open={receiveOpen} party={linkedParty} bills={partyBills}
                             onClose={(msg) => { setReceiveOpen(false); if (msg) toast(msg); }} />
      )}
    </>
  );
}
