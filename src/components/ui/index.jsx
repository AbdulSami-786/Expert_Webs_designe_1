// Shared component language (Design Brief 5 / 8.5).
// Every one of these behaves identically on desktop and mobile; CSS handles the
// density difference. Status colour is ALWAYS paired with a text label.

import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  X, Search, Check, AlertTriangle, Info, Inbox, Plus, ChevronDown, Loader2,
} from 'lucide-react';
import { money, norm } from '../../lib/format';

/* ==========================================================================
   Status pill — colour + label, never colour alone
   ========================================================================== */

const PILL_LABELS = {
  paid: 'Paid', partial: 'Partial', due: 'Due', overdue: 'Overdue',
  voided: 'Voided', pending: 'Pending Sync', cleared: 'Cleared',
  bounced: 'Bounced', active: 'Active', archived: 'Archived',
  // A bill whose only payment is a cheque the bank has not cleared. It is
  // still due — distinct from 'pending', which means an unsynced record.
  'cheque-pending': 'Cheque Pending',
  // Delivery, not money. These need their own keys because 'pending' above
  // already reads as "Pending Sync" — showing that on an undelivered bill
  // would describe the wrong thing entirely.
  'not-delivered': 'Not Delivered',
  delivered: 'Delivered',
  // Some items handed over, the rest still to go (sales) or still to arrive
  // (purchases).
  'part-delivered': 'Partly Delivered',
  received: 'Received',
  'not-received': 'Not Received',
  'part-received': 'Partly Received',
};

export function Pill({ status, label, children, className = '' }) {
  const key = String(status || 'neutral').toLowerCase();
  const cls = PILL_LABELS[key] ? `pill-${key}` : 'pill-neutral';
  return (
    <span className={`pill ${cls} ${className}`}>
      <span className="dot" aria-hidden="true" />
      {children || label || PILL_LABELS[key] || status}
    </span>
  );
}

/* ==========================================================================
   Money display — right-aligned, tabular, bold
   ========================================================================== */

export function Money({ value, showSign = false, className = '', decimals = null }) {
  const v = Number(value) || 0;
  const tone = showSign ? (v > 0 ? 'pos' : v < 0 ? 'neg' : '') : '';
  return <span className={`money ${tone} ${className}`}>{money(v, { showSign, decimals })}</span>;
}

/* ==========================================================================
   Buttons
   ========================================================================== */

export function Button({
  variant = '', size = '', icon: Icon, children, loading = false,
  className = '', block = false, ...rest
}) {
  return (
    <button
      className={[
        'btn',
        variant && `btn-${variant}`,
        size && `btn-${size}`,
        block && 'btn-block',
        !children && 'btn-icon',
        className,
      ].filter(Boolean).join(' ')}
      {...rest}
      // After {...rest}: a spread `disabled={false}` must not be able to
      // re-enable a button that is mid-request, or a second click fires the
      // same write twice (duplicate bills/payments).
      disabled={loading || rest.disabled}
    >
      {loading ? <Loader2 size={15} className="spin" /> : Icon ? <Icon size={15} /> : null}
      {children}
    </button>
  );
}

/* ==========================================================================
   Card
   ========================================================================== */

export function Card({ title, subtitle, actions, children, tight = false, className = '' }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-head">
          <div>
            {title && <h2 className="h2">{title}</h2>}
            {subtitle && <div className="small muted">{subtitle}</div>}
          </div>
          <div className="spacer" />
          {actions}
        </header>
      )}
      <div className={`card-body ${tight ? 'tight' : ''}`}>{children}</div>
    </section>
  );
}

/* ==========================================================================
   Stat card
   ========================================================================== */

