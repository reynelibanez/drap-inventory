import { describe, expect, it } from 'vitest';
import * as web from '../../web/src/lib/offline/logic';
import { placeUnits, ruleAllows, specKey, type LevelRule, type PlaceableUnit, type SlotState } from '../src/services/placement.js';
import { matchUnit, specsContain, unitFitsLine, type MatchableUnit, type OrderLine } from '../src/services/orderLines.js';
import { applyAdjustments, parseAdjustments } from '../src/modules/sales.js';
import { roundPrice, type Rounding } from '../src/services/prices.js';
import { DEFAULT_SETTINGS } from '../src/settings.js';

/**
 * El trabajo sin conexión repite en el navegador reglas del servidor (qué equipo cabe en una línea, descuentos, redondeo, dónde ubicar).
 * Estas pruebas comparan las dos versiones con miles de casos al azar: si alguien cambia una y no la otra, esto falla.
 */

// Generador con semilla: los casos son siempre los mismos.
function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
const pick = <T,>(r: () => number, xs: T[]): T => xs[Math.floor(r() * xs.length)];

const BRANDS = ['Dell', 'dell ', 'HP', 'Lenovo', ''];
const MODELS = ['Latitude 5490', 'latitude 5490', 'EliteBook', 'T480', null];
const CPUS = ['i5-8350U', 'i7-8650U', 'I5-8350U', 'Ryzen 5 3500U'];

const specs = (r: () => number): Record<string, unknown> => {
  const o: Record<string, unknown> = {};
  if (r() < 0.8) o.brand = pick(r, BRANDS);
  if (r() < 0.8) o.model = pick(r, MODELS);
  if (r() < 0.6) o.cpu = pick(r, CPUS);
  if (r() < 0.3) o.ports = r() < 0.5 ? ['USB', 'HDMI'] : ['hdmi', 'usb', 'vga'];
  return o;
};

describe('reglas del servidor y de la app sin conexión (mismos resultados)', () => {
  it('specsContain, unitFitsLine y matchUnit', () => {
    const r = rng(7);
    for (let i = 0; i < 3000; i++) {
      const u: MatchableUnit = { id: i, equipmentTypeId: pick(r, [1, 2]), specs: specs(r), cosmeticGradeId: pick(r, [null, 10, 11]), functionalGradeId: pick(r, [null, 20, 21]) };
      const want = specs(r);
      const line = { equipmentTypeId: pick(r, [1, 2]), specs: want, cosmeticGradeIds: pick(r, [[], [10], [10, 11]]), functionalGradeIds: pick(r, [[], [20]]) };
      expect(web.specsContain(u.specs, want)).toBe(specsContain(u.specs, want));
      expect(web.unitFitsLine(u, line)).toBe(unitFitsLine(u, line));

      const lines: OrderLine[] = Array.from({ length: 1 + Math.floor(r() * 4) }, (_, n) => ({
        id: n + 1, lineNo: n + 1, ...{ ...line, specs: specs(r), equipmentTypeId: pick(r, [1, 2]) }, quantity: 1 + Math.floor(r() * 3), unitPrice: null, notes: null, picked: Math.floor(r() * 3),
      }));
      const taken = new Map<number, number>(lines.map((l) => [l.id, Math.floor(r() * 2)]));
      const a = matchUnit(u, lines, taken); const b = web.matchUnit(u, lines, taken);
      expect(b.status).toBe(a.status);
      expect(b.line?.id ?? null).toBe(a.line?.id ?? null);
    }
  });

  it('descuentos y cargos', () => {
    const r = rng(11);
    for (let i = 0; i < 2000; i++) {
      const list = Array.from({ length: Math.floor(r() * 4) }, (_, n) => ({ label: ` Ajuste ${n} `, kind: pick(r, ['percent', 'amount'] as const), value: Math.round((r() * 200 - 100) * 100) / 100 }));
      const subtotal = Math.round(r() * 1e6) / 100;
      expect(web.applyAdjustments(subtotal, web.parseAdjustments(list))).toEqual(applyAdjustments(subtotal, parseAdjustments(list)));
    }
    for (const bad of [[{ label: '', kind: 'percent', value: 1 }], [{ label: 'x', kind: 'other', value: 1 }], [{ label: 'x', kind: 'amount', value: NaN }], 'nope', null]) {
      expect(web.parseAdjustments(bad)).toEqual(parseAdjustments(bad));
    }
  });

  it('redondeo de precios', () => {
    const r = rng(3);
    for (let i = 0; i < 3000; i++) {
      const v = r() * 2000 - 50;
      for (const how of ['none', 'unit', 'five', 'ten', 'x99'] as Rounding[]) expect(web.roundPrice(v, how)).toBe(roundPrice(v, how));
    }
  });

  it('reglas de nivel y sugerencia de ubicación', () => {
    const r = rng(21);
    const w = DEFAULT_SETTINGS.placement;
    const rule = (): LevelRule | null => (r() < 0.4 ? null : {
      typeId: pick(r, [null, 1, 2]), cosmeticGradeIds: pick(r, [[], [10]]), functionalGradeIds: pick(r, [[], [20]]),
      groupBy: pick(r, [[], ['brand'], ['brand', 'model'], ['brand', 'model', 'cpu']]), strict: r() < 0.5,
    });
    const unit = (id: number): PlaceableUnit => ({ id, typeId: pick(r, [1, 2]), specs: specs(r), cosmeticGradeId: pick(r, [null, 10, 11]), functionalGradeId: pick(r, [null, 20, 21]) });
    for (const v of [undefined, null, '', ' Dell ', ['b', 'A'], 5]) expect(web.specKey(v)).toBe(specKey(v));
    for (let i = 0; i < 300; i++) {
      const mk = (): SlotState[] => {
        const nSlots = 3 + Math.floor(r() * 8);
        return Array.from({ length: nSlots }, (_, n) => {
          const capacity = 1 + Math.floor(r() * 4);
          const residents = Array.from({ length: Math.floor(r() * (capacity + 1)) }, (_, k) => unit(1000 + n * 10 + k));
          return { id: n + 1, code: `S${n + 1}`, areaId: 1 + (n % 3), order: n + 1, capacity, occupied: residents.length, preferredTypes: new Set<number>(r() < 0.5 ? [1] : []), residents, rule: rule() };
        });
      };
      const slotsA = mk();
      // copia profunda para la otra versión (las dos modifican la ocupación al repartir)
      const slotsB: SlotState[] = slotsA.map((s) => ({ ...s, preferredTypes: new Set(s.preferredTypes), residents: [...s.residents] }));
      const units = Array.from({ length: 1 + Math.floor(r() * 8) }, (_, k) => unit(k + 1));
      expect(web.suggestPlacement(slotsB, units, w)).toEqual(placeUnits(slotsA, units, w));
      for (const u of units) { const ru = rule(); expect(web.ruleAllows(u, ru)).toBe(ruleAllows(u, ru)); }
    }
  });
});
