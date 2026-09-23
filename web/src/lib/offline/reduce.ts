import { applyAssetOp } from './domains/assets';
import { applyOrderOp, modelFromDetail } from './domains/orders';
import { applyPartnerOp } from './domains/partners';
import { applyStockOp } from './domains/stock';
import { isTemp, pathIds, resolveId, type Op } from './outbox';
import {
  clone, cleanSerial, DELETED, iso, makeCtx, mergeSpecs, newState, overlaySession, same, subset, sysId,
  type Any, type Ctx, type CtxExtra, type Env, type OrderModel, type State,
} from './state';

/**
 * Aplica, en orden, las acciones pendientes sobre lo último que bajó del servidor. Cada tema tiene sus reglas (lotes y equipos
 * aquí; pedidos, clientes, activos y ubicaciones en `domains/`). El resultado es el estado "como si el servidor ya lo hubiera hecho".
 */

export const LOT_FLOW: Record<string, Record<string, string>> = {
  open: { start_count: 'counting', start_testing: 'testing' },
  counting: { finish_count: 'counted', start_testing: 'testing' },
  counted: { start_testing: 'testing', reopen_count: 'counting' },
  testing: { close: 'closed', reopen_count: 'counting' },
  closed: { reopen: 'testing' },
};

export const unitTarget = (o: Op): number => (o.kind === 'unit.create' ? o.temp!.unit! : resolveId(pathIds(o.path)[0]));
export const lotOfLotOp = (o: Op): number => (o.kind === 'lot.create' ? o.temp!.lot! : resolveId(pathIds(o.path)[0]));
export const isLotOp = (o: Op) => o.kind.startsWith('lot.') || o.kind.startsWith('line.');
export const isUnitOp = (o: Op) => o.kind.startsWith('unit.');

function newLot(o: Op, c: Ctx): Any {
  const b = o.body ?? {};
  const lines = (b.lines ?? []).map((l: Any, i: number) => ({
    id: o.temp!.lines![i], lineNo: i + 1, equipmentTypeId: l.equipmentTypeId, specs: l.specs ?? {}, expectedQty: l.expectedQty ?? 0,
    countedQty: null, isUnexpected: false, notes: l.notes ?? null, countedAt: null, tested: 0, inTesting: 0, difference: null,
  }));
  return {
    id: o.temp!.lot, code: o.temp!.code, statusId: sysId(c, 'lot_status', 'open'), statusKey: 'open',
    supplierId: b.supplierId ?? null, supplierName: b.supplierId ? c.suppliers.get(b.supplierId) ?? null : null,
    purchaseDate: b.purchaseDate ?? iso(o.created).slice(0, 10), reference: b.reference ?? null, currency: c.meta?.company?.currency ?? 'USD',
    totalCost: b.totalCost ?? null, notes: b.notes ?? null, countedAt: null, closedAt: null, createdAt: iso(o.created),
    lines, offLines: [], summary: { unitsByStatus: [] },
  };
}

function matchLine(lot: Any, typeId: number, specs: Record<string, unknown>): number | null {
  const cands = (lot.lines as Any[]).filter((l) => l.equipmentTypeId === typeId && subset(l.specs ?? {}, specs));
  cands.sort((a, b) => {
    const ra = a.tested < (a.countedQty ?? a.expectedQty) ? 0 : 1, rb = b.tested < (b.countedQty ?? b.expectedQty) ? 0 : 1;
    return ra - rb || Object.keys(b.specs ?? {}).length - Object.keys(a.specs ?? {}).length || a.lineNo - b.lineNo;
  });
  return cands[0]?.id ?? null;
}

