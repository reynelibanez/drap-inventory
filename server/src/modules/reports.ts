import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest, forbidden, notFound } from '../errors.js';
import { route, zIdParam, type Ctx } from '../http.js';
import { companyLanguage } from '../services/common.js';
import {
  ALL_OPS, buildQuery, canRun, datasetByKey, loadMeta, resolveDataset, OPS_BY_TYPE,
  type BuiltQuery, type Lang, type ReportDef, type ResolvedDataset,
} from '../services/reportCatalog.js';

/**
 * Reportes personalizados.
 *  - Cada usuario crea reportes propios (privados: solo él los ve) y, con permiso, reportes compartidos con la empresa.
 *  - Un reporte solo usa información que quien lo crea puede ver, y quien lo ejecuta solo obtiene lo que su rol permite.
 *  - Los reportes de fábrica (system_key) no se modifican; se duplican para personalizarlos.
 */

const zDef = z.object({
  mode: z.enum(['detail', 'summary']),
  columns: z.array(z.object({
    field: z.string().min(1).max(100),
    label: z.string().trim().max(80).optional(),
    agg: z.enum(['count', 'countDistinct', 'sum', 'avg', 'min', 'max']).optional(),
  })).min(1).max(80),
  filters: z.array(z.object({
    field: z.string().min(1).max(100),
    op: z.enum(ALL_OPS),
    a: z.string().max(200).optional(),
    b: z.string().max(200).optional(),
    list: z.array(z.string().max(80)).max(500).optional(),
  })).max(50).default([]),
  sort: z.array(z.object({ col: z.number().int().min(0).max(79), dir: z.enum(['asc', 'desc']) })).max(6).default([]),
  limit: z.number().int().min(1).max(50000).optional(),
});
const zLang = z.object({ lang: z.enum(['es', 'en']).default('es') });
const zSave = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullish().transform((v) => v || null),
  dataset: z.string().min(1).max(40),
  visibility: z.enum(['private', 'company']).default('private'),
  definition: zDef,
});

const MAX_ROWS = 50_000;
const PREVIEW_ROWS = 200;

interface ReportRow {
  id: number; name: string; description: string | null; dataset: string; definition: ReportDef;
  visibility: 'private' | 'company'; systemKey: string | null; ownerId: number | null; ownerName: string | null; updatedAt: Date;
}

const SELECT = `SELECT r.id, r.name, r.description, r.dataset, r.definition, r.visibility, r.system_key AS "systemKey",
                       r.owner_membership_id AS "ownerId", ou.full_name AS "ownerName", r.updated_at AS "updatedAt"
                  FROM reports r
                  LEFT JOIN memberships om ON om.id = r.owner_membership_id
                  LEFT JOIN users ou ON ou.id = om.user_id`;

/** Reportes propios y compartidos (los privados de otras personas no existen para nadie, tampoco para administradores). */
const VISIBLE = `r.is_active AND (r.visibility = 'company' OR r.owner_membership_id = $1)`;

async function loadReport(c: Ctx, id: number): Promise<ReportRow> {
  const r = await c.db.opt<ReportRow>(`${SELECT} WHERE r.id = $2 AND ${VISIBLE}`, [c.membershipId, id]);
  if (!r) throw notFound('report_not_found');
  return r;
}

function canEdit(c: Ctx, r: ReportRow): boolean {
  if (r.systemKey) return false;
  return r.visibility === 'private' ? r.ownerId === c.membershipId && c.can('reports.create') : c.can('reports.share');
}

/** Quita lo que no aplica al modo (en detalle no hay cálculos) para guardar la definición limpia. */
function clean(def: z.infer<typeof zDef>): ReportDef {
  return {
    mode: def.mode,
    columns: def.columns.map((c) => ({ field: c.field, ...(c.label ? { label: c.label } : {}), ...(def.mode === 'summary' && c.agg ? { agg: c.agg } : {}) })),
    filters: def.filters.map((f) => ({ field: f.field, op: f.op, ...(f.a !== undefined ? { a: f.a } : {}), ...(f.b !== undefined ? { b: f.b } : {}), ...(f.list ? { list: f.list } : {}) })),
    sort: def.sort.filter((s) => s.col < def.columns.length),
    ...(def.limit ? { limit: def.limit } : {}),
  };
}

