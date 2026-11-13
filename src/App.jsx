import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AppProvider, useApp } from './context/AppContext';
import Shell from './components/layout/Shell';

import Login        from './pages/Login';
import Dashboard    from './pages/Dashboard';
import NewBill      from './pages/NewBill';
import BillView     from './pages/BillView';
import PurchaseView from './pages/PurchaseView';
import Bills        from './pages/Bills';
import Parties      from './pages/Parties';
import PartyLedger  from './pages/PartyLedger';
import Outstanding  from './pages/Outstanding';
import Items        from './pages/Items';
import Returns      from './pages/Returns';
import Cheques      from './pages/Cheques';
import Employees    from './pages/Employees';
import EmployeeLedger from './pages/EmployeeLedger';
import Expenses     from './pages/Expenses';
import StockLoss    from './pages/StockLoss';
import Purchases    from './pages/Purchases';
import Suppliers    from './pages/Suppliers';
import SupplierLedger from './pages/SupplierLedger';
import Assets       from './pages/Assets';
import Accounts     from './pages/Accounts';
import AccountLedger from './pages/AccountLedger';
import LedgerBook   from './pages/LedgerBook';
import BalanceSheet from './pages/BalanceSheet';
import ProfitReport from './pages/ProfitReport';
import Audit        from './pages/Audit';
import ActivityLog  from './pages/ActivityLog';
import Settings     from './pages/Settings';
import More         from './pages/More';
import Users        from './pages/Users';
import SharedLedger from './pages/SharedLedger';

/** Everything except the public shared-ledger view requires a login. */
function Protected({ children }) {
  const { session, booted } = useApp();
  if (!booted) return null;
  if (!session) return <Navigate to="/login" replace />;
  return children;
}

function Router() {
  const { session } = useApp();

  return (
    <Routes>
      {/* Public: password-protected read-only party ledger (FR-21) */}
      <Route path="/share/:token" element={<SharedLedger />} />

      <Route path="/login" element={session ? <Navigate to="/" replace /> : <Login />} />

      <Route element={<Protected><Shell /></Protected>}>
        <Route index                    element={<Dashboard />} />
        <Route path="bill/new"          element={<NewBill />} />
        <Route path="bill/:id/edit"     element={<NewBill />} />
        <Route path="bill/:id"          element={<BillView />} />
        <Route path="purchase/:id"      element={<PurchaseView />} />
        <Route path="bills"             element={<Bills />} />
        <Route path="parties"           element={<Parties />} />
        <Route path="party/:id"         element={<PartyLedger />} />
        <Route path="outstanding"       element={<Outstanding />} />
        <Route path="items"             element={<Items />} />
        <Route path="returns"           element={<Returns />} />
        <Route path="cheques"           element={<Cheques />} />
        <Route path="employees"         element={<Employees />} />
        <Route path="employee/:id"      element={<EmployeeLedger />} />
        <Route path="expenses"          element={<Expenses />} />
        <Route path="stock-loss"        element={<StockLoss />} />
        <Route path="purchases"         element={<Purchases />} />
        <Route path="suppliers"         element={<Suppliers />} />
        <Route path="supplier/:id"      element={<SupplierLedger />} />
        <Route path="assets"            element={<Assets />} />
        <Route path="accounts"          element={<Accounts />} />
        <Route path="account/:method"   element={<AccountLedger />} />
        <Route path="ledger-book"       element={<LedgerBook />} />
        <Route path="balance-sheet"     element={<BalanceSheet />} />
        <Route path="profit"            element={<ProfitReport />} />
        <Route path="audit"             element={<Audit />} />
        <Route path="activity"          element={<ActivityLog />} />
        <Route path="settings"          element={<Settings />} />
        <Route path="users"             element={<Users />} />
        <Route path="more"              element={<More />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AppProvider>
      {/* HashRouter so the app works opened from a local file path too */}
      <HashRouter>
        <Router />
      </HashRouter>
    </AppProvider>
  );
}
