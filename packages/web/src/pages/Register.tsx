import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api, type Session } from '../lib/api';
import Logo from '../components/Logo';
import PinPicker, { type DroppedPin } from '../components/PinPicker';
import GoogleButton, { useGoogleEnabled } from '../components/GoogleButton';
import { EyeIcon, startedSession } from './Login';

/**
 * Create your account (approved design, 31 Oct 2026). No approval any more:
 * "allow customers to create accounts all the way through". Step 1 is Google
 * or email; step 2 the details for deliveries, with the delivery area picked
 * from the zones (and their days). The account is made at once - Retail for
 * a home, Corporate for a business, pay on delivery - and they are signed in.
 */

type AccountType = 'Corporate' | 'Individual';

/** The fourteen parishes, as the server checks them. */
const PARISHES = [
  'Kingston', 'St Andrew', 'St Thomas', 'Portland', 'St Mary', 'St Ann',
  'Trelawny', 'St James', 'Hanover', 'Westmoreland', 'St Elizabeth',
  'Manchester', 'Clarendon', 'St Catherine',
];
/** The same maximums the server checks (registration.MAX). */
const MAX = { name: 120, email: 254, phone: 30, line: 160, town: 80 };
const DAY_WORDS: Record<string, string> = { Mon: 'Mondays', Tue: 'Tuesdays', Wed: 'Wednesdays', Thu: 'Thursdays', Fri: 'Fridays', Sat: 'Saturdays', Sun: 'Sundays' };
const NOT_SURE = '__not_sure';

interface Zone { name: string; covers: string | null; days: string[] }
interface GoogleStart { credential: string; profile?: { email: string; firstName: string; lastName: string } }

