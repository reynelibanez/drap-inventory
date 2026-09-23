import { api } from './api';
import { printLabels } from './printLabels';
import { templateForType, type LabelCtx, type LabelTemplate, type LabelUnit } from './labels';

export const AUTOPRINT_KEY = 'label_autoprint';
export const getAutoPrint = (): boolean => { try { return localStorage.getItem(AUTOPRINT_KEY) !== '0'; } catch { return true; } };
export const setAutoPrint = (on: boolean) => { try { localStorage.setItem(AUTOPRINT_KEY, on ? '1' : '0'); } catch { /* sin almacenamiento */ } };

export async function fetchLabelUnits(ids: number[]): Promise<LabelUnit[]> {
  if (!ids.length) return [];
  const r = await api.get<{ items: LabelUnit[] }>(`/units/batch?ids=${ids.join(',')}`);
  return r.items;
}

/** Activos de la empresa vistos como "equipo" para la etiqueta: sin lote ni testeo; el lugar del activo sale como ubicación. */
export async function fetchLabelAssets(ids: number[]): Promise<LabelUnit[]> {
  if (!ids.length) return [];
  const r = await api.get<{ items: { id: number; code: string; serialNumber: string | null; specs: LabelUnit['specs']; equipmentTypeId: number; location: string | null; notes: string | null }[] }>(`/assets/batch?ids=${ids.join(',')}`);
  return r.items.map((a) => ({
    id: a.id, code: a.code, serialNumber: a.serialNumber, specs: a.specs, lotCode: '', equipmentTypeId: a.equipmentTypeId,
    cosmeticGradeId: null, functionalGradeId: null, testedAt: null, testerNumber: null, slotCode: a.location, notes: a.notes,
  }));
}

/** Agrupa equipos por la plantilla que les toca (la de su tipo o la predeterminada) y devuelve un trabajo por plantilla. */
export function groupByTemplate(units: LabelUnit[], templates: LabelTemplate[], overrides: Record<number, number> = {}) {
  const jobs = new Map<number, { template: LabelTemplate; units: LabelUnit[] }>();
  for (const u of units) {
    const tpl = templates.find((t) => t.id === overrides[u.equipmentTypeId]) ?? templateForType(templates, u.equipmentTypeId);
    if (!tpl) continue;
    (jobs.get(tpl.id) ?? jobs.set(tpl.id, { template: tpl, units: [] }).get(tpl.id)!).units.push(u);
  }
  return [...jobs.values()];
}

/** Imprime directo (sin ventana previa) la etiqueta de cada equipo según su tipo. Devuelve cuántas etiquetas salieron. */
export async function printUnitLabels(ids: number[], templates: LabelTemplate[], ctx: LabelCtx, copies = 1): Promise<number> {
  const units = await fetchLabelUnits(ids);
  let n = 0;
  for (const job of groupByTemplate(units, templates)) {
    const list = job.units.flatMap((u) => Array.from({ length: copies }, () => u));
    await printLabels({ template: job.template, units: list, ctx });
    n += list.length;
  }
  return n;
}
