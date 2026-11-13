// "What did I charge this party for this item last time?"
//
// The question gets asked across the counter, with the customer waiting: they
// want a price, and quoting from memory either gives away margin or starts an
// argument about what was agreed last month. Everything needed to answer it is
// already in the bills — this screen just makes it reachable in one tap from
// the party's own ledger.
//
// Every sale of the item to this party is listed, newest first, because the
// useful answer is usually "last time, and the time before that" rather than a
// single number.

import { useMemo, useState } from 'react';
import { Search, Package, TrendingDown, TrendingUp, Minus } from 'lucide-react';
import { Modal, Button, Empty, Pill } from '../ui';
import { partyItemSummary } from '../../lib/calc';
import { money, fmtDate, r2 } from '../../lib/format';

/** Case- and space-insensitive contains, so "sun oil" finds "Sunflower Oil". */
function matches(name, query) {
  const hay = String(name || '').toLowerCase();
  return String(query || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => hay.includes(word));
}

export default function PartyItemSearchModal({ open, onClose, party, data }) {
  const [query, setQuery] = useState('');
  // Which item's full history is expanded. Only one at a time: the point is to
  // compare a price against its own past, not to read every item at once.
  const [openItem, setOpenItem] = useState(null);

  const summary = useMemo(
    () => (party ? partyItemSummary(party.id, data) : []),
    [party, data],
  );

  const results = useMemo(() => {
    if (!query.trim()) return summary;
    return summary.filter((s) => matches(s.name, query));
  }, [summary, query]);

  const close = () => {
    setQuery('');
    setOpenItem(null);
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={close}
      wide
      title={`Item prices — ${party?.name || ''}`}
      footer={<Button onClick={close}>Close</Button>}
    >
      <div className="field" style={{ marginBottom: 12 }}>
        <div className="input-group">
          <input
            className="input"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search an item this party has bought…"
            aria-label="Search items"
          />
          {query && <Button onClick={() => setQuery('')}>Clear</Button>}
        </div>
        <div className="hint">
          {summary.length
            ? `${party?.name} has bought ${summary.length} different item${summary.length === 1 ? '' : 's'}.`
            : 'No past sales to this party yet.'}
        </div>
      </div>

      {!results.length ? (
        <Empty
          icon={query ? Search : Package}
          title={query ? 'No match' : 'Nothing bought yet'}
          message={query
            ? `${party?.name} has never been billed for anything matching “${query}”.`
            : `Once ${party?.name} has been billed for an item, its price history appears here.`}
        />
      ) : (
        <div className="price-hits">
          {results.map((s) => {
            const expanded = openItem === s.itemId;
            // Movement between the last two sales — the number the shopkeeper
            // is really checking before they quote again.
            const delta = s.last && s.previous ? r2(s.last.price - s.previous.price) : 0;
            const Trend = delta > 0 ? TrendingUp : delta < 0 ? TrendingDown : Minus;

            return (
              <div key={s.itemId} className="price-hit">
                <button
                  type="button"
                  className="price-hit-head"
                  onClick={() => setOpenItem(expanded ? null : s.itemId)}
                  aria-expanded={expanded}
                >
                  <div className="price-hit-name">
                    <strong>{s.name}</strong>
                    {s.status === 'archived' && (
                      <Pill status="voided" label="Archived" />
                    )}
                    <span className="muted small">
                      {s.times} sale{s.times === 1 ? '' : 's'}
                    </span>
                  </div>

                  <div className="price-hit-last">
                    {s.last ? (
                      <>
                        <span className="money">{money(s.last.price)}</span>
                        <span className="muted small">
                          {' '}/ {s.last.unit || s.unit} · {fmtDate(s.last.date)}
                        </span>
                      </>
                    ) : (
                      <span className="muted small">only voided bills</span>
                    )}
                  </div>
                </button>

                {/* Summary line: the three numbers worth seeing without
                    opening the full history. */}
                <div className="price-hit-meta">
                  {s.previous && (
                    <span className={delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'}>
                      <Trend size={12} />
                      {delta === 0
                        ? 'same as before'
                        : `${delta > 0 ? '+' : '−'}${money(Math.abs(delta))} vs previous (${money(s.previous.price)})`}
                    </span>
                  )}
                  {s.minPrice !== s.maxPrice && (
                    <span className="muted">
                      range {money(s.minPrice)}–{money(s.maxPrice)}
                    </span>
                  )}
                  <span className="muted">
                    {s.totalQty} {s.unit} total · {money(s.totalValue)}
                  </span>
                </div>

                {expanded && (
                  <div className="table-wrap" style={{ marginTop: 8 }}>
                    <table className="tbl">
                      <thead>
                        <tr>
                          <th>Bill</th>
                          <th>Date</th>
                          <th className="r">Qty</th>
                          <th className="r">Price</th>
                          <th className="r">Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {s.rows.map((r, i) => (
                          <tr key={`${r.billId}-${i}`}
                              style={r.voided ? { opacity: .55 } : undefined}>
                            <td style={{ fontWeight: 600 }}>
                              {r.billNo}
                              {r.voided && (
                                <>
                                  {' '}
                                  <Pill status="voided" label="Voided" />
                                </>
                              )}
                            </td>
                            <td className="nowrap small">{fmtDate(r.date)}</td>
                            <td className="r">{r.qty} {r.unit}</td>
                            <td className="r strong"
                                style={{ textDecoration: r.voided ? 'line-through' : 'none' }}>
                              {money(r.price)}
                            </td>
                            <td className="r">{money(r.lineTotal)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
