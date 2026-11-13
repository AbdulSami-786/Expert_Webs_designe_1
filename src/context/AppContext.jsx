// Central app state.
//
// Perf Guide 1.1: reference data (parties, items, settings) is fetched ONCE per
// session and kept in memory — not re-fetched on every screen. Writes update
// local state immediately (optimistic) so the UI never feels like it is waiting
// on the network for routine actions.

import { createContext, useContext, useEffect, useState, useCallback, useMemo, useRef } from 'react';
import api, { queueCount, flushQueue } from '../lib/api';
import { readSession } from '../lib/localAdapter';
import { startAutoSync } from '../lib/sync';
import { relockAll } from '../lib/partyLock';
import { CONFIG, DEFAULT_METHODS } from '../lib/config';
import { isSuperAdmin, hasPage } from '../lib/access';

const AppCtx = createContext(null);

export function useApp() {
  const ctx = useContext(AppCtx);
  if (!ctx) throw new Error('useApp must be used inside <AppProvider>');
  return ctx;
}

const EMPTY = {
  parties: [], items: [], partyItemPrices: [],
  bills: [], billItems: [], payments: [], returns: [],
  cheques: [], partyAdvances: [], purchases: [],
  employees: [], employeeTx: [],
  expenses: [], stockLoss: [], assets: [],
  activityLog: [], partyLedgerLinks: [],
  suppliers: [], purchaseBills: [], supplierPayments: [], supplierReturns: [],
  settings: {
    shopName: 'Expert Webs Designs', phone: '', address: '', email: '', logoUrl: '',
    roundingRule: 'nearest1', priceAlertThreshold: 15, defaultCreditDays: 7, customMethods: [],
  },
};

