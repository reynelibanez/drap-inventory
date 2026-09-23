import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../http.js';
import { notFound } from '../errors.js';
import { route, zId, zIdParam } from '../http.js';

const num = (min: number, max: number) => z.number().min(min).max(max);

/** Lista fija de íconos disponibles en el diseñador (nombres de lucide-react). Espejo de web/src/lib/labels.ts (DOCUMENT_ICONS). */
export const DOCUMENT_ICONS = [
  'CheckCircle2', 'XCircle', 'AlertTriangle', 'Info', 'Star', 'ShieldCheck', 'Truck', 'Package', 'PackageCheck', 'Tag',
  'Box', 'Building2', 'Phone', 'Mail', 'MapPin', 'Calendar', 'User', 'Users', 'DollarSign', 'CreditCard',
  'Wrench', 'Laptop', 'Monitor', 'Smartphone', 'HardDrive', 'Cpu', 'Printer', 'ClipboardCheck', 'ClipboardList', 'Award',
  'ThumbsUp', 'Recycle', 'Flag', 'Lock', 'Camera', 'Battery', 'Wifi', 'Plug', 'Zap', 'FileText',
  'FileCheck2', 'PenLine', 'Trophy', 'Gift', 'Clock', 'AlertCircle', 'Globe', 'Sparkles',
] as const;

const element = z.object({
  id: z.string().min(1).max(40),
  type: z.enum(['field', 'text', 'qr', 'barcode', 'rect', 'icon']),
  x: num(-300, 300), y: num(-300, 300), w: num(0, 300), h: num(0, 300),
  source: z.string().max(80).optional(),
  text: z.string().max(400).optional(),
  label: z.boolean().optional(),
  fontSize: num(3, 96).optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
  valign: z.enum(['top', 'middle', 'bottom']).optional(),
  shrink: z.boolean().optional(),
  inverse: z.boolean().optional(),
  showText: z.boolean().optional(),
  filled: z.boolean().optional(),
  border: num(0, 5).optional(),
  icon: z.enum(DOCUMENT_ICONS).optional(),
});

const layout = z.object({ elements: z.array(element).max(80) });

const templateBody = z.object({
  /** 'unit' = etiqueta de equipo/testeo (por tipo); 'order' = documento de pedido (envío); 'lot' = documento de lote. No cambia después de crearla. */
  kind: z.enum(['unit', 'order', 'lot']).default('unit'),
  name: z.string().trim().min(1).max(80),
  widthMm: num(10, 300),
  heightMm: num(10, 300),
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0),
  layout,
  isDefault: z.boolean().default(false),
  isActive: z.boolean().default(true),
  typeIds: z.array(zId).max(200).default([]),
});

const SELECT = `
  SELECT t.id, t.kind, t.name, t.width_mm AS "widthMm", t.height_mm AS "heightMm", t.rotation, t.layout,
         t.is_default AS "isDefault", t.is_active AS "isActive", t.updated_at AS "updatedAt",
         COALESCE((SELECT array_agg(lt.equipment_type_id ORDER BY lt.equipment_type_id) FROM label_template_types lt WHERE lt.template_id = t.id), '{}') AS "typeIds"
    FROM label_templates t`;

async function load(c: Ctx, id: number) {
  const t = await c.db.opt<any>(`${SELECT} WHERE t.id = $1`, [id]);
  if (!t) throw notFound('label_template_not_found');
  return t;
}

/** Deja la plantilla asociada exactamente a esos tipos (un tipo solo tiene una plantilla: se le quita a la anterior). */
async function setTypes(c: Ctx, templateId: number, typeIds: number[]) {
  await c.db.query('DELETE FROM label_template_types WHERE template_id = $1 AND NOT (equipment_type_id = ANY($2::bigint[]))', [templateId, typeIds]);
  if (!typeIds.length) return;
  const valid = await c.db.rows<{ id: number }>('SELECT id FROM equipment_types WHERE id = ANY($1::bigint[])', [typeIds]);
  for (const t of valid) {
    await c.db.query(
      `INSERT INTO label_template_types (company_id, template_id, equipment_type_id) VALUES ($1,$2,$3)
       ON CONFLICT (equipment_type_id) DO UPDATE SET template_id = EXCLUDED.template_id`,
      [c.companyId, templateId, t.id]);
  }
}

export async function labelRoutes(app: FastifyInstance) {
  // Quien puede ver equipos (etiquetas de equipo/testeo), ventas (documentos de pedido), activos o lotes (documentos de lote) puede imprimir, así que puede leer los diseños.
  app.get('/api/label-templates', route(['units.view', 'sales.view', 'assets.view', 'lots.view'], async (c) => {
    const items = await c.db.rows<any>(`${SELECT} ORDER BY t.is_default DESC, lower(t.name), t.id`);
    return { items };
  }));

  app.post('/api/label-templates', route('labels.manage', async (c) => {
    const b = c.body(templateBody);
    if (b.isDefault) await c.db.query('UPDATE label_templates SET is_default = false WHERE is_default AND kind = $1', [b.kind]);
    const r = await c.db.one<{ id: number }>(
      `INSERT INTO label_templates (company_id, kind, name, width_mm, height_mm, rotation, layout, is_default, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [c.companyId, b.kind, b.name, b.widthMm, b.heightMm, b.rotation, JSON.stringify(b.layout), b.isDefault, b.isActive]);
    await setTypes(c, r.id, b.kind === 'unit' ? b.typeIds : []);
    await c.audit('label_template.created', 'label_template', r.id, { name: b.name, kind: b.kind });
    return load(c, r.id);
  }));

  app.put('/api/label-templates/:id', route('labels.manage', async (c) => {
    const { id } = c.params(zIdParam);
    const b = c.body(templateBody);
    const cur = await load(c, id);
    if (b.isDefault) await c.db.query('UPDATE label_templates SET is_default = false WHERE is_default AND kind = $2 AND id <> $1', [id, cur.kind]);
    await c.db.query(
      `UPDATE label_templates SET name = $2, width_mm = $3, height_mm = $4, rotation = $5, layout = $6, is_default = $7, is_active = $8 WHERE id = $1`,
      [id, b.name, b.widthMm, b.heightMm, b.rotation, JSON.stringify(b.layout), b.isDefault, b.isActive]);
    await setTypes(c, id, cur.kind === 'unit' ? b.typeIds : []);
    await c.audit('label_template.updated', 'label_template', id, { name: b.name });
    return load(c, id);
  }));

  app.post('/api/label-templates/:id/duplicate', route('labels.manage', async (c) => {
    const { id } = c.params(zIdParam);
    const src = await load(c, id);
    const r = await c.db.one<{ id: number }>(
      `INSERT INTO label_templates (company_id, kind, name, width_mm, height_mm, rotation, layout, is_default, is_active)
       VALUES ($1,$7,$2,$3,$4,$5,$6,false,true) RETURNING id`,
      [c.companyId, `${src.name} (copia)`.slice(0, 80), src.widthMm, src.heightMm, src.rotation, JSON.stringify(src.layout), src.kind]);
    await c.audit('label_template.created', 'label_template', r.id, { name: src.name, copyOf: id });
    return load(c, r.id);
  }));

  app.delete('/api/label-templates/:id', route('labels.manage', async (c) => {
    const { id } = c.params(zIdParam);
    const t = await load(c, id);
    await c.db.query('DELETE FROM label_templates WHERE id = $1', [id]);
    await c.audit('label_template.deleted', 'label_template', id, { name: t.name });
    return { ok: true };
  }));
}
