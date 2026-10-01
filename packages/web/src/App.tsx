import { useEffect, useState, type ReactNode } from 'react';
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
import Reports from './pages/Reports';
import DriverRoute from './pages/DriverRoute';
import DriverStop from './pages/DriverStop';
import Portal, { PortalInvoice } from './pages/Portal';
import RawMaterials from './pages/RawMaterials';
import Suppliers from './pages/Suppliers';
import Pricing from './pages/Pricing';
import Bom from './pages/Bom';
import Payments from './pages/Payments';
import ErrorBoundary from './components/ErrorBoundary';
import StaleServerNotice from './components/StaleServerNotice';
import TopBar from './components/TopBar';
import SectionTabs from './components/SectionTabs';
import { DialogHost } from './components/Dialog';
import PurchaseOrders from './pages/PurchaseOrders';
import Production from './pages/Production';
import Stock from './pages/Stock';
import StockCount from './pages/StockCount';
import BottlePool from './pages/BottlePool';
import Users from './pages/Users';
import MyAccount from './pages/MyAccount';
import Register from './pages/Register';
import SetPassword from './pages/SetPassword';
import Decisions from './pages/Decisions';
import Zones from './pages/Zones';
import Employees from './pages/Employees';
import EmployeeRecord from './pages/EmployeeRecord';
import CustomerRecord from './pages/CustomerRecord';
import Quotes from './pages/Quotes';
import QuoteAccept from './pages/QuoteAccept';
import CreditNotes from './pages/CreditNotes';
import AutoEmails from './pages/AutoEmails';
import Messages from './pages/Messages';

interface NavItem {
  to: string;
  label: string;
  roles: Role[];
  /** The menu section it sits under: Sales, Deliveries, Money... */
  section?: string;
  /**
   * Where it sits in the office menu, if not in the list. 'action' is the
   * button under the brand (New order: the thing the office does most);
   * 'account' sits with Sign out (My password belongs to the person, not
   * to any part of the business). Drivers' and customers' short tab strips
   * show every item as a tab regardless.
   */
  placement?: 'action' | 'account' | 'decide';
  /** Other addresses that belong to this item (its tabs), which keep it lit. */
  also?: string[];
  /** Which pending count, if any, puts a badge on this item. */
  badge?: 'decisions' | 'quotes';
}

interface PendingCounts { applications: number; approvals: number; acceptedQuotes?: number }

/**
 * Navigation mirrors the Section 10 permission table exactly.
 *
 * Grouped by the job being done (UX review, 28 Sep 2026), not by table:
 * seven sections instead of one list of twenty-four. Order within a section
 * is how often the office reaches for it.
 */
