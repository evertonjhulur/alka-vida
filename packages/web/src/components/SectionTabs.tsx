import { Link, NavLink } from 'react-router-dom';

/** One tab: its address and its label. */
export type Tab = [string, string];

/**
 * Tabs across the top of a screen that brings related screens under one menu
 * item: Orders, Customers, Invoices, Stock, Purchasing, People and logins
 * (mockups, 29 Sep and 11 Oct 2026). Each tab is still its own address, so
 * bookmarks and links keep working.
 *
 * `badges` puts a count on a tab (accepted quotes on Quotes), the way the
 * menu item used to carry it before the menu was shortened.
 */
export default function SectionTabs(
  { tabs, badges }: { tabs: Tab[]; badges?: Record<string, number> },
) {
  return (
    <nav className="tabs section-tabs" aria-label="In this section">
      {tabs.map(([to, label]) => {
        const n = badges?.[to] ?? 0;
        return (
          <NavLink key={to} to={to} end className={({ isActive }) => `tab${isActive ? ' active' : ''}`}>
            {label}
            {n > 0 && <span className="nav-badge" title={`${n} waiting`}>{n}</span>}
          </NavLink>
        );
      })}
    </nav>
  );
}

/** On each page the Settings hub leads to: the way back to it. */
export function BackToSettings() {
  return <p className="back-link"><Link to="/settings">← Settings</Link></p>;
}