/** Suma o resta un equipo en los contadores del lote (por estado, por línea o "sin línea"). */
export function bump(lot: Any, u: Any, d: 1 | -1) {
  const list: { statusId: number; n: number }[] = lot.summary.unitsByStatus;
  const row = list.find((r) => r.statusId === u.statusId);
  if (row) row.n += d; else if (d > 0) list.push({ statusId: u.statusId, n: 1 });
  const testing = u.statusKey === 'testing' ? d : 0;
  const line = u.lotLineId ? (lot.lines as Any[]).find((l) => l.id === u.lotLineId) : null;
  if (line) { line.tested += d; line.inTesting += testing; return; }
  let g = (lot.offLines as Any[]).find((x) => x.equipmentTypeId === u.equipmentTypeId && same(x.specs, u.specs));
  if (!g && d > 0) { g = { equipmentTypeId: u.equipmentTypeId, specs: u.specs, tested: 0, inTesting: 0 }; lot.offLines.push(g); }
  if (g) { g.tested += d; g.inTesting += testing; }
}

export function finalizeLot(lot: Any) {
  let expected = 0, counted = 0, missing = 0, surplus = 0, uncounted = 0;
  for (const l of lot.lines as Any[]) {
    expected += l.expectedQty;
    l.difference = l.countedQty === null ? null : l.countedQty - l.expectedQty;
    if (l.countedQty === null) { uncounted++; continue; }
    counted += l.countedQty;
    if (l.difference < 0) missing += -l.difference; else surplus += l.difference;
  }
  lot.offLines = (lot.offLines as Any[]).filter((g) => g.tested > 0);
  const byStatus = (lot.summary.unitsByStatus as Any[]).filter((r) => r.n > 0);
  const units = byStatus.reduce((a, r) => a + r.n, 0);
  const unlinked = (lot.offLines as Any[]).reduce((a, g) => a + g.tested, 0);
  lot.summary = { expected, counted, missing, surplus, uncountedLines: uncounted, units, unlinkedUnits: unlinked, unitsByStatus: byStatus };
  lot.deletable = units === 0 && (lot.lines as Any[]).every((l) => l.countedQty === null);
  lot.pendingSync = true;
}

function synthUnit(o: Op, c: Ctx, st: State): Any {
  const b = o.body ?? {};
  const lotId = resolveId(pathIds(o.path)[0]);
  const lot = st.lots.get(lotId);
  const specs = b.specs ?? {};
  const lotLineId = b.lotLineId ?? (lot && lot !== DELETED ? matchLine(lot, b.equipmentTypeId, specs) : null);
  return {
    id: o.temp!.unit, code: o.temp!.code, serialNumber: cleanSerial(b.serialNumber), specs, notes: b.notes ?? null,
    lotId, lotCode: lot && lot !== DELETED ? lot.code : c.lotCodes.get(lotId) ?? '', lotLineId,
    equipmentTypeId: b.equipmentTypeId, statusId: sysId(c, 'unit_status', 'testing'), statusKey: 'testing',
    cosmeticGradeId: null, functionalGradeId: null, slotId: null, slotCode: null, testerNumber: overlaySession().techNumber,
    testedAt: null, createdAt: iso(o.created), updatedAt: iso(o.created), orderId: null, orderCode: null, pendingSync: true,
  };
}

export const testingCount = (l: Any) => (l.lines as Any[]).reduce((a, x) => a + x.inTesting, 0) + (l.offLines as Any[]).reduce((a, g) => a + g.inTesting, 0);

function setStatus(u: Any, c: Ctx, key: string) { u.statusKey = key; u.statusId = sysId(c, 'unit_status', key); }
const sellable = (c: Ctx, funId: number | null) => !funId || c.items.get(funId)?.meta?.sellable !== false;


