import { useEffect, useState } from 'react';
import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { THEMES, applyTheme, getTheme, type Theme } from '../lib/theme';

const ICONS: Record<Theme, LucideIcon> = { system: Monitor, light: Sun, dark: Moon };

/** Selector de tema claro / oscuro / automático (según el sistema). */
export function ThemeToggle() {
  const { t } = useTranslation();
  const [theme, setTheme] = useState<Theme>(getTheme);
  useEffect(() => {
    const sync = () => setTheme(getTheme());
    window.addEventListener('themechange', sync);
    return () => window.removeEventListener('themechange', sync);
  }, []);
  return (
    <div className="lang-toggle theme-toggle" role="group" aria-label={t('shell.theme')}>
      {THEMES.map((k) => {
        const Icon = ICONS[k];
        return (
          <button key={k} className={theme === k ? 'on' : ''} onClick={() => applyTheme(k)} title={t(`shell.theme_${k}`)} aria-label={t(`shell.theme_${k}`)} aria-pressed={theme === k}>
            <Icon size={15} />
          </button>
        );
      })}
    </div>
  );
}