async function execute(c: Ctx, q: BuiltQuery) {
  await c.db.query("SELECT set_config('statement_timeout', '30000', true)");
  let res;
  try {
    res = await c.db.client.query({ text: q.sql, values: q.params as any[], rowMode: 'array' });
  } catch (e: any) {
    if (e?.code === '57014') throw badRequest('report_timeout');
    throw e;
  }
  await c.db.query("SELECT set_config('statement_timeout', '0', true)");
  const truncated = res.rows.length > q.limit;
  return { columns: q.columns, rows: truncated ? res.rows.slice(0, q.limit) : res.rows, truncated, limit: q.limit };
}

/** Valida una definición con los permisos de quien guarda (estricto) y devuelve el conjunto de datos. */
async function validateForSave(c: Ctx, dataset: string, def: ReportDef, lang: Lang): Promise<ResolvedDataset> {
  const ds = datasetByKey(dataset);
  if (!ds) throw badRequest('report_dataset_unknown', { dataset });
  if (!c.can(ds.perm)) throw forbidden('report_dataset_forbidden', { dataset });
  const rd = await resolveDataset(c.db, dataset);
  buildQuery(rd, def, { lang, can: c.can, who: { userId: c.userId, membershipId: c.membershipId }, limit: 1, strict: true });
  return rd;
}

