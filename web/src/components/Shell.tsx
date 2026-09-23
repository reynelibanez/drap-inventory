import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Building2, ClipboardList, LogOut, Menu, PanelLeftClose, PanelLeftOpen, Palette } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { LangToggle } from './LangToggle';
import { NotificationBell } from './NotificationBell';
import { InstallButton, PwaBar } from './PwaBar';
import { ThemeToggle } from './ThemeToggle';
import { OfflineEffects, SyncChip } from './SyncStatus';
import { useErr, useToast } from './ui';
import { ScanBox } from './ScanBox';
import { useVisibleNav } from './nav';
import { MobileShell } from './mobile/MobileShell';
import { useIsMobile } from '../lib/useIsMobile';
import { useShellCommon } from './shellHooks';
import { BrandMark } from './BrandMark';

const MINI_KEY = 'ui:sidebar-mini';
const readMini = () => { try { return localStorage.getItem(MINI_KEY) === '1'; } catch { return false; } };

/** Menú lateral contraíble a solo iconos (se recuerda por navegador). En pantallas pequeñas sigue siendo el menú deslizable. */
function useSidebarMini() {
  const [mini, setMini] = useState(readMini);
  const toggle = useCallback(() => {
    setMini((m) => {
      try { localStorage.setItem(MINI_KEY, m ? '0' : '1'); } catch { /* sin almacenamiento */ }
      return !m;
    });
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') { e.preventDefault(); toggle(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);
  return [mini, toggle] as const;
}

function DesktopShell(): ReactNode {
  const { t } = useTranslation();
  const { user, company, companies, selectCompany } = useAuth();
  const [open, setOpen] = useState(false);
  const [mini, toggleMini] = useSidebarMini();
  const err = useErr();
  const toast = useToast();
  const { doLogout } = useShellCommon();

  const visible = useVisibleNav();
  const initials = (user?.fullName ?? '?').split(/\s+/).map((s) => s[0]).slice(0, 2).join('').toUpperCase();

  return (
    <div className={`app ${mini ? 'side-mini' : ''}`}>
      <OfflineEffects />
      {open && <div className="scrim" onClick={() => setOpen(false)} />}
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <div className="brand">
          <BrandMark size={34} />
          <span className="grow brand-text" title={company?.name ?? t('app.name')}>
            <strong className="brand-name truncate">{company?.name ?? t('app.name')}</strong>
            <small className="brand-sub">{t('app.name')}</small>
          </span>
          <button className="icon-btn side-collapse" onClick={toggleMini} title={t(mini ? 'shell.show_menu' : 'shell.hide_menu')} aria-label={t(mini ? 'shell.show_menu' : 'shell.hide_menu')}>
            {mini ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </button>
        </div>
        {companies.length > 1 && (
          <div className="company-switch">
            {mini ? (
              <div className="mini-company" title={company?.name}><Building2 size={18} /></div>
            ) : (
              <div className="row gap-sm">
                <Building2 size={16} className="muted" />
                <select className="input" value={company?.id} onChange={(e) => selectCompany(Number(e.target.value)).catch((x) => toast.error(err(x)))} aria-label={t('shell.company')}>
                  {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
            )}
          </div>
        )}
        <nav className="nav" onClick={() => setOpen(false)}>
          {visible.map((g, i) => (
            <div key={i} className="stack sm" style={{ gap: 2 }}>
              {g.title && <div className="nav-group">{t(g.title)}</div>}
              {g.items.map((it) => (
                <NavLink key={it.to} to={it.to} end={it.to === '/'} title={t(it.label)} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
                  <it.icon size={18} /><span className="nav-label">{t(it.label)}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <NavLink to="/profile" className="user-chip nav-link" title={user?.fullName} onClick={() => setOpen(false)}>
            <span className="avatar">{initials}</span>
            <span className="grow truncate user-name"><strong>{user?.fullName}</strong><br /><small className="muted">{user?.username}</small></span>
          </NavLink>
          <div className="side-row">
            <LangToggle />
            <span className="theme-slot"><ThemeToggle /></span>
            <NavLink to="/appearance" className="icon-btn" title={t('nav.appearance')} aria-label={t('nav.appearance')} onClick={() => setOpen(false)}><Palette size={17} /></NavLink>
          </div>
          <button className="btn btn-ghost btn-sm" style={{ justifyContent: 'flex-start' }} title={t('nav.logout')} aria-label={t('nav.logout')} onClick={() => void doLogout()}><LogOut size={16} /><span className="nav-label">{t('nav.logout')}</span></button>
        </div>
      </aside>
      <div className="main">
        <PwaBar />
        <header className="topbar no-print">
          <button className="icon-btn burger" onClick={() => setOpen(true)} aria-label="menu"><Menu size={20} /></button>
          <ScanBox />
          <div className="grow" />
          <SyncChip />
          <InstallButton />
          <NotificationBell />
          {company && <span className="muted hidden-sm"><ClipboardList size={14} style={{ verticalAlign: -2 }} /> {t('shell.tech_number', { n: company && companies.find((c) => c.id === company.id)?.techNumber })}</span>}
        </header>
        <main className="content"><Outlet /></main>
      </div>
    </div>
  );
}

/** En el teléfono se usa un diseño propio (barra inferior, hojas deslizables, tarjetas); en pantallas grandes, el menú lateral. */
export function Shell(): ReactNode {
  return useIsMobile() ? <MobileShell /> : <DesktopShell />;
}
