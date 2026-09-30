import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import Logo from '../components/Logo';

type AccountType = 'Corporate' | 'Individual';

/**
 * The fourteen parishes. Fixed, and offered as a list so that a round can
 * later be grouped by parish without three spellings of St Catherine.
 */
const PARISHES = [
  'Kingston', 'St Andrew', 'St Thomas', 'Portland', 'St Mary', 'St Ann',
  'Trelawny', 'St James', 'Hanover', 'Westmoreland', 'St Elizabeth',
  'Manchester', 'Clarendon', 'St Catherine',
];

const BLANK = {
  accountType: 'Corporate' as AccountType,
  businessName: '', contactPerson: '',
  firstName: '', lastName: '',
  email: '', phone: '',
  addressLine1: '', addressLine2: '', city: '', parish: '',
  notes: '',
};

/**
 * Asking for an Alka Vida account. Public - nobody filling this in has a way
 * to sign in yet.
 *
 * It creates a REQUEST, not an account. A portal order is a credit order
 * against agreed rates, so the office decides the price tier, the delivery
 * zone and the terms before anything can be ordered. The page says so plainly
 * rather than implying an account appears at once.
 */
export default function Register() {
  const [f, setF] = useState({ ...BLANK });
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isCorporate = f.accountType === 'Corporate';

  const ready = f.email.trim() && f.phone.trim() && (isCorporate
    ? f.businessName.trim() && f.contactPerson.trim()
    : f.firstName.trim() && f.lastName.trim());

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ name: string }>('/api/register', f);
      setDone(r.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send your request');
    } finally { setBusy(false); }
  }

  const header = (
    <header className="public-head">
      <Link to="/" aria-label="Alka Vida, sign in"><Logo height={52} /></Link>
      <Link to="/">Sign in</Link>
    </header>
  );

  if (done) {
    return (
      <div className="login-page">
        {header}
        <main className="public-main">
          <section className="panel">
            <h1 className="public-h1">Thank you, {done}</h1>
            <p>
              We have your details. Someone from Alka Vida will call to agree your
              prices and delivery day.
            </p>
            <p className="muted small">
              Once your account is set up you will get an email with a link to choose
              your own password. Nobody here will ever ask you for it.
            </p>
            <Link to="/">Back to sign in</Link>
          </section>
        </main>
      </div>
    );
  }

  const kind = (t: AccountType) => setF({
    // Switching kind clears only the name fields, which are the ones that
    // differ. Everything already typed stays.
    ...BLANK, accountType: t,
    email: f.email, phone: f.phone,
    addressLine1: f.addressLine1, addressLine2: f.addressLine2,
    city: f.city, parish: f.parish, notes: f.notes,
  });

  return (
    <div className="login-page">
      {header}
      <main className="public-main">
        <div>
          <h1 className="public-h1">Open an account</h1>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            Tell us who you are and where to deliver. We will call to agree your
            prices and delivery day. This is a request, not an order.
          </p>
        </div>

        {error && <div className="notice error">{error}</div>}

        <form onSubmit={submit} className="public-form">
          <div className="seg seg-even" role="group" aria-label="Kind of account">
            <button type="button" className={isCorporate ? 'active' : ''} aria-pressed={isCorporate}
                    onClick={() => kind('Corporate')}>A business</button>
            <button type="button" className={!isCorporate ? 'active' : ''} aria-pressed={!isCorporate}
                    onClick={() => kind('Individual')}>My home</button>
          </div>

          <section className="panel">
            {isCorporate ? (
              <>
                <div className="field">
                  <label htmlFor="bn">Business name</label>
                  <input id="bn" required value={f.businessName}
                         onChange={(e) => setF({ ...f, businessName: e.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor="cp">Who we speak to</label>
                  <input id="cp" required value={f.contactPerson}
                         onChange={(e) => setF({ ...f, contactPerson: e.target.value })} />
                </div>
              </>
            ) : (
              <div className="two">
                <div className="field">
                  <label htmlFor="fn">First name</label>
                  <input id="fn" required value={f.firstName}
                         onChange={(e) => setF({ ...f, firstName: e.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor="ln">Last name</label>
                  <input id="ln" required value={f.lastName}
                         onChange={(e) => setF({ ...f, lastName: e.target.value })} />
                </div>
              </div>
            )}
            <div className="two">
              <div className="field">
                <label htmlFor="ph">Phone</label>
                <input id="ph" type="tel" required value={f.phone}
                       onChange={(e) => setF({ ...f, phone: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="em">Email</label>
                <input id="em" type="email" required value={f.email}
                       onChange={(e) => setF({ ...f, email: e.target.value })} />
              </div>
            </div>
          </section>

          <section className="panel">
            <h2 className="side-h">Where we deliver</h2>
            <div className="field">
              <label htmlFor="a1">Street and number</label>
              <input id="a1" value={f.addressLine1}
                     onChange={(e) => setF({ ...f, addressLine1: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="a2">Building, unit or landmark (optional)</label>
              <input id="a2" value={f.addressLine2}
                     onChange={(e) => setF({ ...f, addressLine2: e.target.value })} />
            </div>
            <div className="two">
              <div className="field">
                <label htmlFor="ct">Town</label>
                <input id="ct" value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="pa">Parish</label>
                <select id="pa" value={f.parish} onChange={(e) => setF({ ...f, parish: e.target.value })}>
                  <option value="">Choose…</option>
                  {PARISHES.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="nt">Anything else (optional)</label>
              <input id="nt" value={f.notes} placeholder="How much you use, best delivery times"
                     onChange={(e) => setF({ ...f, notes: e.target.value })} />
            </div>
          </section>

          <button className="wide big" disabled={busy || !ready}>
            {busy ? 'Sending…' : 'Send my request'}
          </button>
          <p className="muted small" style={{ textAlign: 'center', margin: 0 }}>
            Already have an account? <Link to="/">Sign in</Link>
          </p>
        </form>
      </main>
    </div>
  );
}
