import type { MetaIndex } from './meta';
import type { LabelLot } from './labels';

/** Lo que hace falta de un lote para armar su documento (subconjunto de lo que devuelve GET /lots/:id). */
export interface LotForLabels {
  code: string;
  statusKey: string;
  supplierName: string | null;
  reference: string | null;
  purchaseDate: string | null;
  createdAt: string;
  requiresTesting: boolean;
  notes: string | null;
  lines: { equipmentTypeId: number; expectedQty: number; countedQty: number | null }[];
  summary: { expected: number; counted: number; units: number };
}

/** "18 Laptop · 6 Monitor" a partir de las líneas del lote. */
export function lotLinesSummary(lines: { equipmentTypeId: number; expectedQty: number; countedQty: number | null }[], meta: MetaIndex): string {
  const counts = new Map<number, number>();
  for (const l of lines) counts.set(l.equipmentTypeId, (counts.get(l.equipmentTypeId) ?? 0) + (l.countedQty ?? l.expectedQty));
  return [...counts.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).map(([id, n]) => `${n} ${meta.typeName(id)}`).join(' · ');
}

export function lotToLabel(l: LotForLabels, meta: MetaIndex, statusName: string, noSupplierText = ''): LabelLot {
  return {
    kind: 'lot',
    code: l.code,
    supplierName: l.supplierName ?? noSupplierText,
    reference: l.reference ?? '',
    purchaseDate: l.purchaseDate,
    createdDate: l.createdAt,
    statusName,
    requiresTesting: l.requiresTesting,
    linesSummary: lotLinesSummary(l.lines, meta),
    expectedQty: l.summary.expected,
    countedQty: l.summary.counted,
    unitsCount: l.summary.units,
    notes: l.notes ?? '',
  };
}
