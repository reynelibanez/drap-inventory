import { describe, expect, it } from 'vitest';
import { allocate, distributeCents, type AllocRule, type AllocTarget } from '../src/services/allocation.js';
import { priceFor, roundPrice, type PriceRule, type PriceUnit } from '../src/services/prices.js';

const T = (key: string, qty: number, typeId: number, extra: Partial<AllocTarget> = {}): AllocTarget => ({ key, qty, typeId, specs: {}, ...extra });
const R = (id: string, method: AllocRule['method'], value: number, match: AllocRule['match'] = {}, enabled = true): AllocRule => ({ id, method, value, match, enabled });

describe('allocate', () => {
  it('sin reglas reparte parejo entre todos los equipos', () => {
    const r = allocate({ pool: 1100, targets: [T('a', 4, 1), T('b', 2, 1), T('c', 4, 2)], rules: [] });
    expect(r.perUnit.get('a')).toBe(110);
    expect(r.perUnit.get('c')).toBe(110);
    expect(r.summary.assigned).toBe(1100);
    expect(r.warnings).toEqual([]);
  });

  it('monto fijo por equipo y el resto por peso', () => {
    const rules = [R('m', 'unit_amount', 20, { typeIds: [2] }), R('d', 'weight', 2, { typeIds: [1], specs: { brand: 'Dell' } }), R('h', 'weight', 1, { typeIds: [1] })];
    const r = allocate({ pool: 1100, targets: [T('dell', 4, 1, { specs: { brand: 'Dell' } }), T('hp', 2, 1, { specs: { brand: 'HP' } }), T('lg', 4, 2)], rules });
    expect(r.perUnit.get('lg')).toBe(20);
    expect(r.perUnit.get('dell')).toBe(204);
    expect(r.perUnit.get('hp')).toBe(102);
    expect(r.summary.fixed).toBe(80);
    expect(r.summary.difference).toBe(0);
  });

  it('gana la primera regla activa; las desactivadas se ignoran', () => {
    const rules = [R('off', 'unit_amount', 999, {}, false), R('a', 'unit_amount', 10, { typeIds: [1] }), R('b', 'unit_amount', 50, { typeIds: [1] })];
    const r = allocate({ pool: 500, targets: [T('x', 2, 1)], rules });
    expect(r.ruleOf.get('x')).toBe('a');
    expect(r.perUnit.get('x')).toBe(10);
    expect(r.warnings).toContainEqual({ code: 'rule_unused', ruleId: 'b' });
  });

  it('group_total y percent se reparten parejo dentro del grupo', () => {
    const r = allocate({ pool: 1000, targets: [T('a', 4, 1), T('b', 6, 2)], rules: [R('g', 'group_total', 200, { typeIds: [1] }), R('p', 'percent', 30, { typeIds: [2] })] });
    expect(r.perUnit.get('a')).toBe(50);
    expect(r.perUnit.get('b')).toBe(50);
  });

  it('by_list reparte en proporción al precio de lista y usa el promedio si falta', () => {
    const r = allocate({ pool: 600, targets: [T('a', 1, 1, { list: 100 }), T('b', 1, 1, { list: 200 }), T('c', 1, 1)], rules: [], base: 'by_list' });
    // c usa el promedio (150): pesos 100/200/150 → 600 * 100/450 …
    expect(r.perUnit.get('a')! + r.perUnit.get('b')! + r.perUnit.get('c')!).toBeCloseTo(600, 2);
    expect(r.perUnit.get('b')! / r.perUnit.get('a')!).toBeCloseTo(2, 3);
    expect(r.perUnit.get('c')! / r.perUnit.get('a')!).toBeCloseTo(1.5, 3);
  });

  it('lo congelado (manual / vendido) se descuenta del monto', () => {
    const r = allocate({ pool: 1100, frozen: 300, targets: [T('a', 4, 1), T('b', 2, 1)], rules: [] });
    expect(r.perUnit.get('a')).toBeCloseTo(133.3333, 3);
    expect(r.summary.remainder).toBe(800);
    expect(r.summary.assigned).toBe(1100);
  });

  it('avisa cuando lo fijado supera el monto', () => {
    const r = allocate({ pool: 100, targets: [T('a', 10, 1), T('b', 1, 2)], rules: [R('f', 'unit_amount', 50, { typeIds: [1] })] });
    expect(r.warnings.some((w) => w.code === 'over_allocated')).toBe(true);
    expect(r.perUnit.get('b')).toBe(0);
  });

  it('avisa cuando sobra monto y no hay a quién darlo', () => {
    const r = allocate({ pool: 500, targets: [T('a', 2, 1)], rules: [R('f', 'unit_amount', 100, { typeIds: [1] })] });
    expect(r.summary.difference).toBe(300);
    expect(r.warnings).toContainEqual({ code: 'unallocated', amount: 300 });
  });

  it('un grupo sin equipos con group_total avisa y no pierde el resto', () => {
    const r = allocate({ pool: 100, targets: [T('a', 0, 1), T('b', 2, 2)], rules: [R('g', 'group_total', 40, { typeIds: [1] })] });
    expect(r.warnings).toContainEqual({ code: 'empty_group', ruleId: 'g' });
    expect(r.perUnit.get('b')).toBe(50);
  });

  it('propiedades: coincide sin importar mayúsculas y acepta listas', () => {
    const t = T('a', 1, 1, { specs: { ram: '16 GB', tags: ['x', 'Y'] } });
    const r = allocate({ pool: 10, targets: [t], rules: [R('r', 'unit_amount', 3, { specs: { ram: ['8 gb', '16 GB'], tags: 'y' } })] });
    expect(r.perUnit.get('a')).toBe(3);
    const r2 = allocate({ pool: 10, targets: [t], rules: [R('r', 'unit_amount', 3, { specs: { ram: '32 GB' } })] });
    expect(r2.ruleOf.get('a')).toBeNull();
  });

  it('unlinked solo toma equipos fuera de las líneas', () => {
    const r = allocate({ pool: 100, targets: [T('l', 1, 1, { lineId: 5 }), T('u', 1, 1, { lineId: null })], rules: [R('u', 'unit_amount', 10, { unlinked: true })] });
    expect(r.ruleOf.get('u')).toBe('u');
    expect(r.ruleOf.get('l')).toBeNull();
    expect(r.perUnit.get('l')).toBe(90);
  });
});

