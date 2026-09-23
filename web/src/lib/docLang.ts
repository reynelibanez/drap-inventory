import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from './auth';
import { getDocLang, type DocLang } from './docTrace';
import { makeFmt } from './useFmt';
import { useMeta } from './meta';

export { docLocale, getDocLang, toDoc } from './docTrace';

/**
 * Herramientas para armar un documento (lista de empaque, etiquetas, exportaciones): textos, catálogos, fechas y montos en el
 * idioma de la EMPRESA, no en el del usuario que lo pide.
 */
export function useDoc() {
  const { company } = useAuth();
  const { i18n } = useTranslation();
  const meta = useMeta();
  const lang: DocLang = company?.defaultLanguage === 'en' ? 'en' : 'es';
  return useMemo(() => ({
    lang,
    t: i18n.getFixedT(lang),
    meta: meta.inLang(lang),
    fmt: makeFmt(lang),
  }), [lang, i18n, meta]);
}
