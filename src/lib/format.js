// Formatting helpers. Money always tabular + 2dp internally (Plan 3.4).

import { CONFIG } from './config';

export const CURRENCY = 'Rs';

/** Format a number as currency. Internally values keep 2dp; display trims .00 */
export function money(n, opts = {}) {
  const { showSign = false, decimals = null } = opts;
  const raw = Number(n);
  // Non-finite values would render as "Rs ∞" / "Rs NaN" on a bill, so they
  // fall back to zero. Sub-paisa residue from rounding is clamped too, or a
  // -0.004 balance prints as the nonsensical "-Rs 0".
  const v = !Number.isFinite(raw) || Math.abs(raw) < 0.005 ? 0 : raw;
  const abs = Math.abs(v);
  const dp = decimals !== null ? decimals : (Math.round(abs * 100) % 100 === 0 ? 0 : 2);
  const s = abs.toLocaleString('en-PK', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  const sign = v < 0 ? '-' : (showSign && v > 0 ? '+' : '');
  return `${sign}${CURRENCY} ${s}`;
}

/** Plain number with thousands separators (quantities). */
export function num(n, dp = 0) {
  const v = Number(n) || 0;
  return v.toLocaleString('en-PK', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/** Round to 2dp to avoid float drift when summing money. */
export function r2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * How many BASE units one unit of a bill line is worth.
 *
 * An item can be sold in its alternate unit ("1 Bag = 50 KG"). Quantity and
 * price on a bill line are in the unit the line was sold in, but stock and cost
 * are held per base unit, so a line sold in the alternate unit has to be
 * converted before it touches either. Anything else counts as 1.
 */
export function unitFactor(item, unit) {
  const rate = Number(item?.conversionRate);
  if (item?.altUnit && unit && unit === item.altUnit && rate > 0) return rate;
  return 1;
}

/** ISO date (yyyy-mm-dd) for today, local time. */
export function todayISO() {
  return toISO(new Date());
}

export function toISO(d) {
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt)) return '';
  const p = (x) => String(x).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

/** "12 Mar 2025" */
export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** "12 Mar, 3:45 PM" */
export function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  return d.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

/** Whole days between two dates (b - a). */
export function daysBetween(a, b = new Date()) {
  const d1 = new Date(a), d2 = new Date(b);
  if (isNaN(d1) || isNaN(d2)) return 0;
  d1.setHours(0, 0, 0, 0);
  d2.setHours(0, 0, 0, 0);
  return Math.round((d2 - d1) / 86400000);
}

/** Days a bill is overdue (negative = not yet due). */
export function daysOverdue(dueDate) {
  if (!dueDate) return 0;
  return daysBetween(dueDate, new Date());
}

export function addDays(iso, n) {
  const d = new Date(iso);
  d.setDate(d.getDate() + Number(n || 0));
  return toISO(d);
}

/** Aging bucket per Plan 4.4 / FR-23 */
export function agingBucket(days) {
  if (days <= 7) return '0-7';
  if (days <= 30) return '8-30';
  return '30+';
}

export const AGING_BUCKETS = ['0-7', '8-30', '30+'];

export const AGING_META = {
  '0-7':  { label: '0–7 days',   cls: 'age-0',  mcls: 'due-0',  tone: 'warning', color: '#F59E0B' },
  '8-30': { label: '8–30 days',  cls: 'age-8',  mcls: 'due-8',  tone: 'warning', color: '#EA580C' },
  '30+':  { label: '30+ days',   cls: 'age-30', mcls: 'due-30', tone: 'danger',  color: '#DC2626' },
};

/** Apply the configured rounding rule (FR-11 / Plan 3.4). */
export function applyRounding(amount, rule = 'nearest1') {
  const v = r2(amount);
  switch (rule) {
    case 'exact':    return v;
    case 'nearest1':  return Math.round(v);
    case 'nearest5':  return Math.round(v / 5) * 5;
    case 'nearest10': return Math.round(v / 10) * 10;
    default:          return Math.round(v);
  }
}

export const ROUNDING_RULES = [
  { value: 'exact',     label: 'Exact (no rounding)' },
  { value: 'nearest1',  label: 'Nearest 1 Rupee' },
  { value: 'nearest5',  label: 'Nearest 5 Rupees' },
  { value: 'nearest10', label: 'Nearest 10 Rupees' },
];

/** % change between two values, guarding divide-by-zero. */
export function pctChange(curr, prev) {
  const c = Number(curr) || 0, p = Number(prev) || 0;
  if (p === 0) return c === 0 ? 0 : 100;
  return ((c - p) / Math.abs(p)) * 100;
}

/** Normalised text for search (NFR-6 type-ahead). */
export function norm(s) {
  return String(s ?? '').toLowerCase().trim();
}

/** Build a wa.me link (FR-10 / 7.8 — manual send, not API). */
export function waLink(phone, text) {
  const digits = String(phone || '').replace(/\D/g, '');
  // Pakistan numbers entered as 03xx… become 923xx…. A number that lost its
  // leading 0 on the way through Google Sheets (3xx…, 10 digits) is the same.
  const intl = digits.startsWith('0') ? '92' + digits.slice(1)
    : /^3\d{9}$/.test(digits) ? '92' + digits
    : digits;
  const base = intl ? `https://wa.me/${intl}` : 'https://wa.me/';
  return `${base}?text=${encodeURIComponent(text || '')}`;
}

/**
 * A shareable link to a party's ledger.
 *
 * Anchored to CONFIG.publicUrl so the link points at the live site wherever it
 * was copied from — a link generated on localhost is still openable on the
 * customer's phone. Falls back to the current address when publicUrl is empty.
 */
export function shareLink(token) {
  if (!token) return '';
  const base = String(CONFIG.publicUrl || '').replace(/\/+$/, '');
  if (base) return `${base}/#/share/${token}`;
  return `${window.location.origin}${window.location.pathname}#/share/${token}`;
}

/** Short id generator for client-side records. */
export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function titleCase(s) {
  return String(s || '').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Total quantity on a bill, grouped by unit.
 *
 * Quantities are only addable within one unit: a bill for 50 KG of rice and 12
 * Piece of soap has no single meaningful total, and printing "62" on a receipt
 * a customer checks against their delivery would be worse than printing
 * nothing. So each unit is totalled on its own and the parts are joined —
 * "50 KG + 12 Piece" — while the common single-unit bill still reads as the
 * plain "62 KG" the shopkeeper expects.
 *
 * Lines with no unit are grouped together and shown without one.
 */
export function totalQtyByUnit(lines = []) {
  const byUnit = new Map();

  lines.forEach((l) => {
    const qty = Number(l?.qty) || 0;
    if (!qty) return;
    const unit = String(l?.unit || '').trim();
    byUnit.set(unit, (byUnit.get(unit) || 0) + qty);
  });

  return [...byUnit.entries()].map(([unit, qty]) => {
    const rounded = r2(qty);
    // Show only the decimals the quantity actually has: 62, not 62.00, and
    // 2.5 KG rather than 2.50 KG. Quantities are counted goods, so trailing
    // zeros read as false precision on a receipt.
    const dp = Number.isInteger(rounded) ? 0 : (Math.round(rounded * 10) === rounded * 10 ? 1 : 2);
    return {
      unit,
      qty: rounded,
      label: `${num(rounded, dp)}${unit ? ` ${unit}` : ''}`,
    };
  });
}

/** The same total as one string, e.g. "50 KG + 12 Piece". */
export function totalQtyLabel(lines = []) {
  const parts = totalQtyByUnit(lines);
  if (!parts.length) return '';
  return parts.map((p) => p.label).join(' + ');
}
