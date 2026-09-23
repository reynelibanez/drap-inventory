import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, refreshFailedOffline, refreshSession, setAccessToken, setOfflineSession, setOnSessionExpired, setOnSessionRestored } from './api';
import { cacheClearAll, kick, loadLocalModels, setCacheScope, setOutboxScope, setOverlaySession } from './offline';
import { kv } from './offline/idb';
import i18n, { applyLanguage, type Lang } from './i18n';
import { detachPushDevice } from './push';
import { setDocLang } from './docTrace';

export interface CompanyInfo { id: number; name: string; slug: string; defaultLanguage: Lang; currency: string; isCompanyAdmin: boolean; techNumber: number }
export interface UserInfo { id: number; username: string; email: string | null; fullName: string; language: Lang | null; isPlatformAdmin: boolean; mustChangePassword: boolean }
export interface PlanInfo {
  id: number; key: string; name: Record<string, string>; description: Record<string, string>;
  priceMonthlyCents: number | null; priceAnnualCents: number | null; maxUsers: number | null; maxLocations: number | null;
  features: Record<string, boolean>; isActive: boolean;
  /** null = ese plan/intervalo todavía no tiene precio creado en Stripe (falta correr "npm run stripe:setup"). */
  stripePriceIdMonthly: string | null; stripePriceIdAnnual: string | null;
}
export interface BillingInfo {
  plan: PlanInfo | null; status: 'trialing' | 'active' | 'past_due' | 'canceled' | 'expired';
  billingInterval: 'monthly' | 'annual' | null; trialEndsAt: string | null; currentPeriodEnd: string | null;
  canceledAt: string | null; hasStripeCustomer: boolean; blocked: boolean;
}
export interface AccessInfo { isCompanyAdmin: boolean; permissions: string[]; roles: { id: number; name: string }[]; settings: { reservationDays: number | null; unitCodeFormat: string; inactivityLockMinutes: number | null }; billing: BillingInfo | null }
interface SessionData { accessToken: string; user: UserInfo; companies: CompanyInfo[]; activeCompanyId: number | null; access: AccessInfo | null }

interface AuthState {
  /** `unreachable`: al abrir la app no hubo conexión con el servidor (no se sabe si la sesión sigue vigente). */
  status: 'loading' | 'anon' | 'authed' | 'unreachable';
  retryConnection: () => void;
  user: UserInfo | null;
  companies: CompanyInfo[];
  company: CompanyInfo | null;
  access: AccessInfo | null;
  can: (permission: string) => boolean;
  canAny: (...permissions: string[]) => boolean;
  login: (username: string, password: string) => Promise<SessionData>;
  logout: () => Promise<void>;
  selectCompany: (id: number) => Promise<void>;
  reload: () => Promise<void>;
  setLanguage: (lang: Lang) => Promise<void>;
  /** Pantalla bloqueada por inactividad (ver settings.inactivityLockMinutes de la empresa). */
  locked: boolean;
  /** Confirma la contraseña y desbloquea sin perder la sesión ni la pantalla en la que se estaba. */
  unlock: (password: string) => Promise<void>;
  /** Se cerró la sesión porque este usuario inició sesión en otro dispositivo (para avisar una sola vez en Login). */
  sessionEndReason: 'revoked' | null;
  clearSessionEndReason: () => void;
}

const Ctx = createContext<AuthState | null>(null);

/** Última actividad del usuario (para el bloqueo por inactividad), compartida entre pestañas del mismo navegador. */
const ACTIVITY_KEY = 'drap.lastActivity';
const readActivity = (): number => { try { return Number(localStorage.getItem(ACTIVITY_KEY)) || Date.now(); } catch { return Date.now(); } };
const writeActivity = (t: number) => { try { localStorage.setItem(ACTIVITY_KEY, String(t)); } catch { /* sin almacenamiento */ } };

