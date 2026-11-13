// Page-level access control.
//
// A super admin ("admin" role) opens every page. Every other user sees only the
// pages the super admin ticked for them in User Management.
//
// This list is the single source of truth: the sidebar, the mobile "More" page,
// the route guard and the User Management checkboxes all read from it.
//
// NOTE: this controls what each person is shown in the app. It is not a data
// firewall — the backend still returns the shop's data to any signed-in user.
// The user-management actions themselves ARE enforced server-side (super admin
// only), in both apps-script/Code.gs and src/lib/localAdapter.js.

export const PAGE_GROUPS = [
  {
    label: 'Billing',
    pages: [
      { key: 'dashboard', label: 'Dashboard', to: '/' },
      { key: 'new-bill',  label: 'New Bill',  to: '/bill/new' },
      { key: 'bills',     label: 'All Bills', to: '/bills' },
      { key: 'returns',   label: 'Returns',   to: '/returns' },
    ],
  },
  {
    label: 'Parties & Ledger',
    pages: [
      { key: 'parties',     label: 'Parties',     to: '/parties' },
      { key: 'suppliers',   label: 'Suppliers',   to: '/suppliers' },
      { key: 'outstanding', label: 'Outstanding', to: '/outstanding' },
      { key: 'ledger-book', label: 'Ledger Book', to: '/ledger-book' },
    ],
  },
  {
    label: 'Money',
    pages: [
      { key: 'cheques',  label: 'Cheques',  to: '/cheques' },
      { key: 'accounts', label: 'Accounts', to: '/accounts' },
      { key: 'expenses', label: 'Expenses', to: '/expenses' },
      { key: 'assets',   label: 'Assets',   to: '/assets' },
    ],
  },
  {
    label: 'Stock & Team',
    pages: [
      { key: 'items',      label: 'Items',         to: '/items' },
      { key: 'purchases',  label: 'Purchases',     to: '/purchases' },
      { key: 'stock-loss', label: 'Damaged Stock', to: '/stock-loss' },
      { key: 'employees',  label: 'Employees',     to: '/employees' },
    ],
  },
  {
    label: 'Reports',
    pages: [
      { key: 'profit',        label: 'Profit Report', to: '/profit' },
      { key: 'balance-sheet', label: 'Balance Sheet', to: '/balance-sheet' },
      { key: 'audit',         label: 'Audit Summary', to: '/audit' },
      { key: 'activity',      label: 'Activity Log',  to: '/activity' },
    ],
  },
  {
    label: 'System',
    pages: [
      { key: 'settings', label: 'Settings', to: '/settings' },
    ],
  },
];

export const ALL_PAGES = PAGE_GROUPS.flatMap((g) => g.pages);
export const ALL_PAGE_KEYS = ALL_PAGES.map((p) => p.key);

/**
 * Route -> page key (or a list of keys, any one of which is enough).
 *
 * Detail pages belong to the page they hang off, but they are also opened from
 * other pages: a bill from a party ledger, an outstanding list, a cheque or the
 * dashboard; a party ledger from Outstanding or the Ledger Book. A detail page
 * therefore opens for anyone who has a page that links to it — otherwise a
 * click inside a page the user IS allowed to see ends at "no access".
 * Order matters.
 */
const ROUTE_RULES = [
  [/^\/$/,                    'dashboard'],
  [/^\/bill\/new(\/|$)/,      'new-bill'],
  [/^\/bill\/[^/]+\/edit$/,   'new-bill'],
  [/^\/bills$/,               'bills'],
  [/^\/bill\/[^/]+$/,         ['bills', 'parties', 'outstanding', 'cheques', 'dashboard', 'ledger-book', 'new-bill']],
  [/^\/returns(\/|$)/,        'returns'],
  [/^\/parties$/,             'parties'],
  [/^\/party\/[^/]+$/,        ['parties', 'outstanding', 'dashboard', 'ledger-book', 'bills', 'cheques']],
  [/^\/suppliers$/,           'suppliers'],
  [/^\/supplier\/[^/]+$/,     ['suppliers', 'purchases']],
  [/^\/purchase\/[^/]+$/,     ['purchases', 'suppliers']],
  [/^\/outstanding(\/|$)/,    'outstanding'],
  [/^\/ledger-book(\/|$)/,    'ledger-book'],
  [/^\/cheques(\/|$)/,        'cheques'],
  [/^\/accounts?(\/|$)/,      'accounts'],
  [/^\/expenses(\/|$)/,       'expenses'],
  [/^\/assets(\/|$)/,         'assets'],
  [/^\/items(\/|$)/,          'items'],
  [/^\/sold-out(\/|$)/,       'items'],   // same permission as Items
  [/^\/purchases?(\/|$)/,     'purchases'],
  [/^\/stock-loss(\/|$)/,     'stock-loss'],
  [/^\/employees?(\/|$)/,     'employees'],
  [/^\/profit(\/|$)/,         'profit'],
  [/^\/balance-sheet(\/|$)/,  'balance-sheet'],
  [/^\/audit(\/|$)/,          'audit'],
  [/^\/activity(\/|$)/,       'activity'],
  [/^\/settings(\/|$)/,       'settings'],
  [/^\/users(\/|$)/,          '__super_admin'],
];

/** The page key a path belongs to; null for routes everyone may open (e.g. /more). */
export function pageKeyForPath(pathname) {
  const p = String(pathname || '/').replace(/\/+$/, '') || '/';
  for (const [re, key] of ROUTE_RULES) if (re.test(p)) return key;
  return null;
}

/** Super admin = the original "admin" role (and "superadmin", for clarity). */
export function isSuperAdmin(user) {
  return user?.role === 'admin' || user?.role === 'superadmin';
}

/** May this user open the page with this key (or any one of a list of keys)? */
export function hasPage(user, key) {
  if (!user) return false;
  if (isSuperAdmin(user)) return true;
  if (Array.isArray(key)) return key.some((k) => hasPage(user, k));
  if (key === '__super_admin') return false;
  return Array.isArray(user.allowedPages) && user.allowedPages.includes(key);
}

/** May this user open this URL path? */
export function canAccessPath(user, pathname) {
  const key = pageKeyForPath(pathname);
  if (key === null) return Boolean(user);
  return hasPage(user, key);
}

/** The first page this user may open, in sidebar order — their landing page. */
export function firstAllowedPath(user) {
  const hit = ALL_PAGES.find((p) => hasPage(user, p.key));
  if (hit) return hit.to;
  return isSuperAdmin(user) ? '/' : null;
}
