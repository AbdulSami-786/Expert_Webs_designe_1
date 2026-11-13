// App shell.
//
// Desktop: persistent dark sidebar grouped by module + top bar with date filter
//          and an always-available New Bill button (Design Brief 3.1).
// Mobile:  no sidebar. Bottom tab bar with 5 destinations + floating New Bill
//          action button reachable from any screen (Design Brief 4.1).

import { useMemo, useState } from 'react';
import { NavLink, useNavigate, useLocation, Outlet, Navigate } from 'react-router-dom';
import {
  LayoutDashboard, FilePlus2, Users, BookUser, AlertCircle, Package,
  RotateCcw, Receipt, Wallet, Landmark, BookOpen, Scale, TrendingUp,
  ClipboardList, UserCog, CreditCard, Boxes, ShoppingCart, Building2,
  Settings as SettingsIcon, LogOut, Download, CalendarCheck, Plus,
  MoreHorizontal, WifiOff, RefreshCw, ScrollText, Truck, ShieldCheck, Lock,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { Toasts, Button, Skeleton, Empty } from '../ui';
import { canAccessPath, firstAllowedPath } from '../../lib/access';
import { deriveBills, partyDue } from '../../lib/calc';
import CloseTodayModal from '../CloseTodayModal';
import { downloadBackup } from '../../lib/exporters';

/* Navigation grouped by module — grouping matters past ~15 pages */
const NAV = [
  {
    label: 'Billing',
    items: [
      { to: '/',           icon: LayoutDashboard, label: 'Dashboard', end: true },
      { to: '/bill/new',   icon: FilePlus2,       label: 'New Bill' },
      { to: '/bills',      icon: Receipt,         label: 'All Bills' },
      { to: '/returns',    icon: RotateCcw,       label: 'Returns' },
    ],
  },
  {
    label: 'Parties & Ledger',
    items: [
      { to: '/parties',    icon: Users,        label: 'Parties' },
      { to: '/suppliers',  icon: Truck,        label: 'Suppliers' },
      { to: '/outstanding',icon: AlertCircle,  label: 'Outstanding', badge: 'due' },
      { to: '/ledger-book',icon: BookOpen,     label: 'Ledger Book' },
    ],
  },
  {
    label: 'Money',
    items: [
      { to: '/cheques',    icon: CreditCard, label: 'Cheques' },
      { to: '/accounts',   icon: Landmark,   label: 'Accounts' },
      { to: '/expenses',   icon: Wallet,     label: 'Expenses' },
      { to: '/assets',     icon: Building2,  label: 'Assets' },
    ],
  },
  {
    label: 'Stock & Team',
    items: [
      { to: '/items',      icon: Package,      label: 'Items' },
      { to: '/purchases',  icon: ShoppingCart, label: 'Purchases' },
      { to: '/stock-loss', icon: Boxes,        label: 'Damaged Stock' },
      { to: '/employees',  icon: UserCog,      label: 'Employees' },
    ],
  },
  {
    label: 'Reports',
    items: [
      { to: '/profit',        icon: TrendingUp,    label: 'Profit Report' },
      { to: '/balance-sheet', icon: Scale,         label: 'Balance Sheet' },
      { to: '/audit',         icon: ClipboardList, label: 'Audit Summary' },
      { to: '/activity',      icon: ScrollText,    label: 'Activity Log' },
    ],
  },
  {
    label: 'System',
    items: [
      { to: '/settings',   icon: SettingsIcon, label: 'Settings' },
      { to: '/users',      icon: ShieldCheck,  label: 'User Management' },   // super admin only
    ],
  },
];

/* Mobile bottom tabs — 5 core destinations, everything else under More */
const TABS = [
  { to: '/',            icon: LayoutDashboard, label: 'Home', end: true },
  { to: '/parties',     icon: Users,           label: 'Parties' },
  { to: '/bill/new',    icon: Plus,            label: 'New Bill', primary: true },
  { to: '/outstanding', icon: AlertCircle,     label: 'Outstanding' },
  { to: '/more',        icon: MoreHorizontal,  label: 'More' },
];

export default function Shell() {
  const { session, me, isAdmin, can, logout, data, settings, online, pending, toasts, toast, loading, booted } = useApp();
  const nav = useNavigate();
  const loc = useLocation();
  const [closeToday, setCloseToday] = useState(false);

  // Count of parties currently owing — drives the sidebar badge
  const dueCount = useMemo(() => {
    const derived = deriveBills(data.bills, data);
    return data.parties.filter((p) => partyDue(p.id, derived) > 0).length;
  }, [data]);

  const onBackup = async () => {
    try {
      downloadBackup(data, settings.shopName);
      toast('Backup downloaded', 'success');
    } catch (e) {
      toast('Backup failed', 'error');
    }
  };

  // Only what this person may open. Routes with no page key (e.g. /more) are open to all.
  const allowedNav = useMemo(() => NAV
    .map((g) => ({ ...g, items: g.items.filter((i) => canAccessPath(me, i.to)) }))
    .filter((g) => g.items.length), [me]);
  const allowedTabs = TABS.filter((t) => canAccessPath(me, t.to));

  // Route guard: a page the super admin has not ticked for this user is never
  // rendered, even if they type its address.
  let guarded = <Outlet />;
  if (!canAccessPath(me, loc.pathname)) {
    const landing = firstAllowedPath(me);
    guarded = (landing && loc.pathname === '/')
      ? <Navigate to={landing} replace />
      : (
        <Empty icon={Lock} title="You do not have access to this page"
               message={landing
                 ? 'Ask the super admin if you need it.'
                 : 'No pages have been assigned to your account yet. Ask the super admin.'}
               action={landing
                 ? <Button variant="primary" onClick={() => nav(landing)}>Go to my home page</Button>
                 : <Button onClick={logout}>Sign out</Button>} />
      );
  }

  const pageTitle = useMemo(() => {
    for (const g of NAV) {
      const hit = g.items.find((i) => i.end ? loc.pathname === i.to : loc.pathname.startsWith(i.to));
      if (hit) return hit.label;
    }
    if (loc.pathname.startsWith('/party/')) return 'Party Ledger';
    if (loc.pathname.startsWith('/bill/'))  return 'Bill';
    if (loc.pathname === '/more')           return 'More';
    return settings.shopName;
  }, [loc.pathname, settings.shopName]);

  return (
    <div className="app">
      {/* ---------------- Desktop sidebar ---------------- */}
      <aside className="sidebar">
        <div className="sidebar-brand">
          <img className="logo" src={`${import.meta.env.BASE_URL}brand/logo-mark.svg`} alt="" />
          <span style={{ minWidth: 0 }}>
            {settings.shopName || 'Expert Webs Designs'}
            <small>Business Dashboard</small>
          </span>
        </div>

        <nav style={{ flex: 1, paddingBottom: 12 }}>
          {allowedNav.map((group) => (
            <div className="nav-group" key={group.label}>
              <div className="nav-group-label">{group.label}</div>
              {group.items.map((it) => (
                <NavLink key={it.to} to={it.to} end={it.end}
                         className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
                  <it.icon size={16} />
                  {it.label}
                  {it.badge === 'due' && dueCount > 0 && <span className="nav-badge">{dueCount}</span>}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div style={{ padding: 12, borderTop: '1px solid rgba(255,255,255,.08)' }}>
          <button className="nav-item" style={{ width: '100%' }} onClick={logout}>
            <LogOut size={16} /> Sign out
            <span className="spacer" />
            <span style={{ fontSize: 11, color: '#64748B' }}>{me?.username || session?.username}</span>
          </button>
        </div>
      </aside>

      {/* ---------------- Main column ---------------- */}
      <div className="main">
        {/* Desktop top bar */}
        <header className="topbar">
          <div className="shop">
            {settings.shopName}
            <small>{settings.phone || 'Wholesale Management'}</small>
          </div>
          <div className="spacer" />

          {!online && (
            <span className="sync-chip offline"><WifiOff size={13} /> Offline</span>
          )}
          {pending > 0 && (
            <span className="sync-chip"><RefreshCw size={13} /> {pending} pending sync</span>
          )}

          <Button icon={CalendarCheck} onClick={() => setCloseToday(true)}>Close Today</Button>
          {isAdmin && <Button icon={Download} onClick={onBackup}>Backup</Button>}
          {can('new-bill') && (
            <Button variant="primary" icon={FilePlus2} onClick={() => nav('/bill/new')}>New Bill</Button>
          )}
        </header>

        {/* Mobile top bar */}
        <header className="mobile-topbar">
          <img className="logo" src={`${import.meta.env.BASE_URL}brand/logo-mark.svg`} alt="" style={{ height: 18, width: 'auto', flex: 'none' }} />
          <span className="title">{pageTitle}</span>
          {!online && <span className="sync-chip offline"><WifiOff size={12} /></span>}
          {pending > 0 && <span className="sync-chip"><RefreshCw size={12} /> {pending}</span>}
        </header>

        <main className="page">
          {/* Skeleton only while the first load is in flight. `booted` stays
              true for later refreshes, so saving a record does not blank the
              page the user is looking at. */}
          {loading && !booted ? <Skeleton rows={6} /> : guarded}
        </main>
      </div>

      {/* ---------------- Mobile chrome ---------------- */}
      {can('new-bill') && (
        <button className="fab" onClick={() => nav('/bill/new')} aria-label="New Bill">
          <Plus size={25} />
        </button>
      )}

      <nav className="tabbar">
        {allowedTabs.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end}
                   className={({ isActive }) => (isActive ? 'active' : '')}>
            <t.icon size={20} />
            {t.label}
          </NavLink>
        ))}
      </nav>

      <CloseTodayModal open={closeToday} onClose={() => setCloseToday(false)} />
      <Toasts toasts={toasts} />
    </div>
  );
}
