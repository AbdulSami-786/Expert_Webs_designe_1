// Mobile "More" — everything not in the bottom tab bar (Design Brief 4.1).
// Desktop users reach these from the sidebar, so this page is mobile-oriented.

import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Receipt, RotateCcw, Package, ShoppingCart, Boxes, UserCog, Wallet,
  Building2, CreditCard, Landmark, BookOpen, Scale, TrendingUp, ClipboardList,
  ScrollText, Settings as SettingsIcon, LogOut, Download, CalendarCheck,
  ChevronRight, BookUser, Truck, ShieldCheck,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import { canAccessPath } from '../lib/access';
import { Card, PageHead, Button } from '../components/ui';
import { downloadBackup } from '../lib/exporters';
import CloseTodayModal from '../components/CloseTodayModal';
import { useState } from 'react';

const GROUPS = [
  {
    label: 'Billing',
    items: [
      { to: '/bills',   icon: Receipt,  label: 'All Bills',  desc: 'Search every bill' },
      { to: '/returns', icon: RotateCcw, label: 'Returns',   desc: 'Returns against bills' },
    ],
  },
  {
    label: 'Buying',
    items: [
      { to: '/suppliers', icon: Truck, label: 'Suppliers', desc: 'Parties you buy from — khata, payments, advances' },
    ],
  },
  {
    label: 'Money',
    items: [
      { to: '/cheques',  icon: CreditCard, label: 'Cheques',  desc: 'Pending, cleared, bounced' },
      { to: '/accounts', icon: Landmark,   label: 'Accounts', desc: 'Balance per payment method' },
      { to: '/expenses', icon: Wallet,     label: 'Expenses', desc: 'Running costs' },
      { to: '/assets',   icon: Building2,  label: 'Assets',   desc: 'Business assets' },
    ],
  },
  {
    label: 'Stock & Team',
    items: [
      { to: '/items',      icon: Package,      label: 'Items',         desc: 'Products and stock' },
      { to: '/purchases',  icon: ShoppingCart, label: 'Purchases',     desc: 'Stock from suppliers' },
      { to: '/stock-loss', icon: Boxes,        label: 'Damaged Stock', desc: 'Damaged or expired' },
      { to: '/employees',  icon: UserCog,      label: 'Employees',     desc: 'Salaries and advances' },
    ],
  },
  {
    label: 'Reports',
    items: [
      { to: '/profit',        icon: TrendingUp,    label: 'Profit Report',  desc: 'By item, party, day' },
      { to: '/ledger-book',   icon: BookOpen,      label: 'Ledger Book',    desc: 'Debit/credit khata' },
      { to: '/balance-sheet', icon: Scale,         label: 'Balance Sheet',  desc: 'Owns vs owes' },
      { to: '/audit',         icon: ClipboardList, label: 'Audit Summary',  desc: 'Financial health check' },
      { to: '/activity',      icon: ScrollText,    label: 'Activity Log',   desc: 'Every change recorded' },
    ],
  },
  {
    label: 'System',
    items: [
      { to: '/settings', icon: SettingsIcon, label: 'Settings', desc: 'Shop, rules, password' },
      { to: '/users',    icon: ShieldCheck,  label: 'User Management', desc: 'Add users, passwords, page access' },
    ],
  },
];

export default function More() {
  const nav = useNavigate();
  const { data, settings, session, me, isAdmin, logout, toast } = useApp();
  const [closeToday, setCloseToday] = useState(false);

  // Only the pages this user may open (User Management is super-admin only).
  const groups = GROUPS
    .map((g) => ({ ...g, items: g.items.filter((it) => canAccessPath(me, it.to)) }))
    .filter((g) => g.items.length);

  return (
    <>
      <PageHead title="More" subtitle={settings.shopName} />

      {/* Quick actions */}
      <div className="row mb-2" style={{ gap: 8 }}>
        <Button icon={CalendarCheck} style={{ flex: 1 }} onClick={() => setCloseToday(true)}>
          Close Today
        </Button>
        {isAdmin && (
          <Button icon={Download} style={{ flex: 1 }}
                  onClick={() => { downloadBackup(data, settings.shopName); toast('Backup downloaded'); }}>
            Backup
          </Button>
        )}
      </div>

      <div className="col" style={{ gap: 14 }}>
        {groups.map((g) => (
          <Card key={g.label} title={g.label} tight>
            {g.items.map((it) => (
              <button key={it.to} className="alert-row"
                      style={{ width: '100%', background: 'none', border: 0, textAlign: 'left', cursor: 'pointer' }}
                      onClick={() => nav(it.to)}>
                <span className="ico info"><it.icon size={16} /></span>
                <div className="body">
                  <div className="t">{it.label}</div>
                  <div className="s">{it.desc}</div>
                </div>
                <ChevronRight size={17} className="muted" />
              </button>
            ))}
          </Card>
        ))}

        <Card tight>
          <button className="alert-row"
                  style={{ width: '100%', background: 'none', border: 0, textAlign: 'left', cursor: 'pointer' }}
                  onClick={logout}>
            <span className="ico danger"><LogOut size={16} /></span>
            <div className="body">
              <div className="t">Sign out</div>
              <div className="s">Signed in as {me?.username || session?.username}</div>
            </div>
            <ChevronRight size={17} className="muted" />
          </button>
        </Card>
      </div>

      <CloseTodayModal open={closeToday} onClose={() => setCloseToday(false)} />
    </>
  );
}