export function Stat({ label, value, icon: Icon, delta, deltaLabel, onClick, tone, note, noteTone }) {
  const dir = delta > 0 ? 'up' : delta < 0 ? 'down' : '';
  return (
    <div className={`stat ${onClick ? 'clickable' : ''}`} onClick={onClick}
         role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined}
         onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}>
      <div className="stat-label">
        {Icon && (
          <span className="ico" style={tone ? { background: `${tone}18`, color: tone } : undefined}>
            <Icon size={14} />
          </span>
        )}
        {label}
      </div>
      <div className="stat-value">{value}</div>
      {/* A qualifier on the figure above — "Rs 30,000 in uncleared cheques"
          under an outstanding total. Tinted, because its whole job is to say
          the headline number is not the plain story. */}
      {note && (
        <div className="stat-note" style={noteTone ? { color: noteTone } : undefined}>
          {note}
        </div>
      )}
      {(delta !== undefined && delta !== null) && (
        <div className={`stat-delta ${dir}`}>
          {dir === 'up' ? '▲' : dir === 'down' ? '▼' : '—'}
          {Math.abs(delta).toFixed(1)}%
          {deltaLabel && <span className="muted">{deltaLabel}</span>}
        </div>
      )}
    </div>
  );
}

/* ==========================================================================
   Modal — centred dialog on desktop, full-screen sheet on mobile
   ========================================================================== */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({ open, title, onClose, children, footer, wide = false }) {
  const dialogRef = useRef(null);

  // Callers pass `onClose` as an inline arrow, so its identity changes on every
  // render. Held in a ref, the setup effect below can depend on `open` alone.
  // Listing onClose there re-ran the whole effect on each keystroke — including
  // the "move focus into the dialog" step, which yanked the cursor out of the
  // amount field and back to the date field mid-typing.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;

    // Remember where focus was, so closing the dialog returns the user to the
    // control they opened it from rather than the top of the page.
    const restoreTo = document.activeElement;

    const onKey = (e) => {
      if (e.key === 'Escape') { onCloseRef.current?.(); return; }
      if (e.key !== 'Tab') return;

      // Keep Tab inside the dialog: without this, focus walks into the page
      // behind the backdrop, which a keyboard user cannot see.
      const nodes = dialogRef.current?.querySelectorAll(FOCUSABLE);
      if (!nodes?.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
      }
    };

    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Move focus into the dialog, preferring the first real control over the
    // close button so typing starts where the user expects. A field with
    // autoFocus has already claimed focus — leave it alone.
    if (!dialogRef.current?.contains(document.activeElement)) {
      const nodes = dialogRef.current?.querySelectorAll(FOCUSABLE);
      (nodes?.[1] || nodes?.[0])?.focus();
    }

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
      if (restoreTo instanceof HTMLElement) restoreTo.focus();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div ref={dialogRef} className={`modal ${wide ? 'wide' : ''}`}
           role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head">
          <h2 className="h2">{title}</h2>
          <div className="spacer" />
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>,
    document.body
  );
}

/* ==========================================================================
   Bottom sheet — mobile quick actions
   ========================================================================== */

export function BottomSheet({ open, title, onClose, items = [] }) {
  if (!open) return null;
  return createPortal(
    <div className="sheet-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet-grip" />
        {title && <div className="sheet-title">{title}</div>}
        {items.map((it, i) => (
          <button key={i} className={`sheet-item ${it.danger ? 'danger' : ''}`}
                  onClick={() => { onClose?.(); it.onClick?.(); }}>
            {it.icon && <it.icon size={19} />}
            {it.label}
          </button>
        ))}
      </div>
    </div>,
    document.body
  );
}

/* ==========================================================================
   Confirmation dialog — same wording style on both platforms
   ========================================================================== */

export function Confirm({ open, title, message, confirmLabel = 'Confirm', danger = false, onConfirm, onCancel }) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>{confirmLabel}</Button>
        </>
      }
    >
      <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6 }}>{message}</p>
    </Modal>
  );
}

/* ==========================================================================
   Field wrappers
   ========================================================================== */

export function Field({ label, hint, error, children, className = '', style }) {
  return (
    <div className={`field ${className}`} style={style}>
      {label && <label>{label}</label>}
      {children}
      {hint && !error && <div className="hint">{hint}</div>}
      {error && <div className="err">{error}</div>}
    </div>
  );
}