describe('distributeCents', () => {
  it('mantiene el total exacto', () => {
    const v = [100 / 3, 100 / 3, 100 / 3];
    const out = distributeCents(v, 100);
    expect(Math.round(out.reduce((a, b) => a + b, 0) * 100)).toBe(10000);
    expect(out).toEqual([33.34, 33.33, 33.33]);
  });
  it('reparte 300 entre 316.67 de precios de lista', () => {
    const out = distributeCents([158.335, 158.335], 316.67);
    expect(Math.round(out.reduce((a, b) => a + b, 0) * 100)).toBe(31667);
  });
});

describe('roundPrice', () => {
  it('redondeos comerciales', () => {
    expect(roundPrice(233.9, 'x99')).toBe(233.99);
    expect(roundPrice(234.4, 'x99')).toBe(233.99);
    expect(roundPrice(234.6, 'x99')).toBe(234.99);
    expect(roundPrice(233.5, 'unit')).toBe(234);
    expect(roundPrice(233, 'five')).toBe(235);
    expect(roundPrice(233, 'ten')).toBe(230);
    expect(roundPrice(12.345, 'none')).toBe(12.35);
    expect(roundPrice(-5, 'none')).toBe(0);
  });
});

describe('priceFor', () => {
  const unit = (over: Partial<PriceUnit> = {}): PriceUnit => ({ id: 1, typeId: 1, specs: {}, cosmeticGradeId: null, functionalGradeId: null, lotId: 1, cost: 180, ...over });
  const rule = (over: Partial<PriceRule>): PriceRule => ({ id: 1, name: '', enabled: true, match: {}, method: 'fixed', value: 0, rounding: 'none', minPrice: null, ...over });

  it('markup con redondeo .99', () => {
    expect(priceFor([rule({ method: 'markup_pct', value: 30, rounding: 'x99' })], unit())).toEqual({ price: 233.99, ruleId: 1 });
  });
  it('margen sobre el precio de venta', () => {
    expect(priceFor([rule({ method: 'margin_pct', value: 20 })], unit({ cost: 80 }))?.price).toBe(100);
  });
  it('sin costo, las reglas que lo necesitan se saltan y sigue la siguiente', () => {
    const p = priceFor([rule({ id: 1, method: 'markup_pct', value: 10 }), rule({ id: 2, method: 'fixed', value: 99 })], unit({ cost: null }));
    expect(p).toEqual({ price: 99, ruleId: 2 });
  });
  it('filtros por tipo, lote y rango de costo', () => {
    const rules = [rule({ id: 1, match: { typeIds: [2] }, method: 'fixed', value: 1 }), rule({ id: 2, match: { lotIds: [9] }, method: 'fixed', value: 2 }), rule({ id: 3, match: { costMin: 200 }, method: 'fixed', value: 3 }), rule({ id: 4, match: { costMax: 200 }, method: 'fixed', value: 4 })];
    expect(priceFor(rules, unit())?.ruleId).toBe(4);
    expect(priceFor(rules, unit({ cost: 250 }))?.ruleId).toBe(3);
    expect(priceFor(rules, unit({ lotId: 9, cost: 250 }))?.ruleId).toBe(2);
    expect(priceFor(rules, unit({ typeId: 2 }))?.ruleId).toBe(1);
  });
  it('precio mínimo', () => {
    expect(priceFor([rule({ method: 'fixed', value: 10, minPrice: 25 })], unit())?.price).toBe(25);
  });
  it('desactivada no aplica', () => {
    expect(priceFor([rule({ enabled: false, method: 'fixed', value: 10 })], unit())).toBeNull();
  });
});
