import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Eye, EyeOff, Loader2, Lock, WifiOff } from 'lucide-react';
import { AuthFrame } from '../pages/Login';
import { useAuth } from '../lib/auth';
import { ApiError } from '../lib/api';
import { useErr } from './ui';

/**
 * Bloqueo por inactividad: se dibuja encima de la pantalla actual sin desmontarla (nada de lo que
 * estaba haciendo el usuario se pierde). Requiere la contraseña para continuar; no cierra la sesión.
 * Desbloquear necesita conexión (la contraseña solo se verifica en el servidor).
 */
export function LockScreen() {
  const { t } = useTranslation();
  const { user, unlock, logout } = useAuth();
  const err = useErr();
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await unlock(password);
      setPassword('');
    } catch (x) {
      setError(x instanceof ApiError && x.code === 'offline_required' ? t('auth.unlock_offline') : err(x));
    } finally { setBusy(false); }
  }

  return (
    <div className="lock-overlay" role="alertdialog" aria-modal="true" aria-labelledby="lock-title">
      <AuthFrame title={t('auth.lock_title')} hint={user?.fullName ?? user?.username}>
        <form className="auth-form" onSubmit={submit}>
          {error && (
            <div className="auth-error" role="alert">
              {error === t('auth.unlock_offline') && <WifiOff size={16} />}
              <span>{error}</span>
            </div>
          )}
          <p className="auth-hint" style={{ marginTop: 0 }}>{t('auth.lock_hint')}</p>
          <label className="auth-field">
            <span className="sr-only">{t('auth.password')}</span>
            <Lock size={18} className="auth-ico" />
            <input
              type={show ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)}
              placeholder={t('auth.password')} autoFocus autoComplete="current-password" required
            />
            <button type="button" className="auth-eye" onClick={() => setShow((v) => !v)} aria-label={t(show ? 'auth.hide_password' : 'auth.show_password')} aria-pressed={show} tabIndex={-1}>
              {show ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </label>
          <button type="submit" className="auth-submit" disabled={busy}>
            {busy ? <Loader2 size={18} className="spin" /> : <>{t('auth.unlock')}<ArrowRight size={18} /></>}
          </button>
          <button type="button" className="auth-link" onClick={() => void logout()}>{t('nav.logout')}</button>
        </form>
      </AuthFrame>
    </div>
  );
}
