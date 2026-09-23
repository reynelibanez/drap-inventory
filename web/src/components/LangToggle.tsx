import { useTranslation } from 'react-i18next';
import { useAuth } from '../lib/auth';
import { LANGS, applyLanguage, type Lang } from '../lib/i18n';

/** Selector ES | EN. Si hay sesión guarda la preferencia en el perfil del usuario. */
export function LangToggle() {
  const { i18n } = useTranslation();
  const { setLanguage, status } = useAuth();
  const cur = (i18n.language?.slice(0, 2) ?? 'es') as Lang;
  return (
    <div className="lang-toggle" role="group" aria-label="language">
      {LANGS.map((l) => (
        <button key={l} className={cur === l ? 'on' : ''} onClick={() => (status === 'authed' ? void setLanguage(l) : applyLanguage(l))}>
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
