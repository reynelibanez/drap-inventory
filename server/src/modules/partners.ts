import type { FastifyInstance } from 'fastify';
import { z, type ZodType } from 'zod';
import { notFound } from '../errors.js';
import { route, zId, zIdParam, zPage } from '../http.js';
import { assertCatalogItem, likeEscape } from '../services/common.js';

const txt = (max = 200) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));

interface FieldDef { col: string; schema: ZodType; alias: string }

/**
 * CRUD estándar para listados simples (proveedores, clientes, vendedores):
 * búsqueda, paginación, alta, edición y activar/desactivar (no se borran: tienen historial).
 */
function registerCrud(app: FastifyInstance, o: {
  path: string; table: string; entity: string; view: string; manage: string;
  fields: FieldDef[]; searchCols: string[]; extraSelect?: string; extraJoin?: string;
  beforeSave?: (c: any, data: Record<string, any>) => Promise<void>;
}) {
  const cols = o.fields.map((f) => `t.${f.col} AS "${f.alias}"`).join(', ');
  const select = `SELECT t.id, ${cols}, t.is_active AS "isActive", t.created_at AS "createdAt"${o.extraSelect ? ', ' + o.extraSelect : ''}
                    FROM ${o.table} t ${o.extraJoin ?? ''}`;
  const shape: Record<string, ZodType> = {};
  for (const f of o.fields) shape[f.alias] = f.schema;
  const createSchema = z.object(shape);
  const updateSchema = z.object({ ...shape, isActive: z.boolean().optional() });

  app.get(o.path, route(o.view, async (c) => {
    const q = c.query(zPage.extend({ active: z.enum(['true', 'false', 'all']).default('true'), all: z.enum(['1']).optional() }));
    const params: unknown[] = [];
    const where: string[] = [];
    if (q.active !== 'all') { params.push(q.active === 'true'); where.push(`t.is_active = $${params.length}`); }
    if (q.q) {
      params.push(`%${likeEscape(q.q)}%`);
      where.push('(' + o.searchCols.map((col) => `t.${col} ILIKE $${params.length}`).join(' OR ') + ')');
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (await c.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM ${o.table} t ${w}`, params)).n;
    const pageSize = q.all ? 5000 : q.pageSize;
    const offset = q.all ? 0 : (q.page - 1) * q.pageSize;
    const items = await c.db.rows(`${select} ${w} ORDER BY lower(t.name) LIMIT ${pageSize} OFFSET ${offset}`, params);
    return { items, total };
  }));

  app.get(`${o.path}/:id`, route(o.view, async (c) => {
    const { id } = c.params(zIdParam);
    const row = await c.db.opt(`${select} WHERE t.id = $1`, [id]);
    if (!row) throw notFound();
    return row;
  }));

  const save = async (c: any, id: number | null, data: Record<string, any>) => {
    if (o.beforeSave) await o.beforeSave(c, data);
    const names = o.fields.map((f) => f.col);
    const values = o.fields.map((f) => data[f.alias] ?? null);
    if (id === null) {
      const r = await c.db.one(
        `INSERT INTO ${o.table} (company_id, ${names.join(', ')}) VALUES ($1, ${names.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`,
        [c.companyId, ...values]);
      await c.audit(`${o.entity}.created`, o.entity, r.id, { name: data.name });
      return { id: r.id };
    }
    const sets = names.map((n, i) => `${n} = $${i + 2}`).join(', ');
    const r = await c.db.query(
      `UPDATE ${o.table} SET ${sets}, is_active = COALESCE($${names.length + 2}, is_active) WHERE id = $1`,
      [id, ...values, data.isActive ?? null]);
    if (!r.rowCount) throw notFound();
    await c.audit(`${o.entity}.updated`, o.entity, id, { name: data.name });
    return { id };
  };

  app.post(o.path, route(o.manage, (c) => save(c, null, c.body(createSchema))));
  app.put(`${o.path}/:id`, route(o.manage, (c) => save(c, c.params(zIdParam).id, c.body(updateSchema))));
}

export async function partnerRoutes(app: FastifyInstance) {
  registerCrud(app, {
    path: '/api/suppliers', table: 'suppliers', entity: 'supplier', view: 'suppliers.view', manage: 'suppliers.manage',
    searchCols: ['name', 'contact_name', 'email'],
    fields: [
      { col: 'name', alias: 'name', schema: z.string().trim().min(1).max(160) },
      { col: 'contact_name', alias: 'contactName', schema: txt() },
      { col: 'email', alias: 'email', schema: txt() },
      { col: 'phone', alias: 'phone', schema: txt(50) },
      { col: 'country', alias: 'country', schema: txt(80) },
      { col: 'address', alias: 'address', schema: txt(300) },
      { col: 'notes', alias: 'notes', schema: txt(1000) },
    ],
  });

  registerCrud(app, {
    path: '/api/customers', table: 'customers', entity: 'customer', view: 'customers.view', manage: 'customers.manage',
    searchCols: ['name', 'contact_name', 'email', 'country'],
    fields: [
      { col: 'name', alias: 'name', schema: z.string().trim().min(1).max(160) },
      { col: 'customer_type_id', alias: 'customerTypeId', schema: zId.nullish().transform((v) => v ?? null) },
      { col: 'contact_name', alias: 'contactName', schema: txt() },
      { col: 'email', alias: 'email', schema: txt() },
      { col: 'phone', alias: 'phone', schema: txt(50) },
      { col: 'country', alias: 'country', schema: txt(80) },
      { col: 'address', alias: 'address', schema: txt(300) },
      { col: 'tax_id', alias: 'taxId', schema: txt(50) },
      { col: 'notes', alias: 'notes', schema: txt(1000) },
    ],
    beforeSave: async (c, d) => { await assertCatalogItem(c.db, d.customerTypeId, 'customer_type', 'customerTypeId'); },
  });

  registerCrud(app, {
    path: '/api/sellers', table: 'sellers', entity: 'seller', view: 'sellers.view', manage: 'sellers.manage',
    searchCols: ['name', 'email'],
    fields: [
      { col: 'name', alias: 'name', schema: z.string().trim().min(1).max(160) },
      { col: 'email', alias: 'email', schema: txt() },
      { col: 'phone', alias: 'phone', schema: txt(50) },
      { col: 'membership_id', alias: 'membershipId', schema: zId.nullish().transform((v) => v ?? null) },
    ],
  });
}
