import { BrandMark } from '../BrandMark';
import { useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Building2, ChevronLeft, ChevronRight, CloudOff, LogOut, Menu, Palette, RefreshCw, ScanLine, Bell } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useOnline, useOps } from '../../lib/offline';
import { LangToggle } from '../LangToggle';
import { NotificationBell } from '../NotificationBell';
import { InstallButton, PwaBar } from '../PwaBar';
import { ThemeToggle } from '../ThemeToggle';
import { OfflineEffects, SyncChip } from '../SyncStatus';
import { ScanBox } from '../ScanBox';
import { NAV, useVisibleNav, type NavItem } from '../nav';
import { useShellCommon } from '../shellHooks';
import { useErr, useToast } from '../ui';
import { BottomSheet } from './BottomSheet';

/** Pestañas de la barra inferior por orden de prioridad: se muestran las 4 primeras que el usuario puede usar. */
const TAB_PRIORITY = ['/', '/lots', '/testing', '/units', '/orders', '/locations', '/assets', '/reports'];
const MAX_TABS = 4;

const ALL_ITEMS: NavItem[] = NAV.flatMap((g) => g.items);
const sectionOf = (pathname: string): NavItem | undefined =>
  ALL_ITEMS.filter((i) => i.to !== '/' && (pathname === i.to || pathname.startsWith(`${i.to}/`))).sort((a, b) => b.to.length - a.to.length)[0]
  ?? (pathname === '/' ? ALL_ITEMS.find((i) => i.to === '/') : undefined);
const depthOf = (pathname: string) => pathname.split('/').filter(Boolean).length;
const isIn = (pathname: string, to: string) => (to === '/' ? pathname === '/' : pathname === to || pathname.startsWith(`${to}/`));

/**
 * Diseño propio del teléfono: barra superior con título y acciones, contenido a todo el ancho y barra de pestañas inferior
 * (lo más usado) con un menú "Más" que se abre como hoja deslizable.
 */
