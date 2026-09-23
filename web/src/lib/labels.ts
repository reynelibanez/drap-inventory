import { docLocale } from './docTrace';
import type { MetaIndex, Specs } from './meta';

/** Elemento de una etiqueta (medidas en mm desde la esquina superior izquierda). Espejo de server/src/modules/labels.ts. */
export interface LabelElement {
  id: string;
  type: 'field' | 'text' | 'qr' | 'barcode' | 'rect' | 'icon';
  x: number; y: number; w: number; h: number;
  source?: string;          // field / qr / barcode
  text?: string;            // text
  label?: boolean;          // field: antepone el nombre del dato ("Marca: Dell")
  fontSize?: number;        // pt
  bold?: boolean;
  italic?: boolean;
  align?: 'left' | 'center' | 'right';
  valign?: 'top' | 'middle' | 'bottom';
  shrink?: boolean;         // reduce la letra hasta que el texto quepa
  inverse?: boolean;        // letra blanca sobre fondo negro
  showText?: boolean;       // barcode: muestra el texto debajo
  filled?: boolean;         // rect: relleno negro (útil para líneas)
  border?: number;          // rect: grosor del borde en mm
  icon?: DocumentIcon;      // icon: qué símbolo dibuja
}

/** Lista fija de íconos disponibles en el diseñador. Espejo de server/src/modules/labels.ts (DOCUMENT_ICONS). */
export const DOCUMENT_ICONS = [
  'CheckCircle2', 'XCircle', 'AlertTriangle', 'Info', 'Star', 'ShieldCheck', 'Truck', 'Package', 'PackageCheck', 'Tag',
  'Box', 'Building2', 'Phone', 'Mail', 'MapPin', 'Calendar', 'User', 'Users', 'DollarSign', 'CreditCard',
  'Wrench', 'Laptop', 'Monitor', 'Smartphone', 'HardDrive', 'Cpu', 'Printer', 'ClipboardCheck', 'ClipboardList', 'Award',
  'ThumbsUp', 'Recycle', 'Flag', 'Lock', 'Camera', 'Battery', 'Wifi', 'Plug', 'Zap', 'FileText',
  'FileCheck2', 'PenLine', 'Trophy', 'Gift', 'Clock', 'AlertCircle', 'Globe', 'Sparkles',
] as const;
export type DocumentIcon = (typeof DOCUMENT_ICONS)[number];

/** Clase de plantilla: etiqueta de equipo/testeo (por tipo), documento de lote, o documento de pedido (envío). */
export type LabelKind = 'unit' | 'order' | 'lot';

export interface LabelTemplate {
  id: number;
  kind: LabelKind;
  name: string;
  widthMm: number;
  heightMm: number;
  rotation: 0 | 90 | 180 | 270;
  layout: { elements: LabelElement[] };
  isDefault: boolean;
  isActive: boolean;
  typeIds: number[];
}

/** Datos de un equipo que una etiqueta puede mostrar. */
export interface LabelUnit {
  id?: number;
  code: string;
  serialNumber: string | null;
  specs: Specs;
  lotCode: string;
  equipmentTypeId: number;
  cosmeticGradeId: number | null;
  functionalGradeId: number | null;
  testedAt: string | null;
  testerNumber: number | null;
  slotCode?: string | null;
  notes?: string | null;
}

/** Datos de un pedido que una etiqueta de envío puede mostrar (una etiqueta por bulto). */
export interface LabelOrder {
  kind: 'order';
  code: string;
  customerName: string;
  customerAddress: string;
  customerPhone: string;
  sellerName: string;
  date: string | null;
  unitCount: number;
  typesSummary: string;
  notes: string;
  packageNo: number;
  packageCount: number;
  weight: number | null;
  weightUnit: 'lb' | 'kg';
  length: number | null;
  width: number | null;
  height: number | null;
  dimUnit: 'in' | 'cm';
}

/** Datos de un lote que un documento puede mostrar (un documento por lote, no por bulto). */
export interface LabelLot {
  kind: 'lot';
  code: string;
  supplierName: string;
  reference: string;
  purchaseDate: string | null;
  createdDate: string;
  statusName: string;
  requiresTesting: boolean;
  linesSummary: string;
  expectedQty: number;
  countedQty: number;
  unitsCount: number;
  notes: string;
}

