/**
 * The public website at alkavidaja.com (Everton, 21 Oct 2026; round 3 on
 * 31 Oct 2026).
 *
 * "One site": the app serves the domain, so the website and the app are one
 * address. These pages are for everybody, signed in or not.
 *
 * Round 3 (approved design, 31 Oct 2026): brand and benefits first. A
 * rotating product slider at the top, the products with Add to cart on the
 * home page, a pop-up cart, How it works 1-2-3, Water & you, testimonials,
 * the About text, and the three delivery areas. The header has sign in,
 * search and the cart. Prices: the 5 gallon shows WITH GCT; cases show
 * before GCT, marked "+ GCT" (display only - pricing is unchanged).
 *
 * What comes from the system, so it is never typed twice:
 *  - the products and their LISTED prices (Products & pricing - the price a
 *    walk-in or a customer with no price tier pays);
 *  - the WhatsApp number (Settings › Emails & ordering), else 876-528-6112.
 *
 * Photos: packages/web/public/site/ - one per size named after it (5gal.jpg,
 * 5l.jpg, 1.5l.jpg, 500ml.jpg, 280ml.jpg) and truck.jpg for About us.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { api, type Session } from '../lib/api';
import Logo from '../components/Logo';
import PinPicker, { type DroppedPin } from '../components/PinPicker';
import './site.css';

/* ------------------------------------------------------------------ */
/* Data from the system                                                */
/* ------------------------------------------------------------------ */

export interface SiteProduct {
  id: string; name: string; size: string | null; bottlesPerCase: number;
  priceCents: number; unit: 'case' | 'bottle'; returnable: boolean;
}
interface SiteInfo {
  products: SiteProduct[];
  zones: Array<{ name: string; covers: string | null; days: string[] }>;
  phone: string; whatsapp: string; email: string;
}

const FALLBACK: SiteInfo = { products: [], zones: [], phone: '876-528-6112', whatsapp: '876-528-6112', email: 'orders@alkavidaja.com' };
let cached: Promise<SiteInfo> | null = null;

function useSite(): { site: SiteInfo; loaded: boolean } {
  const [site, setSite] = useState<SiteInfo | null>(null);
  useEffect(() => {
    let live = true;
    if (!cached) cached = api.get<SiteInfo>('/api/public/site').catch(() => { cached = null; return FALLBACK; });
    cached.then((s) => { if (live) setSite(s); });
    return () => { live = false; };
  }, []);
  return { site: site ?? FALLBACK, loaded: site !== null };
}

/** Digits for tel: and wa.me links, with Jamaica's 1 in front of a 10-digit 876 number. */
function digits(phone: string): string {
  const d = phone.replace(/\D/g, '');
  return d.length === 7 ? `1876${d}` : d.length === 10 ? `1${d}` : d;
}
const waLink = (phone: string, text?: string) =>
  `https://wa.me/${digits(phone)}${text ? `?text=${encodeURIComponent(text)}` : ''}`;

const INSTAGRAM = 'https://www.instagram.com/alkavida/';
const FACEBOOK = 'https://www.facebook.com/AlkaVidaAlkalineWater/';

/** J$500, or J$1,250.50 when there are cents. */
export function jmd(cents: number): string {
  const whole = Math.floor(Math.abs(cents) / 100).toLocaleString('en-JM');
  const part = Math.abs(cents) % 100;
  return `J$${whole}${part ? `.${String(part).padStart(2, '0')}` : ''}`;
}

/** "5gal" → "5gal", "1.5L" → "1.5l": the photo's file name. */
export function sizeKey(size: string | null): string {
  return (size ?? '').toLowerCase().replace(/\s+/g, '').replace(/gallons?$/, 'gal');
}
export function sizeLabel(p: Pick<SiteProduct, 'size' | 'name'>): string {
  const k = sizeKey(p.size);
  const gal = k.match(/^([\d.]+)gal$/);
  if (gal) return `${gal[1]} gallon`;
  return p.size?.replace(/l$/i, 'L').replace(/ml$/i, 'ml') || p.name;
}
/** Litres in one bottle, to put the biggest first. */
function litres(p: SiteProduct): number {
  const k = sizeKey(p.size);
  const m = k.match(/^([\d.]+)(ml|l|gal)$/);
  if (!m) return 0;
  const n = Number(m[1]);
  return m[2] === 'ml' ? n / 1000 : m[2] === 'gal' ? n * 3.785 : n;
}
/** The 5 gallon first, then the cases from the biggest bottle down. */
const shopOrder = (a: SiteProduct, b: SiteProduct) =>
  (a.unit === 'bottle' ? 0 : 1) - (b.unit === 'bottle' ? 0 : 1) || litres(b) - litres(a);

/** "Alkaline Water 500ml", "Alkaline Water 5 Gallon". */
const shopName = (p: SiteProduct) => `Alkaline Water ${sizeLabel(p).replace('gallon', 'Gallon')}`;
const packLine = (p: SiteProduct) => (p.unit === 'bottle'
  ? 'Bottle exchange · we swap your empty'
  : `Case of ${p.bottlesPerCase}${sizeKey(p.size) === '5l' ? ' · with handle' : ''}`);
/** Shown on the product (31 Oct 2026). */
const POPULAR = '500ml';

/* ------------------------------------------------------------------ */
/* Prices on the site (30 Oct 2026)                                    */
/* ------------------------------------------------------------------ */

const GCT = 0.15;
/** The 5 gallon is shown with GCT included; cases before GCT. Display only. */
const showsGct = (p: SiteProduct) => p.unit === 'bottle';
const shownCents = (p: SiteProduct) => (showsGct(p) ? Math.round(p.priceCents * (1 + GCT)) : p.priceCents);
const gctWord = (p: SiteProduct) => (showsGct(p) ? 'incl. GCT' : '+ GCT');

/**
 * The money for a list of lines. The total is the listed prices plus 15% GCT
 * - the same estimate the quick order has always given. "shown" adds the
 * line prices as the site shows them, so "GCT on cases" is the difference.
 */
export function siteTotals(lines: Array<{ p: SiteProduct; qty: number }>) {
  const before = lines.reduce((s, l) => s + l.p.priceCents * l.qty, 0);
  const total = before + Math.round(before * GCT);
  const shown = lines.reduce((s, l) => s + shownCents(l.p) * l.qty, 0);
  return { shown, gctOnCases: total - shown, total, unpriced: lines.some((l) => l.p.priceCents === 0) };
}

/* ------------------------------------------------------------------ */
/* The cart (31 Oct 2026): kept on this device until the order is sent */
/* ------------------------------------------------------------------ */

type CartLines = Record<string, number>;
const CART_KEY = 'alkavida.cart';
function readCart(): CartLines {
  try {
    const c = JSON.parse(localStorage.getItem(CART_KEY) ?? '{}') as unknown;
    if (!c || typeof c !== 'object') return {};
    return Object.fromEntries(Object.entries(c as Record<string, unknown>)
      .filter(([, n]) => typeof n === 'number' && n > 0).map(([k, n]) => [k, Math.min(500, Math.floor(n as number))]));
  } catch { return {}; }
}

interface Cart {
  lines: CartLines; count: number; open: boolean;
  add: (id: string, qty: number) => void;
  set: (id: string, qty: number) => void;
  replace: (lines: CartLines) => void;
  clear: () => void;
  show: (open: boolean) => void;
}
const CartContext = createContext<Cart | null>(null);
function useCart(): Cart {
  const c = useContext(CartContext);
  if (!c) throw new Error('The cart is only on the website pages');
  return c;
}

function useCartState(): Cart {
  const [lines, setLines] = useState<CartLines>(readCart);
  const [open, setOpen] = useState(false);
  useEffect(() => { try { localStorage.setItem(CART_KEY, JSON.stringify(lines)); } catch { /* private mode */ } }, [lines]);
  const add = useCallback((id: string, qty: number) => {
    if (qty <= 0) return;
    setLines((l) => ({ ...l, [id]: Math.min(500, (l[id] ?? 0) + qty) }));
    setOpen(true);
  }, []);
  const set = useCallback((id: string, qty: number) => setLines((l) => {
    const next = { ...l };
    if (qty <= 0) delete next[id]; else next[id] = Math.min(500, qty);
    return next;
  }), []);
  const replace = useCallback((next: CartLines) => setLines(next), []);
  const clear = useCallback(() => setLines({}), []);
  const count = Object.values(lines).reduce((s, n) => s + n, 0);
  return { lines, count, open, add, set, replace, clear, show: setOpen };
}

