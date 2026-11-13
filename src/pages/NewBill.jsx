// New Bill — the core flow (FR-1 … FR-12).
//
// Party type-ahead + inline add · item type-ahead + inline add · favourite items
// per party · price auto-fill from that party's last order with history and a
// deviation alert · per-line unit switching · split payment across methods with
// the uncovered remainder auto-becoming Credit with an editable due date ·
// advance balance application · configurable rounding with a visible round-off.

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Plus, Trash2, History, Save, AlertTriangle, UserPlus, PackagePlus,
  Wallet, CreditCard, X,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import api from '../lib/api';
import ChequeFields, { blankCheque } from '../components/forms/ChequeFields';
import {
  Card, Button, Field, Input, Select, TypeAhead, Modal, Pill, Money,
  Empty, PageHead, Textarea, Confirm,
} from '../components/ui';
import PartyForm from '../components/forms/PartyForm';
import ItemForm from '../components/forms/ItemForm';
import BillReceiptModal from '../components/BillReceiptModal';
import { printBill } from '../lib/exporters';
import {
  billTotals, deriveBills, partyAdvanceBalance, partyDue, itemStock, billState,
} from '../lib/calc';
import {
  money, todayISO, addDays, fmtDate, r2, uid, applyRounding, unitFactor,
} from '../lib/format';
import { UNITS } from '../lib/config';

