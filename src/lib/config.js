// ============================================================================
// App configuration
// ============================================================================
//
// backend: 'local'  — runs entirely in the browser (localStorage), no setup.
//                     Use this to explore/demo the dashboard immediately.
//
//          'sheets' — talks to your deployed Google Apps Script Web App,
//                     which reads/writes your Google Sheet (the real database
//                     described in the PRD).
//
// TO GO LIVE ON GOOGLE SHEETS:
//   1. Follow apps-script/SETUP.md (creates the Sheet + deploys the Web App).
//   2. Paste the deployment URL into appsScriptUrl below.
//   3. Change backend to 'sheets'.
//
// Nothing else in the app changes — every screen calls the same api methods.
// ============================================================================

// True inside the Windows desktop app (Electron), false in a normal browser.
export const IS_DESKTOP =
  typeof navigator !== 'undefined' && /\bElectron\//.test(navigator.userAgent || '');

// Your deployed Apps Script Web App URL (the Google Sheet backend).
// Deployment made after the Code.gs update (the one that knows adoptPurchases, supplierId, installPlan).
// Previous deployment, kept for rolling back:
//   https://script.google.com/macros/s/AKfycbyPkrSO3jOpm8gxqGEI9-IHsdvkJDktnQGnsnPBM1EyDmdzsy7nrTLV1krhyeoBG1Ua/exec
const SCRIPT_URL =
  'https://script.google.com/macros/s/AKfycbxjiF2Cbu3XRXkWHG6ZJDcdDZ1KkrOF-vuf0R7mR8vF1Y1C9SWTGzGw7gce4aYTKVYrEA/exec';

// Google Sheets sync login. Leave both empty to keep offline-first sync off.
// Anything written here is compiled into the program, so anyone who has the
// program or the website can read it.
const SYNC_USERNAME = '';
const SYNC_PASSWORD = '';

// Offline-first desktop mode needs a stored sync login (see above).
const HAS_SYNC_AUTH = Boolean(SYNC_USERNAME);

export const CONFIG = {
  // 'sheets' — reads and writes the Google Sheet directly. Everyone signs in
  //            with their own dashboard login, and the website and the desktop
  //            program share the same data and the same users. Bills and
  //            payments still survive a brief outage (api.js queues those two
  //            and replays them).
  //
  // 'local'  — everything is saved on this computer / browser. Used when:
  //              - SCRIPT_URL above is empty (there is no Sheet to talk to), or
  //              - this is the desktop program AND a sync login is set above:
  //                it then works with no internet at all and sync.js uploads
  //                and downloads in the background.
  backend: (!SCRIPT_URL || (IS_DESKTOP && HAS_SYNC_AUTH)) ? 'local' : 'sheets',

  appsScriptUrl: SCRIPT_URL,

  // Google Sheets sync credentials (empty = sync off).
  sheetsAuth: {
    username: SYNC_USERNAME,
    password: SYNC_PASSWORD,
  },

  // Shown in the sidebar/top bar before Settings is saved.
  defaultShopName: 'Expert Webs Designs',

  // Where the dashboard is deployed, used to build shareable party links.
  //
  // Hard-coded on purpose. A share link is pasted into WhatsApp and opened on
  // someone else's phone, so it has to point at the live site no matter where
  // it was generated. Built from window.location instead, a link copied while
  // running locally would read "http://localhost:5173/..." and open nothing on
  // the customer's phone.
  //
  // No trailing slash. Leave empty to fall back to the current address.
  publicUrl: '',

  // Seed the local backend with demo data so the dashboard is not empty
  // on first run. Set false for a clean start with your own data.
  seedDemoData: false,
};

// Payment methods available out of the box. Custom methods are added in
// Settings and merged with these at runtime (FR-7 / FR-54).
export const DEFAULT_METHODS = ['Cash', 'JazzCash', 'EasyPaisa', 'HBL Bank', 'Cheque'];

// Units offered when creating an item (Plan 3.3).
export const UNITS = ['Piece', 'KG', 'Carton', 'Box', 'Dozen', 'Litre', 'Bag', 'Packet'];

export const EXPENSE_CATEGORIES = [
  'Rent', 'Utilities', 'Transport', 'Salaries', 'Stock Loss',
  'Supplies', 'Maintenance', 'Tea & Food', 'Miscellaneous',
];

export const STOCK_LOSS_REASONS = ['Damaged', 'Expired', 'Lost', 'Other'];

export default CONFIG;