const NAV: NavItem[] = [
  { to: '/orders/new', label: 'New order', roles: ['admin', 'user'], placement: 'action' },
  // Approvals and account requests in one list. On a desktop the top bar's
  // "Needs a decision" button leads here; on a phone it heads the menu.
  { to: '/decisions', label: 'Needs a decision', roles: ['admin', 'user'], placement: 'decide', badge: 'decisions' },

  { to: '/', label: 'Today', roles: ['admin', 'user'] },

  { to: '/orders', label: 'Orders', roles: ['admin', 'user'], section: 'Sales' },
  { to: '/quotes', label: 'Quotes', roles: ['admin', 'user'], section: 'Sales', badge: 'quotes' },
  { to: '/recurring', label: 'Standing orders', roles: ['admin', 'user'], section: 'Sales' },
  { to: '/customers', label: 'Customers', roles: ['admin', 'user'], section: 'Sales' },
  { to: '/messages', label: 'Messages & news', roles: ['admin', 'user'], section: 'Sales' },

  { to: '/delivery', label: 'Delivery rounds', roles: ['admin', 'user'], section: 'Deliveries' },
  { to: '/bottle-pool', label: 'Bottle pool', roles: ['admin', 'user'], section: 'Deliveries' },

  { to: '/invoices', label: 'Invoices', roles: ['admin', 'user'], section: 'Money' },
  { to: '/payments', label: 'Payments', roles: ['admin', 'user'], section: 'Money' },
  { to: '/credit-notes', label: 'Credit notes', roles: ['admin', 'user'], section: 'Money' },
  { to: '/statement', label: 'Statements', roles: ['admin', 'user'], section: 'Money' },

  { to: '/production', label: 'Production', roles: ['admin', 'user'], section: 'Production & stock' },
  { to: '/stock', label: 'Stock and counts', roles: ['admin', 'user'], section: 'Production & stock', also: ['/stock-count'] },
  { to: '/materials', label: 'Raw materials', roles: ['admin', 'user'], section: 'Production & stock' },
  { to: '/purchase-orders', label: 'Purchasing', roles: ['admin', 'user'], section: 'Production & stock', also: ['/suppliers'] },

  { to: '/reports', label: 'Reports', roles: ['admin', 'user'], section: 'Reports' },

  // Set up once, changed rarely. Logins are the administrator's alone.
  { to: '/pricing', label: 'Products & pricing', roles: ['admin', 'user'], section: 'Settings' },
  { to: '/zones', label: 'Delivery zones', roles: ['admin', 'user'], section: 'Settings' },
  { to: '/auto-emails', label: 'Emails & ordering', roles: ['admin', 'user'], section: 'Settings' },
  // Logins are the administrator's alone, so office staff see just Employees.
  { to: '/employees', label: 'People and logins', roles: ['admin'], section: 'Settings', also: ['/users'] },
  { to: '/employees', label: 'Employees', roles: ['user'], section: 'Settings' },

  { to: '/route', label: 'My route', roles: ['driver'] },
  // The portal, as separate modules rather than tabs inside one screen.
  { to: '/portal/home', label: 'Home', roles: ['customer'] },
  { to: '/portal/order', label: 'Place an order', roles: ['customer'] },
  { to: '/portal/orders', label: 'My orders', roles: ['customer'] },
  { to: '/portal/repeats', label: 'Standing orders', roles: ['customer'] },
  { to: '/portal/account', label: 'Statements & invoices', roles: ['customer'], also: ['/portal/invoices'] },
  { to: '/portal/quotes', label: 'Quotes', roles: ['customer'] },
  { to: '/portal/profile', label: 'My profile', roles: ['customer'] },

  // Everybody's own password; with Sign out, not in any section.
  { to: '/my-account', label: 'My password', roles: ['admin', 'user', 'driver'], placement: 'account' },
];

/** The tabs of the three screens that merge two menu items each. */
const STOCK: Array<[string, string]> = [['/stock', 'Stock'], ['/stock-count', 'Stock count']];
const PURCHASING: Array<[string, string]> = [['/purchase-orders', 'Purchase orders'], ['/suppliers', 'Suppliers']];
const PEOPLE: Array<[string, string]> = [['/employees', 'Employees'], ['/users', 'Logins']];

/**
 * Whether a menu link lights up only on its own address.
 *
 * By default a link is also active on every address beneath it, which is what
 * keeps Customers lit on a customer's record. But /orders/new sits beneath
 * /orders AND is its own menu item, so on New order both were lit. A link is
 * exact when another menu item lives beneath it.
 */
function exactMatch(to: string): boolean {
  return to === '/' || NAV.some((o) => o.to !== to && o.to.startsWith(`${to}/`));
}

