import { useTranslation } from 'react-i18next';
import { Field, Input } from './ui';
import type { I18nText } from '../lib/i18n';

/** Campo de texto en los dos idiomas (lo que se guarda en la base como {"es": "...", "en": "..."}). */
export function I18nInput({ label, value, onChange, required, autoFocus }: { label: string; value: I18nText; onChange: (v: I18nText) => void; required?: boolean; autoFocus?: boolean }) {
  const { t } = useTranslation();
  return (
    <Field label={label} required={required} hint={t('i18n.hint')}>
      <div className="stack sm">
        <div className="row gap-sm"><span className="chip" style={{ width: 34, textAlign: 'center' }}>ES</span><Input value={value.es ?? ''} autoFocus={autoFocus} onChange={(e) => onChange({ ...value, es: e.target.value })} placeholder={t('common.es')} /></div>
        <div className="row gap-sm"><span className="chip" style={{ width: 34, textAlign: 'center' }}>EN</span><Input value={value.en ?? ''} onChange={(e) => onChange({ ...value, en: e.target.value })} placeholder={t('common.en')} /></div>
      </div>
    </Field>
  );
}

/** Quita vacíos y copia el idioma que falte para que nunca quede un nombre en blanco en alguno de los dos. */
export function completeI18n(v: I18nText): I18nText {
  const es = v.es?.trim(); const en = v.en?.trim();
  return { es: es || en || '', en: en || es || '' };
}
export const i18nValid = (v: I18nText) => !!(v.es?.trim() || v.en?.trim());
