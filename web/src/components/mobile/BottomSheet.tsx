import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

/**
 * Hoja que sube desde abajo (el "cuadro de diálogo" de los teléfonos). Se cierra con la X, tocando fuera o arrastrando hacia abajo.
 * `full` la abre a pantalla casi completa (formularios largos); si no, ocupa solo lo que necesita su contenido.
 */
export function BottomSheet({ open, onClose, title, children, footer, full = false, className = '' }: {
  open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; footer?: ReactNode; full?: boolean; className?: string;
}) {
  const id = useId();
  const sheet = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; dy: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [open, onClose]);

  if (!open) return null;

  const start = (e: React.PointerEvent) => { drag.current = { y: e.clientY, dy: 0 }; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); };
  const move = (e: React.PointerEvent) => {
    if (!drag.current || !sheet.current) return;
    drag.current.dy = Math.max(0, e.clientY - drag.current.y);
    sheet.current.style.transform = `translateY(${drag.current.dy}px)`;
    sheet.current.style.transition = 'none';
  };
  const end = () => {
    if (!drag.current || !sheet.current) return;
    const dy = drag.current.dy;
    drag.current = null;
    sheet.current.style.transition = '';
    sheet.current.style.transform = '';
    if (dy > 90) onClose();
  };

  return (
    <div className="sheet-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={sheet} className={`sheet ${full ? 'sheet-full' : ''} ${className}`} role="dialog" aria-modal="true" aria-labelledby={title ? id : undefined}>
        <div className="sheet-grab" onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end}><span /></div>
        <header className="sheet-head">
          <h3 id={id}>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="close"><X size={20} /></button>
        </header>
        <div className="sheet-body">{children}</div>
        {footer && <footer className="sheet-foot">{footer}</footer>}
      </div>
    </div>
  );
}