export function Input({ onWheel, onKeyDown, ...props }) {
  const ref = useRef(null);
  const isNumber = props.type === 'number';

  // A focused number input treats the mouse wheel and the Up/Down arrows as
  // "change the value". Scrolling the page with the cursor resting over an
  // amount field would silently edit it — an amount that was typed as 500
  // becomes 495 on the way past, and the bill records the wrong figure.
  //
  // The wheel listener has to be registered here rather than through React's
  // onWheel prop: React attaches it passively at the root, and a passive
  // listener cannot call preventDefault(). Scrolling still works; the page
  // just scrolls instead of the number changing.
  useEffect(() => {
    if (!isNumber) return;
    const el = ref.current;
    if (!el) return;

    const block = (e) => { if (document.activeElement === el) e.preventDefault(); };
    el.addEventListener('wheel', block, { passive: false });
    return () => el.removeEventListener('wheel', block);
  }, [isNumber]);

  const handleKeyDown = (e) => {
    // Arrow keys move between fields on a keypad-driven till, so nudging the
    // amount is never what was meant.
    if (isNumber && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) e.preventDefault();
    onKeyDown?.(e);
  };

  return (
    <input
      // Amount and quantity fields get the numeric keypad on a phone, which is
      // most of how bills are entered. A caller can still override it.
      {...(isNumber ? { inputMode: 'decimal' } : null)}
      {...props}
      ref={ref}
      className={`input ${props.className || ''}`}
      onKeyDown={handleKeyDown}
      onWheel={onWheel}
    />
  );
}

export function Select({ options = [], children, className = '', ...rest }) {
  return (
    <select className={`select ${className}`.trim()} {...rest}>
      {children || options.map((o) =>
        typeof o === 'string'
          ? <option key={o} value={o}>{o}</option>
          : <option key={o.value} value={o.value}>{o.label}</option>
      )}
    </select>
  );
}

export function Textarea(props) {
  return <textarea className="textarea" {...props} />;
}

/* ==========================================================================
   Type-ahead (NFR-6) — keyboard navigable, filters in-memory data
   ========================================================================== */

