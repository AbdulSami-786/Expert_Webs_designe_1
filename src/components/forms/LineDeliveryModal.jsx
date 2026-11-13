// Tick off, item by item, what has been handed over.
//
// One dialog serves both directions: goods delivered to a customer on a sales
// bill, and goods received from a supplier on a purchase bill. Each line takes
// a quantity, so "30 of 50 bags sent" is recordable; the tick is the shortcut
// for "all of it".

import { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import { Button, Modal, Input } from '../ui';
import { r2 } from '../../lib/format';

/**
 * lines:  [{ id, name, qty, unit, done }] — `done` is what has gone/arrived so far
 * verb:   'Delivered' or 'Received', used in labels
 * onSave: (changes: [{ id, qty }]) => Promise — only lines that changed
 */
export default function LineDeliveryModal({ open, title, lines = [], verb = 'Delivered', onClose, onSave }) {
  const [vals, setVals] = useState({});
  const [busy, setBusy] = useState(false);

  // Start from what is recorded each time the dialog opens.
  useEffect(() => {
    if (open) setVals(Object.fromEntries(lines.map((l) => [l.id, String(l.done)])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const num = (id) => Number(vals[id]);
  const bad = (l) => {
    const v = vals[l.id];
    return v === '' || v === undefined || !Number.isFinite(Number(v)) || Number(v) < 0 || Number(v) > l.qty + 0.0001;
  };
  const anyBad = lines.some(bad);
  const changes = lines
    .filter((l) => !bad(l) && Math.abs(num(l.id) - l.done) > 0.0001)
    .map((l) => ({ id: l.id, qty: r2(num(l.id)) }));

  const setAll = (full) => setVals(Object.fromEntries(lines.map((l) => [l.id, String(full ? l.qty : 0)])));

  const submit = async () => {
    if (busy || anyBad || !changes.length) return;
    setBusy(true);
    try {
      await onSave(changes);
      onClose();
    } catch { /* toast shown by mutate */ } finally { setBusy(false); }
  };

  const doneCount = lines.filter((l) => !bad(l) && num(l.id) >= l.qty - 0.0001).length;

  return (
    <Modal open={open} title={title} onClose={onClose}
           footer={
             <>
               <Button onClick={onClose}>Cancel</Button>
               <Button variant="primary" icon={Save} onClick={submit} loading={busy}
                       disabled={anyBad || !changes.length}>
                 Save
               </Button>
             </>
           }>
      <div className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 6 }}>
        <span className="small muted" style={{ flex: 1, minWidth: 0 }}>
          Tick an item when all of it is {verb.toLowerCase()}, or type how much.
        </span>
        <Button size="sm" onClick={() => setAll(true)}>All</Button>
        <Button size="sm" onClick={() => setAll(false)}>None</Button>
      </div>

      <div className="ld-lines">
        {lines.map((l) => {
          const full = !bad(l) && num(l.id) >= l.qty - 0.0001;
          return (
            <div key={l.id} className={`ld-line ${full ? 'ld-full' : ''}`}>
              <label className="ld-tick">
                <input type="checkbox" checked={full}
                       onChange={(e) => setVals((x) => ({ ...x, [l.id]: String(e.target.checked ? l.qty : 0) }))} />
                <span>
                  <span className="ld-name">{l.name}</span>
                  <span className="small muted" style={{ display: 'block' }}>
                    Ordered {l.qty} {l.unit || ''}
                    {!bad(l) && !full && num(l.id) > 0 ? ` · ${r2(l.qty - num(l.id))} still to go` : ''}
                  </span>
                </span>
              </label>
              <label className="ld-qty">
                <span className="small muted">{verb}</span>
                <Input type="number" min="0" max={l.qty} step="any" value={vals[l.id] ?? ''}
                       onChange={(e) => setVals((x) => ({ ...x, [l.id]: e.target.value }))}
                       aria-invalid={bad(l)} />
                {bad(l) && <span className="err small">0 to {l.qty}</span>}
              </label>
            </div>
          );
        })}
      </div>

      <div className="small muted mt-2">
        {doneCount} of {lines.length} item{lines.length === 1 ? '' : 's'} fully {verb.toLowerCase()}.
      </div>
    </Modal>
  );
}

/** "2 / 5" — how much of a line has gone or arrived, coloured by whether it is done. */
export function DeliveredCount({ done, qty }) {
  const cls = done >= qty - 0.0001 ? 'full' : done > 0.0001 ? 'part' : 'none';
  return (
    <span className={`ld-count ${cls}`} style={{ display: 'inline', marginTop: 0 }}>
      {cls === 'full' ? '✓ ' : ''}{+Number(done).toFixed(3)} / {+Number(qty).toFixed(3)}
    </span>
  );
}
