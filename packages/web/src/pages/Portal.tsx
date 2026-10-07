import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, download, openPdf, type Session } from '../lib/api';
import { money, statusTone, todayInJamaica, when } from '../lib/format';
import { StatementView } from './Statement';
import { ask } from '../components/Dialog';
import { PARISHES } from '../components/CustomerForm';

interface Row {
  invoice_id: string; invoice_number: string; invoice_date: string; due_date: string | null;
  grand_total_cents: number; balance_cents: number; status: string; is_credit_note: boolean;
}

/** A product at THIS customer's own rate, from /api/customers/:id/prices. */
interface Priced {
  product_id: string; name: string; bottles_per_case: number;
  price_per_case_cents: number; price_per_bottle_cents: number;
  price_tier: string | null;
  is_returnable?: boolean; is_bottle_charge?: boolean;
}

interface MyOrder {
  id: string; order_number: string; order_date: string;
  requested_delivery_date: string | null; status: string;
  delivery_mode: string; grand_total_cents: number; source: string;
  sheet_started?: boolean | null; needs_review?: boolean; customer_po?: string | null;
  lines_summary?: string | null;
  /** Moves and part deliveries (7 Oct 2026, points 8 and 9). */
  events?: Array<{ kind: string; from: string; to: string; reason: string | null }>;
  remaining_summary?: string | null;
}

/** One of the customer's own standing orders. */
interface Schedule {
  id: string; orderNumber: string; pattern: string;
  nextDeliveryDate: string | null; paused: boolean;
  occurrencesRaised: number; lineSummary: string;
}

interface Address {
  id: string; label: string; address_line1: string | null; address_line2: string | null;
  city: string | null; parish: string | null; is_billing: boolean; is_delivery: boolean;
  contact_person: string | null; phone: string | null; delivery_instructions: string | null;
}

interface Position {
  balanceCents: number; overdueCents: number; overdueInvoices: number;
  nextDueDate: string | null; nextDueCents: number;
}

interface Profile {
  id: string; name: string; account_type: string; contact_person: string | null;
  phone: string | null; email: string | null; whatsapp: string | null;
  address_line1: string | null; address_line2: string | null; city: string | null; parish: string | null;
  delivery_address: string | null; delivery_instructions: string | null; delivery_zone: string | null;
  delivery_days: string[] | null; payment_terms: string | null; invoice_cycle: string | null;
  marketing_opt_out: boolean; order_emails: boolean; auto_statements: boolean; gct_exempt: boolean;
  cancel_emails?: boolean; service_emails?: boolean;
  addresses: Address[]; position: Position;
}

interface News {
  id: string; kind: string; title: string; body: string; starts_on: string; ends_on: string | null; pinned: boolean;
  images?: Array<{ id: string; url: string }>;
}

interface Home {
  position: Position; news: News[]; cutoff: string;
  whatsapp: { number: string; link: string | null };
  nextOrder: { order_number: string; requested_delivery_date: string | null; delivery_mode: string; needs_review: boolean } | null;
}

interface MyQuote {
  id: string; quote_number: string; quote_date: string; valid_until: string | null;
  status: string; grand_total_cents: number; lines_summary: string | null; expired: boolean;
}

const GCT_RATE = 0.15;
const PATTERNS = ['Weekly', 'Biweekly', 'Monthly'] as const;
const TABS = ['home', 'order', 'orders', 'repeats', 'account', 'quotes', 'profile'] as const;
type Tab = (typeof TABS)[number];

const KIND_TONE: Record<string, string> = { Promotion: 'ok', Closure: 'warn', Update: 'info', News: 'neutral' };
const addrLine = (a: { address_line1: string | null; address_line2: string | null; city: string | null; parish: string | null }) =>
  [a.address_line1, a.address_line2, a.city, a.parish].filter(Boolean).join(', ');

const BLANK_ADDR = { label: '', addressLine1: '', addressLine2: '', city: '', parish: '', contactPerson: '', phone: '', deliveryInstructions: '' };

