import { useEffect, useState } from 'react';
import {
  HashRouter, Routes, Route, NavLink, Navigate, useNavigate, useLocation,
} from 'react-router-dom';
import { api, getSession, clearSession, type Session, type Role } from './lib/api';

import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Customers from './pages/Customers';
import NewOrder from './pages/NewOrder';
import Orders from './pages/Orders';
import Recurring from './pages/Recurring';
import DeliverySheets from './pages/DeliverySheets';
import RouteDetail from './pages/RouteDetail';
import Settlement from './pages/Settlement';
import Invoices from './pages/Invoices';
import InvoiceDetail from './pages/InvoiceDetail';
import Statement from './pages/Statement';
import Approvals from './pages/Approvals';
import Reports from './pages/Reports';
import DriverRoute from './pages/DriverRoute';
import DriverStop from './pages/DriverStop';
import Portal from './pages/Portal';
import RawMaterials from './pages/RawMaterials';
import Suppliers from './pages/Suppliers';
import Pricing from './pages/Pricing';
import Bom from './pages/Bom';
import Payments from './pages/Payments';
import ErrorBoundary from './components/ErrorBoundary';
import StaleServerNotice from './components/StaleServerNotice';
import PurchaseOrders from './pages/PurchaseOrders';
import Production from './pages/Production';
import Stock from './pages/Stock';
import StockCount from './pages/StockCount';
import BottlePool from './pages/BottlePool';
import Users from './pages/Users';
import MyAccount from './pages/MyAccount';
import Register from './pages/Register';
import SetPassword from './pages/SetPassword';
import Applications from './pages/Applications';
import Zones from './pages/Zones';

interface NavItem {
  to: string;
  label: string;
  roles: Role[];
  /** Groups the sidebar into Sales and Operations. */
  section?: string;
  /** Which pending count, if any, puts a badge on this item. */
  badge?: 'applications' | 'approvals';
}

interface PendingCounts { applications: number; approvals: number }

/** Navigation mirrors the Section 10 permission table exactly. */
const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', roles: ['admin', 'user'] },

  { to: '/orders/new', label: 'New order', roles: ['admin', 'user'], section: 'Sales' },
  { to: '/orders', label: 'Orders', roles: ['admin', 'user'], section: 'Sales' },
  { to: '/recurring', label: 'Standing orders', roles: ['admin', 'user'], section: 'Sales' },
  { to: '/customers', label: 'Customers', roles: ['admin', 'user'], section: 'Sales' },
  { to: '/pricing', label: 'Products & pricing', roles: ['admin', 'user'], section: 'Sales' },
  { to: '/delivery', label: 'Delivery sheets', roles: ['admin', 'user'], section: 'Sales' },
  { to: '/invoices', label: 'Invoices', roles: ['admin', 'user'], section: 'Sales' },
  { to: '/payments', label: 'Payments', roles: ['admin', 'user'], section: 'Sales' },
  { to: '/statement', label: 'Statements', roles: ['admin', 'user'], section: 'Sales' },
  { to: '/approvals', label: 'Approvals', roles: ['admin', 'user'], section: 'Sales', badge: 'approvals' },

  { to: '/materials', label: 'Raw materials', roles: ['admin', 'user'], section: 'Operations' },
  { to: '/suppliers', label: 'Suppliers', roles: ['admin', 'user'], section: 'Operations' },
  { to: '/purchase-orders', label: 'Purchase orders', roles: ['admin', 'user'], section: 'Operations' },
  { to: '/production', label: 'Production', roles: ['admin', 'user'], section: 'Operations' },
  { to: '/stock', label: 'Stock on hand', roles: ['admin', 'user'], section: 'Operations' },
  { to: '/stock-count', label: 'Stock count', roles: ['admin', 'user'], section: 'Operations' },
  { to: '/bottle-pool', label: 'Bottle pool', roles: ['admin', 'user'], section: 'Operations' },

  { to: '/reports', label: 'Reports', roles: ['admin', 'user'] },

  { to: '/route', label: 'My route', roles: ['driver'] },
  // The portal, as separate modules rather than tabs inside one screen.
  { to: '/portal/order', label: 'Place an order', roles: ['customer'] },
  { to: '/portal/orders', label: 'My orders', roles: ['customer'] },
  { to: '/portal/repeats', label: 'Standing orders', roles: ['customer'] },
  { to: '/portal/account', label: 'Statements & invoices', roles: ['customer'] },

  // Administration. Logins are the administrator's alone; changing your own
  // password belongs to everybody, which is why it is not in that section.
  { to: '/applications', label: 'Account requests', roles: ['admin', 'user'], section: 'Administration', badge: 'applications' },
  { to: '/zones', label: 'Delivery zones', roles: ['admin', 'user'], section: 'Administration' },
  { to: '/users', label: 'Logins', roles: ['admin'], section: 'Administration' },
  { to: '/my-account', label: 'My password', roles: ['admin', 'user', 'driver'] },
];

