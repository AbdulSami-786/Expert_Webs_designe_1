// Accounts (FR-40 / Plan 7.9) — one row per payment method with a running
// current balance. Pending cheques stay out until cleared.

import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Landmark, ChevronRight, Download, Wallet, AlertTriangle } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { Card, Button, Empty, PageHead, Money, Stat } from '../components/ui';
import { accountBalances } from '../lib/calc';
import { money, r2 } from '../lib/format';
import { exportExcel } from '../lib/exporters';

export default function Accounts() {
  const { data, settings, methods, toast } = useApp();
  const nav = useNavigate();

  const balances = useMemo(() => accountBalances(methods, data), [methods, data]);

  const totals = useMemo(() => ({
    balance: r2(balances.reduce((s, b) => s + b.balance, 0)),
    in: r2(balances.reduce((s, b) => s + b.in, 0)),
    out: r2(balances.reduce((s, b) => s + b.out, 0)),
  }), [balances]);

  // Money sitting in cheques that have not cleared yet
  const pendingCheques = useMemo(
    () => r2(data.cheques.filter((c) => c.status === 'pending')
      .reduce((s, c) => s + (Number(c.amount) || 0), 0)),
    [data.cheques]
  );

  const onExcel = () => {
    exportExcel('Accounts',
      ['Method', 'Money In', 'Money Out', 'Current Balance'],
      balances.map((b) => [b.method, b.in.toFixed(2), b.out.toFixed(2), b.balance.toFixed(2)]),
      [`${settings.shopName} — Account Balances`, `Total: ${money(totals.balance)}`]);
    toast('Account balances exported');
  };

  return (
    <>
      <PageHead title="Accounts"
                subtitle="Running balance per payment method — click any row for its full statement">
        <Button icon={Download} onClick={onExcel}>Excel</Button>
      </PageHead>

      <div className="stat-grid">
        <Stat label="Total Cash in Hand" value={money(totals.balance)} icon={Wallet} tone="#16A34A" />
        <Stat label="Total Money In" value={money(totals.in)} icon={Landmark} tone="#D9390B" />
        <Stat label="Total Money Out" value={money(totals.out)} icon={Landmark} tone="#DC2626" />
      </div>

      {pendingCheques > 0 && (
        <div style={{
          padding: '10px 13px', background: 'var(--warning-bg)', border: '1px solid #FDE68A',
          borderRadius: 'var(--r)', marginBottom: 16, fontSize: 13, color: '#B45309',
          display: 'flex', gap: 8, alignItems: 'center',
        }}>
          <AlertTriangle size={15} style={{ flex: 'none' }} />
          <span>
            A further <strong>{money(pendingCheques)}</strong> is held in cheques awaiting
            clearance. It is deliberately excluded from these balances until cleared.
          </span>
        </div>
      )}

      <Card tight>
        <div className="table-wrap hide-mobile">
          <table className="tbl">
            <thead>
              <tr>
                <th>Payment method</th>
                <th className="r">Money in</th>
                <th className="r">Money out</th>
                <th className="r">Current balance</th>
                <th style={{ width: 50 }}></th>
              </tr>
            </thead>
            <tbody>
              {balances.map((b) => (
                <tr key={b.method} className="clickable"
                    onClick={() => nav(`/account/${encodeURIComponent(b.method)}`)}>
                  <td style={{ fontWeight: 600 }}>{b.method}</td>
                  <td className="r"><span className="money pos">{money(b.in)}</span></td>
                  <td className="r"><span className="money neg">{money(b.out)}</span></td>
                  <td className="r strong">
                    <span className="money" style={{ fontSize: 15, color: b.balance < 0 ? 'var(--danger)' : undefined }}>
                      {money(b.balance)}
                    </span>
                  </td>
                  <td><ChevronRight size={15} className="muted" /></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Total</td>
                <td className="r">{money(totals.in)}</td>
                <td className="r">{money(totals.out)}</td>
                <td className="r" style={{ fontSize: 15 }}>{money(totals.balance)}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>

        <div className="mcards" style={{ padding: 12 }}>
          {balances.map((b) => (
            <div key={b.method} className="mcard"
                 onClick={() => nav(`/account/${encodeURIComponent(b.method)}`)}>
              <div className="top">
                <span className="name">{b.method}</span>
                <span className="amt" style={{ color: b.balance < 0 ? 'var(--danger)' : 'var(--success)' }}>
                  {money(b.balance)}
                </span>
              </div>
              <div className="meta">
                <span style={{ color: 'var(--success)' }}>In {money(b.in)}</span>
                <span style={{ color: 'var(--danger)' }}>Out {money(b.out)}</span>
                <span className="spacer" />
                <ChevronRight size={15} className="muted" />
              </div>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
