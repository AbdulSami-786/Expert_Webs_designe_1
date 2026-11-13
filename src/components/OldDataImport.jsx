// Settings card: bring the shop's old Excel records into the app, and check that nothing is missing.
// The file (oldData.json) stays on this computer — it is chosen here, never bundled with the app.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Upload, CheckCircle2, AlertTriangle, XCircle, ChevronDown, ChevronRight } from 'lucide-react';
import { useApp } from '../context/AppContext';
import api from '../lib/api';
import { Card, Button, Confirm } from './ui';
import { money } from '../lib/format';
import { importOldData, planOldData, checkOldData, parseOldData } from '../lib/importOldData';

const OK = <CheckCircle2 size={15} color="var(--success)" aria-label="matches" />;
const WARN = <AlertTriangle size={15} color="#B45309" aria-label="differs" />;
const BAD = <XCircle size={15} color="var(--danger)" aria-label="missing" />;

export default function OldDataImport() {
  const { data, settings, toast, refresh } = useApp();
  const [oldData, setOldData] = useState(null);
  const [fileName, setFileName] = useState('');
  const [importing, setImporting] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [showCheck, setShowCheck] = useState(true);
  const [pick, setPick] = useState({ expenses: true, salaries: true, assets: true });

  /* Is the backend new enough? The import moves purchases with the 'adoptPurchases' action. A Google
     Sheet script from before that action existed answers "Unknown action" — and importing against it
     would stop at the first supplier and leave it empty. So ask first, with a call that can never write
     (no supplier is named, so any backend that knows the action refuses it straight away). */
  const [backend, setBackend] = useState({ state: 'checking', msg: '' });
  const checkBackend = useCallback(async () => {
    setBackend({ state: 'checking', msg: '' });
    try {
      await api.adoptPurchases({});
      setBackend({ state: 'ok', msg: '' });
    } catch (err) {
      const msg = String(err?.message || err);
      if (/unknown action/i.test(msg)) setBackend({ state: 'old', msg });
      else if (err?.isNetworkError) setBackend({ state: 'offline', msg });
      else setBackend({ state: 'ok', msg });        // any other refusal means the action exists
    }
  }, []);
  useEffect(() => { checkBackend(); }, [checkBackend]);

  // Both are worked out from the data as it is right now, so they update after an import.
  const plan = useMemo(() => (oldData ? planOldData({ data, oldData }) : null), [oldData, data]);
  const check = useMemo(() => (oldData ? checkOldData({ data, oldData }) : null), [oldData, data]);
  const sum = plan?.summary;

  const choose = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      setOldData(parseOldData(await file.text()));
      setFileName(file.name);
    } catch (err) { setOldData(null); setFileName(''); toast(err.message, 'error'); }
  };

  const run = async () => {
    setConfirm(false);
    setImporting('Starting…');
    // Only the ticked shop records are brought in.
    const trimmed = {
      ...oldData,
      extras: {
        ...oldData.extras,
        expenses: pick.expenses ? oldData.extras?.expenses : [],
        salaries: pick.salaries ? oldData.extras?.salaries : [],
        assets: pick.assets ? oldData.extras?.assets : [],
      },
    };
    try {
      const res = await importOldData({ api, data, settings, oldData: trimmed, onStep: setImporting });
      await refresh();
      toast(`Imported: ${res.suppliers} new suppliers, ${res.moved} purchase rows moved in, ${res.items} new items, `
        + `${res.sales} old-sales bills, ${res.expenses} expenses, ${res.salaries} salaries, ${res.assets} assets`
        + (res.skipped.length ? `. Already there, skipped: ${res.skipped.join(', ')}` : ''), 'success');
    } catch (err) {
      await refresh().catch(() => {});
      toast(`Import stopped: ${err.message || err}. What was added so far is kept; run it again to finish (nothing is duplicated).`, 'error');
    } finally { setImporting(''); }
  };

  const goodSuppliers = check ? check.suppliers.filter((s) => s.ok).length : 0;
  const goodCustomers = check ? check.customers.filter((c) => c.ok).length : 0;

  return (
    <>
      <Card title="Import Old Data & Data Check"
            subtitle="Suppliers, purchases, sales, shop expenses, salaries and assets from your Excel (8 NOV) — and a check that nothing is missing">
        <p className="small muted" style={{ marginTop: 0 }}>
          Choose <strong>oldData.json</strong> from your private &ldquo;old data&rdquo; folder.
          The file stays on this computer; it is not part of the app.
        </p>
        <input type="file" accept=".json,application/json" onChange={choose}
               disabled={Boolean(importing)} style={{ marginBottom: 10 }} />
        {fileName && <div className="small muted" style={{ marginBottom: 8 }}>Using {fileName}</div>}

        {backend.state === 'old' && (
          <div style={{
            padding: '11px 13px', marginBottom: 12, background: 'var(--danger-bg)',
            border: '1px solid #FECACA', borderRadius: 'var(--r-sm)', fontSize: 13, color: '#991B1B',
          }}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>Your Google Sheet script is out of date — update it first</div>
            <div>The import cannot run until the Sheet&rsquo;s script knows the new &ldquo;move purchases&rdquo; step.
              Running it now would leave your suppliers empty. One-time fix:</div>
            <ol style={{ margin: '6px 0 6px', paddingLeft: 20, lineHeight: 1.6 }}>
              <li>Open your Google Sheet → <strong>Extensions → Apps Script</strong>.</li>
              <li>Select everything in <strong>Code.gs</strong> and replace it with the file
                <strong> apps-script/Code.gs</strong> from this project. Save.</li>
              <li><strong>Deploy → Manage deployments → pencil (edit) → Version: New version → Deploy.</strong>
                The link stays the same.</li>
              <li>Come back here and press <strong>Check again</strong>.</li>
            </ol>
            <Button size="sm" onClick={checkBackend}>Check again</Button>
          </div>
        )}
        {backend.state === 'offline' && (
          <div className="small" style={{ marginBottom: 12, color: '#B45309' }}>
            Could not reach the Google Sheet to check it. Check your internet, then{' '}
            <button type="button" className="btn btn-ghost btn-sm" onClick={checkBackend}>try again</button>.
          </div>
        )}

        {plan && (
          <>
            <div className="small" style={{ marginBottom: 10, lineHeight: 1.55 }}>
              <strong>{sum.suppliers}</strong> suppliers{sum.newSuppliers ? ` (${sum.newSuppliers} new)` : ''}.
              Their purchase bills will hold:
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                <li><strong>{sum.moved}</strong> purchase rows already on your Purchases page, moved in as they are
                  — stock does not change</li>
                {sum.added > 0 && (
                  <li><strong>{sum.added}</strong> extra lines the sheet says were bought ({money(sum.addedValue)})</li>
                )}
                {sum.newItems > 0 && <li><strong>{sum.newItems}</strong> items not in the app yet, created</li>}
                <li><strong>{sum.sales}</strong> sold lines ({money(sum.soldValue)}), added as &ldquo;Old Data Sales&rdquo;
                  bills dated {sum.asOf}, each from its supplier&rsquo;s stock</li>
                {sum.payments > 0 && (
                  <li><strong>{sum.payments}</strong> supplier payments from the sheet ({money(sum.paid)})</li>
                )}
              </ul>
            </div>

            <div className="small" style={{ marginBottom: 10 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Shop records not in the app yet</div>
              {[
                ['expenses', `${sum.expenses} shop expenses (${money(sum.expenseTotal)}) — internet, fuel, maintenance, food…`, sum.expenses],
                ['salaries', `${sum.salaries} salary payments (${money(sum.salaryTotal)})${sum.newEmployees ? `, ${sum.newEmployees} new employees` : ''}`, sum.salaries],
                ['assets', `${sum.assets} assets (${money(sum.assetTotal)}) — shop renovation, bike`, sum.assets],
              ].map(([k, label, n]) => (
                <label key={k} className="row" style={{ gap: 8, padding: '3px 0', opacity: n ? 1 : 0.55 }}>
                  <input type="checkbox" checked={pick[k] && n > 0} disabled={!n}
                         onChange={(e) => setPick((p) => ({ ...p, [k]: e.target.checked }))} />
                  <span>{n ? label : `${k[0].toUpperCase()}${k.slice(1)}: nothing missing`}</span>
                </label>
              ))}
            </div>

            <div className="small muted" style={{ marginBottom: 10 }}>
              Cash and bank balances are not touched (everything is recorded under &ldquo;Old Data&rdquo;).
              Running it twice does not duplicate anything.
            </div>

            {plan.warnings.length > 0 && (
              <div style={{
                padding: '9px 11px', marginBottom: 10, background: 'var(--warning-bg)',
                border: '1px solid #FDE68A', borderRadius: 'var(--r-sm)', fontSize: 12.5, color: '#B45309',
              }}>
                {plan.warnings.slice(0, 4).map((w) => <div key={w}>• {w}</div>)}
                {plan.warnings.length > 4 && <div>• and {plan.warnings.length - 4} more</div>}
              </div>
            )}

            <Button icon={Upload} block loading={Boolean(importing)}
                    disabled={backend.state === 'old' || backend.state === 'checking'}
                    onClick={() => setConfirm(true)}>
              {importing || (backend.state === 'old' ? 'Update the Google Sheet script first' : 'Import Old Data')}
            </Button>
          </>
        )}
      </Card>

      {check && (
        <Card title="Data check — sheet vs your software"
              subtitle={`${goodSuppliers} of ${check.suppliers.length} suppliers match · ${check.items.missing.length} items missing · `
                + `${goodCustomers} of ${check.customers.length} installment customers match`}
              actions={<Button size="sm" onClick={() => setShowCheck((v) => !v)}
                               icon={showCheck ? ChevronDown : ChevronRight}>{showCheck ? 'Hide' : 'Show'}</Button>}>
          {showCheck && (
            <>
              <div className="small" style={{ fontWeight: 600, margin: '0 0 4px' }}>Suppliers — bought / sold / available</div>
              <div className="table-wrap">
                <table className="tbl">
                  <thead>
                    <tr><th></th><th>Supplier</th><th className="r">Sheet</th><th className="r">Software now</th></tr>
                  </thead>
                  <tbody>
                    {check.suppliers.map((s) => (
                      <tr key={s.name}>
                        <td style={{ width: 28 }}>{s.ok ? OK : s.app ? WARN : BAD}</td>
                        <td>{s.name}{!s.app && <div className="small muted">not in the software yet</div>}</td>
                        <td className="r small num">{s.sheet.bought} / {s.sheet.sold} / {s.sheet.available}</td>
                        <td className="r small num">
                          {s.app ? `${s.app.bought} / ${s.app.sold} / ${s.app.available}` : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="small" style={{ fontWeight: 600, margin: '14px 0 4px' }}>Items and shop records</div>
              <table className="tbl">
                <tbody>
                  <tr>
                    <td style={{ width: 28 }}>{check.items.missing.length ? BAD : OK}</td>
                    <td>Items on the sheet: {check.items.sheet}</td>
                    <td className="r small">
                      {check.items.missing.length
                        ? `${check.items.missing.length} not in the software: ${check.items.missing.slice(0, 4).join(', ')}${check.items.missing.length > 4 ? '…' : ''}`
                        : 'all present'}
                    </td>
                  </tr>
                  {[['Shop expenses', check.records.expenses], ['Salary payments', check.records.salaries],
                    ['Assets', check.records.assets]].map(([label, r]) => (
                    <tr key={label}>
                      <td>{r.missing ? WARN : OK}</td>
                      <td>{label}: {r.sheet} on the sheet</td>
                      <td className="r small">{r.missing ? `${r.missing} not in the software yet` : 'all present'}</td>
                    </tr>
                  ))}
                  <tr>
                    <td>{OK}</td>
                    <td>Sales cross-check</td>
                    <td className="r small">
                      daily-sales sheet {money(check.salesCross.dailySheet)} · item-wise sold {money(check.salesCross.itemSold)}
                    </td>
                  </tr>
                </tbody>
              </table>

              <div className="small" style={{ fontWeight: 600, margin: '14px 0 4px' }}>
                Installment customers — what they still owe
              </div>
              <div className="small muted" style={{ marginBottom: 6 }}>
                Checked only, not imported: their phones are already counted as sold, so importing them as bills would
                sell the same phone twice. Add a missing customer&rsquo;s balance from New Bill when you are ready.
              </div>
              <div className="table-wrap">
                <table className="tbl">
                  <thead>
                    <tr><th></th><th>Customer</th><th>Item</th><th className="r">Total</th>
                        <th className="r">Sheet owes</th><th className="r">Software owes</th></tr>
                  </thead>
                  <tbody>
                    {check.customers.map((c, i) => (
                      <tr key={`${c.name}-${i}`}>
                        <td style={{ width: 28 }}>{c.ok ? OK : c.found ? WARN : BAD}</td>
                        <td>{c.name}{!c.found && <div className="small muted">no party with this name</div>}</td>
                        <td className="small">{c.item}</td>
                        <td className="r">{money(c.total)}</td>
                        <td className="r">{money(c.left)}</td>
                        <td className="r">{c.found ? money(c.appLeft) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {check.notes.length > 0 && (
                <div className="small muted" style={{ marginTop: 12 }}>
                  <div style={{ fontWeight: 600 }}>Left out of the import on purpose</div>
                  {check.notes.map((n) => <div key={n}>• {n}</div>)}
                </div>
              )}
            </>
          )}
        </Card>
      )}

      <Confirm
        open={confirm}
        title="Import old Excel data?"
        message={`This moves ${sum?.moved ?? 0} existing purchase rows into ${sum?.suppliers ?? 0} suppliers, adds the sold quantities and the ticked shop records. Download a backup first if you want a restore point.`}
        confirmLabel="Import"
        onConfirm={run}
        onCancel={() => setConfirm(false)}
      />
    </>
  );
}