function Shell({ session }: { session: Session }) {
  const navigate = useNavigate();
  const items = NAV.filter((n) => n.roles.includes(session.role));
  const { pathname } = useLocation();

  /**
   * What is waiting for somebody, shown as a count beside the module.
   *
   * Re-read on every navigation, so approving the last request clears the
   * badge without a refresh. Only the office sees these; a driver or a
   * customer has no module to badge.
   */
  const [pending, setPending] = useState<PendingCounts>({ applications: 0, approvals: 0 });
  const office = session.role === 'admin' || session.role === 'user';

  /** The phone menu. Closes on navigation, so a tap never leaves it covering. */
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => { setMenuOpen(false); }, [pathname]);

  useEffect(() => {
    if (!office) return;
    api.get<PendingCounts>('/api/pending-counts').then(setPending).catch(() => {});
  }, [office, pathname]);

  const signOut = () => { clearSession(); navigate('/login'); location.reload(); };

  const badgeFor = (n: NavItem) => (n.badge && pending[n.badge] > 0
    ? (
      <span className="nav-badge" title={`${pending[n.badge]} waiting for you`}>
        {pending[n.badge]}
      </span>
    )
    : null);

  /*
   * A driver or a customer has a handful of destinations, so on a phone they
   * get them all as a strip they can tap straight away. The office has
   * twenty-odd, which only fits behind a menu button.
   *
   * The old layout stacked the whole sidebar above the content on a narrow
   * screen: brand, name, role, every link and a Sign out button. On a
   * driver's phone that was half the screen given to navigation they did not
   * need, with the actual stop pushed below the fold.
   */
  const compactNav = items.length <= 5;

  return (
    <div className="app">
      {/* Phone only. The desktop sidebar below is untouched. */}
      <header className="topbar">
        <div className="topbar-main">
          <span className="topbar-brand">Alka Vida</span>
          {!compactNav && (
            <button className="topbar-menu" aria-expanded={menuOpen}
                    onClick={() => setMenuOpen(!menuOpen)}>
              {menuOpen ? 'Close' : 'Menu'}
              {!menuOpen && (pending.applications + pending.approvals > 0) && (
                <span className="nav-badge">{pending.applications + pending.approvals}</span>
              )}
            </button>
          )}
          {compactNav && (
            <button className="topbar-signout" onClick={signOut}>Sign out</button>
          )}
        </div>

        {compactNav && (
          <nav className="topbar-tabs">
            {items.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.to === '/'}>
                {n.label}{badgeFor(n)}
              </NavLink>
            ))}
          </nav>
        )}

        {!compactNav && menuOpen && (
          <nav className="topbar-drawer" onClick={() => setMenuOpen(false)}>
            {items.map((n, i) => (
              <div key={n.to}>
                {n.section && n.section !== items[i - 1]?.section && (
                  <div className="nav-section">{n.section}</div>
                )}
                <NavLink to={n.to} end={n.to === '/'}>
                  {n.label}{badgeFor(n)}
                </NavLink>
              </div>
            ))}
            <div className="signout">
              <button className="secondary" onClick={signOut}>Sign out</button>
            </div>
          </nav>
        )}
      </header>

      <aside className="sidebar">
        <div className="brand">Alka Vida</div>
        <div className="who">
          {session.name}
          <br />
          <span style={{ textTransform: 'capitalize' }}>{session.role}</span>
        </div>
        <nav>
          {items.map((n, i) => (
            <div key={n.to}>
              {/* Print a heading the first time a section appears. */}
              {n.section && n.section !== items[i - 1]?.section && (
                <div className="nav-section">{n.section}</div>
              )}
              <NavLink to={n.to} end={n.to === '/'}>
                {n.label}{badgeFor(n)}
              </NavLink>
            </div>
          ))}
        </nav>
        <div className="signout">
          <button className="secondary" onClick={signOut}>Sign out</button>
        </div>
      </aside>

      <main className="main">
        <StaleServerNotice />
        <ErrorBoundary>
        <Routes>
          <Route path="/" element={<HomeFor session={session} />} />
          <Route path="/orders/new" element={<NewOrder />} />
          <Route path="/orders" element={<Orders />} />
          <Route path="/recurring" element={<Recurring />} />
          <Route path="/customers" element={<Customers session={session} />} />
          <Route path="/pricing" element={<Pricing session={session} />} />
          <Route path="/products/:productId/bom" element={<Bom />} />
          <Route path="/delivery" element={<DeliverySheets />} />
          <Route path="/delivery/:sheetId" element={<RouteDetail session={session} />} />
          <Route path="/delivery/:sheetId/settlement" element={<Settlement session={session} />} />
          <Route path="/invoices" element={<Invoices />} />
          <Route path="/payments" element={<Payments />} />
          <Route path="/invoices/:invoiceId" element={<InvoiceDetail session={session} />} />
          <Route path="/statement" element={<Statement />} />
          <Route path="/approvals" element={<Approvals session={session} />} />
          <Route path="/materials" element={<RawMaterials session={session} />} />
          <Route path="/suppliers" element={<Suppliers />} />
          <Route path="/purchase-orders" element={<PurchaseOrders />} />
          <Route path="/production" element={<Production />} />
          <Route path="/stock" element={<Stock />} />
          <Route path="/stock-count" element={<StockCount session={session} />} />
          <Route path="/bottle-pool" element={<BottlePool session={session} />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/route" element={<DriverRoute session={session} />} />
          <Route path="/route/stop/:stopId" element={<DriverStop />} />
          {/* Four modules, one screen behind them. */}
          <Route path="/portal" element={<Navigate to="/portal/order" replace />} />
          <Route path="/portal/:tab" element={<Portal session={session} />} />
          <Route path="/users" element={<Users session={session} />} />
          <Route path="/applications" element={<Applications session={session} />} />
          <Route path="/zones" element={<Zones session={session} />} />
          <Route path="/my-account" element={<MyAccount session={session} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </ErrorBoundary>
      </main>
    </div>
  );
}

