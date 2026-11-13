// Export helpers (FR-52 / Plan 7.7) — client-side generation, no server round-trip.
//
// Excel: written as CSV with a .xls-compatible UTF-8 BOM so Excel opens it
//        cleanly and the file stays editable. No heavyweight library needed.
// PDF:   rendered through the browser print dialog with print-only styling,
//        which also produces the printed bill (FR-10).

import { money, fmtDate, totalQtyLabel } from './format';

/* ------------------------------------------------------------------ */
/* File download                                                       */
/* ------------------------------------------------------------------ */

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCSV(rows) {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

function safeName(s) {
  return String(s || 'export').replace(/[^\w\-]+/g, '_');
}

/* ------------------------------------------------------------------ */
/* Excel (CSV) export                                                  */
/* ------------------------------------------------------------------ */

/**
 * Export a report table to Excel.
 * @param {string} title     report name, used in the filename
 * @param {string[]} headers column headers
 * @param {Array[]} rows     row values, already display-formatted
 */
export function exportExcel(title, headers, rows, meta = []) {
  const all = [];
  meta.forEach((line) => all.push([line]));
  if (meta.length) all.push([]);
  all.push(headers);
  rows.forEach((r) => all.push(r));

  // BOM so Excel reads UTF-8 (Rs symbol, party names) correctly
  download(
    `${safeName(title)}_${stamp()}.csv`,
    '﻿' + toCSV(all),
    'text/csv;charset=utf-8;'
  );
}

/* ------------------------------------------------------------------ */
/* Full backup (FR-51)                                                 */
/* ------------------------------------------------------------------ */

/**
 * Download the entire dataset. JSON keeps it restorable; a per-tab CSV bundle
 * would lose type fidelity, so the JSON is the canonical backup.
 */
export function downloadBackup(data, shopName = 'Expert_Webs_Designs') {
  const payload = {
    _backup: {
      shop: shopName,
      generatedAt: new Date().toISOString(),
      version: 1,
      note: 'Full dataset backup. Keep this file safe — it restores every record.',
    },
    ...data,
  };
  download(
    `${safeName(shopName)}_FullBackup_${stamp()}.json`,
    JSON.stringify(payload, null, 2),
    'application/json'
  );
}

/* ------------------------------------------------------------------ */
/* PDF via print                                                       */
/* ------------------------------------------------------------------ */

/**
 * Open a print window containing just the given HTML, styled for paper.
 * Used for bills and for "Export PDF" on report pages — the browser's
 * Save-as-PDF option in the print dialog produces the file.
 *
 * `css` replaces the A4 stylesheet, for output that is not a page of paper —
 * the 80mm thermal receipt. The A4 styles are not merely overridden because
 * nearly every rule in them (fixed-width totals block, side-by-side header,
 * six-column table) is wrong at 72mm and would have to be undone one by one.
 */
export function printHTML(title, bodyHTML, { css = null, width = 900 } = {}) {
  const w = window.open('', '_blank', `width=${width},height=700`);
  if (!w) {
    alert('Please allow pop-ups for this site to print or export PDF.');
    return;
  }
  w.document.write(`<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${escapeHTML(title)}</title>
<style>${css || `
  * { box-sizing: border-box; }
  body {
    font-family: Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: #1F2937; margin: 28px; font-size: 12.5px; line-height: 1.5;
  }
  h1 { font-size: 20px; margin: 0 0 2px; }
  h2 { font-size: 15px; margin: 18px 0 8px; }
  .muted { color: #6B7280; }
  .head { display: flex; justify-content: space-between; align-items: flex-start;
          border-bottom: 2px solid #111318; padding-bottom: 12px; margin-bottom: 16px; }
  .head .right { text-align: right; }
  table { width: 100%; border-collapse: collapse; margin: 10px 0; }
  th { background: #F3F4F6; text-align: left; padding: 7px 9px; font-size: 10.5px;
       text-transform: uppercase; letter-spacing: .04em; border-bottom: 1px solid #D1D5DB; }
  td { padding: 7px 9px; border-bottom: 1px solid #F1F3F5; }
  td.r, th.r { text-align: right; font-variant-numeric: tabular-nums; }
  tfoot td { font-weight: 700; border-top: 2px solid #D1D5DB; background: #F9FAFB; }
  .totals { margin-left: auto; width: 290px; }
  .totals td { padding: 5px 9px; }
  .totals tr.grand td { font-size: 15px; font-weight: 700; border-top: 2px solid #111318; }
  .pill { display: inline-block; padding: 2px 9px; border-radius: 999px;
          font-size: 10.5px; font-weight: 700; border: 1px solid; }
  .pill-paid    { background:#DCFCE7; color:#15803D; border-color:#BBF7D0; }
  .pill-partial { background:#FEF3C7; color:#B45309; border-color:#FDE68A; }
  .pill-due     { background:#FEE2E2; color:#B91C1C; border-color:#FECACA; }
  .pill-voided  { background:#F3F4F6; color:#6B7280; border-color:#E5E7EB; }
  .foot { margin-top: 26px; padding-top: 10px; border-top: 1px solid #E5E7EB;
          font-size: 10.5px; color: #6B7280; text-align: center; }
  @media print { body { margin: 12mm; } .no-print { display: none; } }
`}</style>
</head>
<body>${bodyHTML}
<script>
  window.onload = function () { window.print(); };
<\/script>
</body>
</html>`);
  w.document.close();
}

/* ------------------------------------------------------------------ */
/* Bill print — 80mm thermal receipt (FR-10)                           */
/* ------------------------------------------------------------------ */

// Printable width of the thermal paper. An 80mm roll is printed ~72mm wide by
// most heads, but many portable printers print narrower still, and the driver
// silently clips whatever runs past it — a total in the last column is exactly
// what gets lost. So the width is a setting (Settings → Receipt printer),
// and every rule below is sized against it.
export const RECEIPT_WIDTHS = [
  { value: 72, label: '80mm paper — standard (72mm print)' },
  { value: 68, label: '80mm paper — slightly narrow (68mm)' },
  { value: 64, label: '80mm paper — portable / mini (64mm)' },
  { value: 48, label: '58mm paper (48mm print)' },
];
const DEFAULT_RECEIPT_WIDTH_MM = 72;

/** The printable width from settings, falling back to the 80mm standard. */
export function receiptWidthMm(settings = {}) {
  const w = Number(settings.receiptWidthMm);
  return w >= 40 && w <= 80 ? w : DEFAULT_RECEIPT_WIDTH_MM;
}

/**
 * Text scales with the paper: 13px is the largest that fits
 * "1000 Piece x 1,000.00" and its amount on one 72mm line in this monospace
 * stack, so a narrower roll gets proportionally smaller type.
 */
function receiptCss(widthMm, { pageMm = widthMm } = {}) {
  // pageMm wider than widthMm lays the slip out on a wider page (the width
  // test slip, whose ruler must reach past the setting); its content blocks
  // then set their own width.
  const fitted = pageMm === widthMm;
  const k = widthMm / 72;
  const px = (n) => `${Math.max(9, Math.round(n * k * 2) / 2)}px`;
  return `
  * { box-sizing: border-box; }
  @page { size: ${pageMm}mm auto; margin: 0; }
  body {
    /* A monospace stack keeps the money column aligned down the receipt. The
       narrow measure leaves no room for a column that drifts. */
    font-family: "Menlo", "Consolas", "Liberation Mono", monospace;
    color: #000; background: #fff;
    width: ${pageMm}mm; margin: 0; padding: ${fitted ? '0 1.5mm' : '0'};
    font-size: ${px(13)}; line-height: 1.45;
    /* Bold throughout — thermal heads under-burn thin strokes, so regular
       weight prints grey and faded, especially on a worn roll. */
    font-weight: 700;
  }
  /* Thermal printers render grey as a dither pattern that reads as smudged
     dirt, so everything is pure black and borders are dashed rules. */
  .center { text-align: center; }
  .shop { font-size: ${px(18)}; font-weight: 700; letter-spacing: .02em; word-break: break-word; }
  /* Secondary lines stay bold like everything else; they are set apart by
     size alone, since weight is no longer available to distinguish them. */
  .sub { font-size: ${px(12)}; }
  hr { border: 0; border-top: 1px dashed #000; margin: 7px 0; }
  .kv { display: flex; justify-content: space-between; gap: 6px; }
  .kv .k { flex: 0 0 auto; }
  .kv .v { text-align: right; word-break: break-word; }
  /* Item: name on its own line, then the arithmetic indented under it. Long
     item names therefore never push the amount off the paper. */
  .li { margin: 6px 0; }
  .li .nm { font-weight: 700; }
  /* Indent trimmed 5mm -> 3mm: at 13px the wider indent left too little room
     for the amount, which is the number that must never wrap. */
  .li .calc { display: flex; justify-content: space-between; gap: 4px; padding-left: ${widthMm < 60 ? 1.5 : 3}mm; }
  .li .calc span:last-child { white-space: nowrap; }
  .li .dlv { padding-left: ${widthMm < 60 ? 1.5 : 3}mm; font-size: ${px(11.5)}; }
  .tot { display: flex; justify-content: space-between; gap: 4px; }
  .tot span:last-child { white-space: nowrap; }
  .tot.grand { font-size: ${px(16)}; font-weight: 700; }
  .tot.due { font-weight: 700; }
  .status { font-weight: 700; letter-spacing: .04em; }
  /* Separate-invoice printing: each item's slip starts on its own page, so a
     thermal printer feeds and cuts between them. */
  .slip { break-after: page; page-break-after: always; padding-bottom: 6mm; }
  .slip:last-child { break-after: auto; page-break-after: auto; }
  .foot { font-size: ${px(12)}; margin-top: 6px; }
  /* Nothing may exceed the print head's width or the right edge is clipped. */
  ${fitted ? 'body, body * { max-width: 100%; overflow-wrap: anywhere; }' : 'body * { overflow-wrap: anywhere; }'}
  @media print { .no-print { display: none; } }
`;
}

/**
 * The receipt as a PDF file, saved straight to the device.
 *
 * Drawn with jsPDF rather than routed through the browser's print dialog: one
 * tap writes the file, with no sheet to dismiss and no "Save as PDF" to find.
 * That is the whole point of this function — the print path still exists as
 * printBill() for actual paper.
 *
 * jsPDF is imported lazily. It is ~350KB, and a shopkeeper who never taps PDF
 * should not pay for it on every page load; the chunk is fetched the first
 * time a bill is saved and cached from then on.
 *
 * Laid out on A5 portrait: a PDF is read on a phone screen or filed, not fed
 * through a thermal head, so the 72mm roll measure would open as a thin ribbon.
 * A5 keeps a receipt's tall narrow proportion while staying legible.
 */
export async function downloadBillPDF({ bill, lines, party, payments, settings, state, delivery = null }) {
  const { jsPDF } = await import('jspdf');

  // A5 portrait, in millimetres: 148 x 210.
  const doc = new jsPDF({ unit: 'mm', format: 'a5' });
  const W = 148;
  const M = 12;              // side margin
  const RIGHT = W - M;       // right-aligned money column
  const BOTTOM = 210 - 14;   // start a new page past this

  let y = 16;

  // Helvetica is one of jsPDF's built-in fonts, so no font file has to be
  // embedded and the PDF stays a few KB.
  const set = (size, style = 'normal') => {
    doc.setFont('helvetica', style);
    doc.setFontSize(size);
  };
  const grey = () => doc.setTextColor(110);
  const black = () => doc.setTextColor(17);

  // Money is drawn without the "Rs " prefix the screen uses: jsPDF's built-in
  // fonts are Latin-1, so any non-ASCII currency mark would render as junk.
  const amt = (n) => (Number(n) || 0).toLocaleString('en-PK', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });

  const page = (need = 8) => {
    if (y + need <= BOTTOM) return;
    doc.addPage();
    y = 16;
  };

  const rule = (dashed = false) => {
    page();
    doc.setDrawColor(dashed ? 190 : 150);
    if (dashed && doc.setLineDashPattern) doc.setLineDashPattern([0.7, 0.7], 0);
    doc.setLineWidth(0.2);
    doc.line(M, y, RIGHT, y);
    if (dashed && doc.setLineDashPattern) doc.setLineDashPattern([], 0);
    y += 4.5;
  };

  // Label left, value right, on one line.
  const kv = (k, v, { size = 9.5, style = 'normal', gap = 5 } = {}) => {
    page(gap + 2);
    set(size, style);
    grey(); doc.text(String(k), M, y);
    black();
    doc.setFont('helvetica', style === 'normal' ? 'bold' : style);
    doc.text(String(v), RIGHT, y, { align: 'right' });
    y += gap;
  };

  /* ---- Shop header ---- */
  set(15, 'bold'); black();
  doc.text(String(settings.shopName || 'Expert Webs Designs'), W / 2, y, { align: 'center' });
  y += 5.5;

  set(8); grey();
  [settings.address, settings.phone].filter(Boolean).forEach((t) => {
    page(4);
    doc.text(String(t), W / 2, y, { align: 'center' });
    y += 3.8;
  });
  y += 2;
  rule();

  /* ---- Bill meta ---- */
  kv('Bill', bill.billNo, { style: 'bold' });
  kv('Date', fmtDate(bill.date));
  kv('Party', party?.name || '');
  if (party?.phone) kv('Phone', party.phone);
  if (state.due > 0 && bill.dueDate) kv('Due date', fmtDate(bill.dueDate));
  kv('Status', String(state.status).toUpperCase(), { style: 'bold' });
  if (delivery?.state === 'partial') kv('Delivery', 'PARTLY DELIVERED', { style: 'bold' });
  else if (state.delivery === 'pending') kv('Delivery', 'NOT DELIVERED', { style: 'bold' });

  rule();

  /* ---- Items ----
     Name on its own line with the arithmetic indented beneath it, matching the
     thermal receipt: a long item name then wraps instead of colliding with the
     amount, which must stay readable. */
  lines.forEach((l, i) => {
    const qty = Number(l.qty) || 0;
    const price = Number(l.price) || 0;

    set(9.5, 'bold'); black();
    const name = `${i + 1}. ${l.itemName || 'Item'}`;
    const wrapped = doc.splitTextToSize(name, RIGHT - M);
    page(wrapped.length * 4.2 + 6);
    doc.text(wrapped, M, y);
    y += wrapped.length * 4.2;

    set(9); grey();
    doc.text(`${qty} ${l.unit || ''} x ${amt(price)}`.trim(), M + 4, y);
    set(9, 'bold'); black();
    doc.text(amt(qty * price), RIGHT, y, { align: 'right' });
    y += 6;
    if (delivery?.state === 'partial' && l.delivered !== undefined && l.delivered < qty - 0.0001) {
      set(8.5, 'bold'); grey();
      doc.text(`Sent ${+Number(l.delivered).toFixed(3)} - PENDING ${+(qty - l.delivered).toFixed(3)}`, M + 4, y - 1.5);
      y += 3.5;
    }
  });

  rule();

  const totalQty = totalQtyLabel(lines);
  kv(`${lines.length} item${lines.length === 1 ? '' : 's'}`, totalQty || '');

  rule();

  /* ---- Totals ---- */
  kv('Subtotal', amt(bill.subtotal));
  if (Number(bill.roundOff) !== 0) kv('Round off', amt(bill.roundOff));
  if (state.returned > 0) kv('Returns', `- ${amt(state.returned)}`);

  y += 1;
  page(12);
  doc.setDrawColor(17); doc.setLineWidth(0.5);
  doc.line(M, y, RIGHT, y);
  y += 6;

  set(13, 'bold'); black();
  doc.text('TOTAL', M, y);
  doc.text(amt(state.net), RIGHT, y, { align: 'right' });
  y += 7;

  kv('Paid', amt(state.paid));

  page(10);
  doc.setDrawColor(190); doc.setLineWidth(0.2);
  doc.line(M, y, RIGHT, y);
  y += 5.5;

  set(11, 'bold'); black();
  doc.text('BALANCE DUE', M, y);
  doc.text(amt(state.due), RIGHT, y, { align: 'right' });
  y += 7;

  /* ---- Payments ---- */
  if (payments && payments.length) {
    rule(true);
    set(8, 'bold'); grey();
    page();
    doc.text('PAYMENTS', M, y);
    y += 4.5;
    payments.forEach((p) => {
      kv(p.method + (p.note ? ` (${p.note})` : ''), amt(p.amount), { size: 9 });
    });
  }

  /* ---- Footer ---- */
  y += 3;
  rule(true);
  set(8); grey();
  page(8);
  doc.text('Thank you for your business.', W / 2, y, { align: 'center' });
  y += 4;
  const footLine = [settings.shopName, settings.phone].filter(Boolean).join(' - ');
  if (footLine) doc.text(footLine, W / 2, y, { align: 'center' });

  // A filename the shopkeeper can find later: bill number, then party.
  const safe = (s) => String(s || '').replace(/[^\w\d-]+/g, '-').replace(/^-+|-+$/g, '');
  const name = ['Bill', safe(bill.billNo), safe(party?.name)].filter(Boolean).join('-');
  doc.save(`${name}.pdf`);
}

/**
 * Print a bill.
 *
 * Normal: one receipt with every item, the totals and the payments.
 *
 * `separate`: one invoice slip PER ITEM, each starting on its own page (so a
 * thermal printer cuts between them). A slip carries the shop, bill number,
 * date and party, that one item, and that item's amount as its total. Whole-bill
 * figures — round off, returns, amount paid, balance due — are not split across
 * slips, because they belong to the bill as a whole; the normal print has them.
 * A bill with a single item has nothing to separate and prints normally.
 */
export function printBill({ bill, lines, party, payments, settings, state, delivery = null, separate = false }) {
  const widthMm = receiptWidthMm(settings);
  // A narrow preview window so what is on screen matches the paper.
  const opts = { css: receiptCss(widthMm), width: 380 };

  if (separate && lines.length > 1) {
    const slips = lines.map((l, i) => buildSlipHTML({
      bill, lines: [l], party, payments: [], settings,
      state: { ...state, net: l.qty * l.price, paid: 0, due: 0, returned: 0 },
      delivery, part: { n: i + 1, of: lines.length }, itemOnly: true,
    }));
    printHTML(`Bill ${bill.billNo} - separate invoices`,
      slips.map((h) => `<section class="slip">${h}</section>`).join(''), opts);
    return;
  }

  printHTML(`Bill ${bill.billNo}`,
    buildSlipHTML({ bill, lines, party, payments, settings, state, delivery }), opts);
}

/**
 * The HTML of one receipt. `part` marks it as invoice n of N when a bill is
 * printed one item at a time; `itemOnly` leaves out the whole-bill figures.
 */
function buildSlipHTML({ bill, lines, party, payments, settings, state, delivery = null, part = null, itemOnly = false }) {
  // Part delivered: say so, and show on each line what is still to go.
  const partly = delivery?.state === 'partial';
  // Grouped by unit — a bill mixing KG and Piece has no single total, and a
  // wrong one on a printed receipt is worse than none (see totalQtyLabel).
  const totalQty = totalQtyLabel(lines);

  const row = (k, v, cls = '') =>
    `<div class="kv ${cls}"><span class="k">${k}</span><span class="v">${v}</span></div>`;

  const items = lines.map((l, i) => `
    <div class="li">
      <div class="nm">${part ? part.n : i + 1}. ${escapeHTML(l.itemName)}</div>
      <div class="calc">
        <span>${l.qty} ${escapeHTML(l.unit)} &times; ${money(l.price)}</span>
        <span>${money(l.qty * l.price)}</span>
      </div>
      ${partly && l.delivered !== undefined && l.delivered < l.qty - 0.0001
        ? `<div class="dlv">Sent ${+Number(l.delivered).toFixed(3)} &middot; PENDING ${+(l.qty - l.delivered).toFixed(3)}</div>`
        : ''}
    </div>`).join('');

  const payRows = payments.length
    ? `<hr/><div class="sub">PAYMENTS</div>
       ${payments.map((p) => row(
         escapeHTML(p.method) + (p.note ? ` <span class="sub">(${escapeHTML(p.note)})</span>` : ''),
         money(p.amount),
       )).join('')}`
    : '';

  const html = `
    <div class="center">
      <div class="shop">${escapeHTML(settings.shopName || 'Expert Webs Designs')}</div>
      ${settings.address ? `<div class="sub">${escapeHTML(settings.address)}</div>` : ''}
      ${settings.phone ? `<div class="sub">${escapeHTML(settings.phone)}</div>` : ''}
    </div>

    <hr/>
    ${row('Bill', `<strong>${escapeHTML(bill.billNo)}</strong>`)}
    ${part ? row('Invoice', `<strong>${part.n} of ${part.of}</strong>`) : ''}
    ${row('Date', fmtDate(bill.date))}
    ${row('Party', `<strong>${escapeHTML(party?.name || '')}</strong>`)}
    ${party?.phone ? row('Phone', escapeHTML(party.phone)) : ''}
    ${!itemOnly && state.due > 0 && bill.dueDate ? row('Due date', fmtDate(bill.dueDate)) : ''}
    ${itemOnly ? '' : row('Status', `<span class="status">${state.status.toUpperCase()}</span>`)}
    ${itemOnly ? '' : partly
      ? row('Delivery', '<span class="status">PARTLY DELIVERED</span>')
      : state.delivery === 'pending'
        ? row('Delivery', '<span class="status">NOT DELIVERED</span>')
        : ''}

    <hr/>
    ${items}
    <hr/>

    ${itemOnly ? '' : row(`${lines.length} item${lines.length === 1 ? '' : 's'}`,
          totalQty ? `<strong>${escapeHTML(totalQty)}</strong>` : '')}
    ${itemOnly ? '' : '<hr/>'}

    ${itemOnly ? '' : `<div class="tot"><span>Subtotal</span><span>${money(bill.subtotal)}</span></div>
    ${Number(bill.roundOff) !== 0
      ? `<div class="tot"><span>Round off</span><span>${money(bill.roundOff, { showSign: true })}</span></div>`
      : ''}
    ${state.returned > 0
      ? `<div class="tot"><span>Returns</span><span>- ${money(state.returned)}</span></div>`
      : ''}
    <hr/>`}
    <div class="tot grand"><span>TOTAL</span><span>${money(state.net)}</span></div>
    ${itemOnly ? '' : `<div class="tot"><span>Paid</span><span>${money(state.paid)}</span></div>
    <div class="tot due"><span>BALANCE DUE</span><span>${money(state.due)}</span></div>

    ${payRows}`}

    <hr/>
    <div class="center foot">
      Thank you for your business.<br/>
      ${escapeHTML(settings.shopName || '')}${settings.phone ? ` · ${escapeHTML(settings.phone)}` : ''}
    </div>`;

  return html;
}

/**
 * A ruler across the paper, for finding the printer's real printable width.
 * Whatever number is the last one fully visible on the slip is the width to
 * pick in Settings.
 */
export function printReceiptTest(settings = {}) {
  const widthMm = receiptWidthMm(settings);
  // The ruler spans the whole 80mm roll regardless of the current setting, so
  // the printer's own cut-off is what decides how much of it appears.
  const marks = [44, 48, 52, 56, 60, 64, 68, 72, 76, 80];
  const ruler = marks.map((mm) => `
    <div style="width:${mm}mm;border-right:2.5mm solid #000;margin:3px 0;
                text-align:right;padding-right:1mm;white-space:nowrap">${mm}</div>`).join('');
  const sample = `
    <div style="width:${widthMm}mm;padding:0 1.5mm">
      <div class="li">
        <div class="nm">1. Sample item with a long name to check wrapping</div>
        <div class="calc"><span>1000 Piece &times; ${money(1000)}</span><span>${money(1000000)}</span></div>
      </div>
      <hr/>
      <div class="tot grand"><span>TOTAL</span><span>${money(1000000)}</span></div>
      <div class="tot due"><span>BALANCE DUE</span><span>${money(1000000)}</span></div>
    </div>`;
  const html = `
    <div style="width:${widthMm}mm;padding:0 1.5mm" class="center">
      <div class="shop">${escapeHTML(settings.shopName || 'Expert Webs Designs')}</div>
      <div class="sub">Receipt width test</div>
    </div>
    <hr/>
    <div style="width:${widthMm}mm;padding:0 1.5mm" class="sub">
      The biggest number you can fully read, with its black bar, is your printer's width in mm.
    </div>
    ${ruler}
    <hr/>
    <div style="width:${widthMm}mm;padding:0 1.5mm" class="sub">Sample bill at the current setting (${widthMm}mm):</div>
    ${sample}
    <hr/>
    <div style="width:${widthMm}mm;padding:0 1.5mm" class="center foot">
      If the right edge of the total is cut, pick a narrower width in Settings.
    </div>`;
  // Laid out on the full roll; the sample bill inside sits at the set width.
  printHTML('Receipt width test', html, { css: receiptCss(widthMm, { pageMm: 80 }), width: 380 });
}

/* ------------------------------------------------------------------ */
/* Generic report PDF                                                  */
/* ------------------------------------------------------------------ */

export function printReport({ title, subtitle, shopName, headers, rows, totals = null, meta = [] }) {
  const thead = `<tr>${headers.map((h) =>
    `<th class="${h.align === 'r' ? 'r' : ''}">${escapeHTML(h.label ?? h)}</th>`).join('')}</tr>`;

  const tbody = rows.map((r) =>
    `<tr>${r.map((c, i) =>
      `<td class="${headers[i]?.align === 'r' ? 'r' : ''}">${cellHTML(c)}</td>`
    ).join('')}</tr>`).join('');

  const tfoot = totals
    ? `<tfoot><tr>${totals.map((c, i) =>
        `<td class="${headers[i]?.align === 'r' ? 'r' : ''}">${cellHTML(c)}</td>`).join('')}</tr></tfoot>`
    : '';

  const html = `
    <div class="head">
      <div>
        <h1>${escapeHTML(shopName || 'Expert Webs Designs')}</h1>
        <div class="muted">${escapeHTML(subtitle || '')}</div>
      </div>
      <div class="right">
        <h1>${escapeHTML(title)}</h1>
        <div class="muted">Generated ${fmtDate(new Date())}</div>
      </div>
    </div>
    ${meta.length ? `<div class="muted" style="margin-bottom:10px">${meta.map(escapeHTML).join(' &nbsp;·&nbsp; ')}</div>` : ''}
    <table><thead>${thead}</thead><tbody>${tbody}</tbody>${tfoot}</table>
    <div class="foot">${escapeHTML(shopName || '')} — ${escapeHTML(title)}</div>`;

  printHTML(title, html);
}

export function escapeHTML(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ------------------------------------------------------------------ */
/* Trusted markup in report cells                                      */
/* ------------------------------------------------------------------ */
//
// Report cells are escaped by default, because they carry free-text the user
// typed (party names, item names, notes) straight into the print window.
// Some reports legitimately need markup — a status pill, a bold total row.
// Those callers wrap the value in raw(), which is the ONLY way to get
// unescaped HTML into a cell. Anything built from user input must still be
// escaped by the caller before being handed to raw().

const RAW = Symbol('rawHTML');

/** Mark a string as trusted HTML for a report cell. Never pass user input. */
export function raw(html) {
  return { [RAW]: String(html ?? '') };
}

function cellHTML(c) {
  if (c === null || c === undefined) return '';
  if (typeof c === 'object' && RAW in c) return c[RAW];
  return escapeHTML(c);
}
