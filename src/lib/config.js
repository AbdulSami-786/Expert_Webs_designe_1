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

const SCRIPT_URL = import.meta.env?.VITE_APPS_SCRIPT_URL || '';

export const CONFIG = {
  // Desktop app: 'local'. Everything is saved on the computer, so the app works
  // with no internet at all. Whenever internet is available, sync.js uploads
  // new work to the Sheet and downloads what other devices entered, so every
  // device still ends up agreeing.
  //
  // Website: 'sheets'. A browser tab has no reliable local store to fall back
  // on, so it reads and writes the Sheet directly. Bills and payments still
  // survive a brief outage (api.js queues those two and replays them).
  //
  // With no VITE_APPS_SCRIPT_URL set there is no Sheet to talk to, so the
  // website also runs on 'local' (browser storage) instead of erroring.
  backend: (IS_DESKTOP || !SCRIPT_URL) ? 'local' : 'sheets',

  // Your deployed Apps Script Web App URL (https://script.google.com/macros/s/.../exec).
  // Set it in a local .env file (see .env.example) — never commit the real value.
  appsScriptUrl: SCRIPT_URL,

  // Google Sheets sync credentials (leave empty to keep sync off).
  //
  // Set these in a local .env file (see .env.example), not in this file.
  // Be aware: anything read through VITE_* is compiled into the built
  // JavaScript, so anyone who can open the dashboard can read it. Keep the
  // dashboard itself private and do not reuse this password anywhere.
  sheetsAuth: {
    username: import.meta.env?.VITE_SHEETS_USERNAME || '',
    password: import.meta.env?.VITE_SHEETS_PASSWORD || '',
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
  publicUrl: import.meta.env?.VITE_PUBLIC_URL || '',

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
