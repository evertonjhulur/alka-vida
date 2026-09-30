import { NavLink } from 'react-router-dom';

/**
 * Tabs across the top of a screen that brings two related screens under one
 * menu item: Stock and counts, Purchasing, People and logins (mockups,
 * 29 Sep 2026). Each tab is still its own address, so bookmarks and links
 * keep working.
 */
export default function SectionTabs({ tabs }: { tabs: Array<[string, string]> }) {
  return (
    <nav className="tabs section-tabs" aria-label="In this section">
      {tabs.map(([to, label]) => (
        <NavLink key={to} to={to} end className={({ isActive }) => `tab${isActive ? ' active' : ''}`}>
          {label}
        </NavLink>
      ))}
    </nav>
  );
}
