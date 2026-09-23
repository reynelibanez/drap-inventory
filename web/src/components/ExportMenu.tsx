import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, FileSpreadsheet, FileText, Printer } from 'lucide-react';
import { Button, useErr, useToast } from './ui';
import { Popover } from './grid/Popover';
import { runExport, safeFileName, stamp, type ExportKind, type ExportTable } from './grid/exporters';

export interface ExportOption {
  id: string;
  label: string;
  hint?: string;
  /** Arma la tabla al momento de exportar (puede pedir datos al servidor). */
  build: () => ExportTable | Promise<ExportTable>;
  /** Nombre del archivo sin extensión (se le agrega la fecha). */
  filename: string;
}

/**
 * Botón "Exportar" con varias opciones de documento (por ejemplo: packing list detallado o resumido),
 * cada una en Excel, CSV o PDF/imprimir. `extra` permite añadir acciones propias (como el PDF del servidor).
 */
export function ExportMenu({ options, extra, label, variant = 'secondary' }: {
  options: ExportOption[]; extra?: { label: string; icon?: ReactNode; onClick: () => void | Promise<void> }[]; label?: string; variant?: 'secondary' | 'primary' | 'ghost';
}) {
  const { t } = useTranslation();
  const err = useErr();
  const toast = useToast();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [busy, setBusy] = useState(false);

  async function go(o: ExportOption, kind: ExportKind) {
    setBusy(true);
    try {
      const table = await o.build();
      runExport(kind, table, `${safeFileName(o.filename)}_${stamp()}`);
      setAnchor(null);
    } catch (e) { toast.error(err(e)); } finally { setBusy(false); }
  }

  return (
    <>
      <Button variant={variant} icon={<Download size={16} />} loading={busy} onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}>{label ?? t('grid.export')}</Button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} minWidth={280} align="right">
          <div className="pop-body">
            {options.map((o) => (
              <div key={o.id} className="xm-opt">
                <div><strong>{o.label}</strong>{o.hint && <div className="muted" style={{ fontSize: 12 }}>{o.hint}</div>}</div>
                <div className="row gap-sm">
                  <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void go(o, 'xlsx')}><FileSpreadsheet size={14} />Excel</button>
                  <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void go(o, 'csv')}><FileText size={14} />CSV</button>
                  <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void go(o, 'pdf')}><Printer size={14} />PDF</button>
                </div>
              </div>
            ))}
            {extra?.map((x) => (
              <button key={x.label} type="button" className="xm-extra" onClick={() => { setAnchor(null); void x.onClick(); }}>{x.icon}{x.label}</button>
            ))}
          </div>
        </Popover>
      )}
    </>
  );
}
