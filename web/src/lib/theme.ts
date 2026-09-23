/**
 * Apariencia de la interfaz. Hay dos temas, ambos con la identidad de DRAP Systems:
 *  - "DRAP Claro"  (light): fondo claro con azul Tech Blue.
 *  - "DRAP Noche"  (dark): azul noche (Dark Background) con acento cian.
 * El modo "system" (automático) sigue al sistema operativo. Se guarda por navegador (localStorage).
 */
export type Theme = 'system' | 'light' | 'dark';
export const THEMES: Theme[] = ['system', 'light', 'dark'];
export type Density = 'comfortable' | 'compact';
const KEY = 'theme';
const DENSITY_KEY = 'theme.density';
/** Claves de versiones anteriores (temas con nombre): se borran al arrancar. */
const LEGACY_KEYS = ['theme.light', 'theme.dark', 'theme.name'];
/** Color de la barra del navegador / app instalada en cada modo. */
export const THEME_COLOR = { light: '#0A2F4A', dark: '#0A1E33' } as const;

const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string | null) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } };

export function getTheme(): Theme {
  const v = read(KEY);
  return v === 'light' || v === 'dark' ? v : 'system';
}
/** Modo que se está mostrando ahora (en "automático" depende del sistema operativo). */
export function effectiveMode(mode: Theme = getTheme()): 'light' | 'dark' {
  if (mode !== 'system') return mode;
  try { return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch { return 'light'; }
}
export function getDensity(): Density { return read(DENSITY_KEY) === 'compact' ? 'compact' : 'comfortable'; }

function paint(mode: Theme) {
  const root = document.documentElement;
  if (mode === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', mode);
  root.removeAttribute('data-palette');
  root.setAttribute('data-density', getDensity());
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[effectiveMode(mode)]);
}
const changed = () => window.dispatchEvent(new Event('themechange'));

/** Cambia el modo (lo que hace el botón de temas). */
export function applyTheme(mode: Theme) {
  write(KEY, mode === 'system' ? null : mode);
  paint(mode);
  changed();
}

export function applyDensity(d: Density) {
  write(DENSITY_KEY, d === 'compact' ? 'compact' : null);
  document.documentElement.setAttribute('data-density', d);
  changed();
}

/** Se llama al arrancar, antes de pintar la app. */
export function bootTheme() {
  for (const k of LEGACY_KEYS) write(k, null);
  // Quita estilos en línea de temas con nombre de versiones anteriores.
  const style = document.documentElement.style;
  for (let i = style.length - 1; i >= 0; i--) { const n = style.item(i); if (n.startsWith('--')) style.removeProperty(n); }
  paint(getTheme());
}
bootTheme();
// En automático, si el sistema cambia de claro a oscuro se repinta.
try {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (getTheme() === 'system') { paint('system'); changed(); } });
} catch { /* navegador sin matchMedia */ }
