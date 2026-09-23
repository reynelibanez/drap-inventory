import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { LABEL_CSS, LabelView, fitLabels } from '../components/LabelView';
import type { LabelCtx, LabelSubject, LabelTemplate } from './labels';

export interface PrintJob {
  template: Pick<LabelTemplate, 'widthMm' | 'heightMm' | 'rotation' | 'layout' | 'name'>;
  /** Un equipo (o un bulto de pedido) por etiqueta; para varias copias se repite. */
  units: LabelSubject[];
  ctx: LabelCtx;
}

/**
 * Imprime etiquetas de UNA plantilla: arma una página por etiqueta con el tamaño exacto (@page)
 * dentro de un iframe oculto y abre el diálogo de impresión del navegador (elige allí la DYMO).
 * La rotación (90/270) intercambia el ancho y el alto de la página para impresoras que alimentan de lado.
 */
export async function printLabels(job: PrintJob): Promise<void> {
  const { template: t, units, ctx } = job;
  if (!units.length) return;
  const rot = t.rotation;
  const sideways = rot === 90 || rot === 270;
  const pageW = sideways ? t.heightMm : t.widthMm;
  const pageH = sideways ? t.widthMm : t.heightMm;

  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText = 'position:fixed;left:-10000px;top:0;width:400px;height:400px;border:0;visibility:hidden';
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument!;
  doc.open();
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>${t.name.replace(/[<>&]/g, '')}</title><style>
    @page{size:${pageW}mm ${pageH}mm;margin:0}
    html,body{margin:0;padding:0;background:#fff}
    .pg{position:relative;width:${pageW}mm;height:${pageH}mm;overflow:hidden;break-after:page;page-break-after:always}
    .pg:last-child{break-after:auto;page-break-after:auto}
    .rot{position:absolute;left:0;top:0;transform-origin:0 0}
    ${LABEL_CSS}
  </style></head><body><div id="root"></div></body></html>`);
  doc.close();

  const rotStyle = (): Record<string, string> => {
    if (rot === 90) return { left: `${pageW}mm`, transform: 'rotate(90deg)' };
    if (rot === 270) return { top: `${pageH}mm`, transform: 'rotate(-90deg)' };
    if (rot === 180) return { left: `${pageW}mm`, top: `${pageH}mm`, transform: 'rotate(180deg)' };
    return {};
  };

  const root = createRoot(doc.getElementById('root')!);
  flushSync(() => {
    root.render(
      <>
        {units.map((u, i) => (
          <div className="pg" key={i}>
            <div className="rot" style={rotStyle()}>
              <LabelView widthMm={t.widthMm} heightMm={t.heightMm} elements={t.layout.elements} unit={u} ctx={ctx} />
            </div>
          </div>
        ))}
      </>,
    );
  });
  try { await doc.fonts?.ready; } catch { /* sin soporte */ }
  fitLabels(doc.body);

  const win = iframe.contentWindow!;
  const cleanup = () => { try { root.unmount(); } catch { /* ya cerrado */ } iframe.remove(); };
  win.addEventListener('afterprint', () => setTimeout(cleanup, 500), { once: true });
  setTimeout(cleanup, 5 * 60_000);
  // print() bloquea en Chrome/Edge hasta cerrar el diálogo, así que varias plantillas seguidas salen en orden.
  await new Promise<void>((resolve) => { setTimeout(() => { win.focus(); win.print(); resolve(); }, 50); });
}
