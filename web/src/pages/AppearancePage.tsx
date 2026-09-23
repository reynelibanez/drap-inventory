import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { Card, PageHeader } from '../components/ui';
import { applyDensity, applyTheme, getDensity, getTheme, type Density, type Theme } from '../lib/theme';

/** Vista previa en miniatura: barra lateral azul noche + contenido en el tema que corresponda. */
function Preview({ kind }: { kind: 'light' | 'dark' | 'system' }) {
  const half = (k: 'light' | 'dark') => (
    <div className={`tp-half tp-${k}`}>
      <div className="tp-side"><i /><i /><i /></div>
      <div className="tp-body"><div className="tp-bar" /><div className="tp-line" /><span className="tp-btn">Aa</span></div>
    </div>
  );
  return (
    <div className={`theme-prev ${kind === 'system' ? 'split' : ''}`} aria-hidden="true">
      {kind === 'system' ? <>{half('light')}{half('dark')}</> : half(kind)}
    </div>
  );
}

/** Apariencia: dos temas de la marca DRAP (Claro y Noche) o automático según el sistema; y la densidad de las tablas. */
export default function AppearancePage() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Theme>(getTheme);
  const [density, setDensity] = useState<Density>(getDensity);
  useEffect(() => {
    const sync = () => { setMode(getTheme()); setDensity(getDensity()); };
    window.addEventListener('themechange', sync);
    return () => window.removeEventListener('themechange', sync);
  }, []);

  const modes: { id: Theme; icon: typeof Sun }[] = [
    { id: 'system', icon: Monitor },
    { id: 'light', icon: Sun },
    { id: 'dark', icon: Moon },
  ];

  return (
    <>
      <PageHeader title={t('appearance.title')} subtitle={t('appearance.subtitle')} />
      <div className="stack">
        <Card title={t('appearance.theme')}>
          <div className="theme-grid">
            {modes.map((m) => {
              const on = mode === m.id;
              return (
                <button key={m.id} className={`theme-card ${on ? 'on' : ''}`} onClick={() => applyTheme(m.id)} aria-pressed={on}>
                  <Preview kind={m.id} />
                  <span className="row spread"><strong className="row gap-sm"><m.icon size={15} />{t(`appearance.name_${m.id}`)}</strong>{on && <Check size={16} />}</span>
                  <span className="muted">{t(`appearance.hint_${m.id}`)}</span>
                </button>
              );
            })}
          </div>
        </Card>

        <Card title={t('appearance.density')}>
          <div className="row wrap">
            {(['comfortable', 'compact'] as Density[]).map((d) => (
              <label key={d} className="checkbox"><input type="radio" name="density" checked={density === d} onChange={() => applyDensity(d)} /><span>{t(`appearance.density_${d}`)}</span></label>
            ))}
          </div>
          <p className="muted" style={{ marginTop: 8 }}>{t('appearance.saved_here')}</p>
        </Card>
      </div>
    </>
  );
}
