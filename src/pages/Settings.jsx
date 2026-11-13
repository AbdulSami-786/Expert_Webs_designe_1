// Settings (FR-53 / FR-54) — shop details, password, rounding rule, credit days,
// price-alert threshold, and custom payment methods.

import { useEffect, useMemo, useState } from 'react';
import {
  Save, Lock, Store, SlidersHorizontal, CreditCard, Plus, Trash2,
  Download, Database, AlertTriangle, ShieldCheck, Printer,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import api from '../lib/api';
import { resetLocal } from '../lib/localAdapter';
import {
  Card, Button, Field, Input, Select, PageHead, Textarea, Confirm, Pill,
} from '../components/ui';
import { ROUNDING_RULES, money, applyRounding } from '../lib/format';
import { downloadBackup, printReceiptTest, receiptWidthMm, RECEIPT_WIDTHS } from '../lib/exporters';
import SyncPanel from '../components/SyncPanel';
import OldDataImport from '../components/OldDataImport';
import { CONFIG, DEFAULT_METHODS } from '../lib/config';

export default function Settings() {
  const { data, settings, mutate, toast, logout, isAdmin } = useApp();

  const [shop, setShop] = useState(settings);
  const [pw, setPw] = useState({ old: '', next: '', confirm: '' });
  const [newMethod, setNewMethod] = useState('');
  const [busy, setBusy] = useState(false);
  const [pwBusy, setPwBusy] = useState(false);
  const [pwErr, setPwErr] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => { setShop(settings); }, [settings]);

  const set = (k) => (e) => setShop((s) => ({ ...s, [k]: e.target.value }));

  const saveShop = async () => {
    setBusy(true);
    try {
      await mutate(() => api.saveSettings({
        shopName: shop.shopName, phone: shop.phone, address: shop.address,
        email: shop.email, logoUrl: shop.logoUrl,
      }), 'Shop details saved');
    } catch { /* toast shown */ } finally { setBusy(false); }
  };

  const savePrefs = async () => {
    setBusy(true);
    try {
      await mutate(() => api.saveSettings({
        roundingRule: shop.roundingRule,
        defaultCreditDays: Number(shop.defaultCreditDays) || 7,
        priceAlertThreshold: Number(shop.priceAlertThreshold) || 15,
      }), 'Preferences saved');
    } catch { /* toast shown */ } finally { setBusy(false); }
  };

  const savePrinter = async () => {
    setBusy(true);
    try {
      await mutate(() => api.saveSettings({ receiptWidthMm: receiptWidthMm(shop) }),
        'Receipt printer saved');
    } catch { /* toast shown */ } finally { setBusy(false); }
  };

  const changePassword = async () => {
    setPwErr('');
    if (pw.next.length < 6) return setPwErr('New password must be at least 6 characters');
    if (pw.next !== pw.confirm) return setPwErr('New passwords do not match');
    setPwBusy(true);
    try {
      await api.changePassword(pw.old, pw.next);
      setPw({ old: '', next: '', confirm: '' });
      toast('Password changed — use it next time you sign in', 'success');
    } catch (e) {
      setPwErr(e.message || 'Could not change password');
    } finally { setPwBusy(false); }
  };

  const addMethod = async () => {
    const name = newMethod.trim();
    if (!name) return;
    if ([...DEFAULT_METHODS, ...(settings.customMethods || [])]
        .some((m) => m.toLowerCase() === name.toLowerCase())) {
      return toast('That payment method already exists', 'error');
    }
    await mutate(() => api.saveSettings({
      customMethods: [...(settings.customMethods || []), name],
    }), `"${name}" added`);
    setNewMethod('');
  };

  const removeMethod = async (name) => {
    await mutate(() => api.saveSettings({
      customMethods: (settings.customMethods || []).filter((m) => m !== name),
    }), `"${name}" removed`);
  };

  const doReset = () => {
    setConfirmReset(false);
    resetLocal();
    toast('Local data cleared', 'info');
    setTimeout(() => { logout(); window.location.reload(); }, 600);
  };

  // Live preview of the rounding rule
  const roundingPreview = useMemo(() => {
    const sample = 1247.63;
    const rounded = applyRounding(sample, shop.roundingRule);
    return { sample, rounded, diff: rounded - sample };
  }, [shop.roundingRule]);

  return (
    <>
      <PageHead title="Settings" subtitle="Shop details, billing rules, and account security" />

      <div className="grid-2" style={{ alignItems: 'start' }}>
        <div className="col">
          {/* ---------------- Shop details ---------------- */}
          <Card title="Shop Details" subtitle="Appears on printed bills and shared ledgers">
            <div className="form-grid">
              <Field label="Shop name" className="full">
                <Input value={shop.shopName || ''} onChange={set('shopName')} />
              </Field>
              <Field label="Phone">
                <Input value={shop.phone || ''} onChange={set('phone')} placeholder="03xx-xxxxxxx" />
              </Field>
              <Field label="Email">
                <Input type="email" value={shop.email || ''} onChange={set('email')} />
              </Field>
              <Field label="Address" className="full">
                <Textarea value={shop.address || ''} onChange={set('address')} rows={2} />
              </Field>
            </div>
            <Button variant="primary" icon={Save} onClick={saveShop} loading={busy}>
              Save Shop Details
            </Button>
          </Card>

          {/* ---------------- Billing preferences ---------------- */}
          <Card title="Billing Rules">
            <Field label="Rounding rule"
                   hint={`${money(roundingPreview.sample, { decimals: 2 })} becomes ${money(roundingPreview.rounded)} (round off ${money(roundingPreview.diff, { showSign: true })})`}>
              <Select value={shop.roundingRule || 'nearest1'} onChange={set('roundingRule')}
                      options={ROUNDING_RULES} />
            </Field>

            <div className="form-grid">
              <Field label="Default credit days"
                     hint="Used when a bill has a credit remainder">
                <Input type="number" min="0" value={shop.defaultCreditDays ?? 7}
                       onChange={set('defaultCreditDays')} />
              </Field>

              <Field label="Price change alert (%)"
                     hint="Warn if a price differs from the last one by more than this">
                <Input type="number" min="0" max="100" value={shop.priceAlertThreshold ?? 15}
                       onChange={set('priceAlertThreshold')} />
              </Field>
            </div>

            <Button variant="primary" icon={Save} onClick={savePrefs} loading={busy}>
              Save Billing Rules
            </Button>
          </Card>

          {/* ---------------- Receipt printer ---------------- */}
          <Card title="Receipt Printer" subtitle="Width of the slip your thermal printer prints">
            <Field label="Paper / print width"
                   hint="If the right side of the bill is cut off, print the test slip and pick the last width you can fully see.">
              <Select value={String(receiptWidthMm(shop))}
                      onChange={(e) => setShop((x) => ({ ...x, receiptWidthMm: Number(e.target.value) }))}
                      options={RECEIPT_WIDTHS.map((w) => ({ value: String(w.value), label: w.label }))} />
            </Field>
            <div className="row" style={{ gap: 9, flexWrap: 'wrap' }}>
              <Button icon={Printer} onClick={() => printReceiptTest(shop)}>Print Test Slip</Button>
              <Button variant="primary" icon={Save} onClick={savePrinter} loading={busy}>
                Save Printer Width
              </Button>
            </div>
          </Card>

          {/* ---------------- Payment methods ---------------- */}
          <Card title="Payment Methods" subtitle="Built-in methods plus any you add">
            <div className="chips mb-2">
              {DEFAULT_METHODS.map((m) => (
                <span key={m} className="chip" style={{ cursor: 'default' }}>{m}</span>
              ))}
            </div>

            {(settings.customMethods || []).length > 0 && (
              <>
                <div className="small muted mb-1">Your custom methods</div>
                <div className="col mb-2" style={{ gap: 7 }}>
                  {settings.customMethods.map((m) => (
                    <div key={m} className="row" style={{
                      padding: '8px 11px', border: '1px solid var(--border)',
                      borderRadius: 'var(--r-sm)', gap: 8,
                    }}>
                      <CreditCard size={15} className="muted" />
                      <span style={{ fontWeight: 500 }}>{m}</span>
                      <span className="spacer" />
                      <button className="btn btn-ghost btn-sm" onClick={() => removeMethod(m)}
                              title="Remove method">
                        <Trash2 size={14} color="var(--danger)" />
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}

            <Field label="Add a payment method">
              <div className="input-group">
                <Input value={newMethod} onChange={(e) => setNewMethod(e.target.value)}
                       onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addMethod(); } }}
                       placeholder="e.g. Meezan Bank" />
                <Button icon={Plus} onClick={addMethod}>Add</Button>
              </div>
            </Field>
          </Card>
        </div>

        <div className="col">
          {/* ---------------- Password ---------------- */}
          <Card title="Change Password" subtitle="Stored as an irreversible hash, never plain text">
            <Field label="Current password" error={pwErr}>
              <Input type="password" value={pw.old} autoComplete="current-password"
                     onChange={(e) => setPw((p) => ({ ...p, old: e.target.value }))} />
            </Field>
            <Field label="New password" hint="At least 6 characters">
              <Input type="password" value={pw.next} autoComplete="new-password"
                     onChange={(e) => setPw((p) => ({ ...p, next: e.target.value }))} />
            </Field>
            <Field label="Confirm new password">
              <Input type="password" value={pw.confirm} autoComplete="new-password"
                     onChange={(e) => setPw((p) => ({ ...p, confirm: e.target.value }))} />
            </Field>
            <Button variant="primary" icon={Lock} onClick={changePassword} loading={pwBusy}
                    disabled={!pw.old || !pw.next}>
              Change Password
            </Button>
          </Card>

          {/* Backup, sync, storage and reset are for the super admin only. */}
          {isAdmin && (
          <Card title="Backup" subtitle="Download your entire dataset">
            <p className="small muted" style={{ marginTop: 0 }}>
              Exports every record as a single file. Keep it somewhere safe — it is your
              restore point if anything goes wrong.
            </p>
            <Button icon={Download} block
                    onClick={() => { downloadBackup(data, settings.shopName); toast('Backup downloaded'); }}>
              Download Full Backup
            </Button>
          </Card>
          )}

          {isAdmin && <OldDataImport />}

          {/* ---------------- Google Sheets sync ---------------- */}
          {isAdmin && <SyncPanel />}

          {/* ---------------- Backend status ---------------- */}
          {isAdmin && (
          <Card title="Data Storage">
            <div className="row mb-2" style={{ gap: 9 }}>
              <Database size={17} className="muted" />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>
                  {CONFIG.backend === 'local' ? 'Local browser storage' : 'Google Sheets'}
                </div>
                <div className="small muted">
                  {CONFIG.backend === 'local'
                    ? 'Data is stored in this browser only'
                    : 'Data is stored in your Google Sheet'}
                </div>
              </div>
              <Pill status={CONFIG.backend === 'local' ? 'partial' : 'paid'}
                    label={CONFIG.backend === 'local' ? 'Local' : 'Connected'} />
            </div>

            {CONFIG.backend === 'local' && (
              <div style={{
                padding: '11px 12px', background: 'var(--warning-bg)',
                border: '1px solid #FDE68A', borderRadius: 'var(--r-sm)',
                fontSize: 12.5, color: '#B45309', display: 'flex', gap: 8,
              }}>
                <AlertTriangle size={15} style={{ flex: 'none', marginTop: 1 }} />
                <span>
                  You are running on local browser storage. Data lives only in this browser
                  and is lost if you clear site data. To move to Google Sheets, follow
                  <strong> apps-script/SETUP.md</strong> and switch the backend
                  in <strong>src/lib/config.js</strong>.
                </span>
              </div>
            )}
          </Card>
          )}

          {/* ---------------- Security note ---------------- */}
          <Card title="Keeping Your Data Safe">
            <div className="col small" style={{ gap: 10 }}>
              <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                <ShieldCheck size={15} color="var(--success)" style={{ flex: 'none', marginTop: 1 }} />
                <span>Nothing is ever deleted. Bills are voided, payments reversed, parties archived — all recoverable and logged.</span>
              </div>
              <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                <ShieldCheck size={15} color="var(--success)" style={{ flex: 'none', marginTop: 1 }} />
                <span>Passwords are stored as one-way hashes. Even someone reading the raw data cannot recover them.</span>
              </div>
              {CONFIG.backend === 'sheets' && (
                <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                  <AlertTriangle size={15} color="var(--warning)" style={{ flex: 'none', marginTop: 1 }} />
                  <span>Your real data lives in your Google account. Turn on 2-Step Verification there — that is the real perimeter, not this login.</span>
                </div>
              )}
            </div>
          </Card>

          {/* ---------------- Danger zone ---------------- */}
          {isAdmin && CONFIG.backend === 'local' && (
            <Card title="Danger Zone">
              <p className="small muted" style={{ marginTop: 0 }}>
                Clears all local data and reloads with fresh demo data. Download a backup first
                if you want to keep anything.
              </p>
              <Button variant="danger" icon={Trash2} block onClick={() => setConfirmReset(true)}>
                Reset Local Data
              </Button>
            </Card>
          )}
        </div>
      </div>

      <Confirm
        open={confirmReset}
        title="Reset all local data?"
        message="Every party, item, bill, payment and log stored in this browser will be erased and replaced with fresh demo data. This cannot be undone. Download a backup first if you need this data."
        confirmLabel="Erase everything"
        danger
        onConfirm={doReset}
        onCancel={() => setConfirmReset(false)}
      />
    </>
  );
}