/** Estado de trabajo: copia de lo que hay en la base + las acciones ya aplicadas. Se leen y se cambian con `Env`. */
export function envOf(st: State, c: Ctx): Env {
  const lot = (id: number): Any | null => {
    const rid = resolveId(id);
    if (st.lots.has(rid)) { const l = st.lots.get(rid); return l === DELETED ? null : l; }
    const base = c.baseLots.get(rid);
    if (!base) return null;
    const copy = JSON.parse(JSON.stringify(base));
    copy.summary = { ...copy.summary, unitsByStatus: (copy.summary?.unitsByStatus ?? []).map((r: Any) => ({ ...r })) };
    copy.offLines = copy.offLines ?? [];
    st.lots.set(rid, copy);
    return copy;
  };
  const unit = (id: number): Any | null => {
    const rid = resolveId(id);
    if (st.units.has(rid)) { const u = st.units.get(rid); return u === DELETED ? null : u; }
    const base = c.baseUnits.get(rid);
    if (!base) return null;
    const copy = { ...base, specs: { ...(base.specs ?? {}) } };
    st.units.set(rid, copy);
    return copy;
  };
  const order = (id: number): OrderModel | null => {
    const rid = resolveId(id);
    if (st.orders.has(rid)) { const o = st.orders.get(rid); return o === DELETED ? null : o!; }
    const base = c.baseOrders.get(rid);
    if (!base) return null;
    const m = modelFromDetail(base);
    st.orders.set(rid, m);
    return m;
  };
  return { c, st, lot, unit, order };
}

