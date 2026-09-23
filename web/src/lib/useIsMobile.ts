import { useSyncExternalStore } from 'react';

/**
 * ¿Pantalla de teléfono? En ese caso la app usa su propio diseño para móviles (barra inferior, tarjetas, hojas deslizables…)
 * y no solo la versión de escritorio encogida. El resultado también se anota en <html data-mobile> para los estilos.
 */
export const MOBILE_QUERY = '(max-width: 820px)';
const mq = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(MOBILE_QUERY) : null;

const apply = () => {
  if (typeof document === 'undefined') return;
  if (mq?.matches) document.documentElement.setAttribute('data-mobile', '1');
  else document.documentElement.removeAttribute('data-mobile');
};
apply();
mq?.addEventListener?.('change', apply);

export const isMobileNow = (): boolean => !!mq?.matches;

export function useIsMobile(): boolean {
  return useSyncExternalStore(
    (cb) => { mq?.addEventListener?.('change', cb); return () => mq?.removeEventListener?.('change', cb); },
    () => !!mq?.matches,
    () => false,
  );
}
