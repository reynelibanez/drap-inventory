import type { Db } from '../db.js';

/**
 * Elemento de una etiqueta. Las medidas van en milímetros desde la esquina superior izquierda.
 *  - field:   dato del equipo (source = "code", "serial", "grades", "specs", "spec:<atributo>"...)
 *  - text:    texto fijo
 *  - qr / barcode: código QR o de barras con el dato indicado en `source`
 *  - rect:    línea o recuadro
 */
export interface LabelElement {
  id: string;
  type: 'field' | 'text' | 'qr' | 'barcode' | 'rect';
  x: number; y: number; w: number; h: number;
  source?: string;
  text?: string;
  label?: boolean;
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  align?: 'left' | 'center' | 'right';
  valign?: 'top' | 'middle' | 'bottom';
  shrink?: boolean;
  inverse?: boolean;
  showText?: boolean;
  filled?: boolean;
  border?: number;
}

/** Plantilla inicial: DYMO 30334 (57 × 32 mm), con QR, código, descripción, grados y serie. */
export function defaultLabel(): { name: string; widthMm: number; heightMm: number; layout: { elements: LabelElement[] } } {
  return {
    name: 'DYMO 57 × 32 mm — estándar',
    widthMm: 57,
    heightMm: 32,
    layout: {
      elements: [
        { id: 'qr', type: 'qr', x: 2, y: 4, w: 24, h: 24, source: 'code' },
        { id: 'code', type: 'field', source: 'code', x: 28, y: 2.5, w: 28, h: 4.5, fontSize: 9, bold: true, shrink: true },
        { id: 'type', type: 'field', source: 'type', x: 28, y: 7, w: 28, h: 3.5, fontSize: 7, bold: true, shrink: true },
        { id: 'desc', type: 'field', source: 'specs_all', x: 28, y: 10.5, w: 28, h: 11, fontSize: 6.5, shrink: true },
        { id: 'grades', type: 'field', source: 'grades', label: true, x: 28, y: 21.5, w: 28, h: 4.5, fontSize: 9, bold: true, shrink: true },
        { id: 'serial', type: 'field', source: 'serial', label: true, x: 28, y: 26.5, w: 28, h: 3.5, fontSize: 6, shrink: true },
      ],
    },
  };
}

/** Etiqueta de envío 4 × 6 pulgadas (≈ 102 × 152 mm): cliente, dirección, pedido, bulto, peso, medidas y código. */
export function defaultOrderLabel(): { name: string; widthMm: number; heightMm: number; layout: { elements: LabelElement[] } } {
  return {
    name: 'Envío 102 × 152 mm — estándar',
    widthMm: 102,
    heightMm: 152,
    layout: {
      elements: [
        { id: 'company', type: 'field', source: 'company', x: 4, y: 4, w: 94, h: 6, fontSize: 10, bold: true, shrink: true },
        { id: 'l1', type: 'rect', x: 4, y: 11, w: 94, h: 0.5, filled: true },
        { id: 'customer', type: 'field', source: 'customer', x: 4, y: 14, w: 94, h: 16, fontSize: 24, bold: true, shrink: true, valign: 'middle' },
        { id: 'address', type: 'field', source: 'customer_address', x: 4, y: 31, w: 94, h: 22, fontSize: 12, shrink: true },
        { id: 'l2', type: 'rect', x: 4, y: 55, w: 94, h: 0.5, filled: true },
        { id: 'order', type: 'field', source: 'order_code', label: true, x: 4, y: 58, w: 62, h: 8, fontSize: 14, bold: true, shrink: true },
        { id: 'pkg', type: 'field', source: 'package_of', x: 66, y: 58, w: 32, h: 14, fontSize: 28, bold: true, shrink: true, align: 'right' },
        { id: 'weight', type: 'field', source: 'weight', label: true, x: 4, y: 68, w: 62, h: 8, fontSize: 14, bold: true, shrink: true },
        { id: 'size', type: 'field', source: 'size', label: true, x: 4, y: 78, w: 94, h: 8, fontSize: 14, shrink: true },
        { id: 'units', type: 'field', source: 'units', label: true, x: 4, y: 88, w: 46, h: 6, fontSize: 11, shrink: true },
        { id: 'date', type: 'field', source: 'date', label: true, x: 52, y: 88, w: 46, h: 6, fontSize: 11, shrink: true, align: 'right' },
        { id: 'l3', type: 'rect', x: 4, y: 96, w: 94, h: 0.5, filled: true },
        { id: 'qr', type: 'qr', source: 'code', x: 4, y: 102, w: 42, h: 42 },
        { id: 'bar', type: 'barcode', source: 'code', x: 50, y: 108, w: 48, h: 26, showText: true },
      ],
    },
  };
}

/**
 * Crea las plantillas iniciales que falten: la de equipo si la empresa no tiene ninguna, y la de envío
 * una sola vez (si el usuario la borra después, no vuelve a aparecer).
 */
export async function ensureDefaultLabelTemplate(db: Db, companyId: number): Promise<void> {
  const has = await db.opt('SELECT 1 FROM label_templates WHERE company_id = $1 LIMIT 1', [companyId]);
  if (!has) {
    const d = defaultLabel();
    await db.query(
      `INSERT INTO label_templates (company_id, kind, name, width_mm, height_mm, layout, is_default) VALUES ($1,'unit',$2,$3,$4,$5,true)`,
      [companyId, d.name, d.widthMm, d.heightMm, JSON.stringify(d.layout)]);
  }
  const seeded = await db.opt<{ done: boolean }>(`SELECT COALESCE((settings->'_seeded'->>'orderLabel')::boolean, false) AS done FROM companies WHERE id = $1`, [companyId]);
  if (seeded?.done) return;
  const hasOrder = await db.opt(`SELECT 1 FROM label_templates WHERE company_id = $1 AND kind = 'order' LIMIT 1`, [companyId]);
  if (!hasOrder) {
    const d = defaultOrderLabel();
    await db.query(
      `INSERT INTO label_templates (company_id, kind, name, width_mm, height_mm, layout, is_default) VALUES ($1,'order',$2,$3,$4,$5,true)`,
      [companyId, d.name, d.widthMm, d.heightMm, JSON.stringify(d.layout)]);
  }
  await db.query(
    `UPDATE companies SET settings = settings || jsonb_build_object('_seeded', COALESCE(settings->'_seeded', '{}'::jsonb) || '{"orderLabel": true}'::jsonb) WHERE id = $1`,
    [companyId]);
}