export function TypeAhead({
  items = [],
  value = null,
  onChange,
  getLabel = (x) => x.name,
  getSub = () => '',
  placeholder = 'Search…',
  onAddNew,
  addNewLabel = 'Add new',
  autoFocus = false,
  disabled = false,
  // Lets a parent focus this input later. autoFocus only fires on mount, which
  // is no use for a row added to a list that is already on screen.
  focusRef = null,
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [hl, setHl] = useState(0);
  const wrapRef = useRef(null);
  const inputRef = useRef(null);

  // Published to the parent rather than replacing inputRef, so everything in
  // here that focuses or blurs the input keeps working untouched.
  useEffect(() => {
    if (!focusRef) return undefined;
    focusRef.current = inputRef.current;
    return () => { if (focusRef.current === inputRef.current) focusRef.current = null; };
  });

  const selected = value ? items.find((i) => i.id === value) : null;

  // Filtering runs against data already in memory — no server call per keystroke.
  const results = useMemo(() => {
    const term = norm(q);
    if (!term) return items.slice(0, 50);
    return items
      .filter((i) => norm(getLabel(i)).includes(term) || norm(getSub(i)).includes(term))
      .slice(0, 50);
  }, [q, items, getLabel, getSub]);

  useEffect(() => { setHl(0); }, [q]);

  useEffect(() => {
    const onDoc = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const pick = useCallback((item) => {
    onChange?.(item.id, item);
    setQ('');
    setOpen(false);
    inputRef.current?.blur();
  }, [onChange]);

  const onKeyDown = (e) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) { setOpen(true); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setHl((h) => Math.min(h + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHl((h) => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (results[hl]) pick(results[hl]);
      else if (onAddNew && q.trim()) { onAddNew(q.trim()); setQ(''); setOpen(false); }
    } else if (e.key === 'Escape') { setOpen(false); }
  };

  return (
    <div className="typeahead" ref={wrapRef}>
      <div style={{ position: 'relative' }}>
        <Search
          size={15}
          style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }}
        />
        <input
          ref={inputRef}
          className="input"
          style={{ paddingLeft: 32 }}
          placeholder={selected ? getLabel(selected) : placeholder}
          value={q}
          disabled={disabled}
          autoFocus={autoFocus}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          aria-autocomplete="list"
          aria-expanded={open}
        />
        {selected && !q && (
          <button
            type="button"
            onClick={() => { onChange?.(null, null); setQ(''); inputRef.current?.focus(); }}
            aria-label="Clear selection"
            style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 0, color: 'var(--text-muted)', padding: 4 }}
          >
            <X size={14} />
          </button>
        )}
      </div>

      {open && (
        <div className="typeahead-menu">
          {results.map((item, i) => (
            <div
              key={item.id}
              className={`typeahead-opt ${i === hl ? 'hl' : ''}`}
              onMouseEnter={() => setHl(i)}
              onMouseDown={(e) => { e.preventDefault(); pick(item); }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 500 }}>{getLabel(item)}</div>
                {getSub(item) && <div className="sub">{getSub(item)}</div>}
              </div>
              <div className="spacer" />
              {item.id === value && <Check size={15} color="var(--accent)" />}
            </div>
          ))}

          {!results.length && (
            <div className="typeahead-empty">No matches for “{q}”</div>
          )}

          {onAddNew && (
            <div className="typeahead-add">
              <div
                className="typeahead-opt"
                onMouseDown={(e) => { e.preventDefault(); onAddNew(q.trim()); setQ(''); setOpen(false); }}
                style={{ color: 'var(--accent)', fontWeight: 600 }}
              >
                <Plus size={15} />
                {q.trim() ? `${addNewLabel}: “${q.trim()}”` : addNewLabel}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ==========================================================================
   Empty state — friendly icon + one line + primary action
   ========================================================================== */

export function Empty({ icon: Icon = Inbox, title, message, action }) {
  return (
    <div className="empty">
      <span className="ico"><Icon size={24} /></span>
      <h3>{title}</h3>
      {message && <p>{message}</p>}
      {action}
    </div>
  );
}

/* ==========================================================================
   Skeleton loader — layout does not jump when data arrives
   ========================================================================== */

export function Skeleton({ rows = 5 }) {
  return (
    <div style={{ padding: 16 }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skel skel-row" style={{ width: `${88 - i * 6}%` }} />
      ))}
    </div>
  );
}

/* ==========================================================================
   Toast host
   ========================================================================== */

export function Toasts({ toasts = [] }) {
  const ICONS = { success: Check, error: AlertTriangle, info: Info };
  return createPortal(
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => {
        const I = ICONS[t.type] || Info;
        return (
          <div key={t.id} className={`toast toast-${t.type}`}>
            <I size={16} className="ico" />
            {t.message}
          </div>
        );
      })}
    </div>,
    document.body
  );
}

/* ==========================================================================
   Segmented date-range control (FR-45)
   ========================================================================== */

export const RANGE_PRESETS = [
  { value: 'today', label: 'Today' },
  { value: 'week',  label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'all',   label: 'All' },
];

export function RangePicker({ value, onChange, custom, onCustomChange, presets = RANGE_PRESETS }) {
  return (
    <div className="row wrap" style={{ gap: 8 }}>
      <div className="seg">
        {presets.map((p) => (
          <button key={p.value}
                  className={value === p.value ? 'active' : ''}
                  onClick={() => onChange(p.value)}>
            {p.label}
          </button>
        ))}
        <button className={value === 'custom' ? 'active' : ''} onClick={() => onChange('custom')}>
          Custom
        </button>
      </div>
      {value === 'custom' && (
        <div className="row" style={{ gap: 6 }}>
          <input type="date" className="input" style={{ width: 150 }}
                 value={custom?.from || ''}
                 onChange={(e) => onCustomChange({ ...custom, from: e.target.value })} />
          <span className="muted small">to</span>
          <input type="date" className="input" style={{ width: 150 }}
                 value={custom?.to || ''}
                 onChange={(e) => onCustomChange({ ...custom, to: e.target.value })} />
        </div>
      )}
    </div>
  );
}

/* ==========================================================================
   Search bar
   ========================================================================== */

export function SearchBar({ value, onChange, placeholder = 'Search…', style }) {
  return (
    <div style={{ position: 'relative', minWidth: 200, ...style }}>
      <Search size={15} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
      <input className="input" style={{ paddingLeft: 32 }} placeholder={placeholder}
             value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

/* ==========================================================================
   Page header
   ========================================================================== */

export function PageHead({ title, subtitle, children }) {
  return (
    <div className="page-head">
      <div>
        <h1 className="h1">{title}</h1>
        {subtitle && <p className="sub">{subtitle}</p>}
      </div>
      <div className="spacer" />
      {children}
    </div>
  );
}
