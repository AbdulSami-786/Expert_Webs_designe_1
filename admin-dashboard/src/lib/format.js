const DAY = 86400000;

export const fmtDate = (ms) =>
  ms ? new Date(ms).toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' }) : '—';

export const fmtTime = (ms) =>
  ms ? new Date(ms).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '';

export const fmtDateTime = (ms) => (ms ? `${fmtDate(ms)}, ${fmtTime(ms)}` : '—');

export const fmtShort = (ms) =>
  ms ? new Date(ms).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Never';

/** Whole days left, rounded up: 4 days 3 hours left reads as "5 days". Negative once expired. */
export const daysLeft = (expiresAt, now) => Math.ceil((expiresAt - now) / DAY);

/** For <input type="datetime-local">: the browser wants local time as YYYY-MM-DDTHH:mm. */
export function toInputValue(ms) {
  const d = new Date(ms || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export const fromInputValue = (v) => (v ? new Date(v).getTime() : 0);

/** active | soon | expired | locked — one word that drives the colour of every badge. */
export function clientState(c, now) {
  if (c.locked) return 'locked';
  if (c.expiresAt <= now) return 'expired';
  if (daysLeft(c.expiresAt, now) <= (c.warnDays || 5)) return 'soon';
  return 'active';
}

export const STATE_LABEL = { active: 'Active', soon: 'Expiring soon', expired: 'Expired', locked: 'Closed' };
