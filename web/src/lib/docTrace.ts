/**
 * Idioma de los documentos.
 *
 * Todo lo que el sistema genera como documento (exportar a Excel/CSV, imprimir, etiquetas, listas de empaque, reportes) sale
 * en el idioma de la EMPRESA, no en el que el usuario tenga en pantalla.
 *
 * Los documentos que se arman a mano (lista de empaque, etiquetas) se construyen directamente en el idioma de la empresa (`useDoc`).
 * Las tablas que se exportan desde las pantallas (`DataGrid`) ya vienen con sus títulos y valores escritos en el idioma de
 * pantalla, así que aquí se anota cada texto que se muestra junto con la forma de escribirlo en el idioma de la empresa
 * (lo hacen `i18n.t` y `trText`); al exportar, `toDoc` cambia cada texto por su versión del documento.
 * Solo se anota cuando el idioma de pantalla es distinto del de la empresa: si son iguales no hay nada que traducir.
 *
 * Este archivo no importa nada a propósito, para que lo puedan usar tanto `i18n.ts` como el resto sin ciclos.
 */

export type DocLang = 'es' | 'en';

let doc: DocLang = 'es';
let ui: string = 'es';
const MAX = 20_000;
const seen = new Map<string, () => string>();

export const getDocLang = (): DocLang => doc;
export const getUiLang = (): string => ui;
export function setDocLang(lang: DocLang | null | undefined) {
  const next: DocLang = lang === 'en' ? 'en' : 'es';
  if (next !== doc) { doc = next; seen.clear(); }
}
export function setUiLang(lang: string) {
  const next = lang.slice(0, 2);
  if (next !== ui) { ui = next; seen.clear(); }
}
/** Localización de fechas y números para los documentos (igual que `format.ts`). */
export const docLocale = (): string => (doc === 'en' ? 'en-US' : 'es-US');

/** ¿El idioma de pantalla es distinto del de los documentos? (solo entonces hay que traducir al exportar) */
export const tracing = () => doc !== ui;

/** Anota un texto mostrado en pantalla y cómo se escribe en el idioma de la empresa. Llamar solo si `tracing()`. */
export function note(shown: string, inDoc: () => string) {
  if (!shown) return;
  if (seen.size >= MAX) seen.clear();
  seen.set(shown, inDoc);
}

const SEPARATORS = [' · ', ' — ', ': ', ' / ', ', '];

/** El texto en el idioma de los documentos (los textos compuestos, como "Dell · Latitude", se traducen por partes). */
export function toDoc(s: string, depth = 0): string {
  if (!s || !tracing()) return s;
  const hit = seen.get(s);
  if (hit) return hit();
  if (depth > 3) return s;
  for (const sep of SEPARATORS) {
    if (!s.includes(sep)) continue;
    const out = s.split(sep).map((p) => toDoc(p, depth + 1)).join(sep);
    if (out !== s) return out;
  }
  return s;
}