/**
 * Etiqueta/documento "personalizado": no está asociado a ningún equipo, pedido ni lote real. Cada dato de la plantilla
 * (`source`) se llena a mano en un formulario y se imprime tal cual, sin pasar por catálogos ni cálculos.
 */
export interface LabelCustom { kind: 'custom'; values: Record<string, string> }

/** Lo que un documento dibuja: un equipo, un pedido, un lote, o valores llenados a mano (etiqueta personalizada). */
export type LabelSubject = LabelUnit | LabelOrder | LabelLot | LabelCustom;
export const isOrderSubject = (s: LabelSubject): s is LabelOrder => (s as LabelOrder).kind === 'order';
export const isLotSubject = (s: LabelSubject): s is LabelLot => (s as LabelLot).kind === 'lot';
export const isCustomSubject = (s: LabelSubject): s is LabelCustom => (s as LabelCustom).kind === 'custom';

export interface LabelCtx { meta: MetaIndex; t: (key: string) => string; company: string }

/** Datos fijos que siempre están disponibles; el resto sale de los atributos del tipo de equipo. */
export const BASE_SOURCES = ['code', 'serial', 'lot', 'type', 'grades', 'cosmetic', 'functional', 'cosmetic_name', 'functional_name',
  'specs', 'specs_all', 'tested_date', 'today', 'tester', 'company', 'location', 'notes'] as const;
export type BaseSource = (typeof BASE_SOURCES)[number];

/** Datos de una etiqueta de pedido. `company` y `today` se comparten con las de equipo. */
export const ORDER_SOURCES = ['customer', 'customer_address', 'customer_phone', 'order_code', 'package_of', 'package_no', 'package_count',
  'weight', 'size', 'length', 'width', 'height', 'units', 'types_summary', 'date', 'seller', 'order_notes', 'company', 'today'] as const;
export type OrderSource = (typeof ORDER_SOURCES)[number];

/** Datos de un documento de lote. `company` y `today` se comparten con las de equipo. */
export const LOT_SOURCES = ['lot_code', 'lot_supplier', 'lot_reference', 'lot_purchase_date', 'lot_created_date', 'lot_status',
  'lot_requires_testing', 'lot_lines_summary', 'lot_expected', 'lot_counted', 'lot_units', 'lot_notes', 'company', 'today'] as const;
export type LotSource = (typeof LOT_SOURCES)[number];

export const baseSources = (kind: LabelKind): readonly string[] => (kind === 'order' ? ORDER_SOURCES : kind === 'lot' ? LOT_SOURCES : BASE_SOURCES);

/** Qué puede codificar un QR o un código de barras. */
export const QR_SOURCES = ['code', 'serial', 'info'] as const;
export const BARCODE_SOURCES = ['code', 'serial'] as const;
export const qrSources = (kind: LabelKind): readonly string[] => (kind === 'order' || kind === 'lot' ? ['code', 'info'] : QR_SOURCES);
export const barcodeSources = (kind: LabelKind): readonly string[] => (kind === 'order' || kind === 'lot' ? ['code'] : BARCODE_SOURCES);

export const isSpecSource = (s: string | undefined): s is `spec:${string}` => !!s && s.startsWith('spec:');
export const specKey = (s: string) => s.slice(5);

const fmtDate = (iso: string | null | undefined) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(docLocale(), { year: 'numeric', month: '2-digit', day: '2-digit' });
};

const num = (n: number) => String(Math.round(n * 100) / 100);

