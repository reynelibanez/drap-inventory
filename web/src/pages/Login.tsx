import { BrandMark } from '../components/BrandMark';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Building2, Eye, EyeOff, Loader2, Lock, LogOut, ShieldCheck, User } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Button, Field, Input, useErr, useToast } from '../components/ui';
import { LangToggle } from '../components/LangToggle';
import PlatformPage from './settings/PlatformPage';

const USER_KEY = 'login.username';
const readUser = () => { try { return localStorage.getItem(USER_KEY) ?? ''; } catch { return ''; } };
const saveUser = (v: string | null) => { try { if (v) localStorage.setItem(USER_KEY, v); else localStorage.removeItem(USER_KEY); } catch { /* sin almacenamiento */ } };

/** Marco de las pantallas de acceso: fondo azul noche con patrón de circuito y tarjeta de cristal con el escudo de DRAP. */
export function AuthFrame({ title, hint, children }: { title?: ReactNode; hint?: ReactNode; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="auth-page">
      <div className="auth-lang"><LangToggle /></div>
      <main className="auth-glass">
        <header className="auth-brand">
          <BrandMark size={92} className="auth-shield" />
          <div className="auth-product">{t('app.name')}</div>
          {title ? (
            <>
              <h1 className="auth-h">{title}</h1>
              {hint && <p className="auth-hint">{hint}</p>}
            </>
          ) : <p className="auth-hint">{t('auth.tagline')}</p>}
        </header>
        {children}
        <footer className="auth-foot">DRAP Systems<i />{t('auth.version', { v: __APP_VERSION__ })}</footer>
      </main>
    </div>
  );
}

export function LoginPage() {
  const { t } = useTranslation();
  const { login, sessionEndReason, clearSessionEndReason } = useAuth();
  const err = useErr();
  const saved = readUser();
  const [username, setUsername] = useState(saved);
  const [remember, setRemember] = useState(saved !== '');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (!remember) saveUser(null); }, [remember]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await login(username.trim(), password);
      saveUser(remember ? username.trim() : null);
    } catch (x) { setError(err(x)); } finally { setBusy(false); }
  }
  return (
    <AuthFrame>
      {sessionEndReason === 'revoked' && (
        <div className="auth-note" role="note">
          <span>{t('errors.session_revoked')}</span>
          <button type="button" className="auth-link" onClick={clearSessionEndReason}>{t('common.close')}</button>
        </div>
      )}
      <form className="auth-form" onSubmit={submit}>
        {error && <div className="auth-error" role="alert">{error}</div>}
        <label className="auth-field">
          <span className="sr-only">{t('auth.username')}</span>
          <User size={18} className="auth-ico" />
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder={t('auth.username')} autoFocus={!saved} autoComplete="username" autoCapitalize="none" spellCheck={false} required />
        </label>
        <label className="auth-field">
          <span className="sr-only">{t('auth.password')}</span>
          <Lock size={18} className="auth-ico" />
          <input type={show ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t('auth.password')} autoFocus={!!saved} autoComplete="current-password" required />
          <button type="button" className="auth-eye" onClick={() => setShow((v) => !v)} aria-label={t(show ? 'auth.hide_password' : 'auth.show_password')} aria-pressed={show} tabIndex={-1}>
            {show ? <EyeOff size={18} /> : <Eye size={18} />}
          </button>
        </label>
        <label className="auth-check"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /><span>{t('auth.remember')}</span></label>
        <button type="submit" className="auth-submit" disabled={busy}>
          {busy ? <Loader2 size={18} className="spin" /> : <>{t('auth.enter')}<ArrowRight size={18} /></>}
        </button>
        <button type="button" className="auth-link" onClick={() => setForgot((v) => !v)} aria-expanded={forgot}>{t('auth.forgot')}</button>
        {forgot && <div className="auth-note" role="note"><strong>{t('auth.forgot_title')}</strong><span>{t('auth.forgot_text')}</span></div>}
      </form>
    </AuthFrame>
  );
}

/** Cambio de contraseña obligatorio (primer ingreso o tras un reinicio por el administrador). */
export function ForcePasswordPage() {
  const { t } = useTranslation();
  const { reload, logout } = useAuth();
  const err = useErr();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (next !== again) { setError(t('auth.passwords_differ')); return; }
    setBusy(true); setError('');
    try {
      await api.post('/auth/change-password', { current, next });
      toast.success(t('auth.password_changed'));
      await reload();
    } catch (x) { setError(err(x)); } finally { setBusy(false); }
  }
  return (
    <AuthFrame title={t('auth.change_title')} hint={t('auth.change_hint')}>
      <div className="auth-plain">
        <form className="stack" onSubmit={submit}>
          {error && <div className="alert alert-bad">{error}</div>}
          <Field label={t('auth.current_password')}><Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus autoComplete="current-password" required /></Field>
          <Field label={t('auth.new_password')} hint={t('auth.password_rule')}><Input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required /></Field>
          <Field label={t('auth.repeat_password')}><Input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" required /></Field>
          <div className="row spread">
            <Button variant="ghost" onClick={() => void logout()} icon={<LogOut size={16} />}>{t('nav.logout')}</Button>
            <Button variant="primary" type="submit" loading={busy}>{t('auth.change_action')}</Button>
          </div>
        </form>
      </div>
    </AuthFrame>
  );
}

/** Usuario con acceso a varias empresas (o a ninguna): elige con cuál trabajar. */
export function CompanyPickerPage() {
  const { t } = useTranslation();
  const { companies, selectCompany, logout, user } = useAuth();
  const err = useErr();
  const toast = useToast();
  const [platform, setPlatform] = useState(false);

  if (platform) {
    return (
      <div className="content">
        <PlatformPage standalone onBack={() => setPlatform(false)} />
      </div>
    );
  }
  return (
    <AuthFrame title={t('auth.pick_company')} hint={companies.length ? t('auth.pick_company_hint') : t('auth.no_company')}>
      <div className="auth-plain">
        <div className="stack">
          <div className="company-pick">
            {companies.map((c) => (
              <button key={c.id} onClick={() => selectCompany(c.id).catch((x) => toast.error(err(x)))}>
                <Building2 size={20} />
                <span className="grow"><strong>{c.name}</strong><br /><small className="muted">{c.slug}</small></span>
              </button>
            ))}
          </div>
          {user?.isPlatformAdmin && <Button onClick={() => setPlatform(true)} icon={<ShieldCheck size={16} />}>{t('platform.manage')}</Button>}
          <Button variant="ghost" onClick={() => void logout()} icon={<LogOut size={16} />}>{t('nav.logout')}</Button>
        </div>
      </div>
    </AuthFrame>
  );
}
