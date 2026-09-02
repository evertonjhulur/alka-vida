import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';

type AccountType = 'Corporate' | 'Individual';

const BLANK = {
  accountType: 'Corporate' as AccountType,
  businessName: '', contactPerson: '',
  firstName: '', lastName: '',
  email: '', phone: '', deliveryAddress: '', notes: '',
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

  if (done) {
    return (
      <div className="login-page">
        <div className="panel" style={{ maxWidth: 520 }}>
          <h1>Thank you, {done}</h1>
          <p>
            We have your details. Someone from Alka Vida will be in touch to agree
            your prices and delivery arrangements.
          </p>
          <p className="muted small">
            Once your account is set up you will get an email with a link to choose
            your own password. Nobody here will ever ask you for it.
          </p>
          <Link to="/">Back to sign in</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="panel" style={{ maxWidth: 640 }}>
        <h1>Open an Alka Vida account</h1>
        <p className="muted">
          Tell us about you and we will be in touch to agree your prices and
          delivery. This is a request for an account, not an order.
        </p>

        {error && <div className="notice error">{error}</div>}

        <form onSubmit={submit}>
          <div className="row">
            <div className="field">
              <label htmlFor="at">What kind of account?</label>
              <select id="at" value={f.accountType}
                      onChange={(e) => setF({
                        ...BLANK, accountType: e.target.value as AccountType,
                        email: f.email, phone: f.phone,
                        deliveryAddress: f.deliveryAddress, notes: f.notes,
                      })}>
                <option value="Corporate">A business</option>
                <option value="Individual">Myself</option>
              </select>
            </div>
          </div>

          {isCorporate ? (
            <div className="row">
              <div className="field" style={{ flex: '1 1 260px' }}>
                <label htmlFor="bn">Business name</label>
                <input id="bn" required style={{ width: '100%' }} value={f.businessName}
                       onChange={(e) => setF({ ...f, businessName: e.target.value })} />
              </div>
              <div className="field" style={{ flex: '1 1 220px' }}>
                <label htmlFor="cp">Contact person</label>
                <input id="cp" required style={{ width: '100%' }} value={f.contactPerson}
                       onChange={(e) => setF({ ...f, contactPerson: e.target.value })} />
              </div>
            </div>
          ) : (
            <div className="row">
              <div className="field" style={{ flex: '1 1 220px' }}>
                <label htmlFor="fn">First name</label>
                <input id="fn" required style={{ width: '100%' }} value={f.firstName}
                       onChange={(e) => setF({ ...f, firstName: e.target.value })} />
              </div>
              <div className="field" style={{ flex: '1 1 220px' }}>
                <label htmlFor="ln">Last name</label>
                <input id="ln" required style={{ width: '100%' }} value={f.lastName}
                       onChange={(e) => setF({ ...f, lastName: e.target.value })} />
              </div>
            </div>
          )}

          <div className="row">
            <div className="field" style={{ flex: '1 1 260px' }}>
              <label htmlFor="em">Email</label>
              <input id="em" type="email" required style={{ width: '100%' }} value={f.email}
                     onChange={(e) => setF({ ...f, email: e.target.value })} />
            </div>
            <div className="field" style={{ flex: '1 1 200px' }}>
              <label htmlFor="ph">Phone</label>
              <input id="ph" required style={{ width: '100%' }} value={f.phone}
                     onChange={(e) => setF({ ...f, phone: e.target.value })} />
            </div>
          </div>

          <div className="row">
            <div className="field" style={{ flex: '1 1 100%' }}>
              <label htmlFor="ad">Where would we deliver?</label>
              <input id="ad" style={{ width: '100%' }} value={f.deliveryAddress}
                     placeholder="street, town, parish"
                     onChange={(e) => setF({ ...f, deliveryAddress: e.target.value })} />
            </div>
          </div>

          <div className="row">
            <div className="field" style={{ flex: '1 1 100%' }}>
              <label htmlFor="nt">Anything else we should know?</label>
              <input id="nt" style={{ width: '100%' }} value={f.notes}
                     placeholder="how much you use, how often, delivery times"
                     onChange={(e) => setF({ ...f, notes: e.target.value })} />
            </div>
          </div>

          <button disabled={busy || !ready}>
            {busy ? 'Sending…' : 'Send my request'}
          </button>{' '}
          <Link to="/" className="muted small">I already have an account</Link>
        </form>
      </div>
    </div>
  );
}
