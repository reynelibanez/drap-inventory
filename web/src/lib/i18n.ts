import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { getDocLang, getUiLang, note, setUiLang, tracing } from './docTrace';

// Las traducciones viven en src/i18n/<idioma>/<módulo>.json y se unen aquí.
const merge = (mods: Record<string, unknown>) => Object.assign({}, ...Object.values(mods)) as Record<string, unknown>;
const es = merge(import.meta.glob('../i18n/es/*.json', { eager: true, import: 'default' }));
const en = merge(import.meta.glob('../i18n/en/*.json', { eager: true, import: 'default' }));

export type Lang = 'es' | 'en';
export const LANGS: Lang[] = ['es', 'en'];

function detect(): Lang {
  try {
    const saved = localStorage.getItem('lang');
    if (saved === 'es' || saved === 'en') return saved;
  } catch { /* sin almacenamiento */ }
  return navigator.language?.toLowerCase().startsWith('en') ? 'en' : 'es';
}

/**
 * Anota cada texto traducido para poder escribirlo en el idioma de la empresa al exportar (ver docTrace.ts).
 * Las llamadas que piden un idioma distinto al de pantalla (los documentos armados a mano) no se anotan. OJO: el `t` de
 * `useTranslation` ya trae el idioma de pantalla en `options.lng`, por eso se compara en vez de solo ver si existe.
 */
const docTrace = {
  type: 'postProcessor' as const,
  name: 'docTrace',
  process(value: unknown, key: string | string[], options: Record<string, unknown> | undefined) {
    const asked = options?.lng as string | undefined;
    if (typeof value === 'string' && value && tracing() && (!asked || asked === getUiLang())) {
      const opts = { ...options, lng: getDocLang(), postProcess: undefined };
      note(value, () => String(i18n.t(key as string, opts as never)));
    }
    return value;
  },
};

void i18n.use(initReactI18next).use(docTrace).init({
  resources: { es: { translation: es }, en: { translation: en } },
  lng: detect(),
  fallbackLng: 'es',
  interpolation: { escapeValue: false },
  returnNull: false,
  postProcess: ['docTrace'],
});

setUiLang(i18n.language);
i18n.on('languageChanged', (l) => setUiLang(l));

export function applyLanguage(lang: Lang) {
  void i18n.changeLanguage(lang);
  try { localStorage.setItem('lang', lang); } catch { /* ignorar */ }
  document.documentElement.lang = lang;
}

document.documentElement.lang = i18n.language;
export default i18n;

/** Texto traducible guardado en la base: {"es": "...", "en": "..."}. */
export type I18nText = Partial<Record<Lang, string>>;
const pick = (v: I18nText, lang: string): string => (v as any)[lang] ?? v.es ?? v.en ?? Object.values(v)[0] ?? '';
export const trText = (v: I18nText | null | undefined, lang: string): string => {
  if (!v) return '';
  const out = pick(v, lang);
  if (tracing() && lang !== getDocLang()) note(out, () => pick(v, getDocLang()));
  return out;
};
