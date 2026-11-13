// Login — single admin account for v1 (FR: User Roles).

import { useState } from 'react';
import { LogIn, ShieldCheck } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { Button, Field, Input, Toasts } from '../components/ui';
import { CONFIG } from '../lib/config';

export default function Login() {
  const { login, toast, toasts } = useApp();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return; // guard: block a double login submit
    setErr('');
    setBusy(true);
    try {
      await login(username, password);
      toast('Welcome back', 'success');
    } catch (ex) {
      setErr(ex.message || 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div style={{ textAlign: 'center', marginBottom: 22 }}>
          <img src="/brand/logo-horizontal-darktext.svg" alt={CONFIG.defaultShopName}
               style={{ display: 'block', width: 250, maxWidth: '100%', height: 'auto', margin: '0 auto 14px' }} />
          <p className="muted small" style={{ margin: '4px 0 0' }}>
            Business Dashboard
          </p>
        </div>

        <Field label="Username">
          <Input value={username} onChange={(e) => setUsername(e.target.value)}
                 autoComplete="username" autoFocus />
        </Field>

        <Field label="Password" error={err}>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                 autoComplete="current-password" placeholder="Enter your password" />
        </Field>

        <Button type="submit" variant="primary" size="lg" block icon={LogIn} loading={busy}>
          Sign in
        </Button>

        {/* Dev only: a deployed build must not advertise the default password,
            even while the local backend is in use. */}
        {CONFIG.backend === 'local' && import.meta.env.DEV && (
          <div style={{
            marginTop: 18, padding: '10px 12px', background: 'var(--info-bg)',
            border: '1px solid #BFDBFE', borderRadius: 'var(--r-sm)',
            fontSize: 12, color: '#1D4ED8', display: 'flex', gap: 8,
          }}>
            <ShieldCheck size={15} style={{ flex: 'none', marginTop: 1 }} />
            <span>
              Default login is <strong>admin</strong> / <strong>admin123</strong>.
              Change it in Settings after signing in.
            </span>
          </div>
        )}
      </form>
      <Toasts toasts={toasts} />
    </div>
  );
}