export default function NewBill() {
  const { data, settings, methods, activeParties, activeItems, mutate, toast } = useApp();
  const nav = useNavigate();
  const { id: editId } = useParams();
  // "New Sale" on a supplier's page opens this with ?party=<id> already chosen.
  const [searchParams] = useSearchParams();

  const editingBill = editId ? data.bills.find((b) => b.id === editId) : null;

  // Unsaved bills left on this page last time, so visiting another page and
  // coming back does not lose them. Editing an existing bill never uses drafts.
  const [draft] = useState(() => (editId ? null : loadDrafts(searchParams.get('party'))));
  const f0 = draft ? draft.tabs[draft.active]?.form : null;

  /* ---------------- Form state ---------------- */
  const [partyId, setPartyId] = useState(() => f0?.partyId ?? '');
  const [date, setDate] = useState(() => f0?.date ?? todayISO());
  const [lines, setLines] = useState(() => f0?.lines ?? []);
  const [pays, setPays] = useState(() => f0?.pays ?? [{ key: uid('p'), method: 'Cash', amount: '', cheque: null }]);
  const [dueDate, setDueDate] = useState(() => f0?.dueDate ?? addDays(todayISO(), settings.defaultCreditDays));
  const [applyAdvance, setApplyAdvance] = useState(() => f0?.applyAdvance ?? 0);
  const [note, setNote] = useState(() => f0?.note ?? '');
  // Goods not going out with the bill. Off by default: the counter sale is the
  // common case, so the biller flags the exception rather than confirming the
  // rule on every bill.
  const [pending, setPending] = useState(() => f0?.pending ?? false);
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const [showParty, setShowParty] = useState(false);
  const [showItem, setShowItem] = useState(false);
  const [prefillName, setPrefillName] = useState('');
  const [historyFor, setHistoryFor] = useState(null);
  const [priceWarn, setPriceWarn] = useState(null);

  /* ---------------- Several bills in one sitting ----------------
     A morning's orders arrive together — three shops phone in before anything
     is written up. Each tab is one complete bill with its own party, items and
     payments; only the active one is mounted in the form state above, and the
     others are parked in `tabs` until selected.
     Editing an existing bill is deliberately single-tab: the URL names one
     bill, and a second tab would have nowhere to be saved. */
  const [tabs, setTabs] = useState(() => draft?.tabs ?? [{ key: uid('tab'), label: 'Bill 1', form: null }]);
  const [activeTab, setActiveTab] = useState(() => draft?.active ?? 0);
  // The bill just saved from this tab, shown as a receipt over the page rather
  // than by navigating to it — leaving the page would discard the other tabs.
  const [savedBillId, setSavedBillId] = useState(null);

  /* Load an existing bill when editing (FR-25) */
  useEffect(() => {
    if (!editingBill) return;
    setPartyId(editingBill.partyId);
    setDate(editingBill.date);
    setDueDate(editingBill.dueDate);
    setNote(editingBill.note || '');
    setPending(editingBill.delivery === 'pending');
    setLines(
      data.billItems
        .filter((bi) => bi.billId === editingBill.id)
        .map((bi) => ({
          key: uid('l'), itemId: bi.itemId, qty: String(bi.qty),
          price: String(bi.price), unit: bi.unit, costPriceAtSale: bi.costPriceAtSale,
        }))
    );
    // Existing payments stay attached to the bill; editing adjusts items/total.
    setPays([{ key: uid('p'), method: 'Cash', amount: '', cheque: null }]);
  }, [editingBill, data.billItems]);

  const party = activeParties.find((p) => p.id === partyId) || data.parties.find((p) => p.id === partyId);

  /* Due date follows the party's own default credit days (FR-8) */
  useEffect(() => {
    if (party && !editingBill) {
      setDueDate(addDays(date, party.defaultDueDays || settings.defaultCreditDays));
    }
  }, [party, date, settings.defaultCreditDays, editingBill]);

  /* ---------------- Price history helpers (FR-3 / FR-4) ---------------- */

  /** Most recent price this party paid for this item. */
  const lastPriceFor = useCallback((pid, itemId) => {
    const hist = data.partyItemPrices
      .filter((x) => x.partyId === pid && x.itemId === itemId)
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    return hist[0] || null;
  }, [data.partyItemPrices]);

  const priceHistory = useCallback((pid, itemId) => {
    return data.partyItemPrices
      .filter((x) => x.partyId === pid && x.itemId === itemId)
      .sort((a, b) => new Date(b.date) - new Date(a.date));
  }, [data.partyItemPrices]);

  /** Top items this party orders most (FR: favourite/frequent items). */
  const favourites = useMemo(() => {
    if (!partyId) return [];
    const partyBills = new Set(data.bills.filter((b) => b.partyId === partyId).map((b) => b.id));
    const counts = new Map();
    data.billItems
      .filter((bi) => partyBills.has(bi.billId))
      .forEach((bi) => counts.set(bi.itemId, (counts.get(bi.itemId) || 0) + 1));
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([itemId]) => data.items.find((i) => i.id === itemId))
      .filter((i) => i && i.status !== 'archived');
  }, [partyId, data.bills, data.billItems, data.items]);

  /* ---------------- Line operations ---------------- */

  // The item search of the line to focus once React has rendered it, and the
  // key of the line that asked for focus. Focusing cannot happen inside the
  // state update: the input does not exist until after the re-render.
  const itemInputRef = useRef(null);
  const [focusLineKey, setFocusLineKey] = useState(null);

  const addLine = (itemId = '') => {
    const item = data.items.find((i) => i.id === itemId);
    const last = itemId && partyId ? lastPriceFor(partyId, itemId) : null;
    const key = uid('l');
    setLines((ls) => [...ls, {
      key,
      itemId,
      qty: '1',
      price: last ? String(last.price) : '',
      unit: last?.unit || item?.baseUnit || 'Piece',
      costPriceAtSale: item?.costPrice ?? 0,
      autoFilled: Boolean(last),
    }]);
    // Only an empty line needs the cursor. Adding a line from a favourite chip
    // already knows its item, so stealing focus there would pull the biller
    // away from the chips they are still clicking through.
    if (!itemId) setFocusLineKey(key);
    return key;
  };

  // Focus the new line's item search after it renders, then forget the request
  // so a later re-render cannot yank the cursor back.
  useEffect(() => {
    if (!focusLineKey) return;
    itemInputRef.current?.focus();
    setFocusLineKey(null);
  }, [focusLineKey]);

  // Ctrl+Shift+A adds a line and puts the cursor in its item search, so a long
  // bill can be typed without reaching for the mouse.
  //
  // addLine closes over data and partyId, so the listener reads it through a ref
  // rather than capturing it — bound once, it would otherwise go on calling the
  // version from first render and auto-fill prices from a stale party.
  const addLineRef = useRef(addLine);
  addLineRef.current = addLine;

  // A modal is open over the form. Adding a line behind it would move the cursor
  // to an input the biller cannot see, and the new line would be a surprise when
  // they closed the dialog.
  const modalOpen = showParty || showItem || Boolean(historyFor);
  const modalOpenRef = useRef(modalOpen);
  modalOpenRef.current = modalOpen;

  useEffect(() => {
    const onKey = (e) => {
      // e.code, not e.key: with Shift held e.key is 'A', and on some layouts a
      // modified key reports something else entirely. e.code is the physical key.
      if (e.code !== 'KeyA' || !e.shiftKey || !(e.ctrlKey || e.metaKey)) return;
      if (e.altKey || e.repeat) return;
      if (modalOpenRef.current) return;
      e.preventDefault();      // Chrome has no Ctrl+Shift+A, but stop any host binding
      addLineRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const setLine = (key, patch) => {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  };

  /** Choosing an item auto-fills the price from this party's history (FR-3). */
  const pickItem = (key, itemId) => {
    const item = data.items.find((i) => i.id === itemId);
    const last = partyId ? lastPriceFor(partyId, itemId) : null;
    setLine(key, {
      itemId,
      price: last ? String(last.price) : '',
      unit: last?.unit || item?.baseUnit || 'Piece',
      costPriceAtSale: item?.costPrice ?? 0,
      autoFilled: Boolean(last),
    });
  };

  const removeLine = (key) => setLines((ls) => ls.filter((l) => l.key !== key));

  /**
   * Price-change alert (FR-5): warn when an entered price deviates from this
   * party's last price by more than the configured threshold.
   */
  const checkPriceDeviation = (line) => {
    if (!partyId || !line.itemId || !line.price) return null;
    const last = lastPriceFor(partyId, line.itemId);
    if (!last) return null;
    const oldP = Number(last.price), newP = Number(line.price);
    if (!oldP || !newP) return null;
    const pct = Math.abs((newP - oldP) / oldP) * 100;
    const threshold = Number(settings.priceAlertThreshold) || 15;
    if (pct <= threshold) return null;
    const item = data.items.find((i) => i.id === line.itemId);
    return { itemName: item?.name, oldPrice: oldP, newPrice: newP, pct, up: newP > oldP, lastDate: last.date };
  };

  /* ---------------- Totals ---------------- */

  const validLines = useMemo(
    () => lines.filter((l) => l.itemId && Number(l.qty) > 0 && Number(l.price) >= 0),
    [lines]
  );

  const totals = useMemo(
    () => billTotals(
      validLines.map((l) => ({ qty: Number(l.qty), price: Number(l.price) })),
      settings.roundingRule
    ),
    [validLines, settings.roundingRule]
  );

  const paidNow = useMemo(
    () => r2(pays.reduce((s, p) => s + (Number(p.amount) || 0), 0)),
    [pays]
  );

  const advanceAvailable = useMemo(
    () => (partyId ? partyAdvanceBalance(partyId, data.partyAdvances) : 0),
    [partyId, data.partyAdvances]
  );

  // Anything not covered by a payment or advance automatically becomes Credit (FR-7)
  const creditAmount = useMemo(
    () => r2(Math.max(0, totals.total - paidNow - Number(applyAdvance || 0))),
    [totals.total, paidNow, applyAdvance]
  );

  const overpaid = r2(paidNow + Number(applyAdvance || 0) - totals.total);

  /* The bill just saved, with its paid/due worked out.
     Derived rather than taken from the save response, because the receipt has
     to show what was actually recorded — including any payment or advance
     applied alongside the bill. */
  const savedBill = useMemo(() => {
    if (!savedBillId) return null;
    const b = data.bills.find((x) => x.id === savedBillId);
    return b ? billState(b, data) : null;
  }, [savedBillId, data]);

  /* Credit-limit warning (FR-15) */
  const creditWarning = useMemo(() => {
    if (!party || !Number(party.creditLimit) || creditAmount <= 0) return null;
    const derived = deriveBills(data.bills, data);
    const existing = partyDue(party.id, derived);
    const after = r2(existing + creditAmount);
    if (after <= Number(party.creditLimit)) return null;
    return { existing, after, limit: Number(party.creditLimit) };
  }, [party, creditAmount, data]);

  /* ---------------- Payment rows ---------------- */

  const setPay = (key, patch) => setPays((ps) => ps.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  const addPay = () => setPays((ps) => [...ps, { key: uid('p'), method: 'Cash', amount: '', cheque: null }]);
  const removePay = (key) => setPays((ps) => (ps.length > 1 ? ps.filter((p) => p.key !== key) : ps));

  /** Fill the remaining balance into this payment row. */
  const fillRemaining = (key) => {
    const others = r2(pays.filter((p) => p.key !== key).reduce((s, p) => s + (Number(p.amount) || 0), 0));
    const remaining = r2(Math.max(0, totals.total - others - Number(applyAdvance || 0)));
    setPay(key, { amount: String(remaining) });
  };

  /* ---------------- Tabs: park and restore a bill in progress ---------------- */

  /** Everything the form holds for one bill, as a plain object. */
  const snapshot = useCallback(() => ({
    partyId, date, lines, pays, dueDate, applyAdvance, note, pending,
  }), [partyId, date, lines, pays, dueDate, applyAdvance, note, pending]);

  const restore = useCallback((f) => {
    setPartyId(f?.partyId ?? '');
    setDate(f?.date ?? todayISO());
    setLines(f?.lines ?? []);
    setPays(f?.pays ?? [{ key: uid('p'), method: 'Cash', amount: '', cheque: null }]);
    setDueDate(f?.dueDate ?? addDays(todayISO(), settings.defaultCreditDays));
    setApplyAdvance(f?.applyAdvance ?? 0);
    setNote(f?.note ?? '');
    setPending(f?.pending ?? false);
  }, [settings.defaultCreditDays]);

  /* Keep every unsaved tab in this device's storage as it changes. A saved bill
     retires its tab, so it drops out of the drafts by itself. */
  useEffect(() => {
    if (editId) return;
    const all = tabs.map((t, n) => (n === activeTab ? { ...t, form: snapshot() } : t));
    saveDrafts(all, activeTab);
  }, [editId, tabs, activeTab, snapshot]);

  /** Throw away every unsaved bill on this page and start one empty bill. */
  const clearDrafts = () => {
    setTabs([{ key: uid('tab'), label: 'Bill 1', form: null }]);
    setActiveTab(0);
    restore(null);
    setConfirmClear(false);
    toast('Unsaved bills removed');
  };

  const hasDrafts = !editingBill && (
    tabs.length > 1 || Boolean(partyId) || lines.length > 0 || Boolean(note)
  );

  /** Move to another tab, parking the current one's form on the way out. */
  const switchTab = (i) => {
    if (i === activeTab) return;
    setTabs((ts) => ts.map((t, n) => (n === activeTab ? { ...t, form: snapshot() } : t)));
    restore(tabs[i]?.form);
    setActiveTab(i);
  };

  const addTab = () => {
    const parked = snapshot();
    setTabs((ts) => {
      const next = ts.map((t, n) => (n === activeTab ? { ...t, form: parked } : t));
      return [...next, { key: uid('tab'), label: `Bill ${next.length + 1}`, form: null }];
    });
    restore(null);
    setActiveTab(tabs.length);
  };

  const closeTab = (i) => {
    if (tabs.length === 1) return;

    // Park the active tab first. Closing a DIFFERENT tab leaves you on the one
    // you were editing, and without this its unparked work is dropped the next
    // time the tab list is rewritten.
    const parked = tabs.map((t, n) => (n === activeTab ? { ...t, form: snapshot() } : t));
    const remaining = parked.filter((_, n) => n !== i);

    // Land on the neighbour rather than jumping to the first tab, which is
    // where the eye already is after closing one.
    const nextIndex = i === activeTab
      ? Math.min(i, remaining.length - 1)
      : (i < activeTab ? activeTab - 1 : activeTab);

    // Only the closed tab's contents are discarded. Reloading the form is
    // needed just when the tab on screen is the one that went away.
    if (i === activeTab) restore(remaining[nextIndex].form);
    setTabs(remaining.map((t, n) => ({ ...t, label: `Bill ${n + 1}` })));
    setActiveTab(nextIndex);
  };

  /**
   * Retire the tab whose bill has just been saved.
   *
   * Its work is on the server now, so the tab has nothing left to hold. Every
   * other tab keeps its own contents untouched — that is the whole point of
   * saving one bill without leaving the page. When the last one goes, a fresh
   * empty tab takes its place so the screen is never tabless.
   */
  const closeSavedTab = () => {
    if (tabs.length === 1) {
      setTabs([{ key: uid('tab'), label: 'Bill 1', form: null }]);
      setActiveTab(0);
      restore(null);
      return;
    }

    const remaining = tabs.filter((_, n) => n !== activeTab);
    // Land on the neighbour, which is where the eye already is.
    const nextIndex = Math.min(activeTab, remaining.length - 1);
    setTabs(remaining.map((t, n) => ({ ...t, label: `Bill ${n + 1}` })));
    setActiveTab(nextIndex);
    restore(remaining[nextIndex].form);
  };

  /** One tab's form as a save payload, or null if it has nothing worth saving. */
  const payloadFrom = useCallback((f) => {
    if (!f?.partyId) return null;
    const good = (f.lines || []).filter(
      (l) => l.itemId && Number(l.qty) > 0 && Number(l.price) >= 0,
    );
    if (!good.length) return null;

    const t = billTotals(good, settings.roundingRule);
    const paidNowT = r2((f.pays || []).reduce((s, p) => s + (Number(p.amount) || 0), 0));
    const creditT = r2(Math.max(0, t.total - paidNowT - Number(f.applyAdvance || 0)));

    return {
      partyId: f.partyId,
      date: f.date,
      lines: good.map((l) => ({
        itemId: l.itemId, qty: Number(l.qty), price: Number(l.price),
        unit: l.unit, costPriceAtSale: l.costPriceAtSale,
      })),
      payments: (f.pays || [])
        .filter((p) => Number(p.amount) > 0)
        .map((p) => ({ method: p.method, amount: Number(p.amount), cheque: p.cheque, note: '' })),
      advanceApplied: Number(f.applyAdvance) || 0,
      subtotal: t.subtotal,
      roundOff: t.roundOff,
      total: t.total,
      dueDate: creditT > 0 ? f.dueDate : '',
      note: f.note || '',
      delivery: f.pending ? 'pending' : 'delivered',
    };
  }, [settings.roundingRule]);

  /* ---------------- Save ---------------- */

  const doSave = async () => {
    if (busy) return; // guard: a second click must not save the bill twice
    if (!partyId) return toast('Select a party first', 'error');
    if (!validLines.length) return toast('Add at least one item', 'error');

    setBusy(true);
    try {
      const payload = {
        id: editingBill?.id,
        partyId,
        date,
        lines: validLines.map((l) => ({
          itemId: l.itemId, qty: Number(l.qty), price: Number(l.price),
          unit: l.unit, costPriceAtSale: l.costPriceAtSale,
        })),
        payments: pays
          .filter((p) => Number(p.amount) > 0)
          .map((p) => ({ method: p.method, amount: Number(p.amount), cheque: p.cheque, note: '' })),
        advanceApplied: Number(applyAdvance) || 0,
        subtotal: totals.subtotal,
        roundOff: totals.roundOff,
        total: totals.total,
        dueDate: creditAmount > 0 ? dueDate : '',
        note,
        delivery: pending ? 'pending' : 'delivered',
      };

      const bill = await mutate(
        () => api.saveBill(payload),
        editingBill ? 'Bill updated' : 'Bill saved'
      );

      // Editing is a round trip that started from one bill's page, so it ends
      // back there. A NEW bill does not navigate at all: the receipt opens over
      // the page, which keeps any other tabs — and the work in them — alive.
      // Leaving for the bill's own page would take them with it.
      if (editingBill) {
        nav(`/bill/${bill.id}`);
      } else if (bill?.queued) {
        // Saved offline: there is no server bill to show a receipt for yet.
        closeSavedTab();
      } else {
        setSavedBillId(bill.id);
      }
    } catch {
      /* toast already shown by mutate */
    } finally {
      setBusy(false);
    }
  };

  /** Validate price deviations before saving; confirm if any exceed threshold. */
  const onSave = () => {
    const deviations = validLines.map(checkPriceDeviation).filter(Boolean);
    if (deviations.length) setPriceWarn(deviations);
    else doSave();
  };

  /* ---------------- Inline add handlers ---------------- */

  const onPartyAdded = (p) => { setPartyId(p.id); setShowParty(false); toast(`Party "${p.name}" added`); };
  const onItemAdded = (it) => {
    setShowItem(false);
    addLine(it.id);
    toast(`Item "${it.name}" added`);
  };

  const itemName = (id) => data.items.find((i) => i.id === id)?.name || '';

  return (
    <>
      <PageHead
        title={editingBill ? `Edit Bill ${editingBill.billNo}` : 'New Bill'}
        subtitle={editingBill ? 'Editing keeps the original bill number and history' : 'Select a party, add items, then record payment'}
      >
        <Button onClick={() => nav(-1)}>Cancel</Button>
        {hasDrafts && (
          <Button icon={Trash2} onClick={() => setConfirmClear(true)}
                  title="Remove every bill on this page that has not been saved">
            Clear unsaved bills
          </Button>
        )}
        {/* Saves THIS tab's bill only. The receipt opens over the page rather
            than navigating to it, so any other tabs survive the save. */}
        <Button variant="primary" icon={Save} onClick={onSave} loading={busy}
                disabled={!partyId || !validLines.length}>
          {editingBill ? 'Update Bill' : 'Save Bill'}
        </Button>
      </PageHead>

      {/* ---- Bill tabs: several orders written up in one sitting ----
          Hidden while editing, where the URL names one specific bill. */}
      {!editingBill && (
        <div className="bill-tabs" role="tablist" aria-label="Bills in progress">
          {tabs.map((t, i) => {
            // The party's name is far more use on a tab than "Bill 2".
            const form = i === activeTab ? null : t.form;
            const pid = i === activeTab ? partyId : form?.partyId;
            const p = pid ? data.parties.find((x) => x.id === pid) : null;
            const filled = i === activeTab
              ? Boolean(partyId && validLines.length)
              : Boolean(payloadFrom(t.form));

            return (
              <div key={t.key} className={`bill-tab ${i === activeTab ? 'active' : ''}`}>
                <button type="button" role="tab" aria-selected={i === activeTab}
                        onClick={() => switchTab(i)}>
                  {/* A dot marks a tab that would be saved, so an unfinished
                      one is visible without opening it. */}
                  <span className={`dot ${filled ? 'on' : ''}`} aria-hidden="true" />
                  {p ? p.name : t.label}
                </button>
                {tabs.length > 1 && (
                  <button type="button" className="x" onClick={() => closeTab(i)}
                          title={`Close ${p ? p.name : t.label}`}
                          aria-label={`Close ${p ? p.name : t.label}`}>
                    <X size={13} />
                  </button>
                )}
              </div>
            );
          })}
          <button type="button" className="bill-tab-add" onClick={addTab}
                  title="Write another bill alongside this one">
            <Plus size={14} /> Add bill
          </button>
        </div>
      )}

      <div className="grid-2 bill-layout">
        {/* ================= Left: party + items ================= */}
        <div className="col">
          <Card title="Party">
            <div className="form-grid">
              <Field label="Select party" className="full">
                <TypeAhead
                  items={activeParties}
                  value={partyId}
                  onChange={(id) => setPartyId(id || '')}
                  getLabel={(p) => p.name}
                  getSub={(p) => p.phone || ''}
                  placeholder="Type a party name or phone…"
                  onAddNew={(name) => { setPrefillName(name); setShowParty(true); }}
                  addNewLabel="Add new party"
                  autoFocus={!editingBill}
                />
              </Field>

              <Field label="Bill date">
                <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </Field>

              {creditAmount > 0 && (
                <Field label="Credit due date" hint="Editable — defaults from this party's terms">
                  <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
                </Field>
              )}
            </div>

            {party && (
              <div className="row wrap" style={{ gap: 8, marginTop: 2 }}>
                {party.phone && <span className="small muted">{party.phone}</span>}
                {advanceAvailable > 0 && (
                  <span className="pill pill-cleared">
                    <Wallet size={11} /> Advance available {money(advanceAvailable)}
                  </span>
                )}
                {Number(party.creditLimit) > 0 && (
                  <span className="small muted">Credit limit {money(party.creditLimit)}</span>
                )}
              </div>
            )}

            {creditWarning && (
              <div style={warnBox} className="mt-1">
                <AlertTriangle size={15} style={{ flex: 'none', marginTop: 1 }} />
                <span>
                  This credit bill takes {party.name} to <strong>{money(creditWarning.after)}</strong> owing,
                  above their {money(creditWarning.limit)} credit limit.
                </span>
              </div>
            )}
          </Card>

          <Card
            title="Items"
            actions={
              <Button size="sm" icon={Plus} onClick={() => addLine()}
                      title="Add line (Ctrl+Shift+A)">
                Add line <kbd className="kbd-hint">Ctrl+Shift+A</kbd>
              </Button>
            }
          >
            {/* Favourite items for this party — one tap instead of searching */}
            {favourites.length > 0 && (
              <div className="mb-2">
                <div className="small muted mb-1">Frequently ordered by {party?.name}</div>
                <div className="chips">
                  {favourites.map((f) => (
                    <button key={f.id} className="chip" onClick={() => addLine(f.id)}>
                      <Plus size={11} style={{ marginRight: 3, verticalAlign: -1 }} />
                      {f.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {!lines.length ? (
              <Empty
                icon={PackagePlus}
                title="No items yet"
                message="Add the first item to start building this bill."
                action={<Button variant="primary" icon={Plus} onClick={() => addLine()}>Add item</Button>}
              />
            ) : (
              <div className="col" style={{ gap: 12 }}>
                {lines.map((l, idx) => {
                  const item = data.items.find((i) => i.id === l.itemId);
                  const dev = checkPriceDeviation(l);
                  const last = l.itemId && partyId ? lastPriceFor(partyId, l.itemId) : null;
                  const stock = l.itemId ? itemStock(l.itemId, data) : null;

                  // Units available for this line: base + alt if a conversion exists
                  const unitOpts = item
                    ? [item.baseUnit, ...(item.altUnit ? [item.altUnit] : [])]
                    : UNITS;

                  return (
                    <div key={l.key} style={lineBox}>
                      <div className="row line-head" style={{ gap: 8, marginBottom: 8 }}>
                        <span className="small muted nowrap line-no" style={{ width: 20 }}>{idx + 1}.</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <TypeAhead
                            items={activeItems}
                            value={l.itemId}
                            // Only the line awaiting focus publishes its input,
                            // so the ref cannot end up pointing at another row.
                            focusRef={l.key === focusLineKey ? itemInputRef : null}
                            onChange={(id) => id && pickItem(l.key, id)}
                            getLabel={(i) => i.name}
                            getSub={(i) => `${i.category || 'Uncategorised'} · ${i.baseUnit}`}
                            placeholder="Search item…"
                            onAddNew={(name) => { setPrefillName(name); setShowItem(true); }}
                            addNewLabel="Add new item"
                          />
                        </div>
                        <button className="btn btn-ghost btn-icon" onClick={() => removeLine(l.key)}
                                aria-label="Remove line" title="Remove line">
                          <Trash2 size={15} color="var(--danger)" />
                        </button>
                      </div>

                      <div className="row wrap line-fields" style={{ gap: 8, paddingLeft: 28 }}>
                        <div style={{ width: 92 }}>
                          <label className="small muted">Qty</label>
                          <Input type="number" min="0" step="any" value={l.qty}
                                 onChange={(e) => setLine(l.key, { qty: e.target.value })} />
                        </div>

                        <div style={{ width: 112 }}>
                          <label className="small muted">Unit</label>
                          <Select value={l.unit} onChange={(e) => setLine(l.key, { unit: e.target.value })}
                                  options={unitOpts} />
                        </div>

                        <div style={{ width: 118 }}>
                          <label className="small muted">Rate</label>
                          <Input type="number" min="0" step="any" value={l.price}
                                 onChange={(e) => setLine(l.key, { price: e.target.value, autoFilled: false })} />
                        </div>

                        <div className="spacer hide-mobile" />

                        <div className="line-amount" style={{ textAlign: 'right' }}>
                          <label className="small muted">Amount</label>
                          <div className="money" style={{ fontSize: 16, paddingTop: 6 }}>
                            {money((Number(l.qty) || 0) * (Number(l.price) || 0))}
                          </div>
                        </div>
                      </div>

                      {/* Auto-fill / history / stock / deviation feedback */}
                      <div className="row wrap line-meta" style={{ gap: 8, paddingLeft: 28, marginTop: 7 }}>
                        {l.autoFilled && last && (
                          <span className="pill pill-cleared">
                            Auto-filled from {fmtDate(last.date)}
                          </span>
                        )}
                        {l.itemId && last && (
                          <button className="btn btn-ghost btn-sm" onClick={() => setHistoryFor(l.itemId)}>
                            <History size={13} /> Price history
                          </button>
                        )}
                        {l.itemId && item?.altUnit && Number(item.conversionRate) > 0 && (
                          <span className="small muted">
                            1 {item.altUnit} = {item.conversionRate} {item.baseUnit}
                          </span>
                        )}
                        {stock !== null && (
                          // Stock is in base units; a line in Bags is converted first.
                          (Number(l.qty) || 0) * unitFactor(item, l.unit) > stock ? (
                            // Oversell is allowed (goods may be in transit), but it
                            // must never happen silently — stock would go negative.
                            <span className="pill pill-due">
                              <AlertTriangle size={11} />
                              Only {stock} {item?.baseUnit} in stock
                            </span>
                          ) : (
                            <span className="small muted">
                              Stock: {stock} {item?.baseUnit}
                            </span>
                          )
                        )}
                        {dev && (
                          <span className="pill pill-partial">
                            <AlertTriangle size={11} />
                            {dev.up ? 'Up' : 'Down'} {dev.pct.toFixed(0)}% vs last {money(dev.oldPrice)}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          <Card title="Delivery" subtitle="Whether the goods go out with this bill">
            <label className="row" style={{ gap: 9, alignItems: 'flex-start', cursor: 'pointer' }}>
              <input type="checkbox" checked={pending}
                     onChange={(e) => setPending(e.target.checked)}
                     style={{ width: 17, height: 17, marginTop: 1, flexShrink: 0 }} />
              <span>
                <span style={{ fontWeight: 600 }}>Not delivered yet</span>
                <span className="small muted" style={{ display: 'block' }}>
                  Tick for goods still to be sent. The bill still counts as a sale
                  and as money owed. Open the bill and use Delivery to tick items
                  as they go out — some now, the rest later.
                </span>
              </span>
            </label>
          </Card>

          <Card title="Note" subtitle="Optional — appears on the bill">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)}
                      placeholder="Delivery instructions, reference, anything worth recording…" />
          </Card>
        </div>

        {/* ================= Right: totals + payment ================= */}
        <div className="col">
          <Card title="Bill Total">
            <SumRow label="Subtotal" value={totals.subtotal} />
            {totals.roundOff !== 0 && (
              <SumRow label="Round off" value={totals.roundOff} showSign muted />
            )}
            <div style={{
              display: 'flex', alignItems: 'center', paddingTop: 11, marginTop: 5,
              borderTop: '2px solid var(--border-strong)',
            }}>
              <span style={{ fontWeight: 700, fontSize: 15 }}>Total</span>
              <span className="spacer" />
              <span className="money" style={{ fontSize: 21 }}>{money(totals.total)}</span>
            </div>
            <div className="small muted mt-1">
              Rounding: {settings.roundingRule === 'exact' ? 'exact' : `nearest ${settings.roundingRule.replace('nearest', '')}`}
              {' '}(change in Settings)
            </div>
          </Card>

          <Card
            title="Payment"
            subtitle="Split across any methods — the remainder becomes Credit"
            actions={<Button size="sm" icon={Plus} onClick={addPay}>Add method</Button>}
          >
            {/* Apply party advance (FR-9).
                Offered rather than applied: money the party paid earlier is
                quietly deducted otherwise, and a total that changes on its own
                is exactly what a biller fails to notice. Once something is
                applied the prompt becomes the amount field, so it can still be
                adjusted or taken back off. */}
            {advanceAvailable > 0 && (
              r2(applyAdvance) > 0 ? (
                <Field label="Advance applied"
                       hint={`${money(advanceAvailable)} available in total`}>
                  <div className="input-group">
                    <Input type="number" min="0"
                           max={Math.min(advanceAvailable, totals.total)} step="any"
                           value={applyAdvance}
                           onChange={(e) => setApplyAdvance(e.target.value)} />
                    <Button onClick={() => setApplyAdvance(0)} icon={X}>Remove</Button>
                  </div>
                </Field>
              ) : (
                <div className="note" style={{ marginBottom: 12 }}>
                  <Wallet size={14} />
                  <span style={{ flex: 1 }}>
                    <strong>{party?.name || 'This party'}</strong> has{' '}
                    <strong>{money(advanceAvailable)}</strong> advance with you.
                  </span>
                  <Button size="sm" variant="primary"
                          disabled={totals.total <= 0}
                          onClick={() => setApplyAdvance(
                            String(Math.min(advanceAvailable, totals.total)),
                          )}>
                    Apply to this bill
                  </Button>
                </div>
              )
            )}

            {pays.map((p) => (
              <div key={p.key} style={{ marginBottom: 12 }}>
                <div className="row pay-row" style={{ gap: 7 }}>
                  <Select value={p.method} className="pay-method"
                          onChange={(e) => setPay(p.key, { method: e.target.value, cheque: e.target.value === 'Cheque' ? blankCheque(date) : null })}
                          options={methods} style={{ width: 132 }} />
                  <Input type="number" min="0" step="any" placeholder="0" className="pay-amount"
                         value={p.amount} onChange={(e) => setPay(p.key, { amount: e.target.value })} />
                  <Button size="sm" className="pay-full" onClick={() => fillRemaining(p.key)}
                          title="Fill remaining balance">
                    Full
                  </Button>
                  {pays.length > 1 && (
                    <button className="btn btn-ghost btn-icon pay-remove" onClick={() => removePay(p.key)}
                            aria-label="Remove payment method">
                      <Trash2 size={15} color="var(--danger)" />
                      <span className="hide-desktop" style={{ marginLeft: 6 }}>Remove</span>
                    </button>
                  )}
                </div>

                {/* Cheque detail fields (FR-28) */}
                {p.method === 'Cheque' && (
                  <ChequeFields value={p.cheque} onChange={(cheque) => setPay(p.key, { cheque })} />
                )}
              </div>
            ))}

            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 11, marginTop: 4 }}>
              <SumRow label="Paid now" value={paidNow} muted />
              {Number(applyAdvance) > 0 && <SumRow label="From advance" value={Number(applyAdvance)} muted />}

              {creditAmount > 0 ? (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8, marginTop: 9,
                  padding: '10px 12px', background: 'var(--danger-bg)',
                  border: '1px solid #FECACA', borderRadius: 'var(--r-sm)',
                }}>
                  <CreditCard size={16} color="#B91C1C" style={{ flex: 'none' }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, color: '#B91C1C' }}>On Credit</div>
                    <div className="small" style={{ color: '#B91C1C' }}>Due {fmtDate(dueDate)}</div>
                  </div>
                  <span className="money" style={{ color: '#B91C1C', fontSize: 16 }}>{money(creditAmount)}</span>
                </div>
              ) : overpaid > 0 ? (
                <div style={{ ...warnBox, marginTop: 9 }}>
                  <AlertTriangle size={15} style={{ flex: 'none', marginTop: 1 }} />
                  <span>Payment exceeds the total by <strong>{money(overpaid)}</strong>. Reduce a payment line.</span>
                </div>
              ) : (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8, marginTop: 9,
                  padding: '10px 12px', background: 'var(--success-bg)',
                  border: '1px solid #BBF7D0', borderRadius: 'var(--r-sm)',
                  color: '#15803D', fontWeight: 700,
                }}>
                  Fully paid
                </div>
              )}
            </div>
          </Card>

          <Button variant="primary" size="lg" block icon={Save} onClick={onSave} loading={busy}
                  disabled={!partyId || !validLines.length}>
            {editingBill ? 'Update Bill' : 'Save Bill'}
          </Button>
        </div>
      </div>

      {/* Sticky running total while scrolling on mobile */}
      <div className={`sticky-total ${validLines.length ? 'on' : ''}`}>
        <div>
          <div className="lbl">TOTAL</div>
          <div className="val">{money(totals.total)}</div>
        </div>
        <div className="spacer" />
        {creditAmount > 0 && (
          <div style={{ textAlign: 'right' }}>
            <div className="lbl">ON CREDIT</div>
            <div className="val" style={{ color: '#FCA5A5', fontSize: 16 }}>{money(creditAmount)}</div>
          </div>
        )}
        <Button variant="primary" onClick={onSave} loading={busy}
                disabled={!partyId}>Save</Button>
      </div>

      {/* ---- Receipt for the bill just saved ----
          Shown over this page instead of navigating to the bill, so the other
          tabs and everything typed into them stay exactly where they were.
          Closing it retires this tab, whose work is now on the server. */}
      <BillReceiptModal
        open={Boolean(savedBillId)}
        onClose={() => { setSavedBillId(null); closeSavedTab(); }}
        bill={savedBill}
        lines={savedBillId ? data.billItems.filter((bi) => bi.billId === savedBillId) : []}
        payments={savedBillId ? data.payments.filter((p) => p.billId === savedBillId) : []}
        cheques={savedBillId ? data.cheques.filter((c) => c.billId === savedBillId) : []}
        returns={savedBillId ? data.returns.filter((r) => r.billId === savedBillId) : []}
        itemName={(id) => data.items.find((i) => i.id === id)?.name || 'Item'}
        party={savedBill ? data.parties.find((x) => x.id === savedBill.partyId) : null}
        shopName={settings.shopName}
        allowSeparate
        onPrint={(separate) => {
          if (!savedBill) return;
          printBill({
            separate,
            bill: savedBill,
            lines: data.billItems
              .filter((bi) => bi.billId === savedBillId)
              .map((bi) => ({
                ...bi,
                itemName: data.items.find((i) => i.id === bi.itemId)?.name || 'Item',
              })),
            party: data.parties.find((x) => x.id === savedBill.partyId),
            payments: data.payments.filter((p) => p.billId === savedBillId && !p.reversed),
            settings,
            state: savedBill,
          });
        }}
      />

      <Confirm
        open={confirmClear}
        title="Clear unsaved bills?"
        message={`This removes ${tabs.length === 1 ? 'the bill' : `all ${tabs.length} bills`} on this page that ${tabs.length === 1 ? 'has' : 'have'} not been saved. Saved bills are not affected.`}
        confirmLabel="Clear all"
        danger
        onConfirm={clearDrafts}
        onCancel={() => setConfirmClear(false)}
      />

      {/* ---------------- Inline add dialogs ---------------- */}
      <Modal open={showParty} title="Add New Party" onClose={() => setShowParty(false)}>
        <PartyForm initialName={prefillName} onSaved={onPartyAdded} onCancel={() => setShowParty(false)} />
      </Modal>

      <Modal open={showItem} title="Add New Item" onClose={() => setShowItem(false)}>
        <ItemForm initialName={prefillName} onSaved={onItemAdded} onCancel={() => setShowItem(false)} />
      </Modal>

      {/* Price history (FR-4) */}
      <Modal open={Boolean(historyFor)} title={`Price History — ${itemName(historyFor)}`}
             onClose={() => setHistoryFor(null)}>
        <div className="small muted mb-2">Prices charged to {party?.name} for this item.</div>
        {historyFor && priceHistory(partyId, historyFor).length ? (
          <table className="tbl">
            <thead><tr><th>Date</th><th>Unit</th><th className="r">Price</th></tr></thead>
            <tbody>
              {priceHistory(partyId, historyFor).map((h, i) => (
                <tr key={h.id}>
                  <td>{fmtDate(h.date)} {i === 0 && <Pill status="cleared" label="Latest" />}</td>
                  <td>{h.unit}</td>
                  <td className="r strong"><Money value={h.price} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty title="No price history" message="This is the first time this party is buying this item." />
        )}
      </Modal>

      {/* Price deviation confirmation (FR-5) */}
      <Modal
        open={Boolean(priceWarn)}
        title="Confirm price change"
        onClose={() => setPriceWarn(null)}
        footer={
          <>
            <Button onClick={() => setPriceWarn(null)}>Go back and fix</Button>
            <Button variant="primary" onClick={() => { setPriceWarn(null); doSave(); }}>
              Prices are correct, save
            </Button>
          </>
        }
      >
        <p style={{ marginTop: 0, fontSize: 14 }}>
          {priceWarn?.length === 1 ? 'One price differs' : `${priceWarn?.length} prices differ`} from
          what {party?.name} last paid by more than {settings.priceAlertThreshold}%.
        </p>
        {priceWarn?.map((d, i) => (
          <div key={i} style={{ ...lineBox, marginBottom: 8 }}>
            <div style={{ fontWeight: 600 }}>{d.itemName}</div>
            <div className="row small" style={{ gap: 8, marginTop: 4 }}>
              <span className="muted">Last paid {money(d.oldPrice)} on {fmtDate(d.lastDate)}</span>
              <span>→</span>
              <span style={{ fontWeight: 700, color: d.up ? 'var(--danger)' : 'var(--success)' }}>
                {money(d.newPrice)} ({d.up ? '+' : '−'}{d.pct.toFixed(0)}%)
              </span>
            </div>
          </div>
        ))}
      </Modal>
    </>
  );
}

/* ---------------- Unsaved bill drafts ---------------- */

const DRAFTS_KEY = 'ewd_billDrafts';

/** Does this parked form hold anything a biller would miss? */
function formHasWork(f) {
  return Boolean(f && (f.partyId || (f.lines && f.lines.length) || f.note));
}

/**
 * The bills left unsaved on the New Bill page, as { tabs, active }, or null.
 * `partyFromUrl` ("New Sale" from a party's page) opens its own tab rather than
 * overwriting a bill already in progress.
 */
function loadDrafts(partyFromUrl) {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(DRAFTS_KEY) || 'null');
  } catch { saved = null; }

  let tabs = Array.isArray(saved?.tabs) ? saved.tabs.filter((t) => t && t.key) : [];
  let active = Math.min(Math.max(0, Number(saved?.active) || 0), Math.max(0, tabs.length - 1));

  if (partyFromUrl) {
    const blank = tabs.findIndex((t) => !formHasWork(t.form));
    const form = { partyId: partyFromUrl };
    if (blank >= 0) {
      tabs = tabs.map((t, n) => (n === blank ? { ...t, form } : t));
      active = blank;
    } else {
      tabs = [...tabs, { key: uid('tab'), label: '', form }];
      active = tabs.length - 1;
    }
  }

  if (!tabs.length) return null;
  return { tabs: tabs.map((t, n) => ({ ...t, label: `Bill ${n + 1}` })), active };
}

/** Store the page's bills, or forget them when none holds any work. */
function saveDrafts(tabs, active) {
  try {
    if (!tabs.some((t) => formHasWork(t.form))) {
      localStorage.removeItem(DRAFTS_KEY);
    } else {
      localStorage.setItem(DRAFTS_KEY, JSON.stringify({ tabs, active }));
    }
  } catch { /* storage full or blocked: drafts are a convenience only */ }
}

/* ---------------- small helpers ---------------- */

function SumRow({ label, value, showSign = false, muted = false }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '5px 0' }}>
      <span className={muted ? 'muted' : ''} style={{ fontSize: 13.5 }}>{label}</span>
      <span className="spacer" />
      <Money value={value} showSign={showSign} className={muted ? 'small' : ''} />
    </div>
  );
}

const lineBox = {
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-sm)',
  padding: 11,
  background: '#FCFCFD',
};

const warnBox = {
  display: 'flex', gap: 8, alignItems: 'flex-start',
  padding: '10px 12px', background: 'var(--warning-bg)',
  border: '1px solid #FDE68A', borderRadius: 'var(--r-sm)',
  fontSize: 13, color: '#B45309',
};
