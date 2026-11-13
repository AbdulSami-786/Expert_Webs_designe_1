// Single bill view — print, WhatsApp share, payment trail, returns, void (FR-10 / FR-25/26).

import { useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Printer, Send, Plus, RotateCcw, Pencil, Ban, Undo2, ArrowLeft, Receipt,
  Truck, PackageOpen, FileDown, ListChecks, Files,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import api from '../lib/api';
import {
  Card, Button, Pill, Money, Empty, PageHead, Confirm, Field, Input, Modal,
} from '../components/ui';
import PaymentModal from '../components/forms/PaymentModal';
import ReturnModal from '../components/forms/ReturnModal';
import LineDeliveryModal, { DeliveredCount } from '../components/forms/LineDeliveryModal';
import { deriveBills, billDelivery, lineDeliveredQty } from '../lib/calc';
import { money, fmtDate, fmtDateTime, waLink, totalQtyLabel } from '../lib/format';
import { printBill, downloadBillPDF } from '../lib/exporters';

export default function BillView() {
  const { id } = useParams();
  const nav = useNavigate();
  const { data, settings, mutate } = useApp();

  const [payOpen, setPayOpen] = useState(false);
  const [retOpen, setRetOpen] = useState(false);
  const [deliverOpen, setDeliverOpen] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [reverseFor, setReverseFor] = useState(null);
  const [reverseReason, setReverseReason] = useState('');
  // Guards the delivery toggle, which is tapped directly with no dialog.
  const [busy, setBusy] = useState(false);
  // "Separate Bill": print each item as its own invoice instead of one bill.
  // Off by default and not remembered, so a normal print is never an accident.
  const [separate, setSeparate] = useState(false);

  const bill =data.bills.find((b) => b.id === id);
  // Derived with the party's other bills, so money overpaid elsewhere that
  // settles this bill shows here exactly as it does on the ledger.
  const state = useMemo(() => (bill
    ? deriveBills(data.bills.filter((b) => b.partyId === bill.partyId), data)
        .find((b) => b.id === bill.id)
    : null), [bill, data]);
  const party = bill ? data.parties.find((p) => p.id === bill.partyId) : null;

  const lines = useMemo(() => {
    if (!bill) return [];
    return data.billItems
      .filter((bi) => bi.billId === bill.id)
      .map((bi) => ({
        ...bi,
        itemName: data.items.find((i) => i.id === bi.itemId)?.name || 'Item',
        delivered: lineDeliveredQty(bi, bill),
      }));
  }, [bill, data.billItems, data.items]);

  // Item by item: 'delivered', 'partial' or 'pending' (or 'cancelled').
  const delivery = useMemo(() => billDelivery(bill, data.billItems), [bill, data.billItems]);

  const payments = useMemo(
    () => (bill ? data.payments.filter((p) => p.billId === bill.id) : []),
    [bill, data.payments]
  );

  const returns = useMemo(
    () => (bill ? data.returns.filter((r) => r.billId === bill.id) : []),
    [bill, data.returns]
  );

  const cheques = useMemo(
    () => (bill ? data.cheques.filter((c) => c.billId === bill.id) : []),
    [bill, data.cheques]
  );

  if (!bill) {
    return <Empty icon={Receipt} title="Bill not found"
                  message="This bill may have been removed."
                  action={<Button onClick={() => nav('/bills')}>Back to Bills</Button>} />;
  }

  const livePayments = payments.filter((p) => !p.reversed);
  const receiptArgs = { bill, lines, party, payments: livePayments, settings, state, delivery };

  const canSeparate = lines.length > 1;
  const onPrint = () => printBill({ ...receiptArgs, separate: separate && canSeparate });
  const onPDF = () => downloadBillPDF(receiptArgs);

  const waText = [
    `*${settings.shopName}*`,
    `Bill ${bill.billNo} — ${fmtDate(bill.date)}`,
    '',
    ...lines.map((l) => `${l.itemName} — ${l.qty} ${l.unit} × ${money(l.price)} = ${money(l.qty * l.price)}`),
    '',
    `Total: ${money(state.net)}`,
    `Paid: ${money(state.paid)}`,
    state.due > 0 ? `*Balance due: ${money(state.due)}* (due ${fmtDate(bill.dueDate)})` : '*Fully paid — thank you!*',
  ].join('\n');

  const doVoid = async () => {
    setVoidOpen(false);
    try {
      await mutate(() => api.voidBill(bill.id, voidReason), `Bill ${bill.billNo} voided`);
      setVoidReason('');
    } catch { /* mutate already showed the reason (e.g. payments still on the bill) */ }
  };

  const setDelivery = async (next) => {
    // Tap-driven with no dialog in the way, so a double-tap on a slow
    // connection would send the write twice.
    if (busy) return;
    setBusy(true);
    try {
      await mutate(
        () => api.setDelivery(bill.id, next),
        next === 'delivered'
          ? `Bill ${bill.billNo} marked delivered`
          : `Bill ${bill.billNo} marked pending`,
      );
    } catch {
      /* toast already shown by mutate */
    } finally {
      setBusy(false);
    }
  };

  const saveLineDelivery = (changes) => mutate(
    () => api.setLineDelivery(bill.id, changes.map((c) => ({ id: c.id, deliveredQty: c.qty }))),
    'Delivery updated',
  );

  const doReverse = async () => {
    const p = reverseFor;
    setReverseFor(null);
    try {
      await mutate(() => api.reversePayment(p.id, reverseReason), 'Payment reversed');
      setReverseReason('');
    } catch { /* mutate already showed the reason */ }
  };

  return (
    <>
      <PageHead title={`Bill ${bill.billNo}`}
                subtitle={`${party?.name || 'Unknown party'} · ${fmtDate(bill.date)}`}>
        <Button icon={ArrowLeft} onClick={() => nav(-1)}>Back</Button>
        {canSeparate && (
          <Button icon={Files} variant={separate ? 'primary' : ''} aria-pressed={separate}
                  title="When on, Print gives one separate invoice for every item"
                  onClick={() => setSeparate((s) => !s)}>
            Separate Bill{separate ? ': ON' : ''}
          </Button>
        )}
        <Button icon={Printer} onClick={onPrint}>
          {separate && canSeparate ? `Print ${lines.length} Invoices` : 'Print'}
        </Button>
        <Button icon={FileDown} onClick={onPDF}>PDF</Button>
        {party?.phone && (
          <a className="btn" href={waLink(party.phone, waText)} target="_blank" rel="noreferrer">
            <Send size={15} /> WhatsApp
          </a>
        )}
        {bill.status !== 'voided' && (
          <>
            <Button icon={ListChecks} onClick={() => setDeliverOpen(true)}>
              Delivery
            </Button>
            {delivery.state !== 'delivered'
              ? (
                <Button variant="primary" icon={Truck} loading={busy}
                        onClick={() => setDelivery('delivered')}>
                  Mark All Delivered
                </Button>
              ) : (
                <Button icon={PackageOpen} loading={busy}
                        onClick={() => setDelivery('pending')}>
                  Mark Pending
                </Button>
              )}
            <Button icon={RotateCcw} onClick={() => setRetOpen(true)}>Return</Button>
            <Button icon={Pencil} onClick={() => nav(`/bill/${bill.id}/edit`)}>Edit</Button>
            <Button icon={Ban} onClick={() => setVoidOpen(true)}>Void</Button>
            {state.due > 0 && (
              <Button variant="primary" icon={Plus} onClick={() => setPayOpen(true)}>Add Payment</Button>
            )}
          </>
        )}
      </PageHead>

      {bill.status === 'voided' && (
        <div style={{
          padding: '12px 14px', background: 'var(--neutral-bg)', border: '1px solid var(--border-strong)',
          borderRadius: 'var(--r)', marginBottom: 16, display: 'flex', gap: 9, alignItems: 'center',
        }}>
          <Ban size={17} className="muted" />
          <div>
            <div style={{ fontWeight: 700 }}>This bill is voided</div>
            <div className="small muted">
              {bill.voidReason || 'No reason recorded'} · {fmtDateTime(bill.voidedAt)}
              {' — '}kept in history, excluded from sales and dues.
            </div>
          </div>
        </div>
      )}

      {delivery.state === 'partial' && (
        <div style={{
          padding: '12px 14px', background: 'var(--info-bg)', border: '1px solid #BFDBFE',
          borderRadius: 'var(--r)', marginBottom: 16, display: 'flex', gap: 9, alignItems: 'center',
        }}>
          <ListChecks size={17} color="#1D4ED8" />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, color: '#1D4ED8' }}>Partly delivered</div>
            <div className="small" style={{ color: '#1D4ED8' }}>
              {lines.filter((l) => l.delivered >= l.qty - 0.0001).length} of {lines.length} items
              fully sent. Still to go:{' '}
              {lines.filter((l) => l.delivered < l.qty - 0.0001)
                .map((l) => `${l.itemName} (${+(l.qty - l.delivered).toFixed(3)} ${l.unit})`).join(', ')}
            </div>
          </div>
          <Button size="sm" onClick={() => setDeliverOpen(true)}>Update</Button>
        </div>
      )}

      {delivery.state === 'pending' && (
        <div style={{
          padding: '12px 14px', background: 'var(--warning-bg)', border: '1px solid #FDE68A',
          borderRadius: 'var(--r)', marginBottom: 16, display: 'flex', gap: 9, alignItems: 'center',
        }}>
          <PackageOpen size={17} color="#B45309" />
          <div>
            <div style={{ fontWeight: 700, color: '#B45309' }}>Not delivered yet</div>
            <div className="small" style={{ color: '#B45309' }}>
              The goods on this bill have not gone out. It still counts as a sale
              and as money owed.
            </div>
          </div>
        </div>
      )}

      <div className="grid-2 bill-layout">
        <div className="col">
          <Card title="Items" tight>
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ width: 34 }}>#</th>
                    <th>Item</th>
                    <th className="r">Qty</th>
                    <th>Unit</th>
                    <th className="r">Rate</th>
                    <th className="r">Amount</th>
                    {bill.status !== 'voided' && <th className="r">Delivered</th>}
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={l.id}>
                      <td className="muted">{i + 1}</td>
                      <td style={{ fontWeight: 500 }}>{l.itemName}</td>
                      <td className="r">{l.qty}</td>
                      <td>{l.unit}</td>
                      <td className="r"><Money value={l.price} /></td>
                      <td className="r strong"><Money value={l.qty * l.price} /></td>
                      {bill.status !== 'voided' && (
                        <td className="r nowrap">
                          <DeliveredCount done={l.delivered} qty={l.qty} />
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={2}>
                      {lines.length} item{lines.length === 1 ? '' : 's'}
                    </td>
                    {/* Spans Qty + Unit so a mixed-unit total still sits under
                        the quantity column. */}
                    <td className="r" colSpan={2} style={{ fontWeight: 700 }}>
                      {totalQtyLabel(lines)}
                    </td>
                    <td colSpan={bill.status !== 'voided' ? 3 : 2}></td>
                  </tr>
                  <tr>
                    <td colSpan={5}>Subtotal</td>
                    <td className="r">{money(bill.subtotal)}</td>
                    {bill.status !== 'voided' && <td />}
                  </tr>
                  {Number(bill.roundOff) !== 0 && (
                    <tr>
                      <td colSpan={5} className="muted" style={{ fontWeight: 500 }}>Round off</td>
                      <td className="r">{money(bill.roundOff, { showSign: true })}</td>
                    {bill.status !== 'voided' && <td />}
                    </tr>
                  )}
                  {state.returned > 0 && (
                    <tr>
                      <td colSpan={5} style={{ color: 'var(--danger)' }}>Returns</td>
                      <td className="r" style={{ color: 'var(--danger)' }}>- {money(state.returned)}</td>
                    {bill.status !== 'voided' && <td />}
                    </tr>
                  )}
                  <tr>
                    <td colSpan={5} style={{ fontSize: 15 }}>Total</td>
                    <td className="r" style={{ fontSize: 15 }}>{money(state.net)}</td>
                    {bill.status !== 'voided' && <td />}
                  </tr>
                </tfoot>
              </table>
            </div>
          </Card>

          <Card title="Payments" subtitle="Reversed payments stay listed for traceability" tight>
            {payments.length ? (
              <div className="table-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Date</th><th>Method</th><th>Note</th>
                      <th className="r">Amount</th><th style={{ width: 110 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {payments.map((p) => {
                      const chq = cheques.find((c) => c.paymentId === p.id);
                      return (
                        <tr key={p.id} style={p.reversed ? { opacity: .55 } : undefined}>
                          <td>{fmtDate(p.date)}</td>
                          <td>
                            {p.method}
                            {chq && (
                              <div className="small muted">
                                {chq.chequeNo} · {chq.bankName}{chq.accountHolder ? ` · ${chq.accountHolder}` : ''} <Pill status={chq.status === 'cleared' ? 'cleared' : chq.status === 'bounced' ? 'bounced' : 'partial'}
                                                                          label={chq.status === 'cleared' ? 'Cleared' : chq.status === 'bounced' ? 'Bounced' : 'Pending'} />
                              </div>
                            )}
                          </td>
                          <td className="small muted">{p.note || '—'}</td>
                          <td className="r strong">
                            <span style={p.reversed ? { textDecoration: 'line-through' } : undefined}>
                              {money(p.amount)}
                            </span>
                          </td>
                          <td>
                            <div className="row-actions">
                              {p.reversed ? (
                                <Pill status="voided" label="Reversed" />
                              ) : (
                                <button className="btn btn-ghost btn-sm" title="Reverse this payment"
                                        onClick={() => setReverseFor(p)}>
                                  <Undo2 size={14} />
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty title="No payments yet"
                     message="Nothing has been paid against this bill."
                     action={state.due > 0
                       ? <Button variant="primary" onClick={() => setPayOpen(true)}>Add payment</Button>
                       : null} />
            )}
          </Card>

          {returns.length > 0 && (
            <Card title="Returns" tight>
              <div className="table-wrap">
                <table className="tbl">
                  <thead>
                    <tr><th>Date</th><th>Item</th><th className="r">Qty</th>
                        <th>Restocked</th><th>Note</th><th className="r">Value</th></tr>
                  </thead>
                  <tbody>
                    {returns.map((r) => (
                      <tr key={r.id}>
                        <td>{fmtDate(r.date)}</td>
                        <td>{data.items.find((i) => i.id === r.itemId)?.name || 'Item'}</td>
                        <td className="r">{r.qty}</td>
                        <td>{r.restock ? <Pill status="paid" label="Yes" /> : <Pill status="voided" label="No" />}</td>
                        <td className="small muted">{r.note || '—'}</td>
                        <td className="r strong"><Money value={r.valueAdjusted} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </div>

        {/* ---------------- Summary sidebar ---------------- */}
        <div className="col">
          <Card title="Summary">
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
              <span className="muted">Status</span>
              <span className="spacer" />
              <Pill status={state.status} />
            </div>

            <SumRow label="Total" value={state.net} strong />
            <SumRow label="Paid" value={state.paid} />
            {state.returned > 0 && <SumRow label="Returned" value={state.returned} />}

            <div style={{
              display: 'flex', alignItems: 'center', paddingTop: 11, marginTop: 6,
              borderTop: '2px solid var(--border-strong)',
            }}>
              <span style={{ fontWeight: 700, fontSize: 15 }}>Balance due</span>
              <span className="spacer" />
              <span className="money" style={{ fontSize: 19, color: state.due > 0 ? 'var(--danger)' : 'var(--success)' }}>
                {money(state.due)}
              </span>
            </div>

            {state.due > 0 && (
              <div className="mt-2" style={{
                padding: '10px 12px', borderRadius: 'var(--r-sm)',
                background: state.isOverdue ? 'var(--danger-bg)' : 'var(--warning-bg)',
                border: `1px solid ${state.isOverdue ? '#FECACA' : '#FDE68A'}`,
                color: state.isOverdue ? '#B91C1C' : '#B45309', fontSize: 13,
              }}>
                <strong>Due {fmtDate(bill.dueDate)}</strong>
                {state.isOverdue
                  ? ` — ${state.overdueDays} day${state.overdueDays === 1 ? '' : 's'} overdue`
                  : ' — not yet due'}
              </div>
            )}
          </Card>

          <Card title="Party">
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 3 }}>{party?.name}</div>
            {party?.phone && <div className="small muted">{party.phone}</div>}
            {party?.address && <div className="small muted">{party.address}</div>}
            <Button className="mt-2" block onClick={() => nav(`/party/${party.id}`)}>
              Open full ledger
            </Button>
          </Card>

          {bill.note && (
            <Card title="Note">
              <p style={{ margin: 0, fontSize: 13.5 }}>{bill.note}</p>
            </Card>
          )}
        </div>
      </div>

      <PaymentModal open={payOpen} onClose={() => setPayOpen(false)}
                    bill={bill} state={state} party={party} />

      <ReturnModal open={retOpen} onClose={() => setRetOpen(false)}
                   bill={bill} party={party} />

      <LineDeliveryModal open={deliverOpen} onClose={() => setDeliverOpen(false)}
                         title={`Delivery — Bill ${bill.billNo}`} verb="Delivered"
                         lines={lines.map((l) => ({
                           id: l.id, name: l.itemName, qty: Number(l.qty) || 0, unit: l.unit, done: l.delivered,
                         }))}
                         onSave={saveLineDelivery} />

      {/* Void with reason */}
      <Modal open={voidOpen} title="Void this bill?" onClose={() => setVoidOpen(false)}
             footer={
               <>
                 <Button onClick={() => setVoidOpen(false)}>Cancel</Button>
                 <Button variant="danger" onClick={doVoid}>Void bill</Button>
               </>
             }>
        <p style={{ marginTop: 0, fontSize: 14 }}>
          Bill {bill.billNo} will be marked Voided. It stays in your history with its bill
          number — nothing is deleted — but it stops counting towards sales and dues.
        </p>
        <Field label="Reason" hint="Recorded in the Activity Log">
          <Input value={voidReason} onChange={(e) => setVoidReason(e.target.value)}
                 placeholder="e.g. Entered twice by mistake" autoFocus />
        </Field>
      </Modal>

      {/* Reverse payment with reason */}
      <Modal open={Boolean(reverseFor)} title="Reverse this payment?"
             onClose={() => setReverseFor(null)}
             footer={
               <>
                 <Button onClick={() => setReverseFor(null)}>Cancel</Button>
                 <Button variant="danger" onClick={doReverse}>Reverse payment</Button>
               </>
             }>
        <p style={{ marginTop: 0, fontSize: 14 }}>
          The {money(reverseFor?.amount)} {reverseFor?.method} payment will be reversed. The
          original entry stays visible, marked reversed, so the ledger math remains traceable.
          This bill's balance will increase by {money(reverseFor?.amount)}.
        </p>
        <Field label="Reason" hint="Recorded in the Activity Log">
          <Input value={reverseReason} onChange={(e) => setReverseReason(e.target.value)}
                 placeholder="e.g. Entered against the wrong bill" autoFocus />
        </Field>
      </Modal>
    </>
  );
}

function SumRow({ label, value, strong }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '5px 0' }}>
      <span className={strong ? '' : 'muted'} style={{ fontSize: 13.5, fontWeight: strong ? 600 : 400 }}>
        {label}
      </span>
      <span className="spacer" />
      <Money value={value} />
    </div>
  );
}
