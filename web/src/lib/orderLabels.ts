import type { MetaIndex } from './meta';
import type { LabelOrder } from './labels';

export interface Package { weight: number | null; length: number | null; width: number | null; height: number | null }
export interface Shipping { weightUnit: 'lb' | 'kg'; dimUnit: 'in' | 'cm'; packages: Package[] }

/** Lo que hace falta de un pedido para armar sus etiquetas (subconjunto de lo que devuelve GET /orders/:id). */
export interface OrderForLabels {
  code: string;
  customerName: string | null; customerAddress?: string | null; customerPhone?: string | null;
  sellerName: string | null; createdAt: string; completedAt: string | null; notes: string | null;
  items: { equipmentTypeId: number }[];
  shipping: Shipping;
}

export const EMPTY_PACKAGE: Package = { weight: null, length: null, width: null, height: null };
export const DEFAULT_SHIPPING: Shipping = { weightUnit: 'lb', dimUnit: 'in', packages: [] };

/** "18 Laptop · 6 Monitor" */
export function typesSummary(items: { equipmentTypeId: number }[], meta: MetaIndex): string {
  const counts = new Map<number, number>();
  for (const i of items) counts.set(i.equipmentTypeId, (counts.get(i.equipmentTypeId) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => `${n} ${meta.typeName(id)}`).join(' · ');
}

/** Una etiqueta por bulto. Sin bultos definidos sale una sola, sin peso ni medidas. */
export function orderToLabels(o: OrderForLabels, meta: MetaIndex, shipping: Shipping = o.shipping, noCustomerText = ''): LabelOrder[] {
  const pkgs = shipping.packages.length ? shipping.packages : [EMPTY_PACKAGE];
  const summary = typesSummary(o.items, meta);
  return pkgs.map((p, i) => ({
    kind: 'order' as const,
    code: o.code,
    customerName: o.customerName ?? noCustomerText,
    customerAddress: o.customerAddress ?? '',
    customerPhone: o.customerPhone ?? '',
    sellerName: o.sellerName ?? '',
    date: o.completedAt ?? o.createdAt,
    unitCount: o.items.length,
    typesSummary: summary,
    notes: o.notes ?? '',
    packageNo: i + 1,
    packageCount: pkgs.length,
    weight: p.weight, weightUnit: shipping.weightUnit,
    length: p.length, width: p.width, height: p.height, dimUnit: shipping.dimUnit,
  }));
}
