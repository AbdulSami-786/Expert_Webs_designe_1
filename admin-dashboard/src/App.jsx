import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, ShieldCheck } from 'lucide-react';
import Clients from './pages/Clients';
import { call } from './lib/api';

export default function App() {
  const [data, setData] = useState(null);       // { serverNow, clients, codes }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await call('adminList'));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Connects to the license server straight away.
  useEffect(() => { load(); }, [load]);

  // Could not connect at all (wrong URL, deployment not updated, ...): say why and offer a retry.
  if (!data && !loading) {
    return (
      <div className="login-wrap">
        <div className="login-card">
          <div className="login-icon"><ShieldCheck size={26} /></div>
          <h1>Could not connect</h1>
          <div className="alert err">{error}</div>
          <button className="btn primary block" onClick={load}><RefreshCw size={16} /> Try again</button>
        </div>
      </div>
    );
  }

  if (!data) return <div className="splash">Connecting…</div>;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><ShieldCheck size={20} /> <span>EWD Admin</span><small>Subscriptions</small></div>
        <div className="grow" />
        <button className="btn ghost" onClick={load} disabled={loading}>
          <RefreshCw size={15} className={loading ? 'spin' : ''} /> Refresh
        </button>
      </header>
      <main className="content">
        {error && <div className="alert err">{error}</div>}
        <Clients data={data} reload={load} />
      </main>
    </div>
  );
}