export default function Register({ onSignedIn }: { onSignedIn: (s: Session) => void }) {
  const navigate = useNavigate();
  const fromSignIn = (useLocation().state as { google?: GoogleStart } | null)?.google ?? null;
  const google = useGoogleEnabled();
  const [via, setVia] = useState<'google' | 'email' | null>(fromSignIn ? 'google' : null);
  const [g, setG] = useState<GoogleStart | null>(fromSignIn);
  const [kind, setKind] = useState<AccountType>('Individual');
  const [f, setF] = useState({
    businessName: '', firstName: fromSignIn?.profile?.firstName ?? '', lastName: fromSignIn?.profile?.lastName ?? '',
    email: '', password: '', phone: '', addressLine1: '', addressLine2: '', city: '', parish: '', zone: '',
  });
  const [show, setShow] = useState(false);
  const [pin, setPin] = useState<DroppedPin | null>(null);
  const [zones, setZones] = useState<Zone[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ name: string; confirmSent: boolean; existing: boolean } | null>(null);

  useEffect(() => {
    api.get<{ zones: Zone[] }>('/api/public/site').then((s) => setZones(s.zones)).catch(() => {});
  }, []);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  /** Google said who they are: signed in if we know them, else on to the details. */
  async function withGoogle(credential: string) {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ session?: Session; needsDetails?: boolean; profile?: GoogleStart['profile'] }>('/api/auth/google', { credential });
      if (r.session) {
        startedSession(r.session, onSignedIn);
        setDone({ name: r.session.name.split(' ')[0], confirmSent: false, existing: true });
        return;
      }
      setG({ credential, profile: r.profile });
      setF((x) => ({ ...x, firstName: x.firstName || r.profile?.firstName || '', lastName: x.lastName || r.profile?.lastName || '' }));
      setVia('google');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Google sign-in did not work');
    } finally { setBusy(false); }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!f.zone) { setError('Choose your delivery area, or "Not sure".'); return; }
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ session: Session; existing: boolean; confirmSent: boolean }>('/api/auth/signup', {
        method: via, credential: via === 'google' ? g?.credential : undefined,
        email: via === 'email' ? f.email : undefined, password: via === 'email' ? f.password : undefined,
        accountType: kind, businessName: kind === 'Corporate' ? f.businessName : null,
        firstName: f.firstName, lastName: f.lastName, phone: f.phone,
        addressLine1: f.addressLine1, addressLine2: f.addressLine2, city: f.city, parish: f.parish,
        zone: f.zone === NOT_SURE ? '' : f.zone,
        lat: pin?.lat ?? null, lng: pin?.lng ?? null, accuracyM: pin?.accuracyM ?? null,
      });
      startedSession(r.session, onSignedIn);
      setDone({ name: f.firstName, confirmSent: r.confirmSent, existing: r.existing });
      window.scrollTo(0, 0);
    } catch (err) {
      const m = err instanceof Error ? err.message : 'Your account could not be made';
      // Google's token lasts an hour: past that, ask them to press the button again.
      if (via === 'google' && /google sign-in did not work/i.test(m)) { setVia(null); setG(null); }
      setError(m);
    } finally { setBusy(false); }
  }

  const page = (body: React.ReactNode) => (
    <div className="auth-page">
      <div className="auth-top"><Link to="/">‹ Back to alkavidaja.com</Link></div>
      <main className="auth-col wide">
        <Link to="/" className="auth-logo" aria-label="Alka Vida home"><Logo height={84} /></Link>
        {body}
      </main>
    </div>
  );

  if (done) {
    return page(
      <div className="auth-card center">
        <span className="auth-tick" aria-hidden="true"><svg width="30" height="30" viewBox="0 0 24 24"><path d="m5 12 4.5 4.5L19 7" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg></span>
        <h1 className="auth-h1">{done.existing ? `Welcome back${done.name ? `, ${done.name}` : ''}` : `Welcome to Alka Vida${done.name ? `, ${done.name}` : ''}`}</h1>
        <p>{done.existing ? 'You already had an account with us, so we signed you into it.' : "Your account is ready and you're signed in. Order your first water now, or look around your account."}</p>
        {done.confirmSent && <p className="small muted">We've also sent a link to confirm your email address, so your receipts reach you.</p>}
        <div className="auth-actions">
          <button type="button" className="auth-submit" onClick={() => navigate('/portal/order')}>Order water</button>
          <button type="button" className="auth-submit outline" onClick={() => navigate('/')}>Go to my account</button>
        </div>
      </div>,
    );
  }

  if (!via) {
    return page(<>
      <h1 className="auth-h1">Create your account</h1>
      <p className="auth-sub">Order again in two taps, follow your delivery and see your statement, any time.</p>
      <div className="auth-card">
        {error && <div className="notice error" role="alert">{error}</div>}
        {google && <>
          <GoogleButton onCredential={withGoogle} text="continue_with" />
          <div className="auth-or" role="separator" aria-label="or"><span />OR<span /></div>
        </>}
        <button type="button" className="auth-submit outline" disabled={busy} onClick={() => { setError(null); setVia('email'); }}>
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="2" /><path d="m4 7 8 6 8-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /></svg>
          Continue with email
        </button>
        <p className="small muted" style={{ textAlign: 'center', margin: 0 }}>Just want water today? <Link to="/shop"><b>Order without an account</b></Link></p>
        <p className="small muted" style={{ textAlign: 'center', margin: 0 }}>By creating an account you agree to how we use your details in our <Link to="/privacy">privacy policy</Link>.</p>
      </div>
      <p className="auth-foot">Already have an account? <Link to="/sign-in"><b>Sign in</b></Link></p>
    </>);
  }

  const isBusiness = kind === 'Corporate';
  return page(<>
    <p className="auth-step">STEP 2 OF 2</p>
    <h1 className="auth-h1">A few details for your deliveries</h1>
    <form className="auth-card" onSubmit={submit}>
      {error && <div className="notice error" role="alert">{error}</div>}
      {via === 'google' && g?.profile && (
        <div className="auth-linked">
          <span><b>Connected with Google</b><span>{g.profile.email}</span></span>
          <button type="button" className="as-link" onClick={() => { setVia(null); setG(null); }}>Change</button>
        </div>
      )}

      <div className="auth-seg" role="group" aria-label="Kind of account">
        <button type="button" aria-pressed={!isBusiness} onClick={() => setKind('Individual')}>For my home</button>
        <button type="button" aria-pressed={isBusiness} onClick={() => setKind('Corporate')}>For a business</button>
      </div>

      {isBusiness && (
        <div className="auth-field"><label htmlFor="bn">Business name</label>
          <input id="bn" required maxLength={MAX.name} autoComplete="organization" value={f.businessName} onChange={set('businessName')} /></div>
      )}
      <div className="auth-two">
        <div className="auth-field"><label htmlFor="fn">First name</label>
          <input id="fn" required maxLength={MAX.name} autoComplete="given-name" value={f.firstName} onChange={set('firstName')} /></div>
        <div className="auth-field"><label htmlFor="ln">Last name</label>
          <input id="ln" required maxLength={MAX.name} autoComplete="family-name" value={f.lastName} onChange={set('lastName')} /></div>
      </div>
      {via === 'email' && <>
        <div className="auth-field"><label htmlFor="em">Email</label>
          <input id="em" type="email" required maxLength={MAX.email} autoComplete="email" placeholder="you@example.com" value={f.email} onChange={set('email')} /></div>
        <div className="auth-field"><label htmlFor="pw">Choose a password</label>
          <div className="auth-input">
            <input id="pw" type={show ? 'text' : 'password'} required minLength={8} autoComplete="new-password" placeholder="At least 8 characters" value={f.password} onChange={set('password')} />
            <button type="button" className="auth-eye" aria-label={show ? 'Hide password' : 'Show password'} onClick={() => setShow(!show)}><EyeIcon off={show} /></button>
          </div></div>
      </>}
      <div className="auth-field"><label htmlFor="ph">Phone (WhatsApp if you have it)</label>
        <input id="ph" type="tel" required maxLength={MAX.phone} autoComplete="tel" placeholder="876-" value={f.phone} onChange={set('phone')} /></div>

      <h2 className="auth-h2">Where we deliver</h2>
      <div className="auth-field"><label htmlFor="a1">Street and number</label>
        <input id="a1" required maxLength={MAX.line} autoComplete="address-line1" value={f.addressLine1} onChange={set('addressLine1')} /></div>
      <div className="auth-field"><label htmlFor="a2">Building, unit or landmark (optional)</label>
        <input id="a2" maxLength={MAX.line} autoComplete="address-line2" value={f.addressLine2} onChange={set('addressLine2')} /></div>
      <div className="auth-two">
        <div className="auth-field"><label htmlFor="ct">Town</label>
          <input id="ct" required maxLength={MAX.town} autoComplete="address-level2" value={f.city} onChange={set('city')} /></div>
        <div className="auth-field"><label htmlFor="pa">Parish</label>
          <select id="pa" required autoComplete="address-level1" value={f.parish} onChange={set('parish')}>
            <option value="">Choose…</option>
            {PARISHES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select></div>
      </div>
      <div className="auth-field"><label htmlFor="zn">Your delivery area</label>
        <select id="zn" required value={f.zone} onChange={set('zone')}>
          <option value="">Choose your area…</option>
          {zones.map((z) => <option key={z.name} value={z.name}>{z.name}{z.days.length ? ` · ${z.days.map((d) => DAY_WORDS[d] ?? d).join(' and ')}` : ''}</option>)}
          <option value={NOT_SURE}>Not sure: please place me</option>
        </select>
        <span className="small muted">This sets your delivery day. Not sure? We'll place you and let you know.</span>
      </div>
      <PinPicker value={pin} onChange={setPin} />

      <button className="auth-submit" disabled={busy}>{busy ? 'Making your account…' : 'Create my account'}</button>
      <p className="small muted" style={{ margin: 0 }}>See how we use your details in our <Link to="/privacy">privacy policy</Link>.</p>
      <p className="small muted" style={{ margin: 0 }}>Your account is ready straight away. You pay on delivery or by bank transfer; businesses wanting weekly or monthly invoices can ask the office.</p>
    </form>
    <button type="button" className="as-link auth-back" onClick={() => { setVia(null); setError(null); }}>‹ Back</button>
  </>);
}