/** Scroll to a section of the home page (the site's addresses use #/, so plain #shop links can't). */
function scrollToId(id: string) {
  requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

/* ------------------------------------------------------------------ */
/* Shared parts                                                        */
/* ------------------------------------------------------------------ */

function BottleDrawing({ size }: { size: string | null }) {
  const big = sizeKey(size).endsWith('gal');
  return (
    <svg aria-hidden="true" width="40%" viewBox="0 0 64 88">
      {big
        ? <path d="M20 4h24v8l6 6v62a4 4 0 0 1-4 4H18a4 4 0 0 1-4-4V18l6-6z" fill="#fff" stroke="#0e76bc" strokeWidth="2.5" strokeLinejoin="round" />
        : <path d="M28 10h8v8l6 8v54a4 4 0 0 1-4 4H26a4 4 0 0 1-4-4V26l6-8z" fill="#fff" stroke="#0e76bc" strokeWidth="2.5" strokeLinejoin="round" />}
      <path d={big ? 'M14 40h36M14 58h36' : 'M22 46h20'} stroke="#0ab0da" strokeWidth="2.5" />
    </svg>
  );
}

/** The size's photo from /site/, or a drawn bottle until there is one. */
function ProductPhoto({ product, className }: { product: SiteProduct; className?: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className={className ?? 's-pic'}>
      {failed
        ? <BottleDrawing size={product.size} />
        : <img src={`/site/${sizeKey(product.size)}.jpg`} alt={`Alka Vida ${sizeLabel(product)}`} onError={() => setFailed(true)} />}
    </div>
  );
}

const Icon = {
  person: <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M4 21c1-4 4-6 8-6s7 2 8 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>,
  search: <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" /><path d="m16 16 4.5 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>,
  bag: <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24"><path d="M5 8h14l-1.2 11.2a2 2 0 0 1-2 1.8H8.2a2 2 0 0 1-2-1.8z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /><path d="M9 8V6a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" strokeWidth="2" /></svg>,
  close: <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /></svg>,
  arrow: <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24"><path d="M5 12h13M13 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  play: <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" fill="currentColor" /></svg>,
  phone: <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /></svg>,
  prev: <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  next: <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  instagram: <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="5" fill="none" stroke="currentColor" strokeWidth="2" /><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" strokeWidth="2" /><circle cx="17.5" cy="6.5" r="1.3" fill="currentColor" /></svg>,
  facebook: <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24"><path d="M14 8h3V4h-3a4 4 0 0 0-4 4v3H7v4h3v6h4v-6h3l1-4h-4V8z" fill="currentColor" /></svg>,
  whatsapp: <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24"><path d="M4 20l1.3-4A8 8 0 1 1 8 18.8z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /><path d="M9 9.5c.3 2.2 2.3 4.2 4.5 4.5l1-1.2 1.8.8c-.2 1.2-1.1 1.9-2.3 1.9A6 6 0 0 1 8 9.5c0-1.2.7-2.1 1.9-2.3l.8 1.8z" fill="currentColor" /></svg>,
};

/** A product with − / + and Add to cart (home page and Our water). */
function ProductCard({ p }: { p: SiteProduct }) {
  const cart = useCart();
  const [qty, setQty] = useState(1);
  return (
    <article className="s-pcard">
      <div className="s-pcard-pic">
        <ProductPhoto product={p} />
        {sizeKey(p.size) === POPULAR && <span className="s-tag">MOST POPULAR</span>}
        <div className="s-qty" role="group" aria-label={`How many ${sizeLabel(p)}`}>
          <button type="button" aria-label={`One less ${sizeLabel(p)}`} onClick={() => setQty(Math.max(1, qty - 1))}>−</button>
          <span aria-live="polite">{qty}</span>
          <button type="button" aria-label={`One more ${sizeLabel(p)}`} onClick={() => setQty(Math.min(500, qty + 1))}>+</button>
        </div>
      </div>
      <div className="s-pcard-price">
        {p.priceCents > 0
          ? <span><b>{jmd(shownCents(p))}</b> <span className="s-gct">{gctWord(p)}</span></span>
          : <span className="muted small">Call us for the price</span>}
        <span className="s-ph9">PH 9+</span>
      </div>
      <b className="s-pcard-name">{shopName(p)}</b>
      <span className="muted small">{packLine(p)}</span>
      <button type="button" className="s-pill block" onClick={() => { cart.add(p.id, qty); setQty(1); }}>ADD TO CART</button>
    </article>
  );
}

/** The pop-up cart, from Add to cart or the cart in the header. */
function CartDrawer({ site }: { site: SiteInfo }) {
  const cart = useCart();
  const navigate = useNavigate();
  const closeRef = useRef<HTMLButtonElement>(null);
  const byId = new Map(site.products.map((p) => [p.id, p]));
  const lines = Object.entries(cart.lines)
    .map(([id, qty]) => ({ p: byId.get(id), qty }))
    .filter((l): l is { p: SiteProduct; qty: number } => !!l.p)
    .sort((a, b) => shopOrder(a.p, b.p));
  const t = siteTotals(lines);

  useEffect(() => {
    if (!cart.open) return;
    closeRef.current?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') cart.show(false); };
    const before = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('keydown', key); document.body.style.overflow = before; };
  }, [cart.open, cart.show]);

  if (!cart.open) return null;
  const close = () => cart.show(false);
  return (
    <>
      <button type="button" className="s-cart-back" aria-label="Close your cart" tabIndex={-1} onClick={close} />
      <aside className="s-cart" role="dialog" aria-modal="true" aria-labelledby="cart-h">
        <div className="s-cart-head">
          <h2 id="cart-h" className="display">Your cart ({cart.count})</h2>
          <button ref={closeRef} type="button" className="s-icon" aria-label="Close" onClick={close}>{Icon.close}</button>
        </div>
        {lines.length === 0 ? (
          <div className="s-cart-empty">
            <b style={{ fontSize: 18 }}>Your cart is empty</b>
            <span className="muted">Add a 5 gallon bottle or a case to get started.</span>
            <Link to="/shop" className="s-pill" onClick={close}>Shop the water</Link>
          </div>
        ) : <>
          <div className="s-cart-lines">
            {lines.map(({ p, qty }) => (
              <div key={p.id} className="s-cart-line">
                <ProductPhoto product={p} className="s-cart-pic" />
                <div className="s-cart-info">
                  <div className="s-cart-row"><b>{sizeLabel(p)}</b><b>{p.priceCents > 0 ? jmd(shownCents(p) * qty) : '—'}</b></div>
                  <span className="muted small">{packLine(p)}{p.priceCents > 0 ? ` · ${jmd(shownCents(p))} ${gctWord(p)}` : ''}</span>
                  <div className="s-cart-row">
                    <div className="s-qty small" role="group" aria-label={`How many ${sizeLabel(p)}`}>
                      <button type="button" aria-label={`One less ${sizeLabel(p)}`} onClick={() => cart.set(p.id, qty - 1)}>−</button>
                      <span>{qty}</span>
                      <button type="button" aria-label={`One more ${sizeLabel(p)}`} onClick={() => cart.set(p.id, qty + 1)}>+</button>
                    </div>
                    <button type="button" className="s-link-btn s-remove-link" onClick={() => cart.set(p.id, 0)}>Remove</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="s-cart-foot">
            {!t.unpriced && <>
              <div className="s-sum"><span>Subtotal</span><span>{jmd(t.shown)}</span></div>
              {t.gctOnCases > 0 && <div className="s-sum"><span>GCT on cases (15%)</span><span>{jmd(t.gctOnCases)}</span></div>}
              <div className="s-sum total"><span>Estimated total</span><span style={{ fontSize: 18 }}>{jmd(t.total)}</span></div>
            </>}
            <span className="muted small">Pay on delivery or by bank transfer. We confirm your total and delivery day after you order.</span>
            <button type="button" className="s-pill block big" onClick={() => { close(); navigate('/order'); }}>CHECKOUT</button>
            <button type="button" className="s-pill outline block" onClick={close}>Keep shopping</button>
          </div>
        </>}
      </aside>
    </>
  );
}

const NAV: Array<[string, string]> = [
  ['/about', 'About us'], ['/how-we-deliver', 'Delivery'], ['/business', 'For business'], ['/contact', 'Contact'],
];

function SiteHeader({ session, query, onQuery }: { session: Session | null; query: string; onQuery: (q: string) => void }) {
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const cart = useCart();
  useEffect(() => { setOpen(false); if (pathname !== '/shop') window.scrollTo(0, 0); }, [pathname]);
  const onShop = pathname === '/' || pathname === '/shop';
  const shop = (e: React.MouseEvent) => { if (onShop) { e.preventDefault(); scrollToId('shop'); setOpen(false); } };
  return (
    <header className={`s-head${open ? ' open' : ''}`}>
      <div className="wrap">
        <Link to="/" className="s-logo" aria-label="Alka Vida home"><Logo height={60} /></Link>
        <span className="s-head-spacer" />
        <nav className="s-nav" aria-label="Main">
          <NavLink to="/shop" onClick={shop} className={({ isActive }) => (isActive ? 'active' : '')}>Shop</NavLink>
          {NAV.map(([to, label]) => (
            <NavLink key={to} to={to} className={({ isActive }) => (isActive ? 'active' : '')}>{label}</NavLink>
          ))}
        </nav>
        <div className="s-head-actions">
          {session
            ? <Link to="/" className="s-icon" aria-label="Open the app" title="Open the app">{Icon.person}</Link>
            : <Link to="/sign-in" className="s-icon" aria-label="Sign in to your account" title="Sign in">{Icon.person}</Link>}
          <button type="button" className="s-icon" aria-label="Search" aria-expanded={searching} onClick={() => setSearching(!searching)}>{Icon.search}</button>
          <button type="button" className="s-icon" aria-label={`Your cart, ${cart.count} ${cart.count === 1 ? 'item' : 'items'}`} onClick={() => cart.show(true)}>
            {Icon.bag}<span className="s-count">{cart.count}</span>
          </button>
          <Link to="/shop" onClick={shop} className="s-pill order">ORDER NOW</Link>
          <button type="button" className="s-menu-btn" aria-label="Menu" aria-expanded={open} onClick={() => setOpen(!open)}>
            <svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20"><path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          </button>
        </div>
      </div>
      {searching && (
        <div className="s-search">
          <div className="wrap">
            <label htmlFor="site-search"><b>Search</b></label>
            <input id="site-search" type="search" autoFocus placeholder="5 gallon, 500ml, cases…" value={query}
                   onChange={(e) => { onQuery(e.target.value); if (!onShop) navigate('/shop'); else scrollToId('shop'); }} />
          </div>
        </div>
      )}
    </header>
  );
}

function SiteFooter({ site }: { site: SiteInfo }) {
  return (
    <footer className="s-foot-band">
      <div className="wrap">
        <div className="s-foot-brand">
          <span className="display">Alka Vida</span>
          <span>Alkaline drinking water, bottled from the aquifers in St. Catherine.</span>
          <span><a href={`tel:+${digits(site.phone)}`}><b>{site.phone}</b></a> · <a href={`mailto:${site.email}`}>{site.email}</a></span>
          <div className="s-social">
            <a href={INSTAGRAM} rel="noopener" aria-label="Alka Vida on Instagram">{Icon.instagram}</a>
            <a href={FACEBOOK} rel="noopener" aria-label="Alka Vida on Facebook">{Icon.facebook}</a>
            <a href={waLink(site.whatsapp)} rel="noopener" aria-label="WhatsApp Alka Vida">{Icon.whatsapp}</a>
          </div>
        </div>
        <nav className="s-foot-nav" aria-label="Footer">
          <Link to="/shop">Shop the water</Link>
          <Link to="/sign-in">Sign in</Link>
          <Link to="/register">Open an account</Link>
          <Link to="/how-we-deliver">Delivery</Link>
          <Link to="/business">For business</Link>
          <Link to="/about">About us</Link>
          <Link to="/contact">Contact</Link>
          <Link to="/your-account">Your account online</Link>
        </nav>
        <p className="s-foot-legal">© {new Date().getFullYear()} 1506 Investments Limited. Alka Vida is a brand of 1506 Investments Limited.</p>
      </div>
    </footer>
  );
}

/** The sign-in form on the home page and Your account. */
function SignInCard({ onSignedIn, flat }: { onSignedIn: (s: Session) => void; flat?: boolean }) {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const s = await api.login(email, password);
      onSignedIn(s);
      navigate('/');
    } catch (err) {
      const m = err instanceof Error ? err.message : '';
      setError(/invalid email or password/i.test(m) ? 'That email and password do not match. Check them and try again.' : m || 'Sign in failed');
    } finally { setBusy(false); }
  }
  return (
    <form id="signin" className={`s-signin${flat ? ' flat' : ''}`} onSubmit={submit} aria-labelledby="si-h">
      <h2 id="si-h" className="display">Sign in</h2>
      <p className="muted small" style={{ marginTop: -6 }}>Customers, staff and drivers all sign in here.</p>
      {error && <div className="s-error" role="alert">{error}</div>}
      <div className="s-field">
        <label htmlFor="si-email">Email</label>
        <input id="si-email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="s-field">
        <label htmlFor="si-pass">Password</label>
        <input id="si-pass" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      <button className="s-btn primary block" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      <Link to="/sign-in?forgot=1" className="small">Forgotten your password?</Link>
      <div className="s-foot">New to Alka Vida? <Link to="/register"><b>Open an account</b></Link></div>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Pages                                                               */
/* ------------------------------------------------------------------ */

/** The products, one at a time, turning every 5 seconds until somebody picks one. */
function HeroSlider({ products, phone }: { products: SiteProduct[]; phone: string }) {
  const cart = useCart();
  const [i, setI] = useState(0);
  const [held, setHeld] = useState(false);
  const n = products.length;
  useEffect(() => {
    if (held || n < 2 || cart.open) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const t = window.setInterval(() => setI((x) => (x + 1) % n), 5000);
    return () => window.clearInterval(t);
  }, [held, n, cart.open]);
  const pick = (k: number) => { setI(((k % n) + n) % n); setHeld(true); };
  const cur = n ? products[i % n] : null;
  return (
    <section className="s-hero3" aria-label="Alka Vida">
      <span className="s-ring one" aria-hidden="true" /><span className="s-ring two" aria-hidden="true" />
      <div className="wrap">
        {n > 1 && (
          <div className="s-dots" role="tablist" aria-label="Our products">
            {products.map((p, k) => (
              <button key={p.id} type="button" role="tab" aria-selected={k === i % n} aria-label={`Show ${sizeLabel(p)}`} onClick={() => pick(k)}>
                {String(k + 1).padStart(2, '0')}
              </button>
            ))}
          </div>
        )}
        <div className="s-hero3-copy">
          <span className="s-eyebrow-pill"><span aria-hidden="true" />Jamaica's alkaline water</span>
          <h1 className="display">Alkaline water, delivered fresh to your door.</h1>
          <p className="lead">Smooth, clean, pH 9+ water, bottled from the aquifers in St. Catherine and brought to your home or office by the team that bottles it.</p>
          <div className="s-hero3-actions">
            <button type="button" className="s-pill light big" onClick={() => scrollToId('shop')}>ORDER NOW {Icon.arrow}</button>
            <button type="button" className="s-howbtn" onClick={() => scrollToId('how')}>
              <span className="s-howbtn-circle">{Icon.play}</span>
              <span className="s-howbtn-text"><b>HOW IT WORKS</b><span>From our plant to your door</span></span>
            </button>
          </div>
          <a href={`tel:+${digits(phone)}`} className="s-hero3-call">{Icon.phone}Or call {phone}</a>
        </div>
        {cur && (
          <div className="s-hero3-show">
            <div className="s-hero3-stage">
              <div className="s-hero3-circle"><ProductPhoto key={cur.id} product={cur} className="s-hero3-pic" /></div>
              {cur.priceCents > 0 && (
                <div className="s-hero3-badge">
                  <span className="top">{showsGct(cur) ? sizeLabel(cur).toUpperCase() : `${sizeLabel(cur).toUpperCase()} CASE`}</span>
                  <b>{jmd(shownCents(cur))}</b>
                  <span>{gctWord(cur)}</span>
                </div>
              )}
              {n > 1 && <>
                <button type="button" className="s-arrow prev" aria-label="Previous product" onClick={() => pick(i - 1)}>{Icon.prev}</button>
                <button type="button" className="s-arrow next" aria-label="Next product" onClick={() => pick(i + 1)}>{Icon.next}</button>
              </>}
            </div>
            <div className="s-hero3-caption" aria-live="polite">
              <span><b>{sizeLabel(cur)}</b><span>{packLine(cur)}</span></span>
              <button type="button" className="s-pill white" onClick={() => cart.add(cur.id, 1)}>Add to cart</button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

const STEPS: Array<[string, string, React.ReactNode]> = [
  ['Place an order', 'Choose your 5 gallon bottles and cases. No account needed to start, and it takes about a minute.', Icon.bag],
  ['We bottle and pack it', 'Your water is filled, sealed and loaded at our White Marl plant, ready for your delivery day.',
    <svg aria-hidden="true" width="28" height="28" viewBox="0 0 24 24"><path d="M12 3 4 7v10l8 4 8-4V7zM4 7l8 4 8-4M12 11v10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /></svg>],
  ['Delivered fresh to your door', "Our driver brings it on your area's day and swaps your empties. Pay on delivery or by bank transfer.",
    <svg aria-hidden="true" width="28" height="28" viewBox="0 0 24 24"><path d="M2 16h12V7h4l3 4v5h-3M2 16V7h12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /><circle cx="6" cy="18" r="2" fill="#fff" stroke="currentColor" strokeWidth="2" /><circle cx="17" cy="18" r="2" fill="#fff" stroke="currentColor" strokeWidth="2" /></svg>],
];

/** Posted as they were given (31 Oct 2026): no names; the office confirms the details. */
const SAYINGS: Array<[string, string]> = [
  ["The refill truck comes every Wednesday like clockwork. I haven't carried a bottle home from the supermarket in a year.", 'St. Andrew · Weekly refill'],
  ['Our office goes through six 5-gallon bottles a week. One invoice, one driver, zero chasing. Genuinely easier.', 'New Kingston · Office account'],
  ['It tastes clean and light — my children drink far more water than they used to, and the bottles get swapped, not binned.', 'Portmore · Family order'],
];

const AREAS: Array<[string, string]> = [
  ['Kingston', '5 gallon bottles and cases'],
  ['Portmore', '5 gallon bottles and cases'],
  ['Spanish Town', 'Or collect at our White Marl plant'],
];

function Check() {
  return <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" style={{ flex: 'none' }}><circle cx="12" cy="12" r="11" fill="#0ab0da" /><path d="m7 12 3.5 3.5L17 9" fill="none" stroke="#16202c" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function Home({ site, loaded, session, query }: { site: SiteInfo; loaded: boolean; session: Session | null; query: string }) {
  const { pathname } = useLocation();
  const products = useMemo(() => [...site.products].sort(shopOrder), [site.products]);
  const q = query.trim().toLowerCase();
  const shown = q
    ? products.filter((p) => `${shopName(p)} ${sizeLabel(p)} ${p.name} ${packLine(p)} ${p.unit === 'case' ? 'case cases' : 'bottle refill'}`.toLowerCase()
      .includes(q.replace(/\s+/g, ' ')) || sizeKey(p.size) === sizeKey(q))
    : products;
  // /shop opens the home page at the products (the header's Shop and Order now).
  useEffect(() => { if (pathname === '/shop' && loaded) scrollToId('shop'); }, [pathname, loaded]);

  return (
    <>
      <HeroSlider products={products} phone={site.phone} />

      <section className="s-reasons" aria-label="Why Alka Vida">
        <div className="wrap">
          <div className="s-reason"><span className="s-ring-icon"><svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24"><path d="M12 3c5 6 8 10 8 14a8 8 0 0 1-16 0c0-4 3-8 8-14z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /></svg></span><span><b>A smoother, cleaner taste</b><span className="muted">Water you'll want to keep drinking.</span></span></div>
          <div className="s-reason"><span className="s-ring-icon"><svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24"><circle cx="8" cy="9" r="4" fill="none" stroke="currentColor" strokeWidth="2" /><circle cx="16" cy="9" r="4" fill="none" stroke="currentColor" strokeWidth="2" /><circle cx="12" cy="17" r="4" fill="none" stroke="currentColor" strokeWidth="2" /></svg></span><span><b>Naturally mineral-rich</b><span className="muted">Calcium, magnesium and potassium.</span></span></div>
          <div className="s-reason"><span className="s-ring-icon"><svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24"><path d="M4 12a8 8 0 0 1 14-5l2 2M20 12a8 8 0 0 1-14 5l-2-2M20 4v5h-5M4 20v-5h5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" /></svg></span><span><b>Bottles swapped, not binned</b><span className="muted">We collect your 5 gallon empties.</span></span></div>
          <div className="s-reason"><span className="s-ring-icon text">JA</span><span><b>Made right here in Jamaica</b><span className="muted">Bottled from the aquifers in St. Catherine.</span></span></div>
        </div>
      </section>

      <section id="shop" className="s-section grey s-anchor" aria-labelledby="shop-h">
        <div className="wrap" style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
          <div className="s-sec-head">
            <div><p className="s-kicker">Our products</p><h2 id="shop-h" className="display">Fresh from our plant to your door</h2></div>
            <ViewCartButton />
          </div>
          {loaded && products.length === 0 && <p className="s-info">Our price list is being updated. Call or WhatsApp us on {site.phone} to order.</p>}
          {q && <p className="small">{shown.length ? `Showing ${shown.length} of ${products.length} for “${query.trim()}”.` : `Nothing matches “${query.trim()}”.`}</p>}
          <div className="s-pgrid">{shown.map((p) => <ProductCard key={p.id} p={p} />)}</div>
          <p className="muted small">Prices come straight from our price list. The 5 gallon price includes GCT; case prices are before GCT, which is added at checkout. Business customers see their own prices when they sign in.</p>
        </div>
      </section>

      <section id="how" className="s-section s-anchor" aria-labelledby="how-h">
        <div className="wrap" style={{ display: 'flex', flexDirection: 'column', gap: 28, alignItems: 'center' }}>
          <div className="s-sec-head center"><p className="s-kicker">How it works</p><h2 id="how-h" className="display">From our plant to your kitchen in three easy steps</h2></div>
          <ol className="s-how">
            {STEPS.map(([title, text, icon], k) => (
              <li key={title}>
                <span className="s-how-num" aria-hidden="true">0{k + 1}</span>
                <span className="s-how-icon">{icon}</span>
                <span className="s-how-step">STEP {k + 1}</span>
                <b>{title}</b>
                <span>{text}</span>
              </li>
            ))}
          </ol>
          <Link to="/how-we-deliver"><b>More about delivery →</b></Link>
        </div>
      </section>

      <section className="s-water" aria-labelledby="wy-h">
        <div className="wrap">
          <div className="s-water-copy">
            <p className="s-kicker light">Water &amp; you</p>
            <h2 id="wy-h" className="display">Essential for a healthy life</h2>
            <p className="lead">Water makes up about 60% of the body. Drinking enough of it, and water that tastes good enough to reach for again, is the simplest healthy habit there is.</p>
            <ul>
              <li><Check />Carrying nutrients and oxygen</li>
              <li><Check />Aiding digestion</li>
              <li><Check />Keeping your body temperature steady</li>
              <li><Check />Keeping joints and muscles moving</li>
            </ul>
          </div>
          <div className="s-water-side">
            <div><b>Healthy water for your staff</b><span>Office deliveries on a set day, invoiced weekly or monthly.</span><Link to="/business"><b>Business accounts →</b></Link></div>
            <div><b>Your brand, bottled by us</b><span>Purified or alkaline water under your own label.</span><Link to="/contact?about=bottling"><b>Ask for a quote →</b></Link></div>
          </div>
        </div>
      </section>

      <section className="s-section grey" aria-labelledby="say-h">
        <div className="wrap" style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
          <div className="s-sec-head center"><p className="s-kicker">Testimonials</p><h2 id="say-h" className="display">Here's what our customers say</h2></div>
          <div className="s-grid three">
            {SAYINGS.map(([words, who]) => (
              <figure key={who} className="s-quote">
                <svg aria-hidden="true" width="34" height="26" viewBox="0 0 34 26"><path d="M0 26V15C0 6 5 1 13 0l1 4c-4 1-7 4-7 9h6v13zm20 0V15c0-9 5-14 13-15l1 4c-4 1-7 4-7 9h6v13z" fill="#0ab0da" /></svg>
                <blockquote>{words}</blockquote>
                <figcaption>{who.toUpperCase()}</figcaption>
              </figure>
            ))}
          </div>
        </div>
      </section>

      <section className="s-section" aria-labelledby="ab-h">
        <div className="wrap s-split">
          <div className="s-photo-frame"><img src="/site/truck.jpg" alt="An Alka Vida delivery truck on the road" /></div>
          <div className="s-split-copy">
            <p className="s-kicker">About us</p>
            <h2 id="ab-h" className="display">Bottled in Jamaica, delivered by the people who make it</h2>
            <p style={{ fontSize: 18, lineHeight: 1.65 }}>Alka Vida is a family-run alkaline water plant. The same team fills the bottles, drives the routes and answers the phone — so the water you order is the water we bottled that morning.</p>
            <Link to="/about"><b>Read our story →</b></Link>
          </div>
        </div>
      </section>

      <section className="s-areas" aria-labelledby="where-h">
        <div className="wrap" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div className="s-sec-head">
            <div><p className="s-kicker">Delivery areas</p><h2 id="where-h" className="display">Where our truck goes</h2></div>
            <span style={{ fontWeight: 600 }}>Not sure we reach you? Call <a href={`tel:+${digits(site.phone)}`} style={{ color: 'var(--nav)' }}>{site.phone}</a>.</span>
          </div>
          <div className="s-grid three">
            {AREAS.map(([name, note]) => (
              <div key={name} className="s-area"><b>{name}</b><span>Home and office delivery</span><span className="muted small">{note}</span></div>
            ))}
          </div>
        </div>
      </section>

      <section className="s-section" aria-label="Your account">
        <div className="wrap">
          <div className="s-acct-band">
            {session
              ? <><span><b>Welcome back, {session.name}</b><span>Open the app to order again, follow your delivery and see your statement.</span></span>
                  <span className="s-actions"><Link to="/" className="s-pill">Open the app</Link></span></>
              : <><span><b>Already a customer?</b><span>Sign in to order again in two taps, follow your delivery and see your statement.</span></span>
                  <span className="s-actions"><Link to="/sign-in" className="s-pill">Sign in</Link><Link to="/register" className="s-pill outline">Open an account</Link></span></>}
          </div>
        </div>
      </section>
    </>
  );
}

function ViewCartButton() {
  const cart = useCart();
  return <button type="button" className="s-pill outline" onClick={() => cart.show(true)}>View cart ({cart.count})</button>;
}

const BLURB: Record<string, string> = {
  '5gal': 'Refills for home and office dispensers. We swap your empty.',
  '5l': 'With a handle. For the kitchen, the car or the site.',
  '1.5l': 'The family size for the fridge.',
  '500ml': 'For the bag, the gym and the office fridge.',
  '280ml': 'Lunch boxes, meetings and events.',
};

function Water({ site, loaded }: { site: SiteInfo; loaded: boolean }) {
  const products = useMemo(() => [...site.products].sort(shopOrder), [site.products]);
  return (
    <>
      <section className="s-band">
        <div className="wrap">
          <div style={{ flex: '1 1 520px' }}>
            <h1 className="display">Our water</h1>
            <p>pH 9+ alkaline drinking water in five sizes. The 5 gallon price includes GCT; case prices are before GCT. Business and distributor prices show once you sign in.</p>
          </div>
          <ViewCartButton />
        </div>
      </section>
      <section className="s-section grey" aria-label="Sizes and prices">
        <div className="wrap" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {loaded && products.length === 0 && <p className="s-info">Our price list is being updated. Call or WhatsApp us on {site.phone} for prices.</p>}
          <div className="s-pgrid">{products.map((p) => <ProductCard key={p.id} p={p} />)}</div>
          <div className="s-grid three">
            {products.filter((p) => BLURB[sizeKey(p.size)]).map((p) => (
              <div key={p.id} className="s-box"><b className="title">{sizeLabel(p)}</b><span>{BLURB[sizeKey(p.size)]}</span></div>
            ))}
          </div>
        </div>
      </section>
      <section className="s-section">
        <div className="wrap s-grid three">
          <div className="s-box"><b className="title">Collect or have it delivered</b><span>Cases can be collected at our plant in White Marl, Spanish Town, or delivered with a 5 gallon order.</span></div>
          <div className="s-box"><b className="title">Your first 5 gallon</b><span>No empty bottle to swap? Tick the box when you order and we'll add a bottle to your first order.</span></div>
          <div className="s-box info"><b className="title" style={{ color: 'var(--info)' }}>Buying for a business?</b><span><Link to="/sign-in">Sign in</Link> to see your account's prices, or <Link to="/business"><b>open a business account</b></Link>.</span></div>
        </div>
      </section>
    </>
  );
}

function Delivery({ site }: { site: SiteInfo }) {
  return (
    <>
      <section className="s-band"><div className="wrap"><div><p className="s-kicker">Delivery</p><h1 className="display">Delivered fresh to your door</h1><p>Each area has its own delivery days, so you always know when our truck is coming.</p></div></div></section>
      <section className="s-section" style={{ paddingBottom: 24 }}>
        <div className="wrap">
          <h2 className="display">How it works</h2>
          <ol className="s-steps">
            <li><span className="s-num">1</span><b>Place an order</b><span>On the site, in your account, or on WhatsApp. Set up a standing order and we'll bring the same every week.</span></li>
            <li><span className="s-num">2</span><b>We bottle and pack it</b><span>We confirm your order and get it ready at our White Marl plant for your area's delivery day.</span></li>
            <li><span className="s-num">3</span><b>Delivered to your door</b><span>Our driver swaps your empties and gives you a receipt. Your invoice and receipt also arrive by email.</span></li>
          </ol>
        </div>
      </section>
      <section className="s-section" style={{ paddingTop: 24, paddingBottom: 24 }}>
        <div className="wrap">
          <h2 className="display">Where our truck goes</h2>
          <div className="s-grid three">
            {AREAS.map(([name]) => (
              <div key={name} className="s-area aqua"><b>{name}</b><span>{name === 'Spanish Town' ? 'Home and office delivery, or collect at our White Marl plant' : 'Home and office delivery'}</span></div>
            ))}
          </div>
          <p style={{ marginTop: 16 }}>We confirm your delivery day when you order. Not sure we reach you? Call <a href={`tel:+${digits(site.phone)}`}><b>{site.phone}</b></a>.</p>
        </div>
      </section>
      <section className="s-section" style={{ paddingTop: 24, paddingBottom: 24 }}>
        <div className="wrap">
          <div className="s-box" style={{ gap: 14, padding: 26, maxWidth: 560 }}>
            <h2 style={{ fontSize: 22 }}>Follow your order</h2>
            <span className="muted">Signed in, you'll see where your order is.</span>
            <ol className="s-track">
              <li><span className="s-dot" /><b>Received</b><span className="muted">· we have your order</span></li>
              <li><span className="s-dot" /><b>Ready</b><span className="muted">· loaded for your day</span></li>
              <li><span className="s-dot hollow" /><b>Out for delivery</b><span className="muted">· the driver is on the way</span></li>
              <li><span className="s-dot hollow" /><b>Delivered</b><span className="muted">· receipt by email</span></li>
            </ol>
          </div>
        </div>
      </section>
      <section className="s-section" style={{ paddingTop: 24, paddingBottom: 64 }}>
        <div className="wrap">
          <h2 className="display">Paying</h2>
          <div className="s-grid" style={{ maxWidth: 760 }}>
            <div className="s-box"><b className="title" style={{ fontSize: 20, color: 'var(--nav)' }}>Pay on delivery</b></div>
            <div className="s-box"><b className="title" style={{ fontSize: 20, color: 'var(--nav)' }}>Bank transfer</b></div>
          </div>
        </div>
      </section>
    </>
  );
}

function YourAccount({ onSignedIn, session }: { onSignedIn: (s: Session) => void; session: Session | null }) {
  const features: Array<[string, string]> = [
    ['Order in two taps', 'Repeat your last order, or set a standing order that comes every week.'],
    ['Follow your delivery', 'From received to ready, out for delivery and delivered.'],
    ['Invoices, statements and receipts', 'Every one of them, ready to download.'],
    ['Your balance', "See what you owe and what you've paid, with your order history."],
    ['Your addresses', 'Home, office and billing addresses, so the driver goes to the right door.'],
    ['News, offers and quotes', 'Hear about offers first. Businesses can accept quotes online.'],
  ];
  return (
    <>
      <section className="s-band indigo s-account-hero">
        <div className="wrap">
          <div style={{ flex: '1 1 440px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            <h1 className="display">Your water account, online</h1>
            <p style={{ marginTop: 0 }}>Everything you'd call the office for, any time of day.</p>
            <p className="small" style={{ color: 'var(--nav-label)', marginTop: 0 }}>Already a customer but never signed in? Ask us for an invite and we'll email you a link to set your password.</p>
          </div>
          <figure className="s-preview" aria-label="Example of the account home">
            <div className="s-preview-top"><span className="display" style={{ fontSize: 22, color: 'var(--brand)' }}>Alka Vida</span><span className="muted small">My account</span></div>
            <div className="s-preview-body">
              <div className="display" style={{ fontSize: 24 }}>Welcome</div>
              <div className="s-mini"><span className="k">NEXT DELIVERY</span><b>Thursday · 4 x 5 Gallon</b><span className="s-chip" style={{ background: 'var(--ok-bg)', color: 'var(--ok)' }}>Ready</span></div>
              <div className="s-two">
                <div className="s-mini"><span className="k">YOU OWE</span><b style={{ fontSize: 20 }}>$0.00</b></div>
                <div className="s-mini"><span className="k">STANDING ORDER</span><b>Every Thursday</b></div>
              </div>
            </div>
          </figure>
        </div>
      </section>
      <section className="s-section" style={{ paddingBottom: 24 }}>
        <div className="wrap s-grid three">
          {features.map(([t, d]) => <div key={t} className="s-box"><b className="title">{t}</b><span>{d}</span></div>)}
        </div>
      </section>
      <section className="s-section" style={{ paddingTop: 24, paddingBottom: 64 }}>
        <div className="wrap s-row">
          {session
            ? <div className="s-signin flat"><h2 className="display">You are signed in</h2><p>As {session.name}.</p><Link to="/" className="s-btn primary block">Open the app</Link></div>
            : <SignInCard onSignedIn={onSignedIn} flat />}
          <div className="s-open">
            <h2 className="display">Open an account</h2>
            <p>Tell us who you are and where we deliver. We'll check it and email you a link to set your password.</p>
            <Link to="/register" className="s-btn primary block" style={{ marginTop: 'auto', background: 'var(--nav)' }}>Start</Link>
          </div>
        </div>
      </section>
    </>
  );
}

function Business() {
  return (
    <>
      <section className="s-band"><div className="wrap"><div><h1 className="display">For business</h1><p>Water for your office, shop or customers, and bottling under your own brand.</p></div></div></section>
      <section className="s-section">
        <div className="wrap s-grid three" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))' }}>
          <div className="s-box" style={{ padding: 30, gap: 14 }}>
            <h2 style={{ fontSize: 24 }}>Offices, shops and distributors</h2>
            <p>A business account with your own prices, delivery on a set day, and one invoice a week or a month if that suits your accounts team.</p>
            <ul style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <li>Your account's own prices, shown when you sign in</li>
              <li>Quotes you can accept online</li>
              <li>Weekly or monthly invoicing</li>
              <li>Statements and reminders by email</li>
              <li>Several delivery addresses on one account</li>
            </ul>
            <Link to="/register" className="s-btn primary" style={{ marginTop: 'auto', alignSelf: 'flex-start' }}>Open a business account</Link>
          </div>
          <div className="s-box aqua" style={{ padding: 30, gap: 14 }}>
            <h2 style={{ fontSize: 24 }}>Your brand, bottled by us</h2>
            <p>We bottle purified and alkaline water under your own label, in the sizes you need, on order.</p>
            <ul style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <li>280ml, 500ml, 1.5L and 5L</li>
              <li>Purified or alkaline</li>
              <li>Your labels, our bottling line</li>
              <li>Collected or delivered</li>
            </ul>
            <Link to="/contact?about=bottling" className="s-btn plain" style={{ marginTop: 'auto', alignSelf: 'flex-start' }}>Ask for a quote</Link>
          </div>
        </div>
      </section>
      <section className="s-section grey" style={{ paddingBottom: 64 }}>
        <div className="wrap">
          <h2 className="display">Opening a business account</h2>
          <ol className="s-steps row">
            <li><span className="s-num">1</span><span><b>Apply online</b><br />Business name, who we speak to, and where we deliver.</span></li>
            <li><span className="s-num">2</span><span><b>We set you up</b><br />Your prices, delivery day and how you're invoiced.</span></li>
            <li><span className="s-num">3</span><span><b>Order online</b><br />Your team signs in, orders and downloads invoices.</span></li>
          </ol>
        </div>
      </section>
    </>
  );
}

/** The new opening (30 Oct 2026), then the original story, word for word (Everton, 21 Oct 2026). */
function About({ site }: { site: SiteInfo }) {
  return (
    <>
      <section className="s-band s-about-hero">
        <div className="wrap">
          <div className="s-about-copy">
            <p className="s-kicker">About us</p>
            <h1 className="display">Bottled in Jamaica, delivered by the people who make it</h1>
            <p>Alka Vida is a family-run alkaline water plant. The same team fills the bottles, drives the routes and answers the phone — so the water you order is the water we bottled that morning.</p>
            <div className="s-actions">
              <Link to="/shop" className="s-pill big">Shop the water</Link>
              <a href={`tel:+${digits(site.phone)}`} className="s-pill outline big">Call {site.phone}</a>
            </div>
          </div>
          <div className="s-photo-frame"><img src="/site/truck.jpg" alt="An Alka Vida delivery truck on the road" /></div>
        </div>
      </section>
      <section className="s-reasons" aria-label="What we stand for">
        <div className="wrap">
          <div className="s-reason"><span className="s-ph">pH 9+</span><span><b>Alkaline, every bottle</b><span className="muted">Purified and ionised at our plant.</span></span></div>
          <div className="s-reason"><span className="s-ring-icon text">JA</span><span><b>Made in Jamaica</b><span className="muted">Bottled from the aquifers in St. Catherine.</span></span></div>
          <div className="s-reason"><span className="s-ring-icon text">1</span><span><b>One team, start to finish</b><span className="muted">From the bottling line to your gate.</span></span></div>
        </div>
      </section>
      <article className="wrap s-story">
        <div className="s-story-text">
          <h2 className="display">Our History</h2>
          <p>Alka Vida was founded on a simple belief: what we put into our bodies shapes the way we live, feel, and thrive. Our journey began when our founder set out to support his father during a difficult period of declining wellness. Exploring natural approaches to nourishment, the family embraced an alkaline-focused lifestyle, prioritizing whole foods, clean hydration, and balance. At the heart of this shift was alkaline, ionized water, which became the foundation of their daily ritual and a catalyst for renewed vitality.</p>
          <p>Witnessing the remarkable improvements in energy, balance, and overall well-being, the family was inspired to share the same approach with others. Alka Vida was created to bring elevated hydration and alkaline living to households everywhere.</p>
          <h2 className="display" style={{ marginTop: 18 }}>Why Alkaline Water?</h2>
          <p>Alkaline water is valued for its smoother taste, its elevated pH which contains higher minerals such as calcium, magnesium and potassium. All whilst still helping to hydrate more efficiently.</p>
        </div>
        <aside className="s-mission" aria-labelledby="mission-h">
          <h2 id="mission-h" className="display">Our Mission</h2>
          <p>At Alka Vida, we aim to make clean, revitalizing hydration accessible to every household. We believe in supporting the body with what it needs to perform at its best, starting from the most essential element of life: water. From our story to your home, our purpose is rooted in family, wellness, and the desire to help others discover their own path to vibrant living.</p>
          <Link to="/shop" className="s-btn cyan" style={{ alignSelf: 'flex-start' }}>Shop the water</Link>
        </aside>
      </article>
    </>
  );
}

function Contact({ site }: { site: SiteInfo }) {
  const { search } = useLocation();
  const [name, setName] = useState('');
  const [about, setAbout] = useState(new URLSearchParams(search).get('about') === 'bottling' ? 'Bottling for my brand' : 'A question');
  const [message, setMessage] = useState('');
  // No mail is sent from the page: it opens the visitor's own email, so the
  // message arrives from their address and the reply goes back to it.
  const mailto = `mailto:${site.email}?subject=${encodeURIComponent(`${about}${name ? ` - ${name}` : ''}`)}&body=${encodeURIComponent(message)}`;
  return (
    <>
      <section className="s-band"><div className="wrap"><div><p className="s-kicker">Get in touch</p><h1 className="display">We'd love to assist you</h1><p>Questions about an order, a delivery or a business account? Call or WhatsApp the team. A person answers, not a menu.</p></div></div></section>
      <section className="s-section" style={{ paddingBottom: 72 }}>
        <div className="wrap s-row">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div className="s-two">
              <a href={`tel:+${digits(site.phone)}`} className="s-pill">Call us</a>
              <a href={waLink(site.whatsapp)} className="s-pill outline">WhatsApp us</a>
            </div>
            <dl className="s-dl">
              <dt>Telephone</dt><dd><a href={`tel:+${digits(site.phone)}`}><b>{site.phone}</b></a></dd>
              <dt>WhatsApp</dt><dd><a href={waLink(site.whatsapp)}><b>{site.whatsapp}</b></a></dd>
              <dt>Email</dt><dd><a href={`mailto:${site.email}`}>{site.email}</a></dd>
              <dt>Plant</dt><dd>White Marl, Spanish Town, St Catherine</dd>
              <dt>Office hours</dt><dd>Mon to Fri, 9:00 am to 5:00 pm<br />Sat and Sun, closed</dd>
              <dt>We deliver to</dt><dd>Kingston, Portmore and Spanish Town</dd>
            </dl>
            <div className="s-follow">
              <b>Follow us</b>
              <div>
                <a href={INSTAGRAM} rel="noopener" className="s-chip-link"><span>{Icon.instagram}</span>@alkavida</a>
                <a href={FACEBOOK} rel="noopener" className="s-chip-link"><span>{Icon.facebook}</span>Alka Vida Alkaline Water</a>
              </div>
            </div>
          </div>
          <form className="s-panel" onSubmit={(e) => { e.preventDefault(); window.location.href = mailto; }} aria-labelledby="msg-h" style={{ padding: 28 }}>
            <h2 id="msg-h" className="display" style={{ fontSize: 30 }}>Send us a message</h2>
            <div className="s-two">
              <div className="s-field"><label htmlFor="c-name">Name</label><input id="c-name" value={name} onChange={(e) => setName(e.target.value)} /></div>
              <div className="s-field"><label htmlFor="c-about">About</label>
                <select id="c-about" value={about} onChange={(e) => setAbout(e.target.value)}>
                  <option>A question</option><option>A business account</option><option>Bottling for my brand</option><option>A delivery</option>
                </select>
              </div>
              <div className="s-field full"><label htmlFor="c-msg">Message</label><textarea id="c-msg" rows={5} required value={message} onChange={(e) => setMessage(e.target.value)} /></div>
            </div>
            <button className="s-pill" style={{ alignSelf: 'flex-start' }}>Send by email</button>
            <p className="muted small">This opens your email with the message ready to send to {site.email}.</p>
          </form>
        </div>
      </section>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Quick order (no account) - replaces the JotForm                     */
/* ------------------------------------------------------------------ */

const PARISHES = ['Kingston', 'St Andrew', 'St Catherine', 'St Thomas', 'Portland', 'St Mary', 'St Ann',
  'Trelawny', 'St James', 'Hanover', 'Westmoreland', 'St Elizabeth', 'Manchester', 'Clarendon'];
const SIZE_AT_END = /\s+(\d+(?:\.\d+)?\s*(?:ml|l|ltr|litres?|liters?|gal|gallons?|oz))$/i;
/** Product, then size (11 Oct 2026 ruling): "Alka Vida 500ml" → "Alka Vida". */
const familyOf = (p: SiteProduct) => {
  const m = p.name.match(SIZE_AT_END);
  return m && m.index !== undefined ? p.name.slice(0, m.index).trim() : p.name;
};
const DAY_WORDS: Record<string, string> = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' };

interface Line { key: number; family: string; productId: string; qty: number }

function QuickOrder({ site, loaded }: { site: SiteInfo; loaded: boolean }) {
  const { search } = useLocation();
  const cart = useCart();
  const started = useRef(false);
  const families = useMemo(() => Array.from(new Set(site.products.map(familyOf))), [site.products]);
  const [lines, setLines] = useState<Line[]>([]);
  const [f, setF] = useState({
    firstName: '', lastName: '', businessName: '', phone: '', email: '',
    addressLine1: '', addressLine2: '', city: '', parish: '', preferredDay: '', notes: '', website: '',
  });
  const [fulfilment, setFulfilment] = useState<'Deliver' | 'Collect'>('Deliver');
  const [payMethod, setPayMethod] = useState<'Cash' | 'Bank Transfer'>('Cash');
  const [noEmpties, setNoEmpties] = useState(false);
  const [pin, setPin] = useState<DroppedPin | null>(null);
  const [wantsAccount, setWantsAccount] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ reference: string; name: string } | null>(null);

  // Start with what is in the cart (31 Oct 2026); else the item asked for
  // (?item=), else the 5 gallon.
  useEffect(() => {
    if (started.current || !loaded || site.products.length === 0) return;
    started.current = true;
    const inCart = [...site.products].sort(shopOrder).filter((p) => cart.lines[p.id]);
    if (inCart.length) {
      setLines(inCart.map((p, k) => ({ key: k + 1, family: familyOf(p), productId: p.id, qty: cart.lines[p.id] })));
      return;
    }
    const asked = new URLSearchParams(search).get('item');
    const first = site.products.find((p) => p.id === asked) ?? site.products.find((p) => p.unit === 'bottle') ?? site.products[0];
    setLines([{ key: 1, family: familyOf(first), productId: first.id, qty: 1 }]);
  }, [loaded, site.products, search, cart.lines]);

  // The cart follows changes made here, so the header's count stays right.
  const { replace } = cart;
  useEffect(() => {
    if (!started.current || lines.length === 0) return;
    const next: CartLines = {};
    for (const l of lines) if (l.productId) next[l.productId] = (next[l.productId] ?? 0) + l.qty;
    replace(next);
  }, [lines, replace]);

  const byId = new Map(site.products.map((p) => [p.id, p]));
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const change = (key: number, patch: Partial<Line>) => setLines(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const pickFamily = (key: number, family: string) => {
    const first = site.products.find((p) => familyOf(p) === family);
    change(key, { family, productId: first?.id ?? '' });
  };
  const addLine = () => {
    const p = site.products[0];
    if (p) setLines([...lines, { key: Date.now(), family: familyOf(p), productId: p.id, qty: 1 }]);
  };

  const money = siteTotals(lines.flatMap((l) => { const p = byId.get(l.productId); return p ? [{ p, qty: l.qty }] : []; }));
  const hasFiveGal = lines.some((l) => byId.get(l.productId)?.unit === 'bottle');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ reference: string; name: string }>('/api/public/order', {
        ...f, fulfilment, payMethod, noEmpties: hasFiveGal && noEmpties, wantsAccount: wantsAccount && !!f.email.trim(),
        preferredDay: f.preferredDay || null,
        lat: fulfilment === 'Deliver' ? pin?.lat ?? null : null,
        lng: fulfilment === 'Deliver' ? pin?.lng ?? null : null,
        accuracyM: fulfilment === 'Deliver' ? pin?.accuracyM ?? null : null,
        lines: lines.map((l) => ({ productId: l.productId, qty: l.qty })),
      });
      setDone(r);
      cart.clear();
      window.scrollTo(0, 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Your order could not be sent. Please try again, or call us.');
    } finally { setBusy(false); }
  }

  if (done) {
    return (
      <section className="s-section">
        <div className="wrap" style={{ maxWidth: 720 }}>
          <div className="s-panel" style={{ padding: 32, gap: 16 }}>
            <h1 className="display" style={{ fontSize: 44 }}>Thank you, {done.name}</h1>
            <p style={{ fontSize: 18 }}>We have your order. Your reference is <b>{done.reference}</b>.</p>
            <p>We'll confirm it with you by WhatsApp or phone on {f.phone}, with your total and delivery day.</p>
            {wantsAccount && f.email && <p className="s-ok">Once we've booked it, we'll email {f.email} a link to set your password, so next time you can order in two taps.</p>}
            <div className="s-actions"><Link to="/" className="s-btn primary">Back to home</Link><a href={waLink(site.whatsapp, `Hi Alka Vida, about my order ${done.reference}`)} className="s-btn plain">WhatsApp us</a></div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <div className="wrap s-order">
      <form className="s-order-form" onSubmit={submit} aria-labelledby="qo-h">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <h1 id="qo-h" className="display" style={{ fontSize: 48 }}>Order water</h1>
          <p style={{ fontSize: 17 }}>No account needed. We'll confirm your order and delivery day by WhatsApp or phone.</p>
        </div>
        <div className="s-info" style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 16px' }}>
          <span style={{ flex: '1 1 300px' }}>Already have an account? Sign in for your prices and saved addresses.</span>
          <Link to="/sign-in" style={{ color: 'var(--info)' }}><b>Sign in</b></Link>
        </div>
        {error && <div className="s-error" role="alert">{error}</div>}

        <fieldset className="s-panel" style={{ margin: 0 }}>
          <h2><span className="s-num">1</span>What you need</h2>
          {loaded && site.products.length === 0 && <p className="s-info">Ordering online opens once our price list is set. Call or WhatsApp us on {site.phone}.</p>}
          {lines.map((l, i) => {
            const p = byId.get(l.productId);
            const sizes = site.products.filter((q) => familyOf(q) === l.family);
            return (
              <div key={l.key} className="s-line">
                <div className="s-field"><label htmlFor={`p${l.key}`} className={i ? 'sr-only' : ''}>Product</label>
                  <select id={`p${l.key}`} value={l.family} onChange={(e) => pickFamily(l.key, e.target.value)}>
                    {families.map((fam) => <option key={fam}>{fam}</option>)}
                  </select></div>
                <div className="s-field"><label htmlFor={`s${l.key}`} className={i ? 'sr-only' : ''}>Size</label>
                  <select id={`s${l.key}`} value={l.productId} onChange={(e) => change(l.key, { productId: e.target.value })}>
                    {sizes.map((q) => <option key={q.id} value={q.id}>{sizeLabel(q)}{q.unit === 'case' ? ` · case of ${q.bottlesPerCase}` : ''}</option>)}
                  </select></div>
                <div className="s-field"><label htmlFor={`q${l.key}`} className={i ? 'sr-only' : ''}>{p?.unit === 'case' ? 'Cases' : 'Bottles'}</label>
                  <div className="s-stepper">
                    <button type="button" aria-label="One fewer" onClick={() => change(l.key, { qty: Math.max(1, l.qty - 1) })}>−</button>
                    <input id={`q${l.key}`} inputMode="numeric" value={l.qty} onChange={(e) => change(l.key, { qty: Math.max(1, Math.min(500, Number(e.target.value.replace(/\D/g, '')) || 1)) })} />
                    <button type="button" aria-label="One more" onClick={() => change(l.key, { qty: Math.min(500, l.qty + 1) })}>+</button>
                  </div></div>
                <span className="s-amount">{p && p.priceCents > 0 ? jmd(shownCents(p) * l.qty) : '—'}</span>
                <button type="button" className="s-remove" aria-label={`Remove line ${i + 1}`} disabled={lines.length === 1}
                        onClick={() => setLines(lines.filter((x) => x.key !== l.key))}>×</button>
              </div>
            );
          })}
          <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: '8px 24px', alignItems: 'center' }}>
            <button type="button" className="s-link-btn" style={{ textDecoration: 'none', fontWeight: 700, minHeight: 44 }} onClick={addLine} disabled={!site.products.length}>+ Add another item</button>
            {hasFiveGal && <label className="s-check"><input type="checkbox" checked={noEmpties} onChange={(e) => setNoEmpties(e.target.checked)} /> This is my first 5 gallon order. I have no empty to swap.</label>}
          </div>
        </fieldset>

        <fieldset className="s-panel" style={{ margin: 0 }}>
          <h2><span className="s-num">2</span>You, and where it goes</h2>
          <div className="s-seg" role="group" aria-label="Delivery or collection">
            <button type="button" aria-pressed={fulfilment === 'Deliver'} onClick={() => setFulfilment('Deliver')}>Deliver to me</button>
            <button type="button" aria-pressed={fulfilment === 'Collect'} onClick={() => setFulfilment('Collect')}>I'll collect at White Marl</button>
          </div>
          <div className="s-two">
            <div className="s-field"><label htmlFor="fn">First name</label><input id="fn" required autoComplete="given-name" value={f.firstName} onChange={set('firstName')} /></div>
            <div className="s-field"><label htmlFor="ln">Last name</label><input id="ln" required autoComplete="family-name" value={f.lastName} onChange={set('lastName')} /></div>
            <div className="s-field"><label htmlFor="ph">Phone (WhatsApp if you have it)</label><input id="ph" type="tel" required autoComplete="tel" placeholder="876-" value={f.phone} onChange={set('phone')} /></div>
            <div className="s-field"><label htmlFor="em">Email, for your receipt</label><input id="em" type="email" autoComplete="email" value={f.email} onChange={set('email')} /></div>
            <div className="s-field full"><label htmlFor="bn">Business name (if this is for a business)</label><input id="bn" autoComplete="organization" value={f.businessName} onChange={set('businessName')} /></div>
            {fulfilment === 'Deliver' && <>
              <div className="s-field"><label htmlFor="a1">Street and number</label><input id="a1" required autoComplete="address-line1" value={f.addressLine1} onChange={set('addressLine1')} /></div>
              <div className="s-field"><label htmlFor="a2">Building, unit or landmark</label><input id="a2" autoComplete="address-line2" value={f.addressLine2} onChange={set('addressLine2')} /></div>
              <div className="s-field"><label htmlFor="tw">Town</label><input id="tw" required autoComplete="address-level2" value={f.city} onChange={set('city')} /></div>
              <div className="s-field"><label htmlFor="pa">Parish</label>
                <select id="pa" required value={f.parish} onChange={set('parish')}>
                  <option value="">Choose…</option>{PARISHES.map((p) => <option key={p}>{p}</option>)}
                </select></div>
              <div className="s-field"><label htmlFor="dd">Day you'd like it</label>
                <select id="dd" value={f.preferredDay} onChange={set('preferredDay')}>
                  <option value="">Your area's next delivery day</option>
                  {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => <option key={d} value={d}>{DAY_WORDS[d]}</option>)}
                </select></div>
              <p className="muted small" style={{ alignSelf: 'end' }}>We deliver to each area on set days and will confirm yours.</p>
              <PinPicker value={pin} onChange={setPin} className="full" />
            </>}
            <div className="s-field full"><label htmlFor="nt">{fulfilment === 'Deliver' ? 'Anything the driver should know (optional)' : 'Anything we should know (optional)'}</label>
              <input id="nt" placeholder={fulfilment === 'Deliver' ? 'Gate code, call on arrival…' : ''} value={f.notes} onChange={set('notes')} /></div>
          </div>
          <div className="s-hp" aria-hidden="true"><label htmlFor="website">Leave this empty</label><input id="website" tabIndex={-1} autoComplete="off" value={f.website} onChange={set('website')} /></div>
        </fieldset>

        <fieldset className="s-panel" style={{ margin: 0 }}>
          <h2><span className="s-num">3</span>Paying</h2>
          <label className="s-check"><input type="radio" name="pay" checked={payMethod === 'Cash'} onChange={() => setPayMethod('Cash')} /> {fulfilment === 'Deliver' ? 'Pay on delivery' : 'Pay when you collect'}</label>
          <label className="s-check"><input type="radio" name="pay" checked={payMethod === 'Bank Transfer'} onChange={() => setPayMethod('Bank Transfer')} /> Bank transfer. We'll send our JMMB details with your confirmation.</label>
        </fieldset>

        <label className="s-account-opt">
          <input type="checkbox" checked={wantsAccount} onChange={(e) => setWantsAccount(e.target.checked)} />
          <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <b style={{ fontSize: 16 }}>Open an account with this order</b>
            <span>We'll email you a link to set a password. Next time you can order again in two taps, follow your delivery and get your receipts in one place.{wantsAccount && !f.email.trim() ? ' Add your email above for this.' : ''}</span>
          </span>
        </label>

        <div className="s-actions" style={{ alignItems: 'center' }}>
          <button className="s-btn primary big" disabled={busy || lines.length === 0}>{busy ? 'Sending…' : 'Send order'}</button>
          <span className="muted small">Same-day orders after our cut-off go to the office to approve.</span>
        </div>
      </form>

      <aside className="s-order-side" aria-label="Your order">
        <div className="s-panel">
          <h2>Your order</h2>
          {lines.map((l) => {
            const p = byId.get(l.productId);
            if (!p) return null;
            return <div key={l.key} className="s-sum"><span>{l.qty} x {sizeLabel(p)}{p.unit === 'case' ? (l.qty === 1 ? ' case' : ' cases') : ''}</span><span>{p.priceCents > 0 ? jmd(shownCents(p) * l.qty) : '—'}</span></div>;
          })}
          {!money.unpriced && money.total > 0 && <>
            <div className="s-sum total" style={{ fontWeight: 400 }}><span>Subtotal</span><span>{jmd(money.shown)}</span></div>
            {money.gctOnCases > 0 && <div className="s-sum"><span>GCT on cases (15%)</span><span>{jmd(money.gctOnCases)}</span></div>}
            <div className="s-sum total"><span>Estimated total</span><span style={{ fontSize: 20 }}>{jmd(money.total)}</span></div>
          </>}
          <p className="muted small">At our listed prices; the 5 gallon includes GCT. We confirm the final total before delivery{hasFiveGal && noEmpties ? ', including the bottle for your first 5 gallon' : ''}.</p>
        </div>
        <div className="s-panel">
          <h2>What happens next</h2>
          <ol className="s-track">
            <li><span className="s-dot" /><span><b>We get your order</b> straight away.</span></li>
            <li><span className="s-dot hollow" /><span><b>We confirm it</b> by WhatsApp or phone, with your total and day.</span></li>
            <li><span className="s-dot hollow" /><span><b>We {fulfilment === 'Deliver' ? 'deliver' : 'have it ready'}</b> on your day.</span></li>
            <li><span className="s-dot hollow" /><span><b>Your receipt</b> comes by email.</span></li>
          </ol>
        </div>
        <p className="small">Questions? <a href={waLink(site.whatsapp)}><b>WhatsApp {site.whatsapp}</b></a></p>
      </aside>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The site                                                            */
/* ------------------------------------------------------------------ */

/**
 * Every public page's address. "/" is the home page only when nobody is
 * signed in. None may be an address the app itself uses (/delivery is the
 * office's Delivery rounds), or signed-in staff would land on the website
 * instead - the website's delivery page is /how-we-deliver (23 Oct 2026).
 */
export const SITE_PATHS = ['/', '/shop', '/water', '/how-we-deliver', '/your-account', '/business', '/about', '/contact', '/order'];

const TITLES: Record<string, string> = {
  '/': 'Alka Vida · Alkaline water, delivered fresh to your door', '/shop': 'Shop · Alka Vida', '/water': 'Our water · Alka Vida',
  '/how-we-deliver': 'Delivery · Alka Vida', '/your-account': 'Your account · Alka Vida',
  '/business': 'For business · Alka Vida', '/about': 'About us · Alka Vida',
  '/contact': 'Contact · Alka Vida', '/order': 'Order water · Alka Vida',
};

export default function PublicSite({ session, onSignedIn }: { session: Session | null; onSignedIn: (s: Session) => void }) {
  const { pathname } = useLocation();
  const { site, loaded } = useSite();
  const cart = useCartState();
  const [query, setQuery] = useState('');
  useEffect(() => {
    const before = document.title;
    document.title = TITLES[pathname] ?? 'Alka Vida';
    return () => { document.title = before; };
  }, [pathname]);

  let page: React.ReactNode;
  switch (pathname) {
    case '/water': page = <Water site={site} loaded={loaded} />; break;
    case '/how-we-deliver': page = <Delivery site={site} />; break;
    case '/your-account': page = <YourAccount onSignedIn={onSignedIn} session={session} />; break;
    case '/business': page = <Business />; break;
    case '/about': page = <About site={site} />; break;
    case '/contact': page = <Contact site={site} />; break;
    case '/order': page = <QuickOrder site={site} loaded={loaded} />; break;
    default: page = <Home site={site} loaded={loaded} session={session} query={query} />;
  }
  return (
    <CartContext.Provider value={cart}>
      <div className="site">
        <SiteHeader session={session} query={query} onQuery={setQuery} />
        <main>{page}</main>
        <SiteFooter site={site} />
        <CartDrawer site={site} />
      </div>
    </CartContext.Provider>
  );
}