export async function reportRoutes(app: FastifyInstance) {
  // ------------------------------------------------ lista
  app.get('/api/reports', route('reports.view', async (c) => {
    const rows = await c.db.rows<ReportRow>(`${SELECT} WHERE ${VISIBLE} ORDER BY lower(r.name)`, [c.membershipId]);
    const cache = new Map<string, ResolvedDataset>();
    const out = [];
    for (const r of rows) {
      let rd = cache.get(r.dataset);
      if (!rd) { if (!datasetByKey(r.dataset)) continue; rd = await resolveDataset(c.db, r.dataset); cache.set(r.dataset, rd); }
      if (!canRun(rd, r.definition, c.can)) continue;
      out.push({
        id: r.id, name: r.name, description: r.description, dataset: r.dataset, visibility: r.visibility, systemKey: r.systemKey,
        mode: r.definition.mode, columnCount: r.definition.columns.length,
        mine: r.ownerId === c.membershipId, ownerName: r.ownerName, updatedAt: r.updatedAt, canEdit: canEdit(c, r),
      });
    }
    return out;
  }));

  // ------------------------------------------------ campos y operadores que puede usar este usuario
  app.get('/api/reports/meta', route('reports.view', async (c) => {
    const { lang } = c.query(zLang);
    return { datasets: await loadMeta(c.db, lang, c.can), ops: OPS_BY_TYPE, canShare: c.can('reports.share'), canCreate: c.can('reports.create') };
  }));

  // ------------------------------------------------ vista previa del diseñador
  app.post('/api/reports/preview', route('reports.create', async (c) => {
    const lang = await companyLanguage(c.db, c.companyId);   // el resultado es un documento: idioma de la empresa
    const b = c.body(z.object({ dataset: z.string().min(1).max(40), definition: zDef }));
    const def = clean(b.definition);
    const rd = await validateForSave(c, b.dataset, def, lang);
    return execute(c, buildQuery(rd, def, { lang, can: c.can, who: { userId: c.userId, membershipId: c.membershipId }, limit: PREVIEW_ROWS, strict: true }));
  }));

  // ------------------------------------------------ un reporte
  app.get('/api/reports/:id', route('reports.view', async (c) => {
    const { id } = c.params(zIdParam);
    const r = await loadReport(c, id);
    return { ...r, mine: r.ownerId === c.membershipId, canEdit: canEdit(c, r) };
  }));

  app.post('/api/reports/:id/run', route('reports.view', async (c) => {
    const { id } = c.params(zIdParam);
    const lang = await companyLanguage(c.db, c.companyId);   // el resultado es un documento: idioma de la empresa
    const r = await loadReport(c, id);
    const rd = await resolveDataset(c.db, r.dataset);
    if (!c.can(rd.ds.perm)) throw forbidden('report_dataset_forbidden', { dataset: r.dataset });
    const built = buildQuery(rd, r.definition, { lang, can: c.can, who: { userId: c.userId, membershipId: c.membershipId }, limit: MAX_ROWS, strict: false });
    const res = await execute(c, built);
    return { report: { id: r.id, name: r.name, description: r.description, dataset: r.dataset, visibility: r.visibility, systemKey: r.systemKey, mode: r.definition.mode }, ...res };
  }));

  // ------------------------------------------------ crear / editar / borrar
  app.post('/api/reports', route('reports.create', async (c) => {
    const { lang } = c.query(zLang);
    const b = c.body(zSave);
    if (b.visibility === 'company') c.need('reports.share');
    const def = clean(b.definition);
    await validateForSave(c, b.dataset, def, lang);
    const row = await c.db.one<{ id: number }>(
      `INSERT INTO reports (company_id, name, description, dataset, definition, owner_membership_id, visibility)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [c.companyId, b.name, b.description, b.dataset, JSON.stringify(def), c.membershipId, b.visibility]);
    await c.audit('report.created', 'report', row.id, { name: b.name, dataset: b.dataset, visibility: b.visibility });
    return { id: row.id };
  }));

  app.put('/api/reports/:id', route('reports.view', async (c) => {
    const { id } = c.params(zIdParam);
    const { lang } = c.query(zLang);
    const b = c.body(zSave);
    const r = await loadReport(c, id);
    if (r.systemKey) throw badRequest('report_system_readonly');
    if (!canEdit(c, r)) throw forbidden('report_edit_forbidden');
    if (b.visibility !== r.visibility) {
      if (b.visibility === 'company') c.need('reports.share');
      else if (r.ownerId !== c.membershipId) throw forbidden('report_share_forbidden');
    }
    const def = clean(b.definition);
    await validateForSave(c, b.dataset, def, lang);
    await c.db.query(
      `UPDATE reports SET name = $2, description = $3, dataset = $4, definition = $5, visibility = $6 WHERE id = $1`,
      [id, b.name, b.description, b.dataset, JSON.stringify(def), b.visibility]);
    await c.audit('report.updated', 'report', id, { name: b.name, visibility: b.visibility });
    return { ok: true };
  }));

  app.delete('/api/reports/:id', route('reports.view', async (c) => {
    const { id } = c.params(zIdParam);
    const r = await loadReport(c, id);
    if (r.systemKey) throw badRequest('report_system_readonly');
    if (!canEdit(c, r)) throw forbidden('report_edit_forbidden');
    await c.db.query('DELETE FROM reports WHERE id = $1', [id]);
    await c.audit('report.deleted', 'report', id, { name: r.name });
    return { ok: true };
  }));

  /** Copia un reporte (por ejemplo uno de fábrica) como reporte privado del usuario, listo para personalizar. */
  app.post('/api/reports/:id/duplicate', route('reports.create', async (c) => {
    const { id } = c.params(zIdParam);
    const { lang } = c.query(zLang);
    const r = await loadReport(c, id);
    const rd = await resolveDataset(c.db, r.dataset);
    if (!canRun(rd, r.definition, c.can)) throw forbidden('report_dataset_forbidden', { dataset: r.dataset });
    const name = `${r.name} (${lang === 'en' ? 'copy' : 'copia'})`.slice(0, 120);
    const row = await c.db.one<{ id: number }>(
      `INSERT INTO reports (company_id, name, description, dataset, definition, owner_membership_id, visibility)
       VALUES ($1,$2,$3,$4,$5,$6,'private') RETURNING id`,
      [c.companyId, name, r.description, r.dataset, JSON.stringify(r.definition), c.membershipId]);
    await c.audit('report.created', 'report', row.id, { name, dataset: r.dataset, visibility: 'private', copiedFrom: id });
    return { id: row.id };
  }));
}
