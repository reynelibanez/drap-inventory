/** Escudo de DRAP (logo de la app). `full` muestra el logo completo con el texto "DRAP Systems". */
export function BrandMark({ size = 34, full = false, className = '' }: { size?: number; full?: boolean; className?: string }) {
  return (
    <img
      className={`brand-img ${className}`}
      src={full ? '/logo-full.png' : '/logo-shield.png'}
      alt="DRAP"
      // El alto se fija; el ancho se ajusta solo para no deformar el logo.
      style={{ height: size, width: 'auto' }}
      draggable={false}
    />
  );
}
