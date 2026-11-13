// Bill receipt — a read-only view of one bill.
//
// Used in two places:
//   - the owner's party ledger (Full Statement), where printing is allowed
//   - the public shared-ledger link, where FR-21 forbids edit/print/download
//     controls, so `readOnly` strips them.
//
// It takes its data as plain props rather than reading app state, because the
// public page has no session and only receives that one party's records.

import { useState } from 'react';
import { X, Printer, Receipt, FileDown, Files } from 'lucide-react';
import { Modal, Button, Pill, Money, Empty } from './ui';
import { money, fmtDate, totalQtyLabel } from '../lib/format';

export default function BillReceiptModal({
  open,
  onClose,
  bill,          // derived bill (billState) — carries net/paid/due/status
  lines = [],    // [{ id, itemId, qty, unit, price }]
  payments = [], // [{ id, method, amount, date, note, reversed }]
  cheques = [],
  returns = [],
  itemName = (id) => id,
  party,
  shopName,
  readOnly = false,
  onPrint,       // called with (separate: boolean)
  onPDF,
  allowSeparate = false,  // show the "Separate Bill" button (one invoice per item)
}) {
  // Off by default and reset by closing, so a normal print is never an accident.
  const [separate, setSeparate] = useState(false);

  if (!bill) return null;
  const canSeparate = allowSeparate && lines.length > 1;
  const close = () => { setSeparate(false); onClose(); };

  const livePayments = payments.filter((p) => !p.reversed);
  const subtotal = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.price) || 0), 0);

  // Grouped by unit: quantities only add up within one unit (see totalQtyLabel).
  const totalQty = totalQtyLabel(lines);

  return (
    <Modal
      open={open}
      onClose={close}
      title={`Bill ${bill.billNo}`}
      wide
      footer={
        readOnly ? (
          <Button onClick={onClose}>Close</Button>
        ) : (
          <>
            <Button onClick={close}>Close</Button>
            {onPDF && <Button icon={FileDown} onClick={onPDF}>PDF</Button>}
            {canSeparate && onPrint && (
              <Button icon={Files} variant={separate ? 'primary' : ''} aria-pressed={separate}
                      title="When on, Print gives one separate invoice for every item"
                      onClick={() => setSeparate((s) => !s)}>
                Separate Bill{separate ? ': ON' : ''}
              </Button>
            )}
            {onPrint && (
              <Button variant="primary" icon={Printer} onClick={() => onPrint(separate && canSeparate)}>
                {separate && canSeparate ? `Print ${lines.length} Invoices` : 'Print'}
              </Button>
            )}
          </>
        )
      }
    >
      {/* ---- Header ---- */}
      <div className="receipt-head" style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
        gap: 16, paddingBottom: 12, marginBottom: 14,
        borderBottom: '2px solid var(--primary)', flexWrap: 'wrap',
      }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{shopName}</div>
          {party?.name && <div className="small muted">Billed to: {party.name}</div>}
          {party?.phone && <div className="small muted">{party.phone}</div>}
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{bill.billNo}</div>
          <div className="small muted">{fmtDate(bill.date)}</div>
          <div style={{ marginTop: 4 }}><Pill status={bill.status} /></div>
        </div>
      </div>

      {/* ---- Items ---- */}
      {lines.length ? (
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 32 }}>#</th>
                <th>Item</th>
                <th className="r">Qty</th>
                <th>Unit</th>
                <th className="r">Rate</th>
                <th className="r">Amount</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={l.id || i}>
                  <td className="muted">{i + 1}</td>
                  <td style={{ fontWeight: 500 }}>{itemName(l.itemId)}</td>
                  <td className="r">{l.qty}</td>
                  <td>{l.unit}</td>
                  <td className="r"><Money value={l.price} /></td>
                  <td className="r strong">
                    <Money value={(Number(l.qty) || 0) * (Number(l.price) || 0)} />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2}>
                  {lines.length} item{lines.length === 1 ? '' : 's'}
                </td>
                {/* Spans Qty + Unit so a mixed-unit total like "50 KG + 12 Piece"
                    has room and still sits under the quantity column. */}
                <td className="r" colSpan={2} style={{ fontWeight: 700 }}>{totalQty}</td>
                <td colSpan={2}></td>
              </tr>
            </tfoot>
          </table>
        </div>
      ) : (
        <Empty icon={Receipt} title="No item detail"
               message="This bill has no line items recorded." />
      )}

      {/* ---- Totals ---- */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
        <div className="receipt-totals" style={{ minWidth: 260 }}>
          {totalQty && (
            <div style={{ display: 'flex', alignItems: 'center', padding: '4px 0' }}>
              <span style={{ fontSize: 13 }}>Total quantity</span>
              <span className="spacer" />
              <span style={{ fontSize: 13, fontWeight: 600 }}>{totalQty}</span>
            </div>
          )}
          <Row label="Subtotal" value={subtotal} />
          {Number(bill.roundOff) !== 0 && (
            <Row label="Round off" value={bill.roundOff} showSign muted />
          )}
          {bill.returned > 0 && (
            <Row label="Returns" value={-bill.returned} tone="var(--danger)" />
          )}
          <div style={{
            display: 'flex', alignItems: 'center', padding: '8px 0', marginTop: 4,
            borderTop: '2px solid var(--border-strong)',
          }}>
            <span style={{ fontWeight: 700, fontSize: 14 }}>Total</span>
            <span className="spacer" />
            <span className="money" style={{ fontSize: 17 }}>{money(bill.net)}</span>
          </div>
          <Row label="Paid" value={bill.paid} tone="var(--success)" />
          <div style={{
            display: 'flex', alignItems: 'center', padding: '8px 0',
            borderTop: '1px solid var(--border)',
          }}>
            <span style={{ fontWeight: 700 }}>Balance due</span>
            <span className="spacer" />
            <span className="money" style={{
              fontSize: 16,
              color: bill.due > 0 ? 'var(--danger)' : 'var(--success)',
            }}>
              {money(bill.due)}
            </span>
          </div>
          {bill.due > 0 && bill.dueDate && (
            <div className="small muted" style={{ textAlign: 'right', marginTop: 2 }}>
              Payable by {fmtDate(bill.dueDate)}
            </div>
          )}
        </div>
      </div>

      {/* ---- Payments received ---- */}
      {livePayments.length > 0 && (
        <>
          <h3 className="h3" style={{ marginTop: 18, marginBottom: 7 }}>Payments received</h3>
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Date</th><th>Method</th><th>Note</th><th className="r">Amount</th>
                </tr>
              </thead>
              <tbody>
                {livePayments.map((p) => {
                  const chq = cheques.find((c) => c.paymentId === p.id);
                  return (
                    <tr key={p.id}>
                      <td className="nowrap small">{fmtDate(p.date)}</td>
                      <td>
                        {p.method}
                        {chq && (
                          <div className="small muted">
                            {chq.chequeNo}{chq.bankName ? ` · ${chq.bankName}` : ''}{chq.accountHolder ? ` · ${chq.accountHolder}` : ''}
                            {chq.status !== 'cleared' && (
                              <> · <Pill status={chq.status === 'bounced' ? 'bounced' : 'partial'}
                                         label={chq.status === 'bounced' ? 'Bounced' : 'Pending'} /></>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="small muted">{p.note || '—'}</td>
                      <td className="r strong"><Money value={p.amount} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ---- Returns ---- */}
      {returns.length > 0 && (
        <>
          <h3 className="h3" style={{ marginTop: 18, marginBottom: 7 }}>Returns</h3>
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr><th>Date</th><th>Item</th><th className="r">Qty</th><th className="r">Value</th></tr>
              </thead>
              <tbody>
                {returns.map((r) => (
                  <tr key={r.id}>
                    <td className="nowrap small">{fmtDate(r.date)}</td>
                    <td>{itemName(r.itemId)}</td>
                    <td className="r">{r.qty}</td>
                    <td className="r strong"><Money value={r.valueAdjusted} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {bill.note && (
        <div className="small muted" style={{ marginTop: 16 }}>
          <strong>Note:</strong> {bill.note}
        </div>
      )}
    </Modal>
  );
}

function Row({ label, value, showSign = false, muted = false, tone }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '4px 0' }}>
      <span className={muted ? 'muted' : ''} style={{ fontSize: 13 }}>{label}</span>
      <span className="spacer" />
      <span className="money" style={{ color: tone, fontSize: 13 }}>
        {money(value, { showSign })}
      </span>
    </div>
  );
}
