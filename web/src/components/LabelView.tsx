import { useLayoutEffect, useMemo, useRef, type CSSProperties, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import QRCode from 'qrcode';
import * as LucideIcons from 'lucide-react';
import { code128Modules } from '../lib/code128';
import { codeValue, elementText, type DocumentIcon, type LabelCtx, type LabelElement, type LabelSubject } from '../lib/labels';

/**
 * Estilo de las etiquetas. Es el MISMO para el diseñador, la vista previa y la impresión
 * (se inyecta también dentro del iframe de impresión), así que lo que se ve es lo que sale.
 */
export const LABEL_CSS = `
.lbl{position:relative;box-sizing:border-box;background:#fff;color:#000;overflow:hidden;font-family:Arial,Helvetica,sans-serif;line-height:1.1}
.lbl *{box-sizing:border-box}
.lbl-el{position:absolute;overflow:hidden}
.lbl-text{display:flex}
.lbl-text>span{display:block;width:100%;overflow-wrap:anywhere;white-space:pre-wrap}
.lbl-code{position:absolute;display:block}
.lbl-code svg{display:block;width:100%;height:100%}
.lbl-icon{position:absolute;display:block}
.lbl-icon svg{display:block;width:100%;height:100%}
.lbl-bar-text{position:absolute;left:0;right:0;bottom:0;text-align:center;font-family:Arial,Helvetica,sans-serif;white-space:nowrap;overflow:hidden}
`;

export function LabelStyles() { return <style>{LABEL_CSS}</style>; }

interface QrData { size: number; path: string }
const qrCache = new Map<string, QrData>();
function qrData(text: string): QrData {
  const hit = qrCache.get(text);
  if (hit) return hit;
  const qr = QRCode.create(text || ' ', { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  let d = '';
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!qr.modules.get(r, c)) { c++; continue; }
      let e = c;
      while (e < n && qr.modules.get(r, e)) e++;
      d += `M${c} ${r}h${e - c}v1h-${e - c}z`;
      c = e;
    }
  }
  const out = { size: n, path: d };
  if (qrCache.size > 300) qrCache.clear();
  qrCache.set(text, out);
  return out;
}

function QrSvg({ text }: { text: string }) {
  const q = qrData(text);
  const quiet = 1; // margen mínimo alrededor
  return (
    <svg viewBox={`${-quiet} ${-quiet} ${q.size + quiet * 2} ${q.size + quiet * 2}`} preserveAspectRatio="xMidYMid meet" shapeRendering="crispEdges">
      <path d={q.path} fill="#000" />
    </svg>
  );
}

const QUIET = 10; // módulos de silencio a cada lado del código de barras

function barsPath(modules: string): string {
  let d = '';
  let i = 0;
  while (i < modules.length) {
    if (modules[i] !== '1') { i++; continue; }
    let e = i;
    while (e < modules.length && modules[e] === '1') e++;
    d += `M${QUIET + i} 0h${e - i}v1h-${e - i}z`;
    i = e;
  }
  return d;
}

/** Ancho de un módulo (la barra más fina) en mm para un código de barras dado; sirve para avisar si es muy denso. */
export function barcodeModuleMm(text: string, widthMm: number): number {
  return widthMm / (code128Modules(text).length + QUIET * 2);
}

function BarcodeSvg({ text }: { text: string }) {
  const m = code128Modules(text);
  return (
    <svg viewBox={`0 0 ${m.length + QUIET * 2} 1`} preserveAspectRatio="none" shapeRendering="crispEdges">
      <path d={barsPath(m)} fill="#000" />
    </svg>
  );
}

/** Ícono del diseñador de documentos: cualquier ícono de lucide-react de la lista curada (DOCUMENT_ICONS). */
function IconGlyph({ name }: { name?: DocumentIcon }) {
  const Cmp = name ? (LucideIcons as unknown as Record<string, React.ComponentType<{ absoluteStrokeWidth?: boolean; strokeWidth?: number }>>)[name] : undefined;
  if (!Cmp) return null;
  return <Cmp absoluteStrokeWidth strokeWidth={1.5} />;
}

/** Reduce la letra de los textos con "ajustar" hasta que quepan en su recuadro. */
export function fitLabels(root: HTMLElement | null) {
  if (!root) return;
  root.querySelectorAll<HTMLElement>('[data-fit="1"]').forEach((box) => {
    const inner = box.firstElementChild as HTMLElement | null;
    if (!inner) return;
    const base = Number(box.dataset.base) || 8;
    let size = base;
    box.style.fontSize = `${size}pt`;
    let guard = 0;
    while (size > 4 && guard++ < 80 && (inner.scrollHeight > box.clientHeight + 0.5 || inner.scrollWidth > box.clientWidth + 0.5)) {
      size -= 0.25;
      box.style.fontSize = `${size}pt`;
    }
  });
}