/** Sesión guardada en el teléfono (sin tokens) para poder abrir la app sin conexión. Caduca igual que la sesión del servidor. */
const SNAPSHOT_DAYS = 14;
interface Snapshot { at: number; session: SessionData }
async function loadSnapshot(): Promise<SessionData | null> {
  const snap = await kv.get<Snapshot>('session');
  if (!snap || Date.now() - snap.at > SNAPSHOT_DAYS * 86_400_000) return null;
  return snap.session;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<AuthState['status']>('loading');
  const [data, setData] = useState<SessionData | null>(null);
  const [locked, setLocked] = useState(false);
  const [sessionEndReason, setSessionEndReason] = useState<'revoked' | null>(null);
  const lastCompany = useRef<number | null>(null);

  const apply = useCallback((s: SessionData | null, opts: { offline?: boolean } = {}) => {
    if (!s) {
      setAccessToken(null);
      setOfflineSession(false);
      setData(null);
      setStatus('anon');
      setLocked(false);
      qc.clear();
      lastCompany.current = null;
      setCacheScope(null);
      void setOutboxScope(null);
      void kv.del('session');
      return;
    }
    setLocked(false);
    writeActivity(Date.now());
    setAccessToken(opts.offline ? null : s.accessToken);
    setOfflineSession(!!opts.offline);
    // Copia local y bandeja de trabajo sin conexión: una por usuario y empresa.
    const scope = s.activeCompanyId ? `${s.user.id}:${s.activeCompanyId}` : null;
    setCacheScope(scope);
    void setOutboxScope(scope).then(() => { void loadLocalModels(); if (!opts.offline) void kick(); });
    const perms = new Set(s.access?.permissions ?? []);
    const admin = !!s.access?.isCompanyAdmin;
    setOverlaySession({
      techNumber: s.companies.find((c) => c.id === s.activeCompanyId)?.techNumber ?? 0,
      fullName: s.user.fullName ?? '',
      can: (p) => admin || perms.has(p),
    });
    if (!opts.offline && s.activeCompanyId) void kv.set('session', { at: Date.now(), session: { ...s, accessToken: '' } } satisfies Snapshot);
    if (lastCompany.current !== s.activeCompanyId) qc.clear(); // otra empresa → nada de caché de la anterior
    lastCompany.current = s.activeCompanyId;
    setData(s);
    setStatus('authed');
    // Idioma: preferencia personal → lo elegido antes en este navegador → el de la empresa.
    const company = s.companies.find((c) => c.id === s.activeCompanyId);
    setDocLang(company?.defaultLanguage);   // los documentos salen siempre en el idioma de la empresa
    let saved: string | null = null;
    try { saved = localStorage.getItem('lang'); } catch { /* */ }
    const lang = s.user.language ?? (saved === 'es' || saved === 'en' ? saved : null) ?? company?.defaultLanguage;
    if (lang && lang !== i18n.language) applyLanguage(lang);
  }, [qc]);

  const boot = useCallback(() => {
    void refreshSession().then(async (s) => {
      if (!s && refreshFailedOffline()) {
        // Sin conexión: si el teléfono tiene la sesión guardada se entra igual, con lo último que se descargó.
        const snap = await loadSnapshot();
        if (snap) { apply(snap, { offline: true }); return; }
        setStatus('unreachable');
        return;
      }
      apply(s);
    });
  }, [apply]);

  useEffect(() => {
    setOnSessionExpired((reason) => { if (reason === 'session_revoked') setSessionEndReason('revoked'); apply(null); });
    setOnSessionRestored((s) => apply(s));
    boot();
  }, [apply, boot]);

  const retryConnection = useCallback(() => { setStatus('loading'); boot(); }, [boot]);

  // Si la app se abrió sin conexión, reintenta sola en cuanto vuelve la red.
  useEffect(() => {
    if (status !== 'unreachable') return;
    const retry = () => { setStatus('loading'); boot(); };
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [status, boot]);

  // ---- Bloqueo por inactividad (minutos configurados por la empresa; null/0 = desactivado) ----
  const inactivityMinutes = data?.access?.settings.inactivityLockMinutes ?? null;
  const rearmLockTimer = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    if (status !== 'authed' || !inactivityMinutes) { rearmLockTimer.current = undefined; return; }
    const limitMs = inactivityMinutes * 60_000;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const check = () => {
      const idleFor = Date.now() - readActivity();
      if (idleFor >= limitMs) { setLocked(true); return; }
      if (timer) clearTimeout(timer);
      timer = setTimeout(check, limitMs - idleFor);
    };
    const onActivity = () => {
      // No se escribe en cada evento: alcanza con una vez cada pocos segundos.
      if (Date.now() - readActivity() > 5_000) writeActivity(Date.now());
      if (timer) clearTimeout(timer);
      timer = setTimeout(check, limitMs);
    };
    // Otra pestaña del mismo navegador tuvo actividad: no bloquear esta si la otra sigue en uso.
    const onStorage = (e: StorageEvent) => { if (e.key === ACTIVITY_KEY) check(); };
    // El temporizador se pausa si el navegador suspende la pestaña en segundo plano: se revisa igual al volver.
    const onVisible = () => { if (document.visibilityState === 'visible') check(); };

    const events: (keyof WindowEventMap)[] = ['mousedown', 'keydown', 'touchstart', 'wheel'];
    events.forEach((ev) => window.addEventListener(ev, onActivity, { passive: true }));
    window.addEventListener('storage', onStorage);
    document.addEventListener('visibilitychange', onVisible);
    // Se llama justo después de desbloquear con éxito: reinicia el conteo desde ahora.
    rearmLockTimer.current = () => { writeActivity(Date.now()); check(); };
    check();
    return () => {
      if (timer) clearTimeout(timer);
      events.forEach((ev) => window.removeEventListener(ev, onActivity));
      window.removeEventListener('storage', onStorage);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [status, inactivityMinutes]);

  const login = useCallback(async (username: string, password: string) => {
    const s = await api.post<SessionData>('/auth/login', { username, password });
    apply(s);
    return s;
  }, [apply]);

  const logout = useCallback(async () => {
    await detachPushDevice();   // este navegador deja de recibir los avisos de quien sale
    try { await api.post('/auth/logout'); } catch { /* ya sin sesión */ }
    // Al salir, el teléfono olvida lo descargado y la sesión guardada (lo que esté sin enviar se conserva para cuando vuelva a entrar).
    await kv.del('session');
    await cacheClearAll();
    apply(null);
  }, [apply]);

  const selectCompany = useCallback(async (id: number) => {
    apply(await api.post<SessionData>('/auth/select-company', { companyId: id }));
  }, [apply]);

  const reload = useCallback(async () => {
    const s = await refreshSession();
    if (s) apply(s);
  }, [apply]);

  const unlock = useCallback(async (password: string) => {
    await api.post('/auth/unlock', { password });
    setLocked(false);
    rearmLockTimer.current?.();
  }, []);

  const clearSessionEndReason = useCallback(() => setSessionEndReason(null), []);

  const setLanguage = useCallback(async (lang: Lang) => {
    applyLanguage(lang);
    if (status === 'authed') {
      try {
        await api.patch('/auth/profile', { language: lang });
        setData((d) => (d ? { ...d, user: { ...d.user, language: lang } } : d));
      } catch { /* la preferencia local ya se aplicó */ }
    }
  }, [status]);

  const value = useMemo<AuthState>(() => {
    const company = data?.companies.find((c) => c.id === data.activeCompanyId) ?? null;
    const perms = new Set(data?.access?.permissions ?? []);
    const admin = !!data?.access?.isCompanyAdmin;
    const can = (p: string) => admin || perms.has(p);
    return {
      status, user: data?.user ?? null, companies: data?.companies ?? [], company, access: data?.access ?? null,
      can, canAny: (...ps) => ps.some(can), login, logout, selectCompany, reload, setLanguage, retryConnection,
      locked, unlock, sessionEndReason, clearSessionEndReason,
    };
  }, [status, data, login, logout, selectCompany, reload, setLanguage, retryConnection, locked, unlock, sessionEndReason, clearSessionEndReason]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth fuera de AuthProvider');
  return v;
}