export async function computeState(ops: Op[], extra: CtxExtra = {}): Promise<{ st: State; c: Ctx; env: Env }> {
  const c = await makeCtx(ops, extra);
  const st = newState();
  const env = envOf(st, c);
  const { lot, unit } = env;
  const lineOf = (l: Any, lineId: number) => (l.lines as Any[]).find((x) => x.id === resolveId(lineId));

  for (const o of ops) {
    const b = o.body ?? {};
    switch (o.kind) {
      case 'lot.create': { const l = newLot(o, c); st.lots.set(l.id, l); st.createdLots.push(l.id); st.touchedLots.add(l.id); break; }
      case 'lot.update': {
        const l = lot(lotOfLotOp(o)); if (!l) break; st.touchedLots.add(l.id);
        if ('supplierId' in b) { l.supplierId = b.supplierId ?? null; l.supplierName = b.supplierId ? c.suppliers.get(b.supplierId) ?? l.supplierName : null; }
        if (b.purchaseDate) l.purchaseDate = b.purchaseDate;
        for (const k of ['reference', 'totalCost', 'notes']) if (k in b) l[k] = b[k] ?? null;
        break;
      }
      case 'lot.delete': { const id = resolveId(lotOfLotOp(o)); st.lots.set(id, DELETED); st.touchedLots.add(id); break; }
      case 'line.add': case 'line.unexpected': {
        const l = lot(lotOfLotOp(o)); if (!l) break; st.touchedLots.add(l.id);
        const unexpected = o.kind === 'line.unexpected';
        l.lines.push({
          id: o.temp!.line, lineNo: Math.max(0, ...l.lines.map((x: Any) => x.lineNo)) + 1, equipmentTypeId: b.equipmentTypeId, specs: b.specs ?? {},
          expectedQty: unexpected ? 0 : b.expectedQty ?? 0, countedQty: unexpected ? b.countedQty : null, isUnexpected: unexpected, notes: b.notes ?? null,
          countedAt: unexpected ? iso(o.created) : null, tested: 0, inTesting: 0, difference: null,
        });
        if (unexpected && l.statusKey === 'open') { l.statusKey = 'counting'; l.statusId = sysId(c, 'lot_status', 'counting'); }
        break;
      }
      case 'line.update': {
        const l = lot(lotOfLotOp(o)); if (!l) break; st.touchedLots.add(l.id);
        const ln = lineOf(l, pathIds(o.path)[1]); if (!ln) break;
        Object.assign(ln, { equipmentTypeId: b.equipmentTypeId, specs: b.specs ?? {}, expectedQty: b.expectedQty ?? 0, notes: b.notes ?? null });
        break;
      }
      case 'line.delete': {
        const l = lot(lotOfLotOp(o)); if (!l) break; st.touchedLots.add(l.id);
        l.lines = l.lines.filter((x: Any) => x.id !== resolveId(pathIds(o.path)[1]));
        break;
      }
      case 'lot.counts': {
        const l = lot(lotOfLotOp(o)); if (!l) break; st.touchedLots.add(l.id);
        for (const r of b.counts ?? []) {
          const ln = lineOf(l, r.lineId);
          if (ln) { ln.countedQty = r.countedQty; ln.countedAt = r.countedQty === null ? ln.countedAt : iso(o.created); }
        }
        if (l.statusKey === 'open') { l.statusKey = 'counting'; l.statusId = sysId(c, 'lot_status', 'counting'); }
        break;
      }
      case 'lot.transition': {
        const l = lot(lotOfLotOp(o)); if (!l) break; st.touchedLots.add(l.id);
        const target = LOT_FLOW[l.statusKey]?.[b.action]; if (!target) break;
        l.statusKey = target; l.statusId = sysId(c, 'lot_status', target);
        if (target === 'counted') l.countedAt = iso(o.created);
        l.closedAt = target === 'closed' ? iso(o.created) : null;
        break;
      }
      case 'unit.create': {
        const lotId = resolveId(pathIds(o.path)[0]);
        const l = lot(lotId);
        const u = synthUnit(o, c, st);
        st.units.set(u.id, u); st.createdUnits.push(u.id); st.touchedUnits.add(u.id);
        if (l) {
          st.touchedLots.add(l.id); bump(l, u, 1);
          if (l.statusKey === 'counted') { l.statusKey = 'testing'; l.statusId = sysId(c, 'lot_status', 'testing'); }
        }
        break;
      }
      case 'unit.update': case 'unit.finish': {
        const u = unit(unitTarget(o)); if (!u) break; st.touchedUnits.add(resolveId(u.id));
        const l = lot(u.lotId);
        const before = { ...u, specs: u.specs };
        if (l) { st.touchedLots.add(l.id); bump(l, before, -1); }
        if ('serialNumber' in b) u.serialNumber = cleanSerial(b.serialNumber);
        if (b.specs) u.specs = mergeSpecs(u.specs, b.specs);
        if ('notes' in b) u.notes = b.notes ?? null;
        if ('cosmeticGradeId' in b) u.cosmeticGradeId = b.cosmeticGradeId ?? null;
        if ('functionalGradeId' in b) u.functionalGradeId = b.functionalGradeId ?? null;
        if (o.kind === 'unit.finish') {
          setStatus(u, c, sellable(c, u.functionalGradeId) ? 'available' : 'not_sellable');
          u.testedAt = iso(o.created);
        } else if (u.statusKey === 'available' && !sellable(c, u.functionalGradeId)) setStatus(u, c, 'not_sellable');
        u.updatedAt = iso(o.created);
        u.pendingSync = true;
        if (l) bump(l, u, 1);
        break;
      }
      case 'unit.delete': {
        const id = resolveId(unitTarget(o));
        const u = unit(id);
        if (u) { const l = lot(u.lotId); if (l) { st.touchedLots.add(l.id); bump(l, u, -1); } }
        st.units.set(id, DELETED); st.touchedUnits.add(id);
        break;
      }
      case 'unit.status': case 'unit.costs': case 'unit.prices': case 'loc.assign': case 'loc.unassign': applyStockOp(o, env); break;
      case 'partner.create': case 'partner.update': applyPartnerOp(o, st); break;
      case 'asset.create': case 'asset.update': case 'asset.delete': applyAssetOp(o, c, st); break;
      case 'order.create': case 'order.update': case 'order.shipping': case 'order.items': case 'order.items_remove': case 'order.prices': case 'order.adjustments':
      case 'order.line_add': case 'order.line_update': case 'order.line_delete': case 'order.complete': case 'order.cancel': case 'quick.sale':
        applyOrderOp(o, env); break;
    }
  }
  for (const [, l] of st.lots) if (l !== DELETED) finalizeLot(l);
  return { st, c, env };
}