function Shell({ session }: { session: Session }) {
  const navigate = useNavigate();
  const items = NAV.filter((n) => n.roles.includes(session.role));
  const listed = items.filter((n) => !n.placement);
  const actions = items.filter((n) => n.placement === 'action');
  const account = items.filter((n) => n.placement === 'account');
  const decide = items.filter((n) => n.placement === 'decide');
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

  const waiting = pending.applications + pending.approvals;
  const badgeFor = (n: NavItem) => {
    if (n.badge === 'decisions' && waiting > 0) {
      return <span className="nav-badge" title={`${waiting} waiting for you`}>{waiting}</span>;
    }
    const q = pending.acceptedQuotes ?? 0;
    if (n.badge === 'quotes' && q > 0) {
      return <span className="nav-badge" title={`${q} accepted, waiting to become orders`}>{q}</span>;
    }
    return null;
  };

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
  const compactNav = items.length <= 5 || session.role === 'customer';

  /** The grouped list, shared by the desktop sidebar and the phone drawer. */
  const groupedLinks = (withActions: boolean) => (
    <>
      {withActions && actions.map((n) => (
        <NavLink key={n.to} to={n.to} end={exactMatch(n.to)} className="nav-action">
          + {n.label}
        </NavLink>
      ))}
      {withActions && decide.map((n) => (
        <NavLink key={n.to} to={n.to} end className="nav-decide">
          {n.label}{badgeFor(n)}
        </NavLink>
      ))}
      {listed.map((n, i) => (
        <div key={n.to}>
          {/* Print a heading the first time a section appears. */}
          {n.section && n.section !== listed[i - 1]?.section && (
            <div className="nav-section">{n.section}</div>
          )}
          <NavLink to={n.to} end={exactMatch(n.to)}
                   className={({ isActive }) => (isActive || n.also?.some((a) => pathname.startsWith(a)) ? 'active' : '')}>
            {n.label}{badgeFor(n)}
          </NavLink>
        </div>
      ))}
    </>
  );

  const accountLinks = () => account.map((n) => (
    <NavLink key={n.to} to={n.to} end={exactMatch(n.to)} className="nav-account">
      {n.label}
    </NavLink>
  ));

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
              {!menuOpen && waiting > 0 && (
                <span className="nav-badge">{waiting}</span>
              )}
            </button>
          )}
          {compactNav && (
            <button className="topbar-signout" onClick={signOut}>Sign out</button>
          )}
        </div>

        {compactNav && (
          <nav className={`topbar-tabs${items.length > 5 ? ' many' : ''}`}>
            {items.map((n) => (
              <NavLink key={n.to} to={n.to} end={exactMatch(n.to)}
                       className={({ isActive }) => (isActive || n.also?.some((a) => pathname.startsWith(a)) ? 'active' : '')}>
                {n.label}{badgeFor(n)}
              </NavLink>
            ))}
          </nav>
        )}

        {!compactNav && menuOpen && (
          <nav className="topbar-drawer" onClick={() => setMenuOpen(false)}>
            {groupedLinks(true)}
            <div className="signout">
              {accountLinks()}
              <button className="secondary" onClick={signOut}>Sign out</button>
            </div>
          </nav>
        )}
      </header>

      {/* Desktop. New order, search, what is waiting and the person's own
          account live in the top bar beside it, so the sidebar is only the
          way round the business. */}
      <aside className="sidebar">
        <div className="brand">Alka Vida</div>
        <nav>{groupedLinks(false)}</nav>
      </aside>

      <DialogHost />
      <div className="content-col">
      <TopBar session={session} pending={pending} onSignOut={signOut} />
      <main className="main">
        <StaleServerNotice />
        <ErrorBoundary>
        <Routes>
          <Route path="/" element={<HomeFor session={session} />} />
          <Route path="/orders/new" element={<Keyed><NewOrder /></Keyed>} />
          <Route path="/orders" element={<Orders />} />
          <Route path="/recurring" element={<Recurring />} />
          <Route path="/customers" element={<Keyed><Customers session={session} /></Keyed>} />
          <Route path="/customers/:customerId" element={<CustomerRecord session={session} />} />
          <Route path="/pricing" element={<Pricing session={session} />} />
          <Route path="/products/:productId/bom" element={<Bom />} />
          <Route path="/delivery" element={<DeliverySheets />} />
          <Route path="/delivery/:sheetId" element={<RouteDetail session={session} />} />
          <Route path="/delivery/:sheetId/settlement" element={<Settlement session={session} />} />
          <Route path="/invoices" element={<Invoices />} />
          <Route path="/quotes" element={<Quotes />} />
          <Route path="/quotes/:quoteId" element={<Quotes />} />
          <Route path="/quotes/:quoteId/:mode" element={<Quotes />} />
          <Route path="/credit-notes" element={<Keyed><CreditNotes session={session} /></Keyed>} />
          <Route path="/auto-emails" element={<AutoEmails session={session} />} />
          <Route path="/messages" element={<Messages session={session} />} />
          <Route path="/payments" element={<Payments />} />
          <Route path="/invoices/:invoiceId" element={<InvoiceDetail session={session} />} />
          <Route path="/statement" element={<Statement />} />
          <Route path="/decisions" element={<Decisions session={session} />} />
          {/* The two screens it replaced; old links and bookmarks still land. */}
          <Route path="/approvals" element={<Navigate to="/decisions" replace />} />
          <Route path="/applications" element={<Navigate to="/decisions?show=accounts" replace />} />
          <Route path="/materials" element={<RawMaterials session={session} />} />
          <Route path="/suppliers" element={<><SectionTabs tabs={PURCHASING} /><Suppliers /></>} />
          <Route path="/purchase-orders" element={<><SectionTabs tabs={PURCHASING} /><PurchaseOrders /></>} />
          <Route path="/production" element={<Production />} />
          <Route path="/stock" element={<><SectionTabs tabs={STOCK} /><Stock /></>} />
          <Route path="/stock-count" element={<><SectionTabs tabs={STOCK} /><StockCount session={session} /></>} />
          <Route path="/bottle-pool" element={<BottlePool session={session} />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/route" element={<DriverRoute session={session} />} />
          <Route path="/route/stop/:stopId" element={<DriverStop />} />
          {/* Four modules, one screen behind them. */}
          <Route path="/portal" element={<Navigate to="/portal/home" replace />} />
          <Route path="/portal/invoices/:invoiceId" element={<PortalInvoice />} />
          <Route path="/portal/:tab" element={<Portal session={session} />} />
          <Route path="/users" element={<>{session.role === 'admin' && <SectionTabs tabs={PEOPLE} />}<Users session={session} /></>} />
          <Route path="/zones" element={<Zones session={session} />} />
          <Route path="/employees" element={<>{session.role === 'admin' && <SectionTabs tabs={PEOPLE} />}<Employees session={session} /></>} />
          <Route path="/employees/:employeeId" element={<EmployeeRecord session={session} />} />
          <Route path="/my-account" element={<MyAccount session={session} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </ErrorBoundary>
      </main>
      </div>
    </div>
  );
}

/**
 * Remounts a screen when only its query string changes. "+ New > Counter
 * sale" while already on New order changes ?mode= but not the path, and the
 * screen reads its starting state once; the key makes it start again.
 */
function Keyed({ children }: { children: ReactNode }) {
  const { search } = useLocation();
  return <div key={search} style={{ display: 'contents' }}>{children}</div>;
}

/** Each role lands on the screen that matches their job. */
function HomeFor({ session }: { session: Session }) {
  if (session.role === 'driver') return <Navigate to="/route" replace />;
  if (session.role === 'customer') return <Navigate to="/portal" replace />;
  return <Dashboard session={session} />;
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

  // A quotation's accept link opens the same page whether or not anybody is
  // signed in on this browser.
  const isPublic = PUBLIC_ROUTES.includes(pathname) || pathname.startsWith('/quote/');
  if (session && !isPublic) return <Shell session={session} />;

  return (
    <Routes>
      <Route path="/quote/:token" element={<QuoteAccept />} />
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