/** Valor de un dato de pedido ("" si no está definido, y entonces la etiqueta no muestra nada). */
export function orderSourceValue(source: string, o: LabelOrder, ctx: LabelCtx): string {
  switch (source as OrderSource) {
    case 'customer': return o.customerName;
    case 'customer_address': return o.customerAddress;
    case 'customer_phone': return o.customerPhone;
    case 'order_code': return o.code;
    case 'package_no': return String(o.packageNo);
    case 'package_count': return String(o.packageCount);
    case 'package_of': return `${o.packageNo}/${o.packageCount}`;
    case 'weight': return o.weight === null ? '' : `${num(o.weight)} ${o.weightUnit}`;
    case 'length': return o.length === null ? '' : `${num(o.length)} ${o.dimUnit}`;
    case 'width': return o.width === null ? '' : `${num(o.width)} ${o.dimUnit}`;
    case 'height': return o.height === null ? '' : `${num(o.height)} ${o.dimUnit}`;
    case 'size': {
      const d = [o.length, o.width, o.height];
      return d.every((x) => x === null) ? '' : `${d.map((x) => (x === null ? '?' : num(x))).join(' × ')} ${o.dimUnit}`;
    }
    case 'units': return String(o.unitCount);
    case 'types_summary': return o.typesSummary;
    case 'date': return fmtDate(o.date);
    case 'seller': return o.sellerName;
    case 'order_notes': return o.notes;
    case 'company': return ctx.company;
    case 'today': return fmtDate(new Date().toISOString());
    default: return '';
  }
}

/** Valor de un dato de documento de lote ("" si no está definido). */
export function lotSourceValue(source: string, o: LabelLot, ctx: LabelCtx): string {
  switch (source as LotSource) {
    case 'lot_code': return o.code;
    case 'lot_supplier': return o.supplierName;
    case 'lot_reference': return o.reference;
    case 'lot_purchase_date': return fmtDate(o.purchaseDate);
    case 'lot_created_date': return fmtDate(o.createdDate);
    case 'lot_status': return o.statusName;
    case 'lot_requires_testing': return ctx.t(o.requiresTesting ? 'common.yes' : 'common.no');
    case 'lot_lines_summary': return o.linesSummary;
    case 'lot_expected': return String(o.expectedQty);
    case 'lot_counted': return String(o.countedQty);
    case 'lot_units': return String(o.unitsCount);
    case 'lot_notes': return o.notes;
    case 'company': return ctx.company;
    case 'today': return fmtDate(new Date().toISOString());
    default: return '';
  }
}

/** Nombre corto del dato (para mostrar "Marca: Dell" y en el diseñador). */
export function sourceLabel(source: string, ctx: LabelCtx): string {
  if (isSpecSource(source)) {
    const a = ctx.meta.attrByKey(specKey(source));
    return a ? ctx.meta.label(a.label) : specKey(source);
  }
  return ctx.t(`labels.src.${source}`);
}

/** Valor de un dato para un equipo concreto ("" si el equipo no lo tiene). */
export function sourceValue(source: string, subject: LabelSubject, ctx: LabelCtx): string {
  if (isOrderSubject(subject)) return orderSourceValue(source, subject, ctx);
  if (isLotSubject(subject)) return lotSourceValue(source, subject, ctx);
  if (isCustomSubject(subject)) {
    if (source === 'company') return ctx.company;
    if (source === 'today') return fmtDate(new Date().toISOString());
    return subject.values[source] ?? '';
  }
  const u = subject;
  const { meta } = ctx;
  if (isSpecSource(source)) {
    const a = meta.attrByKey(specKey(source));
    const v = u.specs?.[specKey(source)];
    if (!a || v === undefined || v === null || v === '') return '';
    return meta.specValue(a, v);
  }
  switch (source as BaseSource) {
    case 'code': return u.code;
    case 'serial': return u.serialNumber ?? '';
    case 'lot': return u.lotCode;
    case 'type': return meta.typeName(u.equipmentTypeId);
    case 'cosmetic': return meta.item(u.cosmeticGradeId)?.code ?? '';
    case 'functional': return meta.item(u.functionalGradeId)?.code ?? '';
    case 'grades': return [meta.item(u.cosmeticGradeId)?.code, meta.item(u.functionalGradeId)?.code].filter(Boolean).join(' / ');
    case 'cosmetic_name': return meta.name(u.cosmeticGradeId);
    case 'functional_name': return meta.name(u.functionalGradeId);
    case 'specs': return meta.describe(u.equipmentTypeId, u.specs, true).join(' · ');
    case 'specs_all': return meta.describe(u.equipmentTypeId, u.specs, false).join(' · ');
    case 'tested_date': return fmtDate(u.testedAt);
    case 'today': return fmtDate(new Date().toISOString());
    case 'tester': return u.testerNumber ? String(u.testerNumber) : '';
    case 'company': return ctx.company;
    case 'location': return u.slotCode ?? '';
    case 'notes': return u.notes ?? '';
    default: return '';
  }
}

