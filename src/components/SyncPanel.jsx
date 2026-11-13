// Google Sheets sync status — read-only.
//
// The Sheet is connected in src/lib/config.js, so there is nothing to sign in
// to and no credentials on screen. This panel only reports what is happening:
// how much is waiting, and when it last went up.
//
// There is deliberately no button here. Syncing is automatic — on reconnect,
// after every write, and on a timer — so a manual push could only ever do what
// the app was about to do anyway, while giving the shopkeeper a control that
// looks like it needs pressing. Nothing waits on anyone noticing it.

import { useEffect, useState } from 'react';
import { Cloud, CloudOff, AlertTriangle } from 'lucide-react';
import { Card, Pill } from './ui';
import { useApp } from '../context/AppContext';
import { pendingCount } from '../lib/sync';
import { CONFIG } from '../lib/config';
import { fmtDateTime } from '../lib/format';

const LAST_SYNC_KEY = 'ewd_last_sync_at';

export default function SyncPanel() {
  const { online } = useApp();

  const [pending, setPending] = useState(pendingCount());
  const [err, setErr] = useState('');
  const [lastSync, setLastSync] = useState(() => {
    try { return localStorage.getItem(LAST_SYNC_KEY) || ''; } catch { return ''; }
  });
  const [report, setReport] = useState(null);

  // The sync engine announces its own progress. Since every push now happens on
  // its own, this listener is the only way anything about sync reaches a screen.
  useEffect(() => {
    const onChange = (e) => {
      setPending(e.detail?.pending ?? pendingCount());
      if (e.detail?.status === 'error') setErr(e.detail.error || '');
      if (e.detail?.status === 'syncing') setErr('');
      if (e.detail?.lastSyncAt) {
        setLastSync(e.detail.lastSyncAt);
        try { localStorage.setItem(LAST_SYNC_KEY, e.detail.lastSyncAt); } catch { /* ignore */ }
      }
      if (e.detail?.billNoChanges?.length || e.detail?.failed) {
        setReport({
          billNoChanges: e.detail.billNoChanges || [],
          errors: e.detail.errors || [],
          failed: e.detail.failed || 0,
        });
      }
    };
    const onData = () => setPending(pendingCount());

    window.addEventListener('ewd:sync-changed', onChange);
    window.addEventListener('ewd:data-changed', onData);
    return () => {
      window.removeEventListener('ewd:sync-changed', onChange);
      window.removeEventListener('ewd:data-changed', onData);
    };
  }, []);

  if (CONFIG.backend !== 'local') {
    return (
      <Card title="Google Sheets" subtitle="This dashboard writes to Google Sheets directly">
        <p className="small muted">
          Every action already goes straight to your Google Sheet, so there is
          nothing waiting to upload.
        </p>
      </Card>
    );
  }

  const configured = Boolean(CONFIG.appsScriptUrl && CONFIG.sheetsAuth?.username);

  if (!configured) {
    return (
      <Card title="Google Sheets Sync" actions={<Pill status="due" label="Not set up" />}>
        <p className="small muted">
          Add your Web App URL and <code>sheetsAuth</code> to{' '}
          <code>src/lib/config.js</code> to switch this on. Until then everything
          is saved on this device only. See <code>apps-script/SETUP.md</code>.
        </p>
      </Card>
    );
  }

  return (
    <Card
      title="Google Sheets Sync"
      subtitle="Work offline all day — everything uploads by itself when you have internet"
      actions={
        <Pill
          status={pending > 0 ? 'pending' : 'paid'}
          label={pending > 0 ? `${pending} waiting` : 'Up to date'}
        />
      }
    >
      <div className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 12 }}>
        {online
          ? <Cloud size={16} color="var(--success)" />
          : <CloudOff size={16} color="var(--text-muted)" />}
        <span className="small">
          {online
            ? 'Connected — new records upload automatically'
            : 'No internet — saving on this device, will upload when you reconnect'}
        </span>
      </div>

      <div className="small muted">
        {lastSync ? `Last synced ${fmtDateTime(lastSync)}` : 'Not synced yet'}
      </div>

      {err && (
        <div className="err mt-2" style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
          <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
          <span>{err}</span>
        </div>
      )}

      {report && (
        <div style={{
          marginTop: 12, padding: 11, borderRadius: 'var(--r-sm)',
          background: 'var(--bg)', border: '1px solid var(--border)',
        }}>
          {report.billNoChanges?.length > 0 && (
            <div className="small mt-1" style={{ color: '#B45309' }}>
              {report.billNoChanges.map((c) => (
                <div key={c.id}>Bill {c.from} was renumbered to {c.to} — that number was already used.</div>
              ))}
            </div>
          )}

          {report.errors?.length > 0 && (
            <div className="small mt-1" style={{ color: 'var(--danger)' }}>
              {report.errors.slice(0, 5).map((e, i) => (
                <div key={i}>{e.tab} {e.id}: {e.error}</div>
              ))}
              <div className="muted">These stay on this device and will be retried.</div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
