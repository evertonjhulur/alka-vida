/**
 * The public website at alkavidaja.com (Everton, 21 Oct 2026).
 *
 * "One site": the app serves the domain, so the website and the app are one
 * address. These pages are for everybody, signed in or not. Built from the
 * approved mockups (round 2: separate pages, not one long home page; the
 * About page keeps the original story word for word).
 *
 * What comes from the system, so it is never typed twice:
 *  - the products and their LISTED prices (Products & pricing - the price a
 *    walk-in or a customer with no price tier pays);
 *  - the delivery zones and their days (Settings › Delivery zones);
 *  - the WhatsApp number (Settings › Emails & ordering), else 876-528-6112.
 *
 * Size photos: put them in packages/web/public/site/ named after the size -
 * 5gal.jpg, 5l.jpg, 1.5l.jpg, 500ml.jpg, 280ml.jpg. Until then a drawn
 * bottle stands in.
 */

import { useEffect, useMemo, useState } from 'react';
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
const BLURB: Record<string, string> = {
  '5gal': 'Refills for home and office dispensers. We swap your empty.',
  '5l': 'With a handle. For the kitchen, the car or the site.',
  '1.5l': 'The family size for the fridge.',
  '500ml': 'For the bag, the gym and the office fridge.',
  '280ml': 'Lunch boxes, meetings and events.',
};
const packLabel = (p: SiteProduct) => (p.unit === 'case' ? `Case of ${p.bottlesPerCase}` : 'Delivered');
const priceLine = (p: SiteProduct) => (p.priceCents > 0
  ? <><b>{jmd(p.priceCents)}</b> {p.unit === 'case' ? 'a case' : 'a bottle'}</>
  : <span className="muted">Call us for the price</span>);

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
function ProductPhoto({ product, square }: { product: SiteProduct; square?: boolean }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="s-photo" style={square ? { aspectRatio: '1 / 1' } : undefined}>
      {failed
        ? <BottleDrawing size={product.size} />
        : <img src={`/site/${sizeKey(product.size)}.jpg`} alt={`Alka Vida ${sizeLabel(product)}`} onError={() => setFailed(true)} />}
    </div>
  );
}

const NAV: Array<[string, string]> = [
  ['/water', 'Our water'], ['/how-we-deliver', 'Delivery'], ['/your-account', 'Your account'],
  ['/business', 'For business'], ['/about', 'About us'], ['/contact', 'Contact'],
];

function SiteHeader({ session }: { session: Session | null }) {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => { setOpen(false); window.scrollTo(0, 0); }, [pathname]);
  return (
    <header className={`s-head${open ? ' open' : ''}`}>
      <div className="wrap">
        <Link to="/" className="s-logo" aria-label="Alka Vida home"><Logo height={60} /></Link>
        <span className="s-head-spacer" />
        <nav className="s-nav" aria-label="Main">
          {NAV.map(([to, label]) => (
            <NavLink key={to} to={to} className={({ isActive }) => (isActive ? 'active' : '')}>{label}</NavLink>
          ))}
        </nav>
        <div className="s-head-actions">
          {session
            ? <Link to="/" className="s-btn plain">Open the app</Link>
            : <Link to="/sign-in" className="s-btn plain">Sign in</Link>}
          <Link to="/order" className="s-btn primary order">Order water</Link>
        </div>
        <button type="button" className="s-menu-btn" aria-label="Menu" aria-expanded={open} onClick={() => setOpen(!open)}>
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20"><path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
        </button>
      </div>
    </header>
  );
}