/** Contenido de un QR o código de barras. */
export function codeValue(source: string | undefined, u: LabelSubject, ctx: LabelCtx, forBarcode = false): string {
  if (isOrderSubject(u)) {
    if (source === 'info' && !forBarcode) {
      return [u.code, u.customerName, u.customerAddress, `${u.packageNo}/${u.packageCount}`, orderSourceValue('weight', u, ctx), orderSourceValue('size', u, ctx)].filter(Boolean).join('\n');
    }
    return u.code;
  }
  if (isLotSubject(u)) {
    if (source === 'info' && !forBarcode) {
      return [u.code, u.supplierName, u.linesSummary, `${ctx.t('labels.src.lot_units')}: ${u.unitsCount}`].filter(Boolean).join('\n');
    }
    return u.code;
  }
  if (isCustomSubject(u)) {
    if (source === 'info' && !forBarcode) return Object.values(u.values).filter(Boolean).join('\n');
    return (source && u.values[source]) || u.values.code || '';
  }
  if (source === 'serial') return u.serialNumber || u.code;
  if (source === 'info' && !forBarcode) {
    const lines = [u.code, ctx.meta.typeName(u.equipmentTypeId), ...ctx.meta.describe(u.equipmentTypeId, u.specs, false)];
    const g = sourceValue('grades', u, ctx);
    if (g) lines.push(`${ctx.t('labels.src.grades')}: ${g}`);
    if (u.serialNumber) lines.push(`S/N ${u.serialNumber}`);
    return lines.join('\n');
  }
  return u.code;
}

/** Texto que muestra un elemento de tipo campo o texto. */
export function elementText(el: LabelElement, u: LabelSubject, ctx: LabelCtx): string {
  if (el.type === 'text') return el.text ?? '';
  if (el.type !== 'field' || !el.source) return '';
  const value = sourceValue(el.source, u, ctx);
  if (!value) return '';
  return el.label ? `${sourceLabel(el.source, ctx)}: ${value}` : value;
}

/** Datos de ejemplo para el diseñador: usa valores reales de los catálogos del tipo elegido. */
export function sampleUnit(meta: MetaIndex, typeId: number): LabelUnit {
  const specs: Specs = {};
  for (const { attr } of meta.typeAttrs(typeId)) {
    if (attr.dataType === 'select') { const it = meta.attrOptions(typeId, attr, specs)[0]; if (it) specs[attr.key] = it.id; }
    else if (attr.dataType === 'multiselect') { const it = meta.attrOptions(typeId, attr, specs)[0]; if (it) specs[attr.key] = [it.id]; }
    else if (attr.dataType === 'number') specs[attr.key] = 16;
    else if (attr.dataType === 'boolean') specs[attr.key] = true;
    else if (attr.dataType === 'date') specs[attr.key] = new Date().toISOString().slice(0, 10);
    else specs[attr.key] = attr.key === 'description' ? 'Docking station' : 'Ejemplo';
  }
  return {
    code: 'L260901-1t120', serialNumber: 'SN4F7K29Q1', specs, lotCode: 'L260901', equipmentTypeId: typeId,
    cosmeticGradeId: meta.catalogOptions('cosmetic_grade')[0]?.id ?? null, functionalGradeId: meta.catalogOptions('functional_grade')[0]?.id ?? null,
    testedAt: new Date().toISOString(), testerNumber: 1, slotCode: 'MIA/LAP/R01/1-1', notes: '',
  };
}