export function AppProvider({ children }) {
  // readSession() drops anything expired or malformed, so a stale token from a
  // previous visit can no longer keep the app signed in forever.
  const [session, setSession] = useState(() => readSession());

  const [data, setData] = useState(EMPTY);
  const [loading, setLoading] = useState(false);
  const [booted, setBooted] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [online, setOnline] = useState(navigator.onLine);
  const [pending, setPending] = useState(queueCount());

  const toastId = useRef(0);

  // logout is defined further down; holding it in a ref lets earlier callbacks
  // (refresh, the expiry effect) call it without listing it as a dependency.
  const logoutRef = useRef(() => {});

  /* ---------------- Toasts (brief, non-blocking) ---------------- */
  const toast = useCallback((message, type = 'success') => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, message, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200);
  }, []);

  /* ---------------- Bootstrap ---------------- */
  const refresh = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const d = await api.bootstrap();

      // The account was deleted or switched to inactive since this person
      // signed in. `me` is explicitly null/inactive only on a backend that
      // knows about accounts; an older backend omits it and is left alone.
      if (d.me === null || d.me?.status === 'inactive') {
        logoutRef.current();
        toast(d.me === null
          ? 'Your account no longer exists. Please contact the super admin.'
          : 'Your account has been deactivated. Please contact the super admin.', 'error');
        return d;
      }

      // Merge settings key-by-key rather than replacing the object: a backend
      // that returns partial or empty settings must not strip defaults like
      // roundingRule, which billing depends on. Null/undefined values from the
      // sheet fall back to the default for that key.
      const settings = { ...EMPTY.settings };
      Object.entries(d.settings || {}).forEach(([k, v]) => {
        if (v !== null && v !== undefined && v !== '') settings[k] = v;
      });
      setData({ ...EMPTY, ...d, settings });
      return d;
    } catch (err) {
      if (!silent) toast(err.message || 'Could not load data', 'error');
      throw err;
    } finally {
      if (!silent) setLoading(false);
      setBooted(true);
    }
  }, [toast]);

  useEffect(() => {
    if (session) refresh().catch(() => {});
    else setBooted(true);
  }, [session, refresh]);

  /* ---------------- Session expiry ---------------- */
  // Sign out the moment the session lapses, rather than leaving a dead token
  // in place until the next reload. A `storage` event covers the other case:
  // logging out in one tab should log every tab out.
  useEffect(() => {
    if (!session) return;

    const ms = (session.expiresAt || 0) - Date.now();
    if (ms <= 0) { logoutRef.current(); return; }

    // setTimeout keeps its delay in a signed 32-bit int, so anything beyond
    // ~24.8 days overflows and fires straight away. Sessions now last ten
    // years, so scheduling that directly would sign the user out seconds after
    // they signed in — the exact opposite of a session that does not expire.
    // Past the ceiling there is nothing to schedule: the reload check and the
    // server's own validation both still apply.
    const MAX_DELAY = 2 ** 31 - 1;
    const timer = ms <= MAX_DELAY
      ? setTimeout(() => {
          logoutRef.current();
          toast('Your session expired — please sign in again', 'info');
        }, ms)
      : null;

    const onStorage = (e) => {
      if (e.key === 'ewd_session' && !readSession()) logoutRef.current();
    };

    // The backend rejected the token (expired or revoked server-side).
    const onExpired = () => {
      logoutRef.current();
      toast('Your session expired — please sign in again', 'info');
    };

    // Timers can be paused while a device sleeps, so re-check on return.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !readSession()) onExpired();
    };

    window.addEventListener('storage', onStorage);
    window.addEventListener('ewd:session-expired', onExpired);
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('ewd:session-expired', onExpired);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [session, toast]);

  /* ---------------- Connectivity + offline queue ---------------- */
  useEffect(() => {
    const up = async () => {
      setOnline(true);
      const res = await flushQueue();
      setPending(queueCount());
      if (res.synced > 0) {
        toast(`${res.synced} queued ${res.synced === 1 ? 'bill' : 'bills'} synced`, 'success');
        refresh().catch(() => {});
      }
    };
    const down = () => {
      setOnline(false);
      toast(CONFIG.backend === 'local'
        ? 'You are offline — everything is saved on this computer'
        : 'You are offline — bills will be queued', 'info');
    };
    const onQueue = (e) => setPending(e.detail ?? queueCount());

    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    window.addEventListener('ewd:queue-changed', onQueue);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
      window.removeEventListener('ewd:queue-changed', onQueue);
    };
  }, [toast, refresh]);

  /* ---------------- Google Sheets sync ---------------- */
  // Runs for the whole signed-in session, not just while Settings is open, so
  // a bill written on the shop floor reaches the Sheet without anyone going
  // looking for a button. It is a no-op until the Sheet is connected.
  useEffect(() => {
    if (!session) return undefined;
    return startAutoSync();
  }, [session]);

  // The desktop app downloads records entered on other devices in the
  // background. Show them without a loading spinner interrupting whoever is
  // mid-bill.
  useEffect(() => {
    if (!session) return undefined;
    const onPulled = () => { refresh({ silent: true }).catch(() => {}); };
    window.addEventListener('ewd:data-pulled', onPulled);
    return () => window.removeEventListener('ewd:data-pulled', onPulled);
  }, [session, refresh]);

  /* ---------------- Auth ---------------- */
  const login = useCallback(async (username, password) => {
    const s = await api.login(username, password);
    localStorage.setItem('ewd_session', JSON.stringify(s));
    setSession(s);
    return s;
  }, []);

  const logout = useCallback(() => {
    // Every password-locked party ledger closes with the session.
    relockAll();
    localStorage.removeItem('ewd_session');
    setSession(null);
    setData(EMPTY);
  }, []);

  logoutRef.current = logout;

  /**
   * Run a write action, then refresh state from the backend.
   * Returns the created/updated record so callers can use its id.
   */
  const mutate = useCallback(async (fn, successMsg) => {
    try {
      const result = await fn();
      await refresh();
      if (result?.queued) {
        setPending(queueCount());
        toast('Saved offline — will sync when you reconnect', 'info');
      } else if (successMsg) {
        toast(successMsg, 'success');
      }
      return result;
    } catch (err) {
      toast(err.message || 'Something went wrong', 'error');
      throw err;
    }
  }, [refresh, toast]);

  /* ---------------- Derived reference lists ---------------- */
  const methods = useMemo(
    () => [...DEFAULT_METHODS, ...(data.settings?.customMethods || [])],
    [data.settings]
  );

  const activeParties = useMemo(
    () => data.parties.filter((p) => p.status !== 'archived'),
    [data.parties]
  );

  const activeItems = useMemo(
    () => data.items.filter((i) => i.status !== 'archived'),
    [data.items]
  );

  const activeSuppliers = useMemo(
    () => (data.suppliers || []).filter((s) => s.status !== 'archived'),
    [data.suppliers]
  );

  // Who is signed in and what they may open. Prefers the live record from the
  // last bootstrap (so a super admin's change applies without a re-login) and
  // falls back to what login returned.
  const me = useMemo(() => {
    if (data.me) return data.me;
    if (!session) return null;
    return {
      username: session.username, fullName: session.fullName || '',
      role: session.role, allowedPages: session.allowedPages || [],
    };
  }, [data.me, session]);
  const isAdmin = isSuperAdmin(me);
  const can = useCallback((key) => hasPage(me, key), [me]);

  const value = useMemo(() => ({
    session, me, isAdmin, can, login, logout,
    data, setData, refresh, mutate, loading, booted,
    toast, toasts,
    online, pending,
    methods, activeParties, activeItems, activeSuppliers,
    settings: data.settings,
  }), [session, me, isAdmin, can, login, logout, data, refresh, mutate, loading, booted,
       toast, toasts, online, pending, methods, activeParties, activeItems, activeSuppliers]);

  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}
