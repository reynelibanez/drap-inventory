import type { ReactNode } from 'react';
import { ChevronLeft } from 'lucide-react';
import { useIsMobile } from '../../lib/useIsMobile';

/**
 * Pantallas "lista + detalle" (ubicaciones, catálogos): en el teléfono no caben las dos a la vez, así que se muestra la lista
 * y, al elegir algo, el detalle con este botón para volver. Se usa junto a las clases `md`, `md-master` y `md-detail`
 * (y `data-detail="1"` en el contenedor cuando hay algo elegido).
 */
export function DetailBack({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  if (!useIsMobile()) return null;
  return <button type="button" className="md-back" onClick={onClick}><ChevronLeft size={18} />{children}</button>;
}
