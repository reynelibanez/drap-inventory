import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { fmtDate, fmtDateTime, fmtInt, fmtMoney } from './format';

/** Formatos de fecha, número y moneda para un idioma. */
export const makeFmt = (lang: string) => ({
  lang,
  date: (v: string | Date | null | undefined) => fmtDate(v, lang),
  dateTime: (v: string | Date | null | undefined) => fmtDateTime(v, lang),
  money: (n: number | null | undefined, currency: string) => fmtMoney(n, currency, lang),
  int: (n: number | null | undefined) => fmtInt(n, lang),
});
export type Fmt = ReturnType<typeof makeFmt>;

/** Formatos de fecha, número y moneda según el idioma activo. */
export function useFmt() {
  const { i18n } = useTranslation();
  const lang = i18n.language?.slice(0, 2) ?? 'es';
  return useMemo(() => makeFmt(lang), [lang]);
}
