// Single purchase view — the buying-side twin of BillView: every line, the
// payments and returns against it, what is still owed, and everything that
// can be done to it — print, edit or delete a line, record goods arriving,
// pay the supplier, return goods, cancel.
//
// The route id is any one line of the purchase (a Purchases row). A line of a
// purchase bill opens the whole bill; a Quick Purchase has no bill and opens
// on its own, with only what applies to it.

import { useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Printer, Pencil, Trash2, Ban, ArrowLeft, ShoppingCart, Wallet, ListChecks, Undo2, Truck, Send,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import api from '../lib/api';
import {
  Card, Button, Pill, Money, Empty, PageHead, Confirm, Field, Input, Modal,
} from '../components/ui';
import PurchaseEditModal from '../components/forms/PurchaseEditModal';
import SupplierPaymentModal from '../components/forms/SupplierPaymentModal';
import SupplierReturnModal from '../components/forms/SupplierReturnModal';
import LineDeliveryModal, { DeliveredCount } from '../components/forms/LineDeliveryModal';
import {
  derivePurchaseBills, purchaseBillLines, lineReceivedQty, purchaseReceipt,
} from '../lib/calc';
import { money, fmtDate, fmtDateTime, r2, waLink } from '../lib/format';
import { printReport } from '../lib/exporters';

export default function PurchaseView() {
  const { id } = useParams();
  const nav = useNavigate();
  const { data, settings, mutate } = useApp();

  const [editLine, setEditLine] = useState(null);
  const [deleteLine, setDeleteLine] = useState(null);
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [payOpen, setPayOpen] = useState(false);
  const [retOpen, setRetOpen] = useState(false);
  const [receiving, setReceiving] = useState(false);
  const [delPay, setDelPay] = useState(null);
  const [delRet, setDelRet] = useState(null);

  // The id may name the purchase bill itself, or any line of it.
  const line = data.purchases.find((p) => p.id === id)
    || data.purchases.find((p) => p.purchaseBillId === id) || null;
  const billRec = line?.purchaseBillId
    ? data.purchaseBills.find((b) => b.id === line.purchaseBillId) : null;
  const bill = useMemo(() => (billRec
    ? derivePurchaseBills(billRec.supplierId, data).find((b) => b.id === billRec.id) || null
    : null), [billRec, data]);
  const supplier = billRec ? data.suppliers.find((s) => s.id === billRec.supplierId) : null;
  const lines = bill ? purchaseBillLines(bill.id, data) : (line ? [line] : []);

  const payments = useMemo(() => (bill
    ? data.supplierPayments.filter((p) => p.purchaseBillId === bill.id) : []), [bill, data.supplierPayments]);
  const returns = useMemo(() => (bill
    ? data.supplierReturns.filter((r) => r.purchaseBillId === bill.id) : []), [bill, data.supplierReturns]);

  if (!line) {
    return <Empty icon={ShoppingCart} title="Purchase not found"
                  message="This purchase may have been removed."
                  action={<Button onClick={() => nav('/purchases')}>Back to Purchases</Button>} />;
  }

  const voided = bill?.status === 'voided';
  const itemOf = (itemId) => data.items.find((i) => i.id === itemId);
  const nameOf = (itemId) => itemOf(itemId)?.name || 'Item';
  const total = bill ? bill.total : r2(lines.reduce((t, l) => t + l.qty * l.costPrice, 0));
  const supplierName = supplier?.name || line.supplierName || '';
  const title = bill ? `Purchase ${bill.purchaseNo}` : `Purchase — ${nameOf(line.itemId)}`;
  const receipt = purchaseReceipt(lines);

  const onPrint = () => printReport({
    title,
    subtitle: [supplierName, supplier?.phone].filter(Boolean).join(' · '),
    shopName: settings.shopName,
    headers: ['#', 'Item', { label: 'Qty', align: 'r' }, { label: 'Cost', align: 'r' },
              { label: 'Total', align: 'r' }],
    rows: lines.map((l, i) => [
      i + 1, nameOf(l.itemId),
      `${l.qty} ${itemOf(l.itemId)?.baseUnit || ''}`.trim(),
      money(l.costPrice), money(r2(l.qty * l.costPrice)),
    ]),
    totals: ['', 'Total', '', '', money(total)],
    meta: [
      `Date: ${fmtDate(bill?.date || line.date)}`,
      ...(bill?.invoiceNo ? [`Supplier invoice: ${bill.invoiceNo}`] : []),
      ...(bill ? [`Paid: ${money(bill.paid)}`,
                  ...(bill.returned > 0 ? [`Returned: ${money(bill.returned)}`] : []),
                  `Due: ${money(bill.due)}`]
        : [`Paid from: ${line.method || '—'}`]),
      ...(voided ? ['CANCELLED'] : []),
      ...((bill?.note || line.note) ? [`Note: ${bill?.note || line.note}`] : []),
    ],
  });

  const waText = [
    `*${settings.shopName}*`,
    `${title} — ${fmtDate(bill?.date || line.date)}`,
    '',
    ...lines.map((l) => `${nameOf(l.itemId)} — ${l.qty} × ${money(l.costPrice)} = ${money(l.qty * l.costPrice)}`),
    '',
    `Total: ${money(total)}`,
    ...(bill ? [`Paid: ${money(bill.paid)}`, `Due: ${money(bill.due)}`] : []),
  ].join('\n');

  const doDeleteLine = async () => {
    const l = deleteLine;
    setDeleteLine(null);
    const lastOne = lines.length === 1;
    await mutate(() => api.deletePurchase(l.id), 'Purchase line deleted').catch(() => {});
    if (lastOne) nav('/purchases');
    // Deleted the line this page was opened by: carry on from another line.
    else if (l.id === id) nav(`/purchase/${lines.find((x) => x.id !== l.id).id}`, { replace: true });
  };

  const doVoid = async () => {
    setVoidOpen(false);
    await mutate(() => api.voidPurchaseBill(bill.id, voidReason), `${title} cancelled`).catch(() => {});
    setVoidReason('');
  };

  return (
    <>
      <PageHead title={title}
                subtitle={`${supplierName || 'No supplier'} · ${fmtDate(bill?.date || line.date)}`}>
        <Button icon={ArrowLeft} onClick={() => nav(-1)}>Back</Button>
        <Button icon={Printer} onClick={onPrint}>Print</Button>
        {supplier?.phone && (
          <a className="btn" href={waLink(supplier.phone, waText)} target="_blank" rel="noreferrer">
            <Send size={15} /> WhatsApp
          </a>
        )}
        {bill && !voided && (
          <>
            <Button icon={ListChecks} onClick={() => setReceiving(true)}>Receiving</Button>
            <Button icon={Undo2} onClick={() => setRetOpen(true)}>Return</Button>
            <Button icon={Ban} onClick={() => setVoidOpen(true)}>Cancel</Button>
            {bill.due > 0 && (
              <Button variant="primary" icon={Wallet} onClick={() => setPayOpen(true)}>Pay Supplier</Button>
            )}
          </>
        )}
        {!bill && (
          <>
            <Button icon={Pencil} onClick={() => setEditLine(line)}>Edit</Button>
            <Button icon={Trash2} onClick={() => setDeleteLine(line)}>Delete</Button>
          </>
        )}
      </PageHead>

      {voided && (
        <div style={{
          padding: '12px 14px', background: 'var(--neutral-bg)', border: '1px solid var(--border-strong)',
          borderRadius: 'var(--r)', marginBottom: 16, display: 'flex', gap: 9, alignItems: 'center',
        }}>
          <Ban size={17} className="muted" />
          <div>
            <div style={{ fontWeight: 700 }}>This purchase is cancelled</div>
            <div className="small muted">
              {bill.voidReason || 'No reason recorded'}{bill.voidedAt ? ` · ${fmtDateTime(bill.voidedAt)}` : ''}
              {' — '}kept in history, not counted in stock or what you owe.
            </div>
          </div>
        </div>
      )}

      {!voided && receipt.state !== 'received' && (
        <div style={{
          padding: '12px 14px', background: 'var(--warning-bg)', border: '1px solid #FDE68A',
          borderRadius: 'var(--r)', marginBottom: 16, display: 'flex', gap: 9, alignItems: 'center',
        }}>
          <ListChecks size={17} color="#B45309" />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, color: '#B45309' }}>
              {receipt.state === 'partial' ? 'Partly received' : 'Goods not received yet'}
            </div>
            <div className="small" style={{ color: '#B45309' }}>
              Still to come:{' '}
              {lines.filter((l) => lineReceivedQty(l) < l.qty - 0.0001)
                .map((l) => `${nameOf(l.itemId)} (${+(l.qty - lineReceivedQty(l)).toFixed(3)})`).join(', ')}
            </div>
          </div>
          {bill && <Button size="sm" onClick={() => setReceiving(true)}>Update</Button>}
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
                    <th className="r">Cost</th>
                    <th className="r">Amount</th>
                    {!voided && <th className="r">Received</th>}
                    {!voided && <th style={{ width: 76 }}></th>}
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={l.id}>
                      <td className="muted">{i + 1}</td>
                      <td style={{ fontWeight: 500 }}>{nameOf(l.itemId)}</td>
                      <td className="r">{l.qty}</td>
                      <td>{itemOf(l.itemId)?.baseUnit || ''}</td>
                      <td className="r"><Money value={l.costPrice} /></td>
                      <td className="r strong"><Money value={r2(l.qty * l.costPrice)} /></td>
                      {!voided && (
                        <td className="r nowrap"><DeliveredCount done={lineReceivedQty(l)} qty={Number(l.qty) || 0} /></td>
                      )}
                      {!voided && (
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
                  <tr>
                    <td colSpan={5} style={{ fontSize: 15 }}>Total</td>
                    <td className="r" style={{ fontSize: 15 }}>{money(total)}</td>
                    {!voided && <td colSpan={2} />}
                  </tr>
                </tfoot>
              </table>
            </div>
          </Card>

          {bill && (
            <Card title="Payments to supplier" tight>
              {payments.length ? (
                <div className="table-wrap">
                  <table className="tbl">
                    <thead>
                      <tr><th>Date</th><th>Method</th><th>Note</th><th className="r">Amount</th><th style={{ width: 50 }}></th></tr>
                    </thead>
                    <tbody>
                      {payments.map((p) => (
                        <tr key={p.id}>
                          <td>{fmtDate(p.date)}</td>
                          <td>{p.method}</td>
                          <td className="small muted">{p.note || '—'}</td>
                          <td className="r strong">{money(p.amount)}</td>
                          <td>
                            <button className="btn btn-ghost btn-sm" title="Delete this payment"
                                    onClick={() => setDelPay(p)}>
                              <Trash2 size={14} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty title="No payments on this purchase"
                       message="Payments made to the supplier's account (not to this purchase) settle their oldest purchases first."
                       action={!voided && bill.due > 0
                         ? <Button variant="primary" onClick={() => setPayOpen(true)}>Pay supplier</Button>
                         : null} />
              )}
            </Card>
          )}

          {returns.length > 0 && (
            <Card title="Returned to supplier" tight>
              <div className="table-wrap">
                <table className="tbl">
                  <thead>
                    <tr><th>Date</th><th>Item</th><th className="r">Qty</th><th>Note</th>
                        <th className="r">Value</th><th style={{ width: 50 }}></th></tr>
                  </thead>
                  <tbody>
                    {returns.map((r) => (
                      <tr key={r.id}>
                        <td>{fmtDate(r.date)}</td>
                        <td>{nameOf(r.itemId)}</td>
                        <td className="r">{r.qty}</td>
                        <td className="small muted">{r.note || '—'}</td>
                        <td className="r strong"><Money value={r.value} /></td>
                        <td>
                          <button className="btn btn-ghost btn-sm" title="Delete this return"
                                  onClick={() => setDelRet(r)}>
                            <Trash2 size={14} />
                          </button>
                        </td>
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
            {bill && (
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
                <span className="muted">Status</span>
                <span className="spacer" />
                <Pill status={bill.status} label={voided ? 'Cancelled' : undefined} />
              </div>
            )}
            <SumRow label="Total" value={total} strong />
            {bill && <SumRow label="Paid" value={bill.paid} />}
            {bill?.returned > 0 && <SumRow label="Returned" value={bill.returned} />}
            {bill ? (
              <div style={{
                display: 'flex', alignItems: 'center', paddingTop: 11, marginTop: 6,
                borderTop: '2px solid var(--border-strong)',
              }}>
                <span style={{ fontWeight: 700, fontSize: 15 }}>You owe</span>
                <span className="spacer" />
                <span className="money" style={{ fontSize: 19, color: bill.due > 0 ? 'var(--danger)' : 'var(--success)' }}>
                  {money(bill.due)}
                </span>
              </div>
            ) : (
              <div className="small muted mt-2">Paid from {line.method || '—'} when it was recorded.</div>
            )}
          </Card>

          <Card title="Supplier">
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 3 }}>{supplierName || '—'}</div>
            {supplier?.phone && <div className="small muted">{supplier.phone}</div>}
            {supplier?.address && <div className="small muted">{supplier.address}</div>}
            {bill?.invoiceNo && <div className="small muted">Their invoice: {bill.invoiceNo}</div>}
            {supplier && (
              <Button className="mt-2" block icon={Truck} onClick={() => nav(`/supplier/${supplier.id}`)}>
                Open supplier khata
              </Button>
            )}
          </Card>

          {(bill?.note || line.note) && (
            <Card title="Note">
              <p style={{ margin: 0, fontSize: 13.5 }}>{bill?.note || line.note}</p>
            </Card>
          )}
        </div>
      </div>

      <PurchaseEditModal purchase={editLine} onClose={() => setEditLine(null)} />

      <Confirm
        open={Boolean(deleteLine)}
        danger
        title="Delete this line?"
        message={deleteLine
          ? `${nameOf(deleteLine.itemId)} ${deleteLine.qty} @ ${money(deleteLine.costPrice)}. `
            + (bill && lines.length > 1
              ? `The stock comes back out and ${bill.purchaseNo}'s total drops by ${money(r2(deleteLine.qty * deleteLine.costPrice))}.`
              : bill
                ? `This is the only line, so purchase ${bill.purchaseNo} is removed. `
                  + "Any payment made on it stays on the supplier's account."
                : 'The stock comes back out.')
          : ''}
        confirmLabel="Delete"
        onConfirm={doDeleteLine}
        onCancel={() => setDeleteLine(null)}
      />

      <Modal open={voidOpen} title="Cancel this purchase?" onClose={() => setVoidOpen(false)}
             footer={
               <>
                 <Button onClick={() => setVoidOpen(false)}>Keep it</Button>
                 <Button variant="danger" icon={Ban} onClick={doVoid}>Cancel purchase</Button>
               </>
             }>
        <p className="small">
          {bill?.purchaseNo} will stop counting: its items come out of stock and its total comes
          off what you owe. It stays visible, struck through.
        </p>
        <Field label="Reason">
          <Input value={voidReason} onChange={(e) => setVoidReason(e.target.value)}
                 placeholder="e.g. entered twice" autoFocus />
        </Field>
      </Modal>

      <Confirm
        open={Boolean(delPay)}
        danger
        title="Delete this payment?"
        message={delPay ? `${money(delPay.amount)} (${delPay.method}) on ${fmtDate(delPay.date)}. `
          + 'What you owe the supplier goes back up by this amount.' : ''}
        confirmLabel="Delete"
        onConfirm={async () => {
          const p = delPay;
          setDelPay(null);
          await mutate(() => api.deleteSupplierPayment(p.id), 'Payment deleted').catch(() => {});
        }}
        onCancel={() => setDelPay(null)}
      />

      <Confirm
        open={Boolean(delRet)}
        danger
        title="Delete this return?"
        message={delRet ? `${nameOf(delRet.itemId)} × ${delRet.qty}, value ${money(delRet.value)}. `
          + 'The items go back into stock and what you owe goes back up.' : ''}
        confirmLabel="Delete"
        onConfirm={async () => {
          const r = delRet;
          setDelRet(null);
          await mutate(() => api.deleteSupplierReturn(r.id), 'Return deleted').catch(() => {});
        }}
        onCancel={() => setDelRet(null)}
      />

      {bill && (
        <>
          <SupplierPaymentModal open={payOpen} supplierId={bill.supplierId} purchaseBillId={bill.id}
                                onClose={() => setPayOpen(false)} />
          <SupplierReturnModal open={retOpen} supplierId={bill.supplierId} purchaseBillId={bill.id}
                               onClose={() => setRetOpen(false)} />
          <LineDeliveryModal open={receiving} onClose={() => setReceiving(false)}
                             title={`Goods received — ${bill.purchaseNo}`} verb="Received"
                             lines={lines.map((l) => ({
                               id: l.id, name: nameOf(l.itemId), qty: Number(l.qty) || 0,
                               unit: itemOf(l.itemId)?.baseUnit || '',
                               done: lineReceivedQty(l),
                             }))}
                             onSave={(changes) => mutate(
                               () => api.setPurchaseReceipt(bill.id,
                                 changes.map((c) => ({ id: c.id, receivedQty: c.qty }))),
                               'Receiving updated',
                             )} />
        </>
      )}
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