export function MobileShell() {
  const { t } = useTranslation();
  const { user, company, companies, selectCompany } = useAuth();
  const { pathname } = useLocation();
  const nav = useNavigate();
  const err = useErr();
  const toast = useToast();
  const online = useOnline();
  const ops = useOps();
  const { doLogout } = useShellCommon();
  const visible = useVisibleNav();
  const { can } = useAuth();
  const [more, setMore] = useState(false);
  const [scan, setScan] = useState(false);

  const allowed = useMemo(() => new Set(visible.flatMap((g) => g.items.map((i) => i.to))), [visible]);
  const tabs = useMemo(() => TAB_PRIORITY.filter((to) => allowed.has(to)).slice(0, MAX_TABS).map((to) => ALL_ITEMS.find((i) => i.to === to)!), [allowed]);
  const inTab = tabs.some((tb) => isIn(pathname, tb.to));
  const canScan = can('units.view') || can('lots.view') || can('assets.view');
  const pending = ops.length;
  const initials = (user?.fullName ?? '?').split(/\s+/).map((s) => s[0]).slice(0, 2).join('').toUpperCase();

  const depth = depthOf(pathname);
  const section = sectionOf(pathname);
  const deep = depth >= 2;
  const goBack = () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) nav(-1);
    else nav(section && section.to !== pathname ? section.to : '/', { replace: true });
  };

  // Al abrir el teclado la barra inferior se oculta (deja más espacio a lo que se escribe).
  useEffect(() => {
    const isField = (el: EventTarget | null) => el instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !['checkbox', 'radio', 'button', 'submit', 'file'].includes((el as HTMLInputElement).type);
    let t: ReturnType<typeof setTimeout> | null = null;
    const on = (e: FocusEvent) => { if (isField(e.target)) { if (t) clearTimeout(t); document.documentElement.setAttribute('data-kb', '1'); } };
    const off = () => { t = setTimeout(() => document.documentElement.removeAttribute('data-kb'), 120); };
    document.addEventListener('focusin', on); document.addEventListener('focusout', off);
    return () => { document.removeEventListener('focusin', on); document.removeEventListener('focusout', off); document.documentElement.removeAttribute('data-kb'); if (t) clearTimeout(t); };
  }, []);

  // Cada pantalla nueva empieza arriba.
  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);

  const tile = (it: NavItem) => (
    <NavLink key={it.to} to={it.to} end={it.to === '/'} replace className={({ isActive }) => `m-tile ${isActive ? 'active' : ''}`} onClick={() => setMore(false)}>
      <it.icon size={22} /><span>{t(it.label)}</span>
    </NavLink>
  );

  return (
    <div className="m-app">
      <OfflineEffects />
      <PwaBar />
      <header className="m-top no-print">
        {deep
          ? <button className="m-back" onClick={goBack} aria-label={t('common.back')}><ChevronLeft size={24} /></button>
          : <BrandMark size={30} className="m-logo" />}
        <div className="m-title truncate">{deep ? (section ? t(section.label) : t('app.name')) : (company?.name ?? t('app.name'))}</div>
        <SyncChip />
        {canScan && <button className="icon-btn m-top-btn" onClick={() => setScan(true)} aria-label={t('mobile.scan')} title={t('mobile.scan')}><ScanLine size={21} /></button>}
        <NotificationBell />
      </header>

      <main className="m-content"><Outlet /></main>

      <nav className="m-tabs no-print" aria-label={t('mobile.menu_title')}>
        {tabs.map((tb) => (
          <NavLink key={tb.to} to={tb.to} end={tb.to === '/'} className={({ isActive }) => `m-tab ${isActive || isIn(pathname, tb.to) ? 'active' : ''}`}>
            <tb.icon size={22} /><span>{t(tb.label)}</span>
          </NavLink>
        ))}
        <button className={`m-tab ${!inTab ? 'active' : ''}`} onClick={() => setMore(true)} aria-haspopup="dialog">
          <span className="m-tab-ico"><Menu size={22} />{pending > 0 && <i className="m-dot" />}</span><span>{t('mobile.more')}</span>
        </button>
      </nav>

      <BottomSheet open={scan} onClose={() => setScan(false)} title={t('mobile.scan_title')}>
        <ScanBox autoFocus onDone={() => setScan(false)} className="m-scan" />
      </BottomSheet>

      <BottomSheet open={more} onClose={() => setMore(false)} title={t('mobile.menu_title')} full>
        <div className="m-more">
          <NavLink to="/profile" className="m-user" onClick={() => setMore(false)}>
            <span className="avatar">{initials}</span>
            <span className="grow"><strong className="truncate" style={{ display: 'block' }}>{user?.fullName}</strong><small className="muted">{user?.username}</small></span>
            <ChevronRight size={18} className="muted" />
          </NavLink>

          {companies.length > 1 && (
            <div className="row gap-sm">
              <Building2 size={18} className="muted" />
              <select className="input" value={company?.id} onChange={(e) => { setMore(false); selectCompany(Number(e.target.value)).catch((x) => toast.error(err(x))); }} aria-label={t('shell.company')}>
                {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          )}

          {visible.map((g, i) => (
            <section key={i}>
              {g.title && <div className="m-group">{t(g.title)}</div>}
              <div className="m-tiles">{g.items.map(tile)}</div>
            </section>
          ))}

          <section>
            <div className="m-group">{t('mobile.appearance_group')}</div>
            <div className="m-rows">
              <div className="m-row"><span>{t('mobile.language')}</span><LangToggle /></div>
              <div className="m-row"><span>{t('mobile.theme')}</span><ThemeToggle /></div>
              <NavLink to="/appearance" className="m-row m-row-link" onClick={() => setMore(false)}><span className="row gap-sm"><Palette size={18} />{t('nav.appearance')}</span><ChevronRight size={16} className="muted" /></NavLink>
            </div>
          </section>

          <section>
            <div className="m-group">{t('mobile.account')}</div>
            <div className="m-rows">
              <NavLink to="/notifications" className="m-row m-row-link" onClick={() => setMore(false)}><span className="row gap-sm"><Bell size={18} />{t('notif.title')}</span><ChevronRight size={16} className="muted" /></NavLink>
              <NavLink to="/sync" className="m-row m-row-link" onClick={() => setMore(false)}>
                <span className="row gap-sm">{online ? <RefreshCw size={18} /> : <CloudOff size={18} />}{t('sync.title')}</span>
                <span className="row gap-sm">{pending > 0 && <span className="badge badge-warn">{pending}</span>}<ChevronRight size={16} className="muted" /></span>
              </NavLink>
              <InstallButton />
            </div>
          </section>

          <button className="btn btn-secondary m-logout" onClick={() => { setMore(false); void doLogout(); }}><LogOut size={18} />{t('nav.logout')}</button>
        </div>
      </BottomSheet>
    </div>
  );
}
