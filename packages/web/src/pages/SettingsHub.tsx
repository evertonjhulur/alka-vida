import { Link } from 'react-router-dom';
import type { Session } from '../lib/api';

/**
 * Settings: one menu link, one page of cards (UX review and mockup,
 * 10-11 Oct 2026). The five areas used to be five menu links that sat below
 * the bottom of a laptop screen. Each card opens the page as it was, and
 * each of those pages has a "← Settings" link back here.
 */
interface Card { to: string; title: string; text: string; adminOnly?: boolean; officeOnly?: boolean }

const CARDS: Card[] = [
  { to: '/pricing', title: 'Products & pricing', text: 'What you sell, case sizes, prices, price lists and recipes (bills of materials).' },
  { to: '/zones', title: 'Delivery zones', text: 'The areas you deliver to, the days each one is served and the delivery fee.' },
  { to: '/auto-emails', title: 'Emails & ordering', text: 'The emails Alka Vida sends on its own, and the rules for taking orders.' },
  { to: '/settings/money', title: 'Invoices & payments', text: 'Bank details at the foot of invoices and statements, and whether you take card.' },
  { to: '/employees', title: 'People & logins', text: 'Staff and drivers, and who can sign in to Alka Vida.', adminOnly: true },
  { to: '/employees', title: 'Employees', text: 'Staff and drivers.', officeOnly: true },
  { to: '/settings/notifications', title: 'Notifications', text: 'Who is told about new orders and decisions on their phone, quiet hours, and their devices.', adminOnly: true },
  { to: '/settings/audit-log', title: 'Audit log', text: 'Who did what, and when: every change made in Alka Vida, searchable.', adminOnly: true },
];

export default function SettingsHub(
  { session }: { session: Session; pending?: unknown },
) {
  const admin = session.role === 'admin';
  const cards = CARDS.filter((c) => (c.adminOnly ? admin : c.officeOnly ? !admin : true));
  return (
    <>
      <h1>Settings</h1>
      <p className="subtitle">Everything that is set up once and changed rarely. Pick an area.</p>
      <div className="settings-grid">
        {cards.map((c) => (
          <Link key={c.title} to={c.to} className="settings-card">
            <span className="settings-card-title">{c.title}</span>
            <span className="settings-card-text">{c.text}</span>
          </Link>
        ))}
      </div>
    </>
  );
}
