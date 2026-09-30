import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { api, type Session } from '../lib/api';
import { money, date, when } from '../lib/format';

/**
 * The bar across the top of every office screen, on a desktop.
 *
 * Four things the office reaches for from anywhere, so they no longer have to
 * find the right page first: find a customer, order or invoice; start
 * something new; see what is waiting on a decision; and their own account.
 * Agreed from the UX review mockups (29 Sep 2026). A phone keeps its own top
 * bar and drawer; this one is hidden there.
 */

interface PendingCounts { applications: number; approvals: number }

interface CustomerHit { id: string; name: string; phone: string | null; delivery_zone: string | null }
interface OrderHit {
  id: string; order_number: string; customer_id: string; customer_name: string;
  status: string; grand_total_cents: string;
}
interface InvoiceHit {
  invoice_id: string; invoice_number: string; customer_name: string;
  invoice_date: string; balance_cents: string;
}

interface Index { customers: CustomerHit[]; orders: OrderHit[]; invoices: InvoiceHit[] }

type Menu = 'new' | 'account' | null;

const ROLE_NAMES: Record<string, string> = {
  admin: 'Administrator', user: 'Office staff', driver: 'Driver', customer: 'Customer',
};

const MAX_PER_GROUP = 5;

export default function TopBar({
  session, pending, onSignOut,
}: { session: Session; pending: PendingCounts; onSignOut: () => void }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const [menu, setMenu] = useState<Menu>(null);
  const [q, setQ] = useState('');
  const [searching, setSearching] = useState(false);
  const [index, setIndex] = useState<Index | null>(null);
  const [indexError, setIndexError] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);

  // Whatever is open closes when the page changes or on a click elsewhere.
  useEffect(() => { setMenu(null); setSearching(false); setQ(''); }, [pathname]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) {
        setMenu(null); setSearching(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setMenu(null); setSearching(false); }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  /**
   * The search reads the same three lists the office screens already use,
   * once, the first time the box is used on a page. A few hundred customers
   * and the recent orders and invoices are small enough to filter here, and
   * it keeps working exactly like the list screens' own search boxes.
   */
  async function loadIndex() {
    if (index) return;
    try {
      const [customers, orders, invoices] = await Promise.all([
        api.get<CustomerHit[]>('/api/customers'),
        api.get<OrderHit[]>('/api/orders'),
        api.get<InvoiceHit[]>('/api/invoices'),
      ]);
      setIndex({ customers, orders, invoices });
    } catch {
      setIndexError(true);
    }
  }
  // Fresh lists on each new page, so a customer added a moment ago is found.
  useEffect(() => { setIndex(null); setIndexError(false); }, [pathname]);

  const needle = q.trim().toLowerCase();
  const has = (...fields: Array<string | null | undefined>) =>
    fields.some((f) => (f ?? '').toLowerCase().includes(needle));
  const hits = needle.length < 2 || !index ? null : {
    customers: index.customers.filter((c) => has(c.name, c.phone, c.delivery_zone))
      .slice(0, MAX_PER_GROUP),
    orders: index.orders.filter((o) => has(o.order_number, o.customer_name))
      .slice(0, MAX_PER_GROUP),
    invoices: index.invoices.filter((i) => has(i.invoice_number, i.customer_name))
      .slice(0, MAX_PER_GROUP),
  };
  const firstHit = hits && (
    hits.customers[0] ? `/customers/${hits.customers[0].id}`
      : hits.orders[0] ? `/customers/${hits.orders[0].customer_id}?tab=orders`
        : hits.invoices[0] ? `/invoices/${hits.invoices[0].invoice_id}` : null);
  const nothing = hits && !hits.customers.length && !hits.orders.length && !hits.invoices.length;

  const waiting = pending.approvals + pending.applications;
  const toggle = (m: Menu) => { setMenu(menu === m ? null : m); setSearching(false); };
  const office = session.role === 'admin' || session.role === 'user';

  return (
    <div className="deskbar" ref={barRef}>
      {office && (
        <div className="deskbar-search">
          <label htmlFor="global-search" className="visually-hidden">
            Search customers, orders and invoices
          </label>
          <input id="global-search" type="search" autoComplete="off"
                 placeholder="Search customers, orders, invoices"
                 value={q}
                 onFocus={() => { setSearching(true); setMenu(null); loadIndex(); }}
                 onChange={(e) => { setQ(e.target.value); setSearching(true); }}
                 onKeyDown={(e) => {
                   if (e.key === 'Enter' && firstHit) navigate(firstHit);
                 }} />
          {searching && needle.length >= 2 && (
            <div className="deskbar-pop deskbar-results" role="listbox"
                 aria-label="Search results">
              {indexError && <div className="pop-empty">Search is not available right now.</div>}
              {!indexError && !hits && <div className="pop-empty">Searching…</div>}
              {nothing && <div className="pop-empty">Nothing matches “{q.trim()}”.</div>}
              {hits && hits.customers.length > 0 && (
                <div className="pop-group">
                  <div className="pop-head">Customers</div>
                  {hits.customers.map((c) => (
                    <Link key={c.id} to={`/customers/${c.id}`} className="pop-item">
                      <span>{c.name}</span>
                      <span className="pop-meta">
                        {[c.delivery_zone, c.phone].filter(Boolean).join(' · ')}
                      </span>
                    </Link>
                  ))}
                </div>
              )}
              {hits && hits.orders.length > 0 && (
                <div className="pop-group">
                  <div className="pop-head">Orders</div>
                  {hits.orders.map((o) => (
                    <Link key={o.id} to={`/customers/${o.customer_id}?tab=orders`}
                          className="pop-item">
                      <span>{o.order_number} · {o.customer_name}</span>
                      <span className="pop-meta">
                        {o.status} · {money(Number(o.grand_total_cents))}
                      </span>
                    </Link>
                  ))}
                </div>
              )}
              {hits && hits.invoices.length > 0 && (
                <div className="pop-group">
                  <div className="pop-head">Invoices</div>
                  {hits.invoices.map((i) => (
                    <Link key={i.invoice_id} to={`/invoices/${i.invoice_id}`}
                          className="pop-item">
                      <span>{i.invoice_number} · {i.customer_name}</span>
                      <span className="pop-meta">
                        {when(i.invoice_date)} · {money(Number(i.balance_cents))} owing
                      </span>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="deskbar-spacer" />

      {office && (
        <div className="deskbar-menu">
          <button type="button" aria-haspopup="true" aria-expanded={menu === 'new'}
                  onClick={() => toggle('new')}>
            + New ▾
          </button>
          {menu === 'new' && (
            <div className="deskbar-pop deskbar-pop-right" role="menu">
              <Link role="menuitem" className="pop-item" to="/orders/new">
                <span>Order</span><span className="pop-meta">delivery or collection</span>
              </Link>
              <Link role="menuitem" className="pop-item" to="/orders/new?mode=Counter">
                <span>Counter sale</span><span className="pop-meta">walk-in, paid now</span>
              </Link>
              <Link role="menuitem" className="pop-item" to="/quotes/new">
                <span>Quote</span><span className="pop-meta">prices for a customer to accept</span>
              </Link>
              <Link role="menuitem" className="pop-item" to="/credit-notes?new=1">
                <span>Credit note</span><span className="pop-meta">money back to a customer</span>
              </Link>
              <Link role="menuitem" className="pop-item" to="/payments">
                <span>Payment received</span><span className="pop-meta">transfer, cheque, card</span>
              </Link>
              <Link role="menuitem" className="pop-item" to="/customers?new=1">
                <span>Customer</span><span className="pop-meta">add to the list</span>
              </Link>
            </div>
          )}
        </div>
      )}

      {office && (
        <NavLink to="/decisions" className="deskbar-decide"
              title={waiting > 0 ? `${pending.approvals} money changes, ${pending.applications} new accounts` : undefined}>
          Needs a decision
          {waiting > 0 && <span className="nav-badge">{waiting}</span>}
        </NavLink>
      )}

      <div className="deskbar-menu">
        <button type="button" className="deskbar-account"
                aria-haspopup="true" aria-expanded={menu === 'account'}
                onClick={() => toggle('account')}>
          {session.name} ▾
        </button>
        {menu === 'account' && (
          <div className="deskbar-pop deskbar-pop-right" role="menu">
            <div className="pop-empty">
              <strong>{session.name}</strong>
              <br />{ROLE_NAMES[session.role] ?? session.role}
            </div>
            {session.role !== 'customer' && (
              <Link role="menuitem" className="pop-item" to="/my-account">
                <span>My password</span>
              </Link>
            )}
            <button type="button" role="menuitem" className="pop-item pop-button"
                    onClick={onSignOut}>
              <span>Sign out</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