/** Each role lands on the screen that matches their job. */
function HomeFor({ session }: { session: Session }) {
  if (session.role === 'driver') return <Navigate to="/route" replace />;
  if (session.role === 'customer') return <Navigate to="/portal" replace />;
  return <Dashboard />;
}

/**
 * The two screens that belong to nobody: asking for an account, and choosing
 * a password from an invitation.
 *
 * They must render whether or not somebody is signed in. An invitation link
 * lands in a browser that may well already hold a session - the office
 * checking a link before sending it, or a customer opening it on the machine
 * where somebody else is signed in - and routing them to a dashboard instead
 * would strand them with no obvious way to the page the link was for.
 */
const PUBLIC_ROUTES = ['/register', '/set-password'];

/**
 * Chooses between the signed-in app and the pages that belong to nobody.
 *
 * The current path comes from useLocation, NOT from reading window.location
 * and listening for hashchange. React Router drives a HashRouter through the
 * History API, and pushState does not fire hashchange - so a flag maintained
 * that way sticks on whatever it was when the page first loaded. It did:
 * after setting a password from an invitation, signing in succeeded, the
 * session was stored, and the app carried on showing the login form until the
 * page was reloaded by hand. Which is precisely the moment a new customer
 * meets this screen for the first time.
 */
function Routed({
  session, onSignedIn,
}: { session: Session | null; onSignedIn: (s: Session) => void }) {
  const { pathname } = useLocation();

  if (session && !PUBLIC_ROUTES.includes(pathname)) return <Shell session={session} />;

  return (
    <Routes>
      <Route path="/register" element={<Register />} />
      <Route path="/set-password" element={<SetPassword />} />
      <Route path="*" element={<Login onSignedIn={onSignedIn} />} />
    </Routes>
  );
}

export default function App() {
  const [session, setSession] = useState<Session | null>(getSession());

  useEffect(() => {
    const onStorage = () => setSession(getSession());
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  return (
    <HashRouter>
      <Routed session={session} onSignedIn={setSession} />
    </HashRouter>
  );
}