/** Datos de ejemplo de una etiqueta de pedido, para el diseñador. */
export function sampleOrder(): LabelOrder {
  return {
    kind: 'order', code: 'V2609-0001', customerName: 'Tech Import Corp', customerAddress: '1250 NW 79th Ave\nDoral, FL 33126', customerPhone: '305-555-0142',
    sellerName: 'Carlos R.', date: new Date().toISOString(), unitCount: 24, typesSummary: '18 Laptop · 6 Monitor', notes: '',
    packageNo: 1, packageCount: 2, weight: 42.5, weightUnit: 'lb', length: 24, width: 18, height: 12, dimUnit: 'in',
  };
}

/** Datos de ejemplo de un documento de lote, para el diseñador. */
export function sampleLot(): LabelLot {
  return {
    kind: 'lot', code: 'L260901', supplierName: 'Tech Import Corp', reference: 'PO-4521', purchaseDate: new Date().toISOString(),
    createdDate: new Date().toISOString(), statusName: 'En testeo', requiresTesting: false, linesSummary: '18 Laptop · 6 Monitor',
    expectedQty: 24, countedQty: 24, unitsCount: 24, notes: '',
  };
}

/** Plantilla de documento de pedido: la predeterminada, o la primera activa. */
export function templateForOrder(templates: LabelTemplate[]): LabelTemplate | null {
  const active = templates.filter((t) => t.kind === 'order' && t.isActive);
  return active.find((t) => t.isDefault) ?? active[0] ?? null;
}

/** Plantilla de documento de lote: la predeterminada, o la primera activa. */
export function templateForLot(templates: LabelTemplate[]): LabelTemplate | null {
  const active = templates.filter((t) => t.kind === 'lot' && t.isActive);
  return active.find((t) => t.isDefault) ?? active[0] ?? null;
}

/** Plantilla que corresponde a un tipo: la asociada a ese tipo, o la predeterminada (solo entre las de equipo/testeo). */
export function templateForType(templates: LabelTemplate[], typeId: number): LabelTemplate | null {
  const active = templates.filter((t) => t.isActive && (t.kind === 'unit' || !t.kind));
  return active.find((t) => t.typeIds.includes(typeId)) ?? active.find((t) => t.isDefault) ?? active[0] ?? null;
}

export const uid = () => Math.random().toString(36).slice(2, 9);

/** Tamaños de etiqueta habituales (referencia: pueden ajustarse en milímetros). */
export const LABEL_PRESETS: { id: string; name: string; w: number; h: number }[] = [
  { id: 'dymo-30334', name: 'DYMO 30334 (57 × 32 mm)', w: 57, h: 32 },
  { id: 'dymo-30336', name: 'DYMO 30336 (54 × 25 mm)', w: 54, h: 25 },
  { id: 'dymo-30252', name: 'DYMO 30252 (89 × 28 mm)', w: 89, h: 28 },
  { id: 'dymo-30321', name: 'DYMO 30321 (89 × 36 mm)', w: 89, h: 36 },
  { id: 'dymo-30330', name: 'DYMO 30330 (51 × 19 mm)', w: 51, h: 19 },
  { id: 'dymo-30332', name: 'DYMO 30332 (25 × 25 mm)', w: 25, h: 25 },
  { id: 'dymo-30323', name: 'DYMO 30323 (101 × 54 mm)', w: 101, h: 54 },
  { id: 'dymo-30256', name: 'DYMO 30256 (102 × 59 mm)', w: 102, h: 59 },
  { id: 'dymo-4xl', name: 'DYMO 4XL (102 × 152 mm)', w: 102, h: 152 },
  { id: 'ship-4x6', name: '4 × 6 in (102 × 152 mm)', w: 102, h: 152 },
  { id: 'ship-4x3', name: '4 × 3 in (102 × 76 mm)', w: 102, h: 76 },
  { id: 'th-100x50', name: '100 × 50 mm', w: 100, h: 50 },
  { id: 'th-60x40', name: '60 × 40 mm', w: 60, h: 40 },
  { id: 'th-50x25', name: '50 × 25 mm', w: 50, h: 25 },
  { id: 'a4', name: 'A4 (210 × 297 mm)', w: 210, h: 297 },
  { id: 'letter', name: 'Carta / Letter (216 × 279 mm)', w: 216, h: 279 },
];

export const mmToPt = (mm: number) => (mm * 72) / 25.4;