export interface LabelViewProps {
  widthMm: number;
  heightMm: number;
  elements: LabelElement[];
  unit: LabelSubject;
  ctx: LabelCtx;
  style?: CSSProperties;
  /** Modo diseñador: cada elemento recibe estos eventos y una capa para seleccionarlo. */
  editor?: { selectedId: string | null; onPointerDown: (e: RPointerEvent, el: LabelElement, mode: 'move' | 'resize') => void; onBackground: () => void; children?: ReactNode };
}

export function LabelView({ widthMm, heightMm, elements, unit, ctx, style, editor }: LabelViewProps) {
  const ref = useRef<HTMLDivElement>(null);
  const texts = useMemo(() => elements.map((el) => (el.type === 'field' || el.type === 'text' ? elementText(el, unit, ctx) : '')), [elements, unit, ctx]);
  useLayoutEffect(() => { fitLabels(ref.current); });

  return (
    <div ref={ref} className="lbl" style={{ width: `${widthMm}mm`, height: `${heightMm}mm`, ...style }}
      onPointerDown={editor ? (e) => { if (e.target === e.currentTarget) editor.onBackground(); } : undefined}>
      {elements.map((el, i) => {
        const box: CSSProperties = { left: `${el.x}mm`, top: `${el.y}mm`, width: `${el.w}mm`, height: `${el.h}mm` };
        const editProps = editor ? { onPointerDown: (e: RPointerEvent) => editor.onPointerDown(e, el, 'move'), 'data-el': el.id, style: { ...box, cursor: 'move', touchAction: 'none' as const } } : { style: box };
        let inner: ReactNode = null;
        let cls = 'lbl-el';
        let extra: Record<string, string> = {};
        let boxStyle: CSSProperties = {};

        if (el.type === 'field' || el.type === 'text') {
          cls += ' lbl-text';
          const fs = el.fontSize ?? 8;
          boxStyle = {
            fontSize: `${fs}pt`, fontWeight: el.bold ? 700 : 400, fontStyle: el.italic ? 'italic' : 'normal', textAlign: el.align ?? 'left',
            alignItems: el.valign === 'middle' ? 'center' : el.valign === 'bottom' ? 'flex-end' : 'flex-start',
            ...(el.inverse ? { background: '#000', color: '#fff', padding: '0.3mm 0.6mm' } : {}),
          };
          if (el.shrink !== false) extra = { 'data-fit': '1', 'data-base': String(fs) };
          inner = <span>{texts[i]}</span>;
        } else if (el.type === 'qr') {
          cls += ' lbl-code';
          inner = <QrSvg text={codeValue(el.source, unit, ctx)} />;
        } else if (el.type === 'barcode') {
          cls += ' lbl-code';
          const text = codeValue(el.source, unit, ctx, true);
          const textH = el.showText ? Math.min(3.4, el.h * 0.32) : 0;
          inner = (
            <>
              <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: `${el.h - textH}mm` }}><BarcodeSvg text={text} /></div>
              {el.showText && <div className="lbl-bar-text" style={{ height: `${textH}mm`, fontSize: `${(textH * 72) / 25.4 * 0.85}pt`, lineHeight: `${textH}mm` }}>{text}</div>}
            </>
          );
        } else if (el.type === 'icon') {
          cls += ' lbl-icon';
          inner = <IconGlyph name={el.icon} />;
        } else {
          boxStyle = el.filled ? { background: '#000' } : { border: `${el.border ?? 0.3}mm solid #000` };
        }
        const { style: st, ...rest } = editProps as { style: CSSProperties } & Record<string, unknown>;
        return <div key={el.id} className={cls} {...extra} {...rest} style={{ ...st, ...boxStyle }}>{inner}</div>;
      })}
      {editor?.children}
    </div>
  );
}

/** Etiqueta ampliada/reducida por un factor `k` ocupando el espacio real (para vistas previas). */
export function ScaledLabel({ k, ...props }: LabelViewProps & { k: number }) {
  return (
    <div style={{ width: `${props.widthMm * k}mm`, height: `${props.heightMm * k}mm`, flex: 'none' }}>
      <div style={{ transform: `scale(${k})`, transformOrigin: '0 0', width: `${props.widthMm}mm`, height: `${props.heightMm}mm` }}>
        <LabelView {...props} />
      </div>
    </div>
  );
}
