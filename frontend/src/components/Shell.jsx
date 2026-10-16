import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { fmtNumber, initials } from '../format.js';
import { Button } from './ui.jsx';

/** The campaign workspace (customer and reseller share it). */
const WORKSPACE_NAV = (dashLabel) => [
  { to: '/app', label: dashLabel, icon: '▦', end: true },
  { to: '/app/contacts', label: 'Contacts', icon: '☺' },
  { to: '/app/templates', label: 'Templates', icon: '✎' },
  { to: '/app/campaigns', label: 'Campaigns', icon: '➤' },
  { to: '/app/voice', label: 'Voice calls', icon: '☎' },
  { to: '/app/media', label: 'Media library', icon: '▣' },
  { to: '/app/whatsapp', label: 'WhatsApp', icon: '✆' },
  { to: '/app/usage', label: 'Usage', icon: '◔' },
  { to: '/app/credits', label: 'Credits', icon: '◈' },
];

const NAV = {
  admin: [
    { to: '/admin', label: 'Dashboard', icon: '▦', end: true },
    { section: 'People' },
    { to: '/admin/resellers', label: 'Resellers', icon: '⇄' },
    { to: '/admin/customers', label: 'Customers', icon: '☺' },
    { to: '/admin/cutting', label: 'Campaign cutting', icon: '%' },
    { section: 'System' },
    { to: '/admin/voice', label: 'Calling & CLI', icon: '☎' },
    { to: '/admin/whatsapp-api', label: 'WhatsApp API', icon: '✆' },
    { to: '/admin/audit', label: 'Audit log', icon: '☰' },
    { to: '/admin/settings', label: 'Settings', icon: '⚙' },
    { to: '/admin/profile', label: 'My account', icon: '◉' },
  ],
  reseller: [
    { to: '/reseller', label: 'Dashboard', icon: '▦', end: true },
    { to: '/reseller/customers', label: 'My customers', icon: '☺' },
    { to: '/reseller/audit', label: 'Activity', icon: '☰' },
    { section: 'My campaigns' },
    ...WORKSPACE_NAV('Campaign dashboard'),
    { section: 'Account' },
    { to: '/reseller/profile', label: 'My account', icon: '◉' },
  ],
  customer: [
    ...WORKSPACE_NAV('Dashboard'),
    { to: '/app/activity', label: 'Activity log', icon: '☰' },
    { to: '/app/profile', label: 'My account', icon: '◉' },
  ],
};

const ROLE_LABEL = { admin: 'Administrator', reseller: 'Reseller', customer: 'Customer' };

export default function Shell() {
  const { user, brandName, logout, refreshUser } = useAuth();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const location = useLocation();

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  // Credits change while campaigns run, so re-read the balance whenever the person moves to another page.
  const hasWallet = user.role === 'customer' || user.role === 'reseller';
  useEffect(() => {
    if (hasWallet) refreshUser();
  }, [location.pathname, hasWallet, refreshUser]);

  const items = NAV[user.role] || [];
  return (
    <div className="shell">
      <div className={`overlay-nav ${open ? 'open' : ''}`} onClick={() => setOpen(false)} />
      <aside className={`sidebar ${open ? 'open' : ''}`} aria-label="Main navigation">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 32 32" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinejoin="round">
              <path d="M7 25l2-6A10 10 0 1 1 13 23z" />
            </svg>
          </span>
          <span className="truncate">{brandName}</span>
        </div>
        <nav className="nav">
          {items.map((it, i) =>
            it.section ? (
              <div className="nav-section" key={`s${i}`}>
                {it.section}
              </div>
            ) : (
              <NavLink key={it.to} to={it.to} end={it.end} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
                <span className="nav-icon" aria-hidden="true">
                  {it.icon}
                </span>
                {it.label}
              </NavLink>
            ),
          )}
        </nav>
        <div className="sidebar-foot">
          <div className="truncate" title={user.email}>
            {user.email}
          </div>
          <div style={{ opacity: 0.7 }}>{ROLE_LABEL[user.role]}</div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="row gap-s">
            <button className="btn btn-ghost menu-btn" aria-label="Open menu" onClick={() => setOpen(true)}>
              ☰
            </button>
            <span className="muted small">{ROLE_LABEL[user.role]} panel</span>
          </div>
          <div className="row gap-s">
            {hasWallet ? (
              <Link to="/app/credits" className={`credit-chip ${(user.credits || 0) <= 0 ? 'zero' : (user.credits || 0) <= 50 ? 'low' : ''}`} title="Your credit balance" aria-label={`Credit balance: ${fmtNumber(user.credits || 0)}`}>
                <span aria-hidden="true">◈</span> {fmtNumber(user.credits || 0)} <span className="credit-word">credits</span>
              </Link>
            ) : null}
            <div className="avatar" aria-hidden="true">
              {initials(user.name)}
            </div>
            <span className="truncate" style={{ maxWidth: 160 }}>
              {user.name}
            </span>
            <Button
              size="sm"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                await logout();
              }}
            >
              Sign out
            </Button>
          </div>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
