// Wraps the whole dashboard and enforces the monthly-maintenance subscription.
//
//   expired / closed by admin  -> a full-screen BLACK page; the dashboard behind it is not rendered.
//                                  The page has the renewal-code box, so paying fixes it on the spot.
//   expiring within N days     -> the dashboard works, with a popup every time it is opened.
//   anything else              -> invisible.

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, KeyRound, Lock } from 'lucide-react';
import {
  LICENSE_ENABLED, computeState, fetchStatus, readCache, redeemCode, touchSeen, trustedNow,
} from '../lib/license';

const RECHECK_MS = 10 * 60 * 1000;   // ask the server again while the dashboard stays open
const TICK_MS = 30 * 1000;           // re-evaluate the (remembered) expiry; catches "expired while open"
const FOCUS_RECHECK_MS = 2 * 60 * 1000;

const fmtWhen = (ms) =>
  new Date(ms).toLocaleString('en-GB', {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

/** Renewal-code entry shared by the black page and the popup. */
function RenewForm({ onRenew, autoFocus = false }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (busy || !code.trim()) return;
    setBusy(true);
    setErr('');
    try {
      await onRenew(code);
    } catch (ex) {
      setErr(ex.message || 'Could not renew. Try again.');
      setBusy(false);
    }
    // On success the gate switches screens, which unmounts this form — no state to reset.
  };

  return (
    <form className="lic-form" onSubmit={submit}>
      <label htmlFor="lic-code">Renewal code</label>
      <input
        id="lic-code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())}
        placeholder="EWD-XXXX-XXXX-XXXX" autoComplete="off" autoCapitalize="characters"
        spellCheck={false} autoFocus={autoFocus}
      />
      {err && <div className="lic-err" role="alert">{err}</div>}
      <button className="lic-btn lic-btn-primary" type="submit" disabled={busy || !code.trim()}>
        <KeyRound size={16} /> {busy ? 'Checking…' : 'Renew subscription'}
      </button>
    </form>
  );
}

export default function LicenseGate({ children, bypass = false }) {
  const active = LICENSE_ENABLED && !bypass;

  const [cache, setCache] = useState(() => (active ? readCache() : null));
  // With a remembered answer we can decide instantly; without one, wait (briefly) for the server.
  const [loaded, setLoaded] = useState(() => !active || Boolean(readCache()));
  const [, setTick] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [renewedUntil, setRenewedUntil] = useState(0);
  const lastFetch = useRef(0);

  const refresh = useCallback(async () => {
    lastFetch.current = Date.now();
    try {
      setCache(await fetchStatus());
    } catch {
      // Offline or the server hiccupped: keep whatever we remembered. Never lock out on an outage.
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    refresh();

    const poll = setInterval(refresh, RECHECK_MS);
    const tick = setInterval(() => {
      setCache((c) => touchSeen(c));
      setTick((n) => n + 1);
    }, TICK_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastFetch.current > FOCUS_RECHECK_MS) refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      clearInterval(poll); clearInterval(tick);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [active, refresh]);

  const onRenew = useCallback(async (code) => {
    const next = await redeemCode(code);
    setCache(next);
    setDismissed(true);
    setRenewedUntil(next.status.expiresAt || 0);
  }, []);

  if (!active) return children;

  if (!loaded) {
    return <div className="lic-screen"><div className="lic-wait">Checking subscription…</div></div>;
  }

  const status = cache?.status || null;
  const { state, daysLeft } = computeState(status, trustedNow(cache));

  /* ---------------- Black page: expired / closed / unknown ---------------- */
  if (state !== 'ok' && state !== 'soon') {
    const closed = state === 'locked';
    const unknown = state === 'unregistered';
    const title = closed ? 'This dashboard is closed'
      : unknown ? 'This dashboard is not registered'
      : 'Your monthly subscription has expired';
    const detail = status?.lockMessage
      || (closed ? 'Access to this dashboard has been paused. Enter a renewal code to open it again, or contact support.'
        : unknown ? 'This copy is not linked to a subscription. Please contact support.'
        : `Your monthly maintenance ended on ${fmtWhen(status.expiresAt)}. Enter your renewal code to continue.`);

    return (
      <div className="lic-screen" role="alert">
        <div className="lic-panel">
          <div className="lic-icon"><Lock size={30} /></div>
          <h1>{title}</h1>
          {status?.name && <div className="lic-name">{status.name}</div>}
          <p>{detail}</p>
          {!unknown && <RenewForm onRenew={onRenew} autoFocus />}
          {status?.contact && <div className="lic-contact">Contact: {status.contact}</div>}
        </div>
      </div>
    );
  }

  /* ---------------- Working dashboard (+ popup when close to expiry) ---------------- */
  const showWarning = state === 'soon' && !dismissed;
  const daysText = daysLeft <= 1 ? 'in less than a day' : `in just ${daysLeft} days`;

  return (
    <>
      {children}

      {showWarning && (
        <div className="lic-backdrop">
          <div className="lic-modal" role="dialog" aria-modal="true" aria-label="Subscription expiring">
            <div className="lic-icon warn"><AlertTriangle size={26} /></div>
            <h2>Your subscription will expire {daysText}</h2>
            <p>
              Monthly maintenance ends on <strong>{fmtWhen(status.expiresAt)}</strong>. After that this
              dashboard will stop opening until it is renewed.
            </p>
            <p className="lic-sub">Have a renewal code? Enter it now to renew.</p>
            <RenewForm onRenew={onRenew} />
            <button className="lic-btn lic-btn-ghost" onClick={() => setDismissed(true)}>
              Remind me later
            </button>
          </div>
        </div>
      )}

      {renewedUntil > 0 && (
        <div className="lic-backdrop">
          <div className="lic-modal" role="dialog" aria-modal="true" aria-label="Subscription renewed">
            <div className="lic-icon ok"><CheckCircle2 size={28} /></div>
            <h2>Subscription renewed</h2>
            <p>Your dashboard is active until <strong>{fmtWhen(renewedUntil)}</strong>. Thank you!</p>
            <button className="lic-btn lic-btn-primary" onClick={() => setRenewedUntil(0)} autoFocus>Continue</button>
          </div>
        </div>
      )}
    </>
  );
}