export default function Portal({ session }: { session: Session }) {
  /*
   * Which module this is comes from the address, not from state: each one is
   * its own item in the sidebar, so it has to survive a reload and a
   * bookmark, and the highlighted nav item has to agree with what is on
   * screen.
   */
  const { tab: fromUrl } = useParams();
  const navigate = useNavigate();
  const tab: Tab = (TABS as readonly string[]).includes(fromUrl ?? '') ? (fromUrl as Tab) : 'home';
  const setTab = (t: Tab) => navigate(`/portal/${t}`);

  const [rows, setRows] = useState<Row[]>([]);
  const [prices, setPrices] = useState<Priced[]>([]);
  const [myOrders, setMyOrders] = useState<MyOrder[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [repeatFor, setRepeatFor] = useState<string | null>(null);
  const [quotes, setQuotes] = useState<MyQuote[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [home, setHome] = useState<Home | null>(null);

  // How many of each product, keyed by product: every product is on the
  // screen with − / +, rather than a line to add and a product to choose.
  const [qty, setQty] = useState<Record<string, number>>({});
  const [mode, setMode] = useState<'Delivery' | 'Pickup'>('Delivery');
  const [wanted, setWanted] = useState('');
  const [notes, setNotes] = useState('');
  const [po, setPo] = useState('');
  const [addressId, setAddressId] = useState('');
  /** 5-gallon empties they will hand over; '' until they say. */
  const [empties, setEmpties] = useState('');
  const [bottle, setBottle] = useState<Priced | null>(null);

  const [pf, setPf] = useState<Record<string, string | boolean>>({});
  const [addrEdit, setAddrEdit] = useState<{ id: string | null; v: typeof BLANK_ADDR } | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [placed, setPlaced] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const customerId = session.customerId;

  async function load() {
    if (!customerId) return;
    const [h, p] = await Promise.all([
      api.get<Home>('/api/portal/home'),
      api.get<Profile>('/api/portal/profile'),
    ]);
    setHome(h); setProfile(p);
    setPf({
      contactPerson: p.contact_person ?? '', phone: p.phone ?? '', whatsapp: p.whatsapp ?? '',
      // Before addresses came in parts the whole line sat in one field; it
      // opens in Street so nothing is lost.
      addressLine1: (p.address_line1 || p.city || p.parish) ? (p.address_line1 ?? '') : (p.delivery_address ?? ''),
      addressLine2: p.address_line2 ?? '', city: p.city ?? '',
      parish: p.parish ?? '', deliveryInstructions: p.delivery_instructions ?? '',
      orderEmails: p.order_emails !== false, autoStatements: p.auto_statements !== false,
      offers: !p.marketing_opt_out,
      cancelEmails: p.cancel_emails !== false, serviceEmails: p.service_emails !== false,
    });
    setRows(await api.get<Row[]>('/api/invoices'));
    setMyOrders(await api.get<MyOrder[]>('/api/orders'));
    setSchedules(await api.get<Schedule[]>('/api/portal/recurring'));
    // The 5-gallon bottle itself is not chosen here: it is added for any
    // shortfall in empties (7 Oct 2026, point 13).
    const all = await api.get<Priced[]>(`/api/customers/${customerId}/prices`);
    setBottle(all.find((p) => p.is_bottle_charge) ?? null);
    setPrices(all.filter((p) => !p.is_bottle_charge));
    setQuotes(await api.get<MyQuote[]>('/api/quotations').catch(() => []));
  }

  /** Accept or decline a quote sent to them (Everton, 30 Sep 2026). */
  async function answerQuote(q: MyQuote, decision: 'Accepted' | 'Declined') {
    if (decision === 'Declined' && !await ask(`Decline quotation ${q.quote_number}?`,
      { confirmLabel: 'Decline it', cancelLabel: 'Keep it', danger: true })) return;
    await act(async () => {
      await api.post(`/api/portal/quotations/${q.id}/answer`, { decision });
      setPlaced(decision === 'Accepted'
        ? `Thank you. Quotation ${q.quote_number} is accepted; we will be in touch to arrange it.`
        : `Quotation ${q.quote_number} declined.`);
    }, 'Could not send your answer');
  }

  async function act(what: () => Promise<void>, fallback: string) {
    setBusy(true); setError(null); setPlaced(null);
    try {
      await what();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : fallback);
    } finally { setBusy(false); }
  }

  /** Cancel an order that has not gone out yet. */
  async function cancelOrder(o: MyOrder) {
    if (!await ask(
      `Cancel order ${o.order_number}?\n\nIt will not be delivered.`,
      { confirmLabel: 'Cancel the order', cancelLabel: 'Keep it', danger: true },
    )) return;
    await act(async () => {
      await api.post(`/api/portal/orders/${o.id}/cancel`, {});
      setPlaced(`Order ${o.order_number} has been cancelled.`);
    }, 'Could not cancel the order');
  }

  /** Turn a pending order into a repeat. */
  async function makeRepeat(o: MyOrder, pattern: string) {
    await act(async () => {
      await api.post(`/api/portal/orders/${o.id}/repeat`, { pattern });
      setPlaced(
        `${o.order_number} will now repeat ${pattern.toLowerCase()}. `
        + 'We raise each one for you a week before it is due.',
      );
      setRepeatFor(null);
      setTab('repeats');
    }, 'Could not set up the repeat');
  }

  async function pauseRepeat(s: Schedule) {
    await act(async () => {
      await api.post(`/api/portal/recurring/${s.id}/pause`, { paused: !s.paused });
      setPlaced(s.paused
        ? 'Your repeat order has started again.'
        : 'Your repeat order is paused. Nothing will be sent until you start it again.');
    }, 'Could not change the repeat');
  }

  async function stopRepeat(s: Schedule) {
    if (!await ask(
      'Stop this repeat order for good?\n\n'
      + 'Anything already delivered is unaffected. To pause it for a while instead, '
      + 'use Pause.',
      { confirmLabel: 'Stop it', cancelLabel: 'Keep it', danger: true },
    )) return;
    await act(async () => {
      await api.post(`/api/portal/recurring/${s.id}/cancel`, {});
      setPlaced('Your repeat order has been stopped.');
    }, 'Could not stop the repeat');
  }

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    await act(async () => {
      await api.patch('/api/portal/profile', {
        contactPerson: pf.contactPerson, phone: pf.phone, whatsapp: pf.whatsapp,
        addressLine1: pf.addressLine1, addressLine2: pf.addressLine2, city: pf.city, parish: pf.parish,
        deliveryInstructions: pf.deliveryInstructions,
        orderEmails: pf.orderEmails, autoStatements: pf.autoStatements, marketingOptOut: !pf.offers,
        cancelEmails: pf.cancelEmails, serviceEmails: pf.serviceEmails,
      });
      setPlaced('Your details are saved.');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }, 'Could not save your details');
  }

  async function saveAddress(e: React.FormEvent) {
    e.preventDefault();
    if (!addrEdit) return;
    await act(async () => {
      if (addrEdit.id) await api.patch(`/api/portal/addresses/${addrEdit.id}`, addrEdit.v);
      else await api.post('/api/portal/addresses', addrEdit.v);
      setPlaced(`${addrEdit.v.label} saved. You can choose it when you place an order.`);
      setAddrEdit(null);
    }, 'Could not save the address');
  }

  async function removeAddress(a: Address) {
    if (!await ask(`Remove ${a.label}?`, { confirmLabel: 'Remove it', danger: true })) return;
    await act(async () => {
      await api.del(`/api/portal/addresses/${a.id}`);
      setPlaced(`${a.label} removed.`);
    }, 'Could not remove the address');
  }

  useEffect(() => { load().catch((e) => setError(e.message)); }, [customerId]);

  const unitOf = (p: Priced) => (p.bottles_per_case > 0 ? 'case' : 'bottle');
  void unitOf;
  const rateOf = (p: Priced) => (p.bottles_per_case > 0
    ? Number(p.price_per_case_cents)
    : Number(p.price_per_bottle_cents));

  /**
   * The total this customer will actually be asked for, worked out the same
   * way the server does it: their own rate, then GCT (unless they are exempt).
   * Shown as subtotal, then GCT, then the total (team feedback, point 2).
   */
  const exempt = !!profile?.gct_exempt;
  // Full 5-gallon bottles on the order, and how many of them are short of an
  // empty in exchange: those are bought, at the bottle's price.
  const fullFives = prices.filter((p) => p.is_returnable)
    .reduce((n, p) => n + (qty[p.product_id] ?? 0) * (p.bottles_per_case > 0 ? p.bottles_per_case : 1), 0);
  const shortfall = fullFives > 0 && empties !== '' ? Math.max(0, fullFives - (Math.round(Number(empties)) || 0)) : 0;
  const totals = useMemo(() => {
    let subtotal = 0;
    for (const p of prices) {
      const n = qty[p.product_id] ?? 0;
      if (n > 0) subtotal += n * rateOf(p);
    }
    if (bottle && shortfall > 0) subtotal += shortfall * Number(bottle.price_per_bottle_cents);
    const gct = exempt ? 0 : Math.round(subtotal * GCT_RATE);
    return { subtotal, gct, grandTotal: subtotal + gct };
  }, [qty, prices, exempt, bottle, shortfall]);

  const bump = (id: string, by: number) =>
    setQty((q) => ({ ...q, [id]: Math.max(0, Math.min(9999, (q[id] ?? 0) + by)) }));

  const deliveryAddresses = (profile?.addresses ?? []).filter((a) => a.is_delivery);
  const cutoff = home?.cutoff ?? '10:00';
  const nowHm = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Jamaica', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  const lateToday = mode === 'Delivery' && wanted === todayInJamaica() && nowHm >= cutoff;

  async function place(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setPlaced(null);

    // Whether a quantity means cases or loose bottles is the product's rule,
    // not the customer's.
    const payload = prices
      .filter((p) => (qty[p.product_id] ?? 0) > 0)
      .map((p) => (p.bottles_per_case > 0
        ? { productId: p.product_id, cases: qty[p.product_id] }
        : { productId: p.product_id, looseBottles: qty[p.product_id] }));

    if (payload.length === 0) {
      setError('Choose at least one product and say how many you want.');
      setBusy(false);
      return;
    }
    if (fullFives > 0 && empties === '') {
      setError('Tell us how many empty 5-gallon bottles you will hand over.');
      setBusy(false);
      return;
    }

    try {
      const order = await api.post<{
        orderNumber: string; grandTotalCents: number; deliveryDate?: string | null; needsReview?: boolean;
      }>(
        '/api/orders',
        {
          lines: payload,
          deliveryMode: mode,
          requestedDeliveryDate: wanted || null,
          notes: notes || null,
          customerPo: po || null,
          addressId: mode === 'Delivery' ? (addressId || null) : null,
          emptiesExpected: fullFives > 0 ? Math.max(0, Math.round(Number(empties)) || 0) : null,
        },
      );
      setPlaced(
        `Thank you — order ${order.orderNumber} for ${money(order.grandTotalCents)} is in. `
        + (mode === 'Pickup'
          ? 'We will have it ready for you to collect.'
          : order.needsReview
            ? `It came in after our ${cutoff} cut-off for same-day delivery, so we will check it and confirm the day with you shortly.`
            : order.deliveryDate ? `It is booked for delivery on ${when(order.deliveryDate)}.`
              : 'It will go out on the next round for your area.')
        + '',
      );
      setQty({});
      setWanted(''); setNotes(''); setPo(''); setEmpties('');
      await load();
      setTab('orders');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not place the order');
    } finally { setBusy(false); }
  }

  if (!customerId) {
    return <div className="notice error">This login is not linked to a customer account.</div>;
  }

  const pos = home?.position ?? profile?.position;
  const positionFigures = () => (
    <div className="figures portal-figures">
      <div className="fig">
        <div className="fig-label">{(pos?.balanceCents ?? 0) < 0 ? 'In credit' : 'Balance'}</div>
        <div className="fig-value">{money(Math.abs(pos?.balanceCents ?? 0))}</div>
        <div className="fig-sub">{(pos?.balanceCents ?? 0) > 0 ? 'what you owe in total' : 'nothing owed'}</div>
      </div>
      <div className={`fig${(pos?.overdueCents ?? 0) > 0 ? ' attention' : ''}`}>
        <div className="fig-label">Overdue</div>
        <div className="fig-value">{money(pos?.overdueCents ?? 0)}</div>
        <div className={`fig-sub${(pos?.overdueCents ?? 0) > 0 ? ' bad' : ''}`}>
          {(pos?.overdueInvoices ?? 0) > 0
            ? `${pos!.overdueInvoices} invoice${pos!.overdueInvoices === 1 ? '' : 's'} past due` : 'nothing late'}
        </div>
      </div>
      <div className="fig">
        <div className="fig-label">Next due</div>
        <div className="fig-value" style={{ fontSize: pos?.nextDueDate ? 22 : 17 }}>
          {pos?.nextDueDate ? money(pos.nextDueCents) : '—'}
        </div>
        <div className="fig-sub">{pos?.nextDueDate ? `on ${when(pos.nextDueDate)}` : 'nothing coming due'}</div>
      </div>
    </div>
  );

  /**
   * Plain functions returning JSX, NOT nested components: a component
   * declared inside another gets a new type on every render, so the inputs
   * unmount and lose focus on every keystroke.
   */
  const pfInput = (key: string, label: string, opts: { placeholder?: string; type?: string; wide?: boolean } = {}) => (
    <div className={`field${opts.wide ? ' grow' : ''}`}>
      <label htmlFor={`pf-${key}`}>{label}</label>
      <input id={`pf-${key}`} type={opts.type ?? 'text'} value={String(pf[key] ?? '')} placeholder={opts.placeholder}
             onChange={(e) => setPf({ ...pf, [key]: e.target.value })} />
    </div>
  );
  const addrInput = (key: keyof typeof BLANK_ADDR, label: string, placeholder?: string) => (
    <div className="field grow">
      <label htmlFor={`ad-${key}`}>{label}</label>
      <input id={`ad-${key}`} value={addrEdit?.v[key] ?? ''} placeholder={placeholder}
             onChange={(e) => setAddrEdit(addrEdit && { ...addrEdit, v: { ...addrEdit.v, [key]: e.target.value } })} />
    </div>
  );

  return (
    <>
      <h1>{tab === 'home' && profile ? `Welcome, ${profile.contact_person || profile.name}` : 'My account'}</h1>

      {error && <div className="notice error">{error}</div>}
      {placed && <div className="notice ok">{placed}</div>}

      {tab === 'home' && (
        <>
          {/*
            * Home, redone (Everton, 7 Oct 2026, point 2): News & offers first
            * and large, as picture cards; the account and the next delivery
            * underneath.
            */}
          <section className="news-hero" aria-labelledby="news-h">
            <h2 id="news-h">News &amp; offers</h2>
            {(home?.news ?? []).length === 0 ? (
              <div className="news-card news-empty">
                <div className="news-card-body">
                  <strong>Nothing new right now</strong>
                  <p className="muted" style={{ margin: '4px 0 0' }}>Our offers and news show up here first. Check back soon.</p>
                </div>
              </div>
            ) : (
              <div className="news-grid">
                {/* A post with a picture leads, large; the rest follow in order. */}
                {[...(home?.news ?? [])].sort((a, b) => Number(!!b.images?.length) - Number(!!a.images?.length)).map((n, i) => (
                  <article key={n.id} className={`news-card${i === 0 ? ' lead' : ''}${n.images?.length ? '' : ' no-pic'}`}>
                    {n.images?.[0] && (
                      <img className="news-pic" src={n.images[0].url} alt="" loading={i < 2 ? 'eager' : 'lazy'} />
                    )}
                    <div className="news-card-body">
                      <span className={`chip ${KIND_TONE[n.kind] ?? 'neutral'}`}>{n.kind === 'Promotion' ? 'Offer' : n.kind}</span>
                      <h3>{n.title}</h3>
                      {n.body && <p className="news-body">{n.body}</p>}
                      {(n.images?.length ?? 0) > 1 && (
                        <div className="news-thumbs">
                          {n.images!.slice(1).map((im) => <img key={im.id} src={im.url} alt="" loading="lazy" />)}
                        </div>
                      )}
                      {n.ends_on && <div className="muted small">Until {when(n.ends_on)}</div>}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          <div className="home-actions">
            <button type="button" className="big" onClick={() => setTab('order')}>Place an order</button>
            {home?.whatsapp.link && (
              <a className="button-link whatsapp big" href={home.whatsapp.link} target="_blank" rel="noreferrer">
                Order on WhatsApp
              </a>
            )}
            <button type="button" className="secondary big" onClick={() => setTab('account')}>Invoices &amp; statement</button>
          </div>

          <div className="portal-home">
            <section className="panel">
              <h2 style={{ marginTop: 0 }}>Your next delivery</h2>
              {home?.nextOrder ? (
                <p style={{ margin: '0 0 8px' }}>
                  <strong>{home.nextOrder.order_number}</strong>{' '}
                  {home.nextOrder.needs_review ? 'is waiting for us to confirm the day.'
                    : home.nextOrder.delivery_mode === 'Pickup'
                      ? `is for you to collect${home.nextOrder.requested_delivery_date ? ` on ${when(home.nextOrder.requested_delivery_date)}` : ''}.`
                      : home.nextOrder.requested_delivery_date
                        ? `is coming on ${when(home.nextOrder.requested_delivery_date)}.`
                        : 'is going out on the next round for your area.'}
                </p>
              ) : <p className="muted" style={{ margin: '0 0 8px' }}>Nothing on order at the moment.</p>}
              <p className="muted small" style={{ margin: 0 }}>
                Same-day delivery: order by {cutoff}. After that we check with you before it goes out.
              </p>
            </section>
            <section className="panel">
              <h2 style={{ marginTop: 0 }}>Your account</h2>
              {positionFigures()}
            </section>
          </div>
        </>
      )}

      {tab === 'order' && (
        <form onSubmit={place} className="portal-order">
          <div>
            <h2 style={{ margin: 0 }}>Order water</h2>
            <p className="muted small" style={{ margin: '4px 0 0' }}>
              Your {prices[0]?.price_tier ? `${prices[0].price_tier} ` : ''}prices. We confirm the amount
              from what is actually delivered.
            </p>
          </div>

          <section className="panel">
            {prices.map((p) => {
              const n = qty[p.product_id] ?? 0;
              const cased = p.bottles_per_case > 0;
              return (
                <div key={p.product_id} className={`drop-row${n > 0 ? ' picked' : ''}`}>
                  <div>
                    <strong>{p.name.replace(/^Alka Vida\s+/i, '')}</strong>
                    <div className="muted small">
                      {money(rateOf(p))} {cased ? `a case of ${p.bottles_per_case}` : 'a bottle'}
                      {n > 0 ? ` · ${money(n * rateOf(p))}` : ''}
                    </div>
                  </div>
                  <div className="stepper big">
                    <button type="button" className="secondary" disabled={n === 0}
                            aria-label={`Fewer ${p.name}${cased ? ' cases' : ''}`} onClick={() => bump(p.product_id, -1)}>−</button>
                    <input type="number" min="0" inputMode="numeric" aria-label={`How many ${p.name}${cased ? ' cases' : ' bottles'}`}
                           value={n || ''} placeholder="0"
                           onChange={(e) => setQty((q) => ({ ...q, [p.product_id]: Math.max(0, Math.round(Number(e.target.value) || 0)) }))} />
                    <button type="button" className="secondary"
                            aria-label={`More ${p.name}${cased ? ' cases' : ''}`} onClick={() => bump(p.product_id, 1)}>+</button>
                  </div>
                </div>
              );
            })}
          </section>

          {fullFives > 0 && (
            <section className="panel bottle-box">
              <div className="field" style={{ marginBottom: 4 }}>
                <label htmlFor="empties">How many empty 5-gallon bottles will you hand over?</label>
                <input id="empties" type="number" min="0" inputMode="numeric" style={{ maxWidth: 140 }}
                       value={empties} placeholder={String(fullFives)}
                       onChange={(e) => setEmpties(e.target.value)} />
              </div>
              <p className="small" style={{ margin: 0 }}>
                Each full bottle is swapped for an empty one.{' '}
                {shortfall > 0 && bottle
                  ? <strong>{shortfall} short, so {shortfall === 1 ? 'that bottle is' : 'those bottles are'} added at {money(Number(bottle.price_per_bottle_cents))} each. They are yours to keep and swap next time.</strong>
                  : `Fewer empties than full bottles and the extra bottles are charged${bottle ? ` at ${money(Number(bottle.price_per_bottle_cents))} each` : ''}; they are then yours to keep.`}
              </p>
            </section>
          )}

          <section className="panel">
            <div className="seg seg-even" role="group" aria-label="Delivery or collection">
              <button type="button" className={mode === 'Delivery' ? 'active' : ''} aria-pressed={mode === 'Delivery'}
                      onClick={() => setMode('Delivery')}>Deliver to me</button>
              <button type="button" className={mode === 'Pickup' ? 'active' : ''} aria-pressed={mode === 'Pickup'}
                      onClick={() => setMode('Pickup')}>I&rsquo;ll collect</button>
            </div>
            {mode === 'Delivery' && (
              <div className="field" style={{ marginTop: 10 }}>
                <label htmlFor="addr">Deliver to</label>
                <select id="addr" value={addressId} style={{ width: '100%', minHeight: 44 }}
                        onChange={(e) => setAddressId(e.target.value)}>
                  <option value="">{profile?.delivery_address ? `Main address: ${profile.delivery_address}` : 'My main address'}</option>
                  {deliveryAddresses.map((a) => (
                    <option key={a.id} value={a.id}>{a.label}: {addrLine(a)}</option>
                  ))}
                </select>
                <div className="small" style={{ marginTop: 4 }}>
                  <button type="button" className="as-link small" onClick={() => { setTab('profile'); setAddrEdit({ id: null, v: { ...BLANK_ADDR } }); }}>
                    + Add a different delivery address
                  </button>
                </div>
              </div>
            )}
            <div className="two" style={{ marginTop: 10 }}>
              <div className="field">
                <label htmlFor="wd">{mode === 'Pickup' ? 'When will you collect?' : 'Delivery date (optional)'}</label>
                <input id="wd" type="date" value={wanted} min={todayInJamaica()} onChange={(e) => setWanted(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="po">Your PO number (optional)</label>
                <input id="po" value={po} placeholder="if your accounts team needs one"
                       onChange={(e) => setPo(e.target.value)} />
              </div>
            </div>
            <div className="field">
              <label htmlFor="nt">Anything we should know?</label>
              <input id="nt" value={notes} placeholder="e.g. leave at the back gate"
                     onChange={(e) => setNotes(e.target.value)} />
            </div>
            {lateToday ? (
              <div className="notice warn" style={{ margin: 0 }}>
                It is past {cutoff}, our cut-off for same-day delivery. You can still place it: we will check
                whether it can go today and confirm with you.
              </div>
            ) : (
              <p className="muted small" style={{ margin: 0 }}>
                {mode === 'Pickup' ? 'We will have it ready for you.'
                  : `Left blank, it goes on your next delivery day. Same-day orders by ${cutoff}.`}
              </p>
            )}
          </section>

          <section className="panel portal-sum">
            {shortfall > 0 && bottle && (
              <div className="total-line muted"><span>incl. {shortfall} × 5-gallon bottle</span><span>{money(shortfall * Number(bottle.price_per_bottle_cents))}</span></div>
            )}
            <div className="total-line"><span>Subtotal</span><span>{money(totals.subtotal)}</span></div>
            <div className="total-line"><span>{exempt ? 'GCT (exempt)' : 'GCT 15%'}</span><span>{money(totals.gct)}</span></div>
            <div className="total-line grand"><span>Total</span><span>{money(totals.grandTotal)}</span></div>
          </section>
          <button className="wide big" disabled={busy || totals.grandTotal === 0}>
            {busy ? 'Placing…' : 'Place order'}
          </button>
        </form>
      )}

      {tab === 'orders' && (
        <div className="panel phone-cards">
          <h2 style={{ marginTop: 0 }}>My orders</h2>
          <table>
            <thead>
              <tr>
                <th>Order</th><th>Placed</th><th>Delivery date</th>
                <th>How</th><th className="num">Total</th><th>Status</th><th />
              </tr>
            </thead>
            <tbody>
              {myOrders.map((o) => {
                const onRoad = !!o.sheet_started && o.status === 'Pending';
                const onRoadPart = !!o.sheet_started && o.status === 'Partially Delivered';
                const statusWord = o.needs_review && o.status === 'Pending' ? 'Being confirmed'
                  : onRoad || onRoadPart ? 'Out for delivery'
                    : o.status === 'Partially Delivered' ? 'Part delivered' : o.status;
                return (
                  <Fragment key={o.id}>
                    <tr>
                      {/* On a phone this row is a card: `lead` is its heading,
                          and each other cell prints its own column name. */}
                      <td className="lead">
                        <span>
                          {o.order_number}
                          {o.customer_po && <div className="muted small">your PO {o.customer_po}</div>}
                          {o.lines_summary && <div className="muted small">{o.lines_summary.replace(/Alka Vida\s+/gi, '')}</div>}
                          {(o.events?.length ?? 0) > 0 && (
                            <ul className="order-events">
                              {o.events!.map((ev, i) => (
                                <li key={i} className={ev.kind === 'Part delivered' ? 'part' : undefined}>
                                  {ev.kind === 'Rescheduled'
                                    ? `Rescheduled from ${when(ev.from)} to ${when(ev.to)}${ev.reason ? ` (${ev.reason})` : ''}`
                                    : `Part delivered ${when(ev.from)}; the rest on ${when(ev.to)}`}
                                </li>
                              ))}
                            </ul>
                          )}
                          {o.status === 'Partially Delivered' && o.remaining_summary && (
                            <div className="small" style={{ color: 'var(--warn)' }}>
                              Still to come: {o.remaining_summary.replace(/Alka Vida\s+/gi, '')}
                              {o.requested_delivery_date ? ` on ${when(o.requested_delivery_date)}` : ''}
                            </div>
                          )}
                        </span>
                        <span className={`chip ${statusTone(statusWord)} phone-only`}>{statusWord}</span>
                      </td>
                      <td data-label="Placed">{when(o.order_date)}</td>
                      <td data-label="Delivery date"
                          className={o.requested_delivery_date ? undefined : 'empty'}>
                        {o.requested_delivery_date ? when(o.requested_delivery_date) : '—'}
                      </td>
                      <td data-label="How" className="small">
                        {o.delivery_mode === 'Pickup' ? 'Collection' : 'Delivery'}
                      </td>
                      <td data-label="Total" className="num money">
                        {money(Number(o.grand_total_cents))}
                      </td>
                      <td className="on-desktop">
                        <span className={`chip ${statusTone(statusWord)}`}>{statusWord}</span>
                      </td>
                      <td className="num actions">
                        {/* Only an order that has not gone out can be changed.
                            Once the driver has set off it is on the van. */}
                        {o.status === 'Pending' && !onRoad && (
                          <>
                            <button className="secondary" disabled={busy}
                                    onClick={() => setRepeatFor(repeatFor === o.id ? null : o.id)}>
                              {repeatFor === o.id ? 'Cancel' : 'Repeat this'}
                            </button>{' '}
                            <button className="danger-soft" disabled={busy}
                                    onClick={() => cancelOrder(o)}>
                              Cancel order
                            </button>
                          </>
                        )}
                        {onRoad && <span className="muted small">On its way. Call us to change it.</span>}
                      </td>
                    </tr>
                    {repeatFor === o.id && (
                      <tr>
                        <td colSpan={7} style={{ background: '#f9fafb' }}>
                          <strong>Get this order again, regularly</strong>
                          <p className="muted small" style={{ marginTop: 4 }}>
                            We will raise the same order for you each time, about a week
                            before it is due, at whatever your prices are on the day. You
                            can pause or stop it whenever you like.
                          </p>
                          {PATTERNS.map((p) => (
                            <span key={p}>
                              <button type="button" disabled={busy}
                                      onClick={() => makeRepeat(o, p)}>
                                {p === 'Weekly' ? 'Every week'
                                  : p === 'Biweekly' ? 'Every two weeks' : 'Every month'}
                              </button>{' '}
                            </span>
                          ))}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {myOrders.length === 0 && (
            <p className="muted">
              No orders yet. Use <strong>Place an order</strong> to make your first one.
            </p>
          )}
          <p className="muted small">
            The total shown is what we expect. The invoice is raised when the water is
            actually delivered, from the quantity delivered on the day.
          </p>
        </div>
      )}

      {tab === 'repeats' && (
        <div className="panel phone-cards">
          <h2 style={{ marginTop: 0 }}>Repeat orders</h2>
          <p className="muted small">
            An order we send you regularly without you having to ask. Set one up from
            <strong> My orders</strong> — place the order you want, then choose
            “Repeat this”.
          </p>
          <table>
            <thead>
              <tr>
                <th>What</th><th>How often</th><th>Next one</th>
                <th className="num">Sent so far</th><th>Status</th><th />
              </tr>
            </thead>
            <tbody>
              {schedules.map((s) => (
                <tr key={s.id}>
                  <td className="lead">
                    <span>
                      {s.lineSummary || s.orderNumber}
                      <div className="muted small">from {s.orderNumber}</div>
                    </span>
                    <span className={`chip ${s.paused ? 'warn' : 'ok'} phone-only`}>
                      {s.paused ? 'Paused' : 'Running'}
                    </span>
                  </td>
                  <td data-label="How often">
                    {s.pattern === 'Weekly' ? 'Every week'
                      : s.pattern === 'Biweekly' ? 'Every two weeks' : 'Every month'}
                  </td>
                  <td data-label="Next one"
                      className={s.nextDeliveryDate ? undefined : 'empty'}>
                    {s.nextDeliveryDate ? when(s.nextDeliveryDate) : '—'}
                  </td>
                  <td data-label="Sent so far" className="num">{s.occurrencesRaised}</td>
                  <td className="on-desktop">
                    <span className={`chip ${s.paused ? 'warn' : 'ok'}`}>
                      {s.paused ? 'Paused' : 'Running'}
                    </span>
                  </td>
                  <td className="num actions">
                    <button className="secondary" disabled={busy}
                            onClick={() => pauseRepeat(s)}>
                      {s.paused ? 'Start again' : 'Pause'}
                    </button>{' '}
                    <button className="danger-soft" disabled={busy}
                            onClick={() => stopRepeat(s)}>
                      Stop for good
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {schedules.length === 0 && (
            <p className="muted">
              You have no repeat orders. Place an order, then choose “Repeat this”
              against it in My orders.
            </p>
          )}
          <p className="muted small">
            Pausing keeps the arrangement but sends nothing until you start it again.
            Missed weeks are not made up afterwards.
          </p>
        </div>
      )}

      {tab === 'quotes' && (
        <div className="panel phone-cards">
          <h2 style={{ marginTop: 0 }}>Quotes from us</h2>
          <table>
            <thead><tr><th>Quote</th><th>What</th><th>Valid until</th><th className="num">Total</th><th /></tr></thead>
            <tbody>
              {quotes.map((q) => (
                <tr key={q.id}>
                  <td className="lead"><span>{q.quote_number}</span><span className="muted small">{when(q.quote_date)}</span></td>
                  <td data-label="What" className="small">{q.lines_summary}</td>
                  <td data-label="Valid until">{q.valid_until ? when(q.valid_until) : '—'}</td>
                  <td data-label="Total" className="num money">{money(Number(q.grand_total_cents))}</td>
                  <td className="num">
                    <span className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                      <button type="button" className="secondary" disabled={busy}
                              onClick={() => download(`/api/quotations/${q.id}/pdf`, `${q.quote_number}.pdf`).catch((e) => setError(e.message))}>PDF</button>
                      {q.status === 'Sent' && !q.expired ? (
                        <>
                          <button type="button" className="approve-soft" disabled={busy} onClick={() => answerQuote(q, 'Accepted')}>Accept</button>
                          <button type="button" className="danger-soft" disabled={busy} onClick={() => answerQuote(q, 'Declined')}>Decline</button>
                        </>
                      ) : (
                        <span className="chip neutral">{q.expired ? 'Expired' : q.status === 'Converted' ? 'Accepted, ordered' : q.status}</span>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {quotes.length === 0 && <p className="muted">No quotes yet.</p>}
        </div>
      )}

      {tab === 'account' && (
        <>
          {positionFigures()}
          <div className="panel phone-cards">
            <h2 style={{ marginTop: 0 }}>Invoices</h2>
            <p className="muted small" style={{ marginTop: 0 }}>Tap an invoice number to see it, print it or save it as a PDF.</p>
            <table>
              <thead>
                <tr>
                  <th>Invoice</th><th>Date</th><th>Due</th><th className="num">Total</th>
                  <th className="num">Balance</th><th>Status</th><th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.invoice_id}>
                    <td className="lead">
                      <Link to={`/portal/invoices/${r.invoice_id}`}>{r.invoice_number}</Link>
                      <span className={`chip ${statusTone(r.status)} phone-only`}>
                        {r.status}
                      </span>
                    </td>
                    <td data-label="Date">{when(r.invoice_date)}</td>
                    <td data-label="Due" className={r.due_date ? undefined : 'empty'}>
                      {r.is_credit_note ? '—' : r.due_date ? when(r.due_date) : '—'}
                    </td>
                    <td data-label="Total" className="num">
                      {money(Number(r.grand_total_cents))}
                    </td>
                    {/* What they still owe is the number that matters here. */}
                    <td data-label="Balance" className="num money">
                      {money(Number(r.balance_cents))}
                    </td>
                    <td className="on-desktop">
                      <span className={`chip ${statusTone(r.status)}`}>{r.status}</span>
                    </td>
                    <td className="num actions">
                      <button type="button" className="secondary" disabled={busy}
                              onClick={() => download(`/api/portal/invoices/${r.invoice_id}/pdf`, `${r.invoice_number}.pdf`)
                                .catch((e) => setError(e.message))}>PDF</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && <p className="muted">No invoices yet.</p>}
          </div>

          <h2>Statement</h2>
          <StatementView customerId={customerId} />
        </>
      )}

      {tab === 'profile' && profile && (
        <>
          <form className="panel" onSubmit={saveProfile}>
            <h2 style={{ marginTop: 0 }}>My details</h2>
            <p className="muted small" style={{ marginTop: 0 }}>
              {profile.name} · {profile.email}. To change the account name or email, please call us.
            </p>
            <div className="row">
              {pfInput('contactPerson', 'Contact person', { wide: true })}
              {pfInput('phone', 'Phone', { type: 'tel' })}
              {pfInput('whatsapp', 'WhatsApp (if different)', { type: 'tel' })}
            </div>
            <fieldset className="form-block">
              <legend>Main delivery address</legend>
              <div className="row">
                {pfInput('addressLine1', 'Street', { wide: true })}
                {pfInput('addressLine2', 'Apartment, building (optional)', { wide: true })}
              </div>
              <div className="row">
                {pfInput('city', 'Town or district', { wide: true })}
                <div className="field grow">
                  <label htmlFor="pf-parish">Parish</label>
                  <select id="pf-parish" value={String(pf.parish ?? '')} onChange={(e) => setPf({ ...pf, parish: e.target.value })}>
                    <option value="">Choose…</option>
                    {PARISHES.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>
              </div>
            </fieldset>
            <div className="field">
              <label htmlFor="pf-di">Delivery notes for the driver</label>
              <textarea id="pf-di" rows={2} style={{ width: '100%', boxSizing: 'border-box' }}
                        placeholder="Gate code, where to leave it, who to ask for…"
                        value={String(pf.deliveryInstructions ?? '')}
                        onChange={(e) => setPf({ ...pf, deliveryInstructions: e.target.value })} />
            </div>
            <fieldset className="form-block">
              <legend>Emails from us</legend>
              <label className="check"><input type="checkbox" checked={!!pf.orderEmails}
                onChange={(e) => setPf({ ...pf, orderEmails: e.target.checked })} /> Order confirmations (placed, delivered, moved to another day)</label>
              <label className="check"><input type="checkbox" checked={!!pf.cancelEmails}
                onChange={(e) => setPf({ ...pf, cancelEmails: e.target.checked })} /> Order cancelled</label>
              <label className="check"><input type="checkbox" checked={!!pf.autoStatements}
                onChange={(e) => setPf({ ...pf, autoStatements: e.target.checked })} /> A monthly statement</label>
              <label className="check"><input type="checkbox" checked={!!pf.serviceEmails}
                onChange={(e) => setPf({ ...pf, serviceEmails: e.target.checked })} /> Service announcements (closures, holidays, changes to delivery days)</label>
              <label className="check"><input type="checkbox" checked={!!pf.offers}
                onChange={(e) => setPf({ ...pf, offers: e.target.checked })} /> News and special offers</label>
              <p className="muted small" style={{ margin: '4px 0 0' }}>
                Invoices, receipts and statements we send you always come. Every other email has an Unsubscribe link at the bottom.
              </p>
            </fieldset>
            <button disabled={busy}>{busy ? 'Saving…' : 'Save my details'}</button>
          </form>

          <div className="panel">
            <div className="panel-head">
              <h2>Other delivery addresses</h2>
              {!addrEdit && (
                <button type="button" className="secondary" onClick={() => setAddrEdit({ id: null, v: { ...BLANK_ADDR } })}>
                  + Add an address
                </button>
              )}
            </div>
            {addrEdit && (
              <form onSubmit={saveAddress} className="sub-panel" style={{ marginBottom: 12 }}>
                <div className="row">
                  {addrInput('label', 'Name it', 'e.g. Warehouse, Home')}
                  {addrInput('addressLine1', 'Street')}
                </div>
                <div className="row">
                  {addrInput('addressLine2', 'Apartment, building (optional)')}
                  {addrInput('city', 'Town or district')}
                  <div className="field grow">
                    <label htmlFor="ad-parish">Parish</label>
                    <select id="ad-parish" value={addrEdit.v.parish}
                            onChange={(e) => setAddrEdit({ ...addrEdit, v: { ...addrEdit.v, parish: e.target.value } })}>
                      <option value="">Choose…</option>
                      {PARISHES.map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                  </div>
                </div>
                <div className="row">
                  {addrInput('contactPerson', 'Who to ask for (optional)')}
                  {addrInput('phone', 'Phone there (optional)')}
                </div>
                {addrInput('deliveryInstructions', 'Delivery notes (optional)', 'Gate code, where to leave it…')}
                <div className="row" style={{ gap: 8 }}>
                  <button disabled={busy}>Save address</button>
                  <button type="button" className="secondary" onClick={() => setAddrEdit(null)}>Cancel</button>
                </div>
              </form>
            )}
            {profile.addresses.filter((a) => a.is_delivery).length === 0 && !addrEdit && (
              <p className="muted" style={{ margin: 0 }}>None yet. Add one to have an order delivered somewhere other than your main address.</p>
            )}
            {profile.addresses.filter((a) => a.is_delivery).map((a) => (
              <div key={a.id} className="addr-row">
                <div>
                  <strong>{a.label}</strong>
                  <div className="small">{addrLine(a)}</div>
                  {a.delivery_instructions && <div className="muted small">{a.delivery_instructions}</div>}
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <button type="button" className="secondary" onClick={() => setAddrEdit({
                    id: a.id,
                    v: {
                      label: a.label, addressLine1: a.address_line1 ?? '', addressLine2: a.address_line2 ?? '',
                      city: a.city ?? '', parish: a.parish ?? '', contactPerson: a.contact_person ?? '',
                      phone: a.phone ?? '', deliveryInstructions: a.delivery_instructions ?? '',
                    },
                  })}>Change</button>
                  <button type="button" className="danger-soft" onClick={() => removeAddress(a)}>Remove</button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

/** One invoice, for the customer: see it, print it, save it (point 6). */
export function PortalInvoice() {
  const { invoiceId } = useParams();
  const [inv, setInv] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.get<Record<string, unknown>>(`/api/invoices/${invoiceId}`).then(setInv).catch((e) => setError(e.message));
  }, [invoiceId]);
  if (error) return <div className="notice error">{error}</div>;
  if (!inv) return <p className="muted">Loading…</p>;
  const n = (k: string) => Number(inv[k] ?? 0);
  const lines = (inv.lines as Array<Record<string, unknown>>) ?? [];
  const orders = (inv.orders as Array<{ order_number: string; customer_po: string | null }>) ?? [];
  const isCN = !!inv.isCreditNote;
  const path = `/api/portal/invoices/${invoiceId}/pdf`;
  return (
    <>
      <p style={{ marginTop: 0 }}><Link to="/portal/account">← Statements &amp; invoices</Link></p>
      <div className="inv-title">
        <div>
          <h1 style={{ marginBottom: 2 }}>{isCN ? 'Credit note' : 'Invoice'} {String(inv.invoiceNumber)}</h1>
          {orders.length > 0 && (
            <div className="muted">Order {orders.map((o) => o.order_number).join(', ')}
              {orders.some((o) => o.customer_po) ? ` · your PO ${orders.map((o) => o.customer_po).filter(Boolean).join(', ')}` : ''}</div>
          )}
        </div>
        <span className={`chip ${statusTone(String(inv.status))}`}>{String(inv.status)}</span>
      </div>
      <div className="row" style={{ gap: 8, margin: '10px 0 14px' }}>
        <button type="button" onClick={() => openPdf(path).catch((e) => setError(e.message))}>Print</button>
        <button type="button" className="secondary"
                onClick={() => download(path, `${String(inv.invoiceNumber)}.pdf`).catch((e) => setError(e.message))}>
          Download PDF
        </button>
      </div>
      <div className="panel paper">
        <p className="small" style={{ marginTop: 0 }}>
          Dated {when(String(inv.invoiceDate))}
          {!isCN && inv.dueDate ? ` · due ${when(String(inv.dueDate))}` : ''}
          {inv.period_from && inv.period_to ? ` · deliveries ${when(String(inv.period_from))} to ${when(String(inv.period_to))}` : ''}
        </p>
        <table className="paper-lines">
          <thead><tr>{lines.some((l) => l.delivered_on) && <th>Delivered</th>}<th>Item</th><th>Quantity</th><th className="num">Unit price</th><th className="num">Amount</th></tr></thead>
          <tbody>
            {lines.map((l, i) => {
              const cased = Number(l.cases) > 0;
              return (
                <tr key={i}>
                  {lines.some((x) => x.delivered_on) && <td className="small">{l.delivered_on ? when(String(l.delivered_on)) : ''}</td>}
                  <td>{String(l.product_name ?? '')}</td>
                  <td>{cased ? `${l.cases} cs` : String(l.loose_bottles)}</td>
                  <td className="num">{money(Number(cased ? l.price_per_case_cents : l.price_per_bottle_cents))}</td>
                  <td className="num">{money(Number(l.line_total_cents))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="paper-totals">
          <div className="total-line"><span>Subtotal</span><span>{money(Math.abs(n('subtotal_cents')))}</span></div>
          {n('discount_amount_cents') > 0 && <div className="total-line"><span>Discount</span><span>−{money(n('discount_amount_cents'))}</span></div>}
          <div className="total-line"><span>{inv.gct_exempt ? 'GCT (exempt)' : 'GCT 15%'}</span><span>{money(Math.abs(n('gct_cents')))}</span></div>
          <div className="total-line grand"><span>{isCN ? 'Credit' : 'Total'}</span><span>{money(Math.abs(n('grandTotalCents')))}</span></div>
          {!isCN && (
            <>
              <div className="total-line"><span>Paid</span><span>{money(n('amountPaidCents'))}</span></div>
              <div className="total-line grand"><span>Balance due</span><span>{money(n('balanceCents'))}</span></div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
