import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../http.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { route, zId, zIdParam } from '../http.js';
import { lockRows } from '../services/common.js';
import { applyPriceRules, loadPriceRules, priceRuleSchema, ROUNDINGS, roundPrice, type PriceRule } from '../services/prices.js';

const rulesBody = z.object({ rules: z.array(priceRuleSchema).max(200) });
const scopeBody = z.object({
  scope: z.enum(['available', 'unsold']).default('available'),
  lotId: zId.nullish(),
  overwriteManual: z.boolean().default(false),
});

function withIds(rules: z.infer<typeof priceRuleSchema>[]): PriceRule[] {
  return rules.map((r, i) => ({ ...r, id: i + 1 }));
}

export async function priceRoutes(app: FastifyInstance) {
  // ---------- Reglas de precio ----------
  app.get('/api/price-rules', route(['prices.manage', 'sales.price'], async (c) => {
    const [rules, auto] = await Promise.all([
      loadPriceRules(c.db),
      c.db.one<{ v: boolean | null }>(`SELECT (settings->>'autoPrice')::boolean AS v FROM companies WHERE id = $1`, [c.companyId]),
    ]);
    return { rules, autoPrice: auto.v !== false, canManage: c.can('prices.manage') };
  }));

  /** Reemplaza la lista completa de reglas (el orden de la lista es el orden de prioridad). */
  app.put('/api/price-rules', route('prices.manage', async (c) => {
    const b = c.body(rulesBody);
    await c.db.query('DELETE FROM price_rules');
    let i = 0;
    for (const r of b.rules) {
      await c.db.query(
        `INSERT INTO price_rules (company_id, sort_order, name, enabled, match, method, value, rounding, min_price) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [c.companyId, i++, r.name, r.enabled, JSON.stringify(r.match), r.method, r.value, r.rounding, r.minPrice ?? null]);
    }
    await c.audit('prices.rules_saved', 'company', c.companyId, { rules: b.rules.length });
    return { rules: await loadPriceRules(c.db) };
  }));

  app.put('/api/price-rules/auto', route('prices.manage', async (c) => {
    const { enabled } = c.body(z.object({ enabled: z.boolean() }));
    await c.db.query(`UPDATE companies SET settings = settings || jsonb_build_object('autoPrice', $2::boolean) WHERE id = $1`, [c.companyId, enabled]);
    await c.audit('prices.auto_changed', 'company', c.companyId, { enabled });
    return { autoPrice: enabled };
  }));

  /** Qué cambiaría al aplicar las reglas (las guardadas, o las que se están editando). No guarda nada. */
  app.post('/api/prices/preview', route('prices.manage', async (c) => {
    const b = c.body(scopeBody.extend({ rules: z.array(priceRuleSchema).max(200).optional() }));
    const r = await applyPriceRules(c.db, { scope: b.scope, lotId: b.lotId, overwriteManual: b.overwriteManual, dryRun: true, rules: b.rules ? withIds(b.rules) : undefined, sample: 30 });
    return r;
  }));

  /** Aplica las reglas a los equipos (respeta los precios fijados a mano, salvo que se pida lo contrario). */
  app.post('/api/prices/recalculate', route('prices.manage', async (c) => {
    const b = c.body(scopeBody);
    const r = await applyPriceRules(c.db, { scope: b.scope, lotId: b.lotId, overwriteManual: b.overwriteManual });
    await c.audit('prices.recalculated', 'company', c.companyId, { scope: b.scope, lotId: b.lotId ?? null, changed: r.changed, overwriteManual: b.overwriteManual });
    return r;
  }));

  // ---------- Precio de lista individual y en bloque ----------
  const bulkBody = z.object({
    unitIds: z.array(zId).min(1).max(5000),
    /** set = precio exacto · pct = subir/bajar un porcentaje · add = sumar/restar un monto · margin = margen sobre el costo · rules = dejar que lo calculen las reglas · clear = sin precio */
    mode: z.enum(['set', 'pct', 'add', 'margin', 'rules', 'clear']),
    value: z.number().min(-1e10).max(1e10).optional(),
    rounding: z.enum(ROUNDINGS).default('none'),
  });

  async function changePrices(c: Ctx, b: z.infer<typeof bulkBody>) {
    c.need('prices.manage');
    if (['set', 'pct', 'add', 'margin'].includes(b.mode) && b.value === undefined) throw badRequest('invalid_value');
    if (b.mode === 'set' && b.value! < 0) throw badRequest('invalid_value');
    if (b.mode === 'margin' && b.value! >= 100) throw badRequest('invalid_value');
    const ids = [...new Set(b.unitIds)].sort((x, y) => x - y);
    await lockRows(c.db, 'units', ids);
    const units = await c.db.rows<{ id: number; code: string; status_key: string; list_price: number | null; cost: number | null }>(
      `SELECT u.id, u.code, st.system_key AS status_key, u.list_price, u.cost FROM units u JOIN catalog_items st ON st.id = u.status_id WHERE u.id = ANY($1::bigint[])`, [ids]);
    if (units.length !== ids.length) throw notFound('unit_not_found');
    const sold = units.find((u) => u.status_key === 'sold');
    if (sold) throw conflict('unit_sold', { code: sold.code });
    let changed = 0, skipped = 0;
    if (b.mode === 'rules') {
      await c.db.query(`UPDATE units SET price_source = NULL WHERE id = ANY($1::bigint[]) AND price_source = 'manual'`, [ids]);
      const r = await applyPriceRules(c.db, { scope: 'unsold', unitIds: ids });
      changed = r.changed;
    } else {
      for (const u of units) {
        let price: number | null;
        if (b.mode === 'clear') price = null;
        else if (b.mode === 'set') price = b.value!;
        else if (b.mode === 'pct') price = u.list_price === null ? null : u.list_price * (1 + b.value! / 100);
        else if (b.mode === 'add') price = u.list_price === null ? null : u.list_price + b.value!;
        else price = u.cost === null ? null : u.cost / (1 - b.value! / 100);
        if (price === null && b.mode !== 'clear') { skipped++; continue; }
        const final = price === null ? null : roundPrice(price, b.rounding);
        await c.db.query('UPDATE units SET list_price = $2, price_source = $3 WHERE id = $1', [u.id, final, final === null ? null : 'manual']);
        await c.audit('unit.price_changed', 'unit', u.id, { from: u.list_price, to: final, mode: b.mode });
        changed++;
      }
    }
    return { ok: true, changed, skipped };
  }

  app.post('/api/units/prices', route('prices.manage', async (c) => changePrices(c, c.body(bulkBody))));
  app.put('/api/units/:id/price', route('prices.manage', async (c) => {
    const { id } = c.params(zIdParam);
    const b = c.body(z.object({ price: z.number().min(0).max(1e10).nullable().optional(), auto: z.boolean().optional() }));
    if (b.auto) return changePrices(c, { unitIds: [id], mode: 'rules', rounding: 'none' });
    if (b.price === undefined) throw badRequest('invalid_value');
    return changePrices(c, b.price === null ? { unitIds: [id], mode: 'clear', rounding: 'none' } : { unitIds: [id], mode: 'set', value: b.price, rounding: 'none' });
  }));
}