function SiteFooter({ site }: { site: SiteInfo }) {
  return (
    <footer className="s-foot-band">
      <div className="wrap">
        <div className="s-foot-brand">
          <span className="display">Alka Vida</span>
          <span>Alkaline drinking water from White Marl, St Catherine.</span>
          <span><a href={`tel:+${digits(site.phone)}`}><b>{site.phone}</b></a> · <a href={`mailto:${site.email}`}>{site.email}</a></span>
        </div>
        <nav className="s-foot-nav" aria-label="Footer">
          <Link to="/order">Order water</Link>
          <Link to="/sign-in">Sign in</Link>
          <Link to="/register">Open an account</Link>
          <Link to="/business">For business</Link>
          <Link to="/about">About us</Link>
          <Link to="/contact">Contact</Link>
          <a href="https://www.facebook.com/AlkaVidaAlkalineWater/" rel="noopener">Facebook</a>
          <a href="https://www.instagram.com/alkavida/" rel="noopener">Instagram</a>
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

function Home({ site, onSignedIn, session }: { site: SiteInfo; onSignedIn: (s: Session) => void; session: Session | null }) {
  return (
    <>
      <section className="s-hero">
        <div className="wrap">
          <div className="s-hero-copy">
            <p className="s-eyebrow">pH 9+ alkaline drinking water · bottled in St Catherine</p>
            <h1 className="display">Alkaline water,<br />delivered on your day.</h1>
            <p className="lead">5 gallon delivery for homes and offices, and cases from 280ml to 5L. Order in a minute without an account, or sign in to order again, track deliveries and see your statement.</p>
            <div className="s-actions">
              <Link to="/order" className="s-btn primary big">Order water</Link>
              <Link to="/register" className="s-btn outline big">Open an account</Link>
            </div>
            <p>Rather WhatsApp? <a href={waLink(site.whatsapp, 'Hi Alka Vida, I would like to place an order:')} style={{ color: 'var(--nav)' }}><b>Message us on {site.whatsapp}</b></a></p>
          </div>
          {session
            ? <div className="s-signin"><h2 className="display">Welcome back</h2><p>You are signed in as {session.name}.</p><Link to="/" className="s-btn primary block">Open the app</Link></div>
            : <SignInCard onSignedIn={onSignedIn} />}
        </div>
      </section>

      <section className="s-reasons" aria-label="Why Alka Vida">
        <div className="wrap">
          <div className="s-reason"><span className="s-ph">pH 9+</span><span><b>Alkaline, every bottle</b><span className="muted">Smooth taste, bottled at our White Marl plant.</span></span></div>
          <div className="s-reason"><span className="s-ph" style={{ background: '#f2fafc', border: '2px solid var(--cyan)', color: 'var(--brand)' }}>Day</span><span><b>Delivered on your area's day</b><span className="muted">Each area has set delivery days, so you know when we come.</span></span></div>
          <div className="s-reason"><span className="s-ph" style={{ background: '#f2fafc', border: '2px solid var(--cyan)', color: 'var(--brand)' }}>J$</span><span><b>Pay the way that suits you</b><span className="muted">Cash or bank transfer on delivery, or on account for businesses.</span></span></div>
        </div>
      </section>

      {site.products.length > 0 && (
        <section className="s-section grey" aria-labelledby="range-h">
          <div className="wrap">
            <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-end', gap: '8px 24px', marginBottom: 18 }}>
              <h2 id="range-h" className="display" style={{ fontSize: 40, margin: 0 }}>Our water</h2>
              <Link to="/water"><b>See all sizes and prices →</b></Link>
            </div>
            <div className="s-strip">
              {site.products.map((p) => (
                <Link key={p.id} to="/water" className="s-tile">
                  <ProductPhoto product={p} square />
                  <b style={{ fontSize: 17 }}>{sizeLabel(p)}</b>
                  <span className="muted small">{p.priceCents > 0 ? `${jmd(p.priceCents)} ${p.unit === 'case' ? 'a case' : 'a bottle'}` : packLabel(p)}</span>
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}

      <section className="s-section" aria-label="Find out more">
        <div className="wrap s-grid three">
          <Link to="/how-we-deliver" className="s-door aqua"><b>How delivery works</b><span>Order, we bring it on your area's day, you pay and get a receipt.</span><span className="go">Delivery and paying →</span></Link>
          <Link to="/your-account" className="s-door indigo"><b>Your water account, online</b><span>Order again, follow your delivery, see your statement and receipts.</span><span className="go">What you can do →</span></Link>
          <Link to="/business" className="s-door"><b>For business</b><span>Business accounts with your own prices, and water bottled under your own label.</span><span className="go">Business accounts →</span></Link>
        </div>
      </section>
    </>
  );
}

function Water({ site, loaded }: { site: SiteInfo; loaded: boolean }) {
  return (
    <>
      <section className="s-band">
        <div className="wrap">
          <div style={{ flex: '1 1 520px' }}>
            <h1 className="display">Our water</h1>
            <p>pH 9+ alkaline drinking water. Prices shown are our listed prices, before GCT. Business and distributor prices show once you sign in.</p>
          </div>
          <Link to="/order" className="s-btn primary big">Order water</Link>
        </div>
      </section>
      <section className="s-section grey" aria-label="Sizes and prices">
        <div className="wrap">
          {loaded && site.products.length === 0 && <p className="s-info">Our price list is being updated. Call or WhatsApp us on {site.phone} for prices.</p>}
          <div className="s-grid">
            {site.products.map((p) => (
              <article key={p.id} className={`s-card${p.unit === 'bottle' ? ' featured' : ''}`}>
                <ProductPhoto product={p} />
                <span className={`s-chip${p.unit === 'bottle' ? ' info' : ''}`}>{packLabel(p)}</span>
                <h2>{sizeLabel(p)}</h2>
                {site.products.filter((q) => sizeKey(q.size) === sizeKey(p.size)).length > 1 && <span className="small">{p.name}</span>}
                <p className="muted small">{BLURB[sizeKey(p.size)] ?? ''}</p>
                <p className="s-price price">{priceLine(p)}</p>
                <Link to={`/order?item=${p.id}`} className={`s-btn ${p.unit === 'bottle' ? 'primary' : 'plain'} block`} style={{ minHeight: 44 }}>Add to order</Link>
              </article>
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

const DAY_WORDS: Record<string, string> = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' };
const dayList = (days: string[]) => days.map((d) => DAY_WORDS[d] ?? d).join(' and ');

function Delivery({ site }: { site: SiteInfo }) {
  const zones = site.zones.filter((z) => z.days.length > 0);
  const [zone, setZone] = useState('');
  const chosen = zones.find((z) => z.name === zone);
  return (
    <>
      <section className="s-band"><div className="wrap"><div><h1 className="display">How delivery works</h1><p>We deliver to each area on set days, so you always know when we're coming.</p></div></div></section>
      <section className="s-section" style={{ paddingBottom: 24 }}>
        <div className="wrap">
          <ol className="s-steps">
            <li><span className="s-num">1</span><b>Order</b><span>Here on the site, in your account, or on WhatsApp. Set up a standing order and we'll bring the same every week.</span></li>
            <li><span className="s-num">2</span><b>We deliver on your day</b><span>We confirm your order and bring it on your area's delivery day. Another day can be asked for; the office confirms it.</span></li>
            <li><span className="s-num">3</span><b>Pay and get a receipt</b><span>Pay the driver by cash or transfer, or pay on account. Your invoice and receipt arrive by email.</span></li>
          </ol>
        </div>
      </section>
      <section className="s-section" style={{ paddingTop: 24, paddingBottom: 24 }}>
        <div className="wrap s-row">
          <div className="s-box info" style={{ gap: 12, padding: 26 }}>
            <h2 style={{ fontSize: 22, color: 'var(--info)' }}>When do you come to my area?</h2>
            {zones.length === 0
              ? <span>Call or WhatsApp us on {site.phone} and we'll tell you your delivery day.</span>
              : <>
                  <div className="s-field" style={{ maxWidth: 360 }}>
                    <label htmlFor="area" style={{ color: 'var(--ink)' }}>Your area</label>
                    <select id="area" value={zone} onChange={(e) => setZone(e.target.value)}>
                      <option value="">Choose your area…</option>
                      {zones.map((z) => <option key={z.name} value={z.name}>{z.name}</option>)}
                    </select>
                  </div>
                  {chosen && <p><b>We deliver to {chosen.name} on {dayList(chosen.days)}.</b>{chosen.covers ? <span className="muted"> Covers {chosen.covers}.</span> : null}</p>}
                  <span className="small">Area not listed? Call us on {site.phone}.</span>
                </>}
          </div>
          <div className="s-box" style={{ gap: 14, padding: 26 }}>
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
          <div className="s-grid three">
            <div className="s-box"><b className="title">Cash to the driver</b><span>Pay when your water arrives. The driver gives you a receipt.</span></div>
            <div className="s-box"><b className="title">Bank transfer</b><span>To 1506 Investments Limited at JMMB. We send the details with your confirmation.</span></div>
            <div className="s-box"><b className="title">On account</b><span>For business accounts: one invoice a week or a month, with statements by email.</span></div>
          </div>
          <p className="muted small" style={{ marginTop: 16 }}>Same-day orders after our cut-off go to the office to approve. You can cancel an order until the driver starts the round.</p>
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

/** The original About Us copy, word for word (Everton, 21 Oct 2026). */
function About() {
  return (
    <>
      <section className="s-band"><div className="wrap"><h1 className="display">About Us</h1></div></section>
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
          <Link to="/order" className="s-btn cyan" style={{ alignSelf: 'flex-start' }}>Order water</Link>
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
      <section className="s-band"><div className="wrap"><div><h1 className="display">Contact Us</h1><p>We can't wait to hear from you.</p></div></div></section>
      <section className="s-section" style={{ paddingBottom: 72 }}>
        <div className="wrap s-row">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div className="s-two">
              <a href={`tel:+${digits(site.phone)}`} className="s-btn primary">Call us</a>
              <a href={waLink(site.whatsapp)} className="s-btn plain">WhatsApp us</a>
            </div>
            <dl className="s-dl">
              <dt>Telephone</dt><dd><a href={`tel:+${digits(site.phone)}`}><b>{site.phone}</b></a></dd>
              {site.whatsapp !== site.phone && <><dt>WhatsApp</dt><dd><a href={waLink(site.whatsapp)}>{site.whatsapp}</a></dd></>}
              <dt>Email</dt><dd><a href={`mailto:${site.email}`}>{site.email}</a></dd>
              <dt>Plant</dt><dd>White Marl, Spanish Town, St Catherine</dd>
              <dt>Office hours</dt><dd>Mon to Fri, 9:00 am to 5:00 pm<br />Sat and Sun, closed</dd>
            </dl>
          </div>
          <form className="s-panel" onSubmit={(e) => { e.preventDefault(); window.location.href = mailto; }} aria-labelledby="msg-h" style={{ padding: 28 }}>
            <h2 id="msg-h" className="display" style={{ fontSize: 30 }}>Drop us a line</h2>
            <div className="s-two">
              <div className="s-field"><label htmlFor="c-name">Name</label><input id="c-name" value={name} onChange={(e) => setName(e.target.value)} /></div>
              <div className="s-field"><label htmlFor="c-about">About</label>
                <select id="c-about" value={about} onChange={(e) => setAbout(e.target.value)}>
                  <option>A question</option><option>A business account</option><option>Bottling for my brand</option><option>A delivery</option>
                </select>
              </div>
              <div className="s-field full"><label htmlFor="c-msg">Message</label><textarea id="c-msg" rows={5} required value={message} onChange={(e) => setMessage(e.target.value)} /></div>
            </div>
            <button className="s-btn primary" style={{ alignSelf: 'flex-start' }}>Send by email</button>
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
const GCT = 0.15;

interface Line { key: number; family: string; productId: string; qty: number }

function QuickOrder({ site, loaded }: { site: SiteInfo; loaded: boolean }) {
  const { search } = useLocation();
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

  // Start with the item they chose on Our water, else the 5 gallon.
  useEffect(() => {
    if (!loaded || lines.length > 0 || site.products.length === 0) return;
    const asked = new URLSearchParams(search).get('item');
    const first = site.products.find((p) => p.id === asked) ?? site.products.find((p) => p.unit === 'bottle') ?? site.products[0];
    setLines([{ key: 1, family: familyOf(first), productId: first.id, qty: 1 }]);
  }, [loaded, site.products, search, lines.length]);

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

  const subtotal = lines.reduce((s, l) => s + (byId.get(l.productId)?.priceCents ?? 0) * l.qty, 0);
  const unpriced = lines.some((l) => (byId.get(l.productId)?.priceCents ?? 0) === 0);
  const gct = Math.round(subtotal * GCT);
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
                <span className="s-amount">{p && p.priceCents > 0 ? jmd(p.priceCents * l.qty) : '—'}</span>
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
          <label className="s-check"><input type="radio" name="pay" checked={payMethod === 'Cash'} onChange={() => setPayMethod('Cash')} /> Cash {fulfilment === 'Deliver' ? 'to the driver' : 'when you collect'}</label>
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
            return <div key={l.key} className="s-sum"><span>{l.qty} x {sizeLabel(p)}{p.unit === 'case' ? (l.qty === 1 ? ' case' : ' cases') : ''}</span><span>{p.priceCents > 0 ? jmd(p.priceCents * l.qty) : '—'}</span></div>;
          })}
          {!unpriced && subtotal > 0 && <>
            <div className="s-sum total" style={{ fontWeight: 400 }}><span>Subtotal</span><span>{jmd(subtotal)}</span></div>
            <div className="s-sum"><span>GCT 15%</span><span>{jmd(gct)}</span></div>
            <div className="s-sum total"><span>Estimated total</span><span style={{ fontSize: 20 }}>{jmd(subtotal + gct)}</span></div>
          </>}
          <p className="muted small">At our listed prices. We confirm the final total before delivery{hasFiveGal && noEmpties ? ', including the bottle for your first 5 gallon' : ''}.</p>
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
export const SITE_PATHS = ['/', '/water', '/how-we-deliver', '/your-account', '/business', '/about', '/contact', '/order'];

const TITLES: Record<string, string> = {
  '/': 'Alka Vida · Alkaline drinking water, delivered', '/water': 'Our water · Alka Vida',
  '/how-we-deliver': 'Delivery · Alka Vida', '/your-account': 'Your account · Alka Vida',
  '/business': 'For business · Alka Vida', '/about': 'About us · Alka Vida',
  '/contact': 'Contact · Alka Vida', '/order': 'Order water · Alka Vida',
};

export default function PublicSite({ session, onSignedIn }: { session: Session | null; onSignedIn: (s: Session) => void }) {
  const { pathname } = useLocation();
  const { site, loaded } = useSite();
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
    case '/about': page = <About />; break;
    case '/contact': page = <Contact site={site} />; break;
    case '/order': page = <QuickOrder site={site} loaded={loaded} />; break;
    default: page = <Home site={site} onSignedIn={onSignedIn} session={session} />;
  }
  return (
    <div className="site">
      <SiteHeader session={session} />
      <main>{page}</main>
      <SiteFooter site={site} />
    </div>
  );
}
