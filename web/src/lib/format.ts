const loc = (lang: string) => (lang === 'en' ? 'en-US' : 'es-US');

export function fmtDate(v: string | Date | null | undefined, lang: string): string {
  if (!v) return '—';
  const d = typeof v === 'string' ? new Date(v.length === 10 ? v + 'T00:00:00' : v) : v;
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(loc(lang), { year: 'numeric', month: 'short', day: 'numeric' });
}

export function fmtDateTime(v: string | Date | null | undefined, lang: string): string {
  if (!v) return '—';
  const d = typeof v === 'string' ? new Date(v) : v;
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(loc(lang), { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtMoney(n: number | null | undefined, currency: string, lang: string): string {
  if (n === null || n === undefined) return '—';
  try { return new Intl.NumberFormat(loc(lang), { style: 'currency', currency }).format(n); } catch { return `${n} ${currency}`; }
}

export const fmtInt = (n: number | null | undefined, lang: string) => (n === null || n === undefined ? '—' : new Intl.NumberFormat(loc(lang)).format(n));

/** Fecha local (no UTC) en formato yyyy-mm-dd para inputs type=date. */
export const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Tiempo transcurrido en lenguaje natural ("hace 5 min", "ayer"); pasada una semana, la fecha. */
export function timeAgo(v: string | Date, lang: string, now = Date.now()): string {
  const d = typeof v === 'string' ? new Date(v) : v;
  const sec = Math.round((d.getTime() - now) / 1000);
  const abs = Math.abs(sec);
  const rtf = new Intl.RelativeTimeFormat(loc(lang), { numeric: 'auto' });
  if (abs < 45) return rtf.format(0, 'second');
  if (abs < 3600) return rtf.format(Math.round(sec / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(sec / 3600), 'hour');
  if (abs < 7 * 86400) return rtf.format(Math.round(sec / 86400), 'day');
  return fmtDate(d, lang);
}
