import type { Ctx } from '../http.js';
import type { Db } from '../db.js';
import { AppError, badRequest } from '../errors.js';
import { getSettings, nextLotCode } from '../settings.js';
import { sysItemId } from './common.js';
import { insertUnit } from '../modules/units.js';
import { loadTypeAttrs, normalizeSpecs, type AttrConf } from './specs.js';
import { bestFuzzyMatch } from './textMatch.js';

// ---------------------------------------------------------------------------------------------------------------------
// Importación de equipos desde un archivo CSV: arma una especificación por fila, corrigiendo o creando valores de
// catálogo cuando hace falta, y da de alta cada equipo directamente como "disponible" (sin pasar por testeo), dentro
// de un lote nuevo creado para la importación. Vista previa y confirmación usan exactamente el mismo código: la vista
// previa hace todo de verdad y al final revierte (SAVEPOINT), así no hay manera de que se comporten distinto.
// ---------------------------------------------------------------------------------------------------------------------

export interface ImportMapping {
  /** Columna con el número de serie (o null si no se importa). */
  serialCol: number | null;
  /** Columna que identifica el origen/referencia de cada equipo (se guarda en las notas). */
  referenceCol: number | null;
  /** Columna de notas del equipo. */
  notesCol: number | null;
  /** Columnas adicionales que no corresponden a ningún atributo: su valor se agrega a las notas con el nombre de su encabezado. */
  extraCols: number[];
  /** Atributo del tipo de equipo → columna de origen (o null si no se importa ese atributo). */
  attrs: Record<string, number | null>;
}

export interface ImportRowResult {
  rowIndex: number;
  ok: boolean;
  unitCode?: string;
  serial?: string | null;
  specs?: Record<string, unknown>;
  notes?: string | null;
  reason?: string;
}

export interface NewCatalogItem { attrKey: string; value: string }

export interface ImportOutcome {
  lotId: number;
  lotCode: string;
  created: number;
  skipped: number;
  results: ImportRowResult[];
  newCatalogItems: NewCatalogItem[];
}

interface CatalogItemRow { id: number; nameEs: string; nameEn: string | null; code: string | null; parentItemId: number | null; isActive: boolean }

/** Resuelve valores de catálogo para la importación: corrige errores leves (fuzzy) o crea el valor si no existe. Cachea dentro de la misma corrida. */
export class Resolver {
  private itemsByCatalog = new Map<number, CatalogItemRow[]>();
  private cache = new Map<string, number>();
  readonly created: NewCatalogItem[] = [];

  constructor(private db: Db, private companyId: number) {}

  private async items(catalogId: number): Promise<CatalogItemRow[]> {
    let list = this.itemsByCatalog.get(catalogId);
    if (!list) {
      list = await this.db.rows<CatalogItemRow>(
        `SELECT id, name->>'es' AS "nameEs", name->>'en' AS "nameEn", code, parent_item_id AS "parentItemId", is_active AS "isActive"
           FROM catalog_items WHERE catalog_id = $1`, [catalogId]);
      this.itemsByCatalog.set(catalogId, list);
    }
    return list;
  }

  private async create(catalogId: number, parentItemId: number | null, name: string, code: string | null, attrKey: string): Promise<number> {
    const r = await this.db.one<{ id: number }>(
      `INSERT INTO catalog_items (company_id, catalog_id, parent_item_id, code, name, sort_order)
       VALUES ($1,$2,$3,$4,$5, (SELECT COALESCE(max(sort_order), -1) + 1 FROM catalog_items WHERE catalog_id = $2)) RETURNING id`,
      [this.companyId, catalogId, parentItemId, code, JSON.stringify({ es: name, en: name })]);
    (this.itemsByCatalog.get(catalogId) ?? this.itemsByCatalog.set(catalogId, []).get(catalogId)!)
      .push({ id: r.id, nameEs: name, nameEn: name, code, parentItemId, isActive: true });
    this.created.push({ attrKey, value: name });
    return r.id;
  }

  /**
   * Texto libre (marca, modelo, procesador, sistema operativo, estado de batería...): si hay un valor parecido en el
   * catálogo (comparando contra el nombre en español o en inglés) lo usa, corrigiendo tipeos o diferencias de idioma;
   * si no hay nada parecido, crea el valor tal como vino (limpio de espacios de más).
   */
  async fuzzy(catalogId: number, attrKey: string, parentItemId: number | null, raw: string): Promise<number> {
    const name = raw.replace(/\s+/g, ' ').trim();
    if (!name) throw badRequest('empty_value', { attribute: attrKey });
    const ck = `${catalogId}|${parentItemId ?? ''}|${name.toLowerCase()}`;
    const hit = this.cache.get(ck);
    if (hit) return hit;
    const pool = (await this.items(catalogId)).filter((i) => i.isActive && (parentItemId === null || i.parentItemId === null || i.parentItemId === parentItemId));
    const candidates = pool.flatMap((i) => {
      const list = [{ key: i.nameEs, item: i }];
      if (i.nameEn && i.nameEn.toLowerCase() !== i.nameEs.toLowerCase()) list.push({ key: i.nameEn, item: i });
      return list;
    });
    const match = bestFuzzyMatch(name, candidates);
    const id = match ? match.item.id : await this.create(catalogId, parentItemId, name, null, attrKey);
    this.cache.set(ck, id);
    return id;
  }

  /** Valor numérico (RAM, capacidad de disco, tamaño de pantalla): coincidencia exacta por "código"; si no existe, se crea. */
  async exactNumeric(catalogId: number, attrKey: string, code: string, label: string): Promise<number> {
    const ck = `${catalogId}||${code}`;
    const hit = this.cache.get(ck);
    if (hit) return hit;
    const pool = await this.items(catalogId);
    const found = pool.find((i) => i.isActive && i.code === code);
    const id = found ? found.id : await this.create(catalogId, null, label, code, attrKey);
    this.cache.set(ck, id);
    return id;
  }

  /**
   * Busca un valor por su "código" exacto SIN crear uno nuevo si no existe: para catálogos cerrados donde cualquier
   * texto que no sea uno de los códigos válidos es casi siempre un error de captura (p. ej. los grados A/B/C/D),
   * nunca un valor legítimo nuevo que debiera agregarse al catálogo.
   */
  async exactCode(catalogId: number, code: string): Promise<number | null> {
    const pool = await this.items(catalogId);
    const found = pool.find((i) => i.isActive && i.code?.toLowerCase() === code.toLowerCase());
    return found ? found.id : null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Interpretación de columnas compuestas frecuentes en inventarios de laptops: "I5-1005G1" (procesador + generación) y
// "240GB SSD" (tipo de disco + capacidad).
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Procesador + generación a partir de un solo texto (p. ej. "I5-1005G1", "AMD RYZEN 5 3500U", "AMD AG7310").
 * `skuName` es solo el número de modelo, sin el prefijo de familia (p. ej. "1005G1", no "i5-1005G1"): el
 * catálogo "Generaciones de procesador" ya no repite la familia, porque esa la dice el campo "Procesador".
 */
export function parseCpu(raw: string): { family: string; skuName: string | null } | null {
  const s = raw.trim();
  if (!s) return null;
  let m = /^I\s*([3579])[\s-]*([A-Za-z0-9]+)$/i.exec(s);
  if (m) return { family: `Intel Core i${m[1]}`, skuName: m[2].toUpperCase() };
  m = /^AMD\s*RYZEN\s*([3579])(?:\s+([A-Za-z0-9]+))?$/i.exec(s);
  if (m) return { family: `AMD Ryzen ${m[1]}`, skuName: m[2] ? m[2].toUpperCase() : null };
  if (/^(INTEL\s*)?PENTIUM\b/i.test(s)) return { family: 'Intel Pentium', skuName: null };
  if (/^(INTEL\s*)?CELERON\b/i.test(s)) return { family: 'Intel Celeron', skuName: null };
  if (/^(INTEL\s*)?XEON\b/i.test(s)) return { family: 'Intel Xeon', skuName: null };
  m = /^APPLE\s*(M[123])\b/i.exec(s);
  if (m) return { family: `Apple ${m[1].toUpperCase()}`, skuName: null };
  // Cualquier otro texto (p. ej. una APU de gama baja sin generación conocida): se guarda tal cual como procesador,
  // sin inventar una generación que no se puede determinar con certeza.
  return { family: s.replace(/\s+/g, ' '), skuName: null };
}

/** Tipo de disco + capacidad a partir de un solo texto (p. ej. "240GB SSD", "1TB", "500GB HDD"). */
export function parseStorage(raw: string): { typeName: string | null; code: string | null; label: string | null } {
  const s = raw.toUpperCase();
  let typeName: string | null = null;
  if (/NVME/.test(s)) typeName = 'SSD NVMe';
  else if (/SSD/.test(s)) typeName = 'SSD SATA';
  else if (/HDD/.test(s)) typeName = 'HDD';
  else if (/EMMC/.test(s)) typeName = 'eMMC';
  const m = /(\d+(?:\.\d+)?)\s*(TB|GB)/.exec(s);
  let code: string | null = null, label: string | null = null;
  if (m) {
    const n = parseFloat(m[1]);
    if (m[2] === 'TB') { code = `${n}TB`; label = `${n} TB`; }
    else { const v = Math.round(n); code = String(v); label = `${v} GB`; }
  }
  // Sin ninguna indicación del tipo pero con una capacidad: se asume SSD (lo más común en equipos reacondicionados).
  if (!typeName && code) typeName = 'SSD SATA';
  return { typeName, code, label };
}

function parseNumberWithUnit(raw: string, defaultUnit: 'GB' = 'GB'): { code: string; label: string } | null {
  const m = /(\d+(?:\.\d+)?)\s*(TB|GB)?/i.exec(raw);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = (m[2] ?? defaultUnit).toUpperCase();
  if (unit === 'TB') return { code: `${n}TB`, label: `${n} TB` };
  const v = Math.round(n);
  return { code: String(v), label: `${v} GB` };
}

/** "WIN 10 PRO" → "Windows 10 Pro" (abreviatura muy común en inventarios; el resto lo resuelve la comparación aproximada). */
export const normalizeOs = (raw: string): string => raw.replace(/\bwin\b/gi, 'Windows');

export const FALSE_WORDS = /^(no|n|false|0)$/i;
/** Textos que en la práctica significan "sin dato" (muy comunes en inventarios exportados de Excel): se tratan como vacíos. */
export const EMPTY_TOKENS = /^(n\/a|na|-|none|s\/n|null)$/i;
/** Limpia una celda del CSV: recorta espacios y convierte los textos que significan "sin dato" en vacío. */
export const cell = (raw: string): string => { const v = raw.trim(); return EMPTY_TOKENS.test(v) ? '' : v; };

// ---------------------------------------------------------------------------------------------------------------------

export async function resolveRowSpecs(resolver: Resolver, attrs: AttrConf[], mapping: ImportMapping, row: string[]): Promise<Record<string, unknown>> {
  const byKey = new Map(attrs.map((a) => [a.key, a]));
  const get = (col: number | null | undefined): string => (col === null || col === undefined ? '' : cell(row[col] ?? ''));
  const specs: Record<string, unknown> = {};

  const cpuCombo = byKey.has('processor') && byKey.has('generation')
    && mapping.attrs.processor != null && mapping.attrs.processor === mapping.attrs.generation;
  const storageCombo = byKey.has('storage_type') && byKey.has('storage_size')
    && mapping.attrs.storage_type != null && mapping.attrs.storage_type === mapping.attrs.storage_size;

  // ---- Marca y modelo (el modelo depende de la marca ya resuelta) ----
  let brandId: number | undefined;
  const brandAttr = byKey.get('brand');
  if (brandAttr?.catalogId && mapping.attrs.brand != null) {
    const raw = get(mapping.attrs.brand);
    if (raw) { brandId = await resolver.fuzzy(brandAttr.catalogId, 'brand', null, raw); specs.brand = brandId; }
  }
  const modelAttr = byKey.get('model');
  if (modelAttr && mapping.attrs.model != null) {
    const raw = get(mapping.attrs.model);
    if (raw) {
      if (modelAttr.dataType === 'select' && modelAttr.catalogId) specs.model = await resolver.fuzzy(modelAttr.catalogId, 'model', brandId ?? null, raw);
      else if (modelAttr.dataType === 'text') specs.model = raw;
    }
  }

  // ---- Procesador y generación ----
  // (un equipo con más de un procesador es rarísimo, pero se admite igual si el atributo se configuró como "varios
  // valores", por la misma razón que el resto: consistencia con cómo se resuelve cualquier otro atributo así.)
  let processorId: number | undefined;
  const procAttr = byKey.get('processor');
  const genAttr = byKey.get('generation');
  const procIsMulti = procAttr?.dataType === 'multiselect';
  const genIsMulti = genAttr?.dataType === 'multiselect';
  if (cpuCombo && procAttr?.catalogId) {
    const raw = get(mapping.attrs.processor);
    if (raw && (procIsMulti || genIsMulti)) {
      const procIds: number[] = []; const genIds: number[] = [];
      for (const part of splitMulti(raw)) {
        const parsed = parseCpu(part);
        if (!parsed) continue;
        const pid = await resolver.fuzzy(procAttr.catalogId, 'processor', null, parsed.family);
        procIds.push(pid);
        if (parsed.skuName && genAttr?.catalogId) genIds.push(await resolver.fuzzy(genAttr.catalogId, 'generation', pid, parsed.skuName));
      }
      if (procIds.length) { specs.processor = procIsMulti ? procIds : procIds[0]; processorId = procIds[0]; }
      if (genIds.length) specs.generation = genIsMulti ? genIds : genIds[0];
    } else {
      const parsed = raw ? parseCpu(raw) : null;
      if (parsed) {
        processorId = await resolver.fuzzy(procAttr.catalogId, 'processor', null, parsed.family);
        specs.processor = processorId;
        if (parsed.skuName && genAttr?.catalogId) specs.generation = await resolver.fuzzy(genAttr.catalogId, 'generation', processorId, parsed.skuName);
      }
    }
  } else {
    if (procAttr?.catalogId && mapping.attrs.processor != null) {
      const raw = get(mapping.attrs.processor);
      if (raw) {
        if (procIsMulti) { const ids = await resolveMulti(resolver, procAttr.catalogId, 'processor', null, raw); if (ids.length) { specs.processor = ids; processorId = ids[0]; } }
        else { processorId = await resolver.fuzzy(procAttr.catalogId, 'processor', null, raw); specs.processor = processorId; }
      }
    }
    if (genAttr?.catalogId && mapping.attrs.generation != null) {
      const raw = get(mapping.attrs.generation);
      if (raw) {
        if (genIsMulti) { const ids = await resolveMulti(resolver, genAttr.catalogId, 'generation', processorId ?? null, raw); if (ids.length) specs.generation = ids; }
        else specs.generation = await resolver.fuzzy(genAttr.catalogId, 'generation', processorId ?? null, raw);
      }
    }
  }

  // ---- Tipo y capacidad de disco ----
  // Un equipo puede tener más de un disco (p. ej. una laptop con SSD + HDD): si "Tipo de disco" o "Capacidad de
  // disco" se configuraron como "Lista (varios valores)", una celda como "256GB SSD, 1TB HDD" se separa en sus
  // partes y cada una se resuelve por su cuenta, en el mismo orden para tipo y capacidad (así el disco N de una
  // lista corresponde al disco N de la otra). Con un solo valor configurado, el comportamiento es igual que antes.
  const stTypeAttr = byKey.get('storage_type');
  const stSizeAttr = byKey.get('storage_size');
  const stTypeIsMulti = stTypeAttr?.dataType === 'multiselect';
  const stSizeIsMulti = stSizeAttr?.dataType === 'multiselect';
  if (storageCombo) {
    const raw = get(mapping.attrs.storage_type);
    if (raw && (stTypeIsMulti || stSizeIsMulti)) {
      const typeIds: number[] = []; const sizeIds: number[] = [];
      for (const part of splitMulti(raw)) {
        const parsed = parseStorage(part);
        if (parsed.typeName && stTypeAttr?.catalogId) typeIds.push(await resolver.fuzzy(stTypeAttr.catalogId, 'storage_type', null, parsed.typeName));
        if (parsed.code && stSizeAttr?.catalogId) sizeIds.push(await resolver.exactNumeric(stSizeAttr.catalogId, 'storage_size', parsed.code, parsed.label!));
      }
      if (typeIds.length) specs.storage_type = stTypeIsMulti ? typeIds : typeIds[0];
      if (sizeIds.length) specs.storage_size = stSizeIsMulti ? sizeIds : sizeIds[0];
    } else {
      const parsed = raw ? parseStorage(raw) : null;
      if (parsed) {
        if (parsed.typeName && stTypeAttr?.catalogId) specs.storage_type = await resolver.fuzzy(stTypeAttr.catalogId, 'storage_type', null, parsed.typeName);
        if (parsed.code && stSizeAttr?.catalogId) specs.storage_size = await resolver.exactNumeric(stSizeAttr.catalogId, 'storage_size', parsed.code, parsed.label!);
      }
    }
  } else {
    if (stTypeAttr?.catalogId && mapping.attrs.storage_type != null) {
      const raw = get(mapping.attrs.storage_type);
      if (raw) {
        if (stTypeIsMulti) { const ids = await resolveMulti(resolver, stTypeAttr.catalogId, 'storage_type', null, raw); if (ids.length) specs.storage_type = ids; }
        else specs.storage_type = await resolver.fuzzy(stTypeAttr.catalogId, 'storage_type', null, raw);
      }
    }
    if (stSizeAttr?.catalogId && mapping.attrs.storage_size != null) {
      const raw = get(mapping.attrs.storage_size);
      if (raw) {
        if (stSizeIsMulti) {
          const ids: number[] = [];
          for (const part of splitMulti(raw)) { const n = parseNumberWithUnit(part); if (n) ids.push(await resolver.exactNumeric(stSizeAttr.catalogId, 'storage_size', n.code, n.label)); }
          if (ids.length) specs.storage_size = ids;
        } else {
          const n = parseNumberWithUnit(raw);
          if (n) specs.storage_size = await resolver.exactNumeric(stSizeAttr.catalogId, 'storage_size', n.code, n.label);
        }
      }
    }
  }

  // ---- RAM ----
  // (p. ej. dos pentes de memoria de distinta capacidad: "8GB, 4GB")
  const ramAttr = byKey.get('ram');
  if (ramAttr?.catalogId && mapping.attrs.ram != null) {
    const raw = get(mapping.attrs.ram);
    if (raw) {
      if (ramAttr.dataType === 'multiselect') {
        const ids: number[] = [];
        for (const part of splitMulti(raw)) { const m = /(\d+(?:\.\d+)?)/.exec(part); if (m) { const v = Math.round(parseFloat(m[1])); ids.push(await resolver.exactNumeric(ramAttr.catalogId, 'ram', String(v), `${v} GB`)); } }
        if (ids.length) specs.ram = ids;
      } else {
        const m = /(\d+(?:\.\d+)?)/.exec(raw);
        if (m) { const v = Math.round(parseFloat(m[1])); specs.ram = await resolver.exactNumeric(ramAttr.catalogId, 'ram', String(v), `${v} GB`); }
      }
    }
  }

  // ---- Pantalla ----
  const screenAttr = byKey.get('screen_size');
  if (screenAttr?.catalogId && mapping.attrs.screen_size != null) {
    const raw = get(mapping.attrs.screen_size);
    if (raw) {
      if (screenAttr.dataType === 'multiselect') {
        const ids: number[] = [];
        for (const part of splitMulti(raw)) { const m = /(\d+(?:\.\d+)?)/.exec(part); if (m) { const v = parseFloat(m[1]); ids.push(await resolver.exactNumeric(screenAttr.catalogId, 'screen_size', String(v), `${v}"`)); } }
        if (ids.length) specs.screen_size = ids;
      } else {
        const m = /(\d+(?:\.\d+)?)/.exec(raw);
        if (m) { const v = parseFloat(m[1]); specs.screen_size = await resolver.exactNumeric(screenAttr.catalogId, 'screen_size', String(v), `${v}"`); }
      }
    }
  }

  // ---- Sistema operativo ----
  // (p. ej. un equipo con arranque dual: "Windows 11 Pro, Ubuntu 22.04")
  const osAttr = byKey.get('os');
  if (osAttr?.catalogId && mapping.attrs.os != null) {
    const raw = get(mapping.attrs.os);
    if (raw) {
      if (osAttr.dataType === 'multiselect') { const ids = await resolveMulti(resolver, osAttr.catalogId, 'os', null, normalizeOs(raw)); if (ids.length) specs.os = ids; }
      else specs.os = await resolver.fuzzy(osAttr.catalogId, 'os', null, normalizeOs(raw));
    }
  }

  // ---- Estado de batería ----
  const battCondAttr = byKey.get('battery_condition');
  if (battCondAttr?.catalogId && mapping.attrs.battery_condition != null) {
    const raw = get(mapping.attrs.battery_condition);
    if (raw) {
      if (battCondAttr.dataType === 'multiselect') { const ids = await resolveMulti(resolver, battCondAttr.catalogId, 'battery_condition', null, raw); if (ids.length) specs.battery_condition = ids; }
      else specs.battery_condition = await resolver.fuzzy(battCondAttr.catalogId, 'battery_condition', null, raw);
    }
  }

  // ---- Pantalla táctil / incluye cargador (booleanos) ----
  for (const key of ['touch_screen', 'has_charger'] as const) {
    const attr = byKey.get(key);
    if (attr && mapping.attrs[key] != null) {
      const raw = get(mapping.attrs[key]);
      if (raw) specs[key] = !FALSE_WORDS.test(raw);
    }
  }

  // ---- Salud de batería (número) ----
  const battHealthAttr = byKey.get('battery_health');
  if (battHealthAttr && mapping.attrs.battery_health != null) {
    const raw = get(mapping.attrs.battery_health);
    const m = raw ? /(\d+(?:\.\d+)?)/.exec(raw) : null;
    if (m) specs.battery_health = parseFloat(m[1]);
  }

  // ---- El resto de los atributos configurados que no tienen un manejo especial arriba ----
  // (a los de arriba —marca, modelo, procesador, generación, disco, RAM, pantalla, SO, batería— no hay que
  // volver a tocarlos aquí ni siquiera cuando su bloque no encontró nada que guardar, p. ej. "NO RAM": si se
  // reintentaran acá como si fueran un atributo cualquiera, el fuzzy-match los tomaría como texto libre y
  // crearía un valor de catálogo inventado a partir de esa palabra.)
  const handledElsewhere = new Set(['brand', 'model', 'processor', 'generation', 'storage_type', 'storage_size', 'ram', 'screen_size', 'os', 'battery_condition']);
  for (const a of attrs) {
    if (handledElsewhere.has(a.key) || specs[a.key] !== undefined) continue;
    const col = mapping.attrs[a.key];
    if (col == null) continue;
    const raw = get(col);
    if (!raw) continue;
    if (a.dataType === 'text') specs[a.key] = raw;
    // Atributo de catálogo propio (no es ninguno de los de arriba) con "Lista (varios valores)": misma separación por comas.
    else if (a.dataType === 'multiselect' && a.catalogId) { const ids = await resolveMulti(resolver, a.catalogId, a.key, null, raw); if (ids.length) specs[a.key] = ids; }
    else if (a.dataType === 'select' && a.catalogId) specs[a.key] = await resolver.fuzzy(a.catalogId, a.key, null, raw);
  }

  return specs;
}

export function buildNotes(headers: string[], mapping: ImportMapping, row: string[]): string | null {
  const get = (col: number | null | undefined): string => (col === null || col === undefined ? '' : cell(row[col] ?? ''));
  const parts: string[] = [];
  const ref = get(mapping.referenceCol);
  if (ref) parts.push(`Ref: ${ref}`);
  for (const col of mapping.extraCols) {
    const v = get(col);
    if (v) parts.push(`${headers[col] ?? `Col. ${col + 1}`}: ${v}`);
  }
  const notes = get(mapping.notesCol);
  if (notes) parts.push(notes);
  return parts.length ? parts.join(' | ').slice(0, 1000) : null;
}

export const cleanSerial = (s: string): string | null => { const v = cell(s); return v ? v.slice(0, 100) : null; };

/**
 * Separa un valor compuesto en sus partes, para atributos "Lista (varios valores)" que admiten más de un componente
 * igual en el mismo equipo (p. ej. una celda "SSD 256GB, HDD 1TB" para un equipo con dos discos). Si el valor no
 * tiene ningún separador (el caso normal, de un solo componente) devuelve un único elemento con el texto completo,
 * así que aplicarlo a un atributo de un solo valor no cambia nada.
 */
export function splitMulti(raw: string): string[] {
  return raw.split(/\s*(?:,|\/|\+|;| y | and )\s*/i).map((s) => s.trim()).filter(Boolean);
}

/**
 * Resuelve el valor de un atributo de catálogo (select) a partir de una celda del CSV, respetando si el atributo
 * admite un solo valor o varios ("Lista (varios valores)"): con varios, separa la celda en partes y resuelve cada
 * una por su cuenta (p. ej. tipo y capacidad de cada disco, en el mismo orden) en vez de tratar la celda entera
 * como un solo valor.
 */
async function resolveMulti(
  resolver: Resolver, catalogId: number, attrKey: string, parentItemId: number | null, raw: string,
): Promise<number[]> {
  const ids: number[] = [];
  // No se eliminan duplicados: dos discos del mismo tamaño ("256GB SSD, 256GB SSD") deben quedar como dos valores.
  for (const part of splitMulti(raw)) ids.push(await resolver.fuzzy(catalogId, attrKey, parentItemId, part));
  return ids;
}

/**
 * Cuenta cuántas de las columnas usadas en el mapeo tienen de verdad algo escrito en esta fila. Un renglón sobrante
 * al final de la hoja de cálculo (común en exportaciones de Excel) puede traer basura suelta en una sola celda
 * (una comilla, una barra) sin ser un equipo real: por eso no alcanza con mirar si "algo" quedó, hace falta que
 * haya más de un dato.
 */
export function countFilledMappedCells(mapping: ImportMapping, row: string[]): number {
  const cols = new Set<number>();
  if (mapping.serialCol !== null) cols.add(mapping.serialCol);
  if (mapping.referenceCol !== null) cols.add(mapping.referenceCol);
  if (mapping.notesCol !== null) cols.add(mapping.notesCol);
  for (const c of mapping.extraCols) cols.add(c);
  for (const c of Object.values(mapping.attrs)) if (c !== null && c !== undefined) cols.add(c);
  let n = 0;
  for (const c of cols) if (cell(row[c] ?? '')) n++;
  return n;
}

/**
 * Ejecuta toda la importación: crea el lote contenedor y da de alta un equipo por fila. Cada fila corre en su
 * propio SAVEPOINT: si una fila falla (dato inválido, serie repetida...) se revierte solo esa fila y se sigue
 * con las demás, sin perder el resto de la importación.
 *
 * `verifyOnTest`: por defecto los equipos quedan directo como "disponibles" (sin testeo), igual que la venta de
 * un lote completo. Si se activa, en cambio, cada equipo entra a testeo (igual que un lote normal) y se guarda
 * una foto de lo que decía el archivo (serie y datos técnicos) en `unit_import_snapshots`, para poder comparar
 * después contra lo que el técnico confirme al terminar el testeo (ver los campos de reporte "Verificación de
 * importación" del conjunto de datos "Equipos" y "Lotes").
 */
export async function performImport(c: Ctx, opts: {
  equipmentTypeId: number; headers: string[]; dataRows: string[][]; mapping: ImportMapping; lotReference: string | null;
  verifyOnTest?: boolean;
}): Promise<ImportOutcome> {
  const type = await c.db.opt<{ is_active: boolean }>('SELECT is_active FROM equipment_types WHERE id = $1', [opts.equipmentTypeId]);
  if (!type || !type.is_active) throw badRequest('invalid_equipment_type');
  const attrs = await loadTypeAttrs(c.db, opts.equipmentTypeId);
  const resolver = new Resolver(c.db, c.companyId);
  const verifyOnTest = opts.verifyOnTest ?? false;

  const settings = await getSettings(c.db, c.companyId);
  const today = new Date();
  const lotCode = await nextLotCode(c.db, settings, today);
  const lotStatus = await sysItemId(c.db, 'lot_status', 'counted');
  const company = await c.db.one<{ currency: string }>('SELECT currency FROM companies WHERE id = $1', [c.companyId]);
  const lot = await c.db.one<{ id: number }>(
    `INSERT INTO lots (company_id, code, status_id, purchase_date, reference, currency, requires_testing, counted_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8) RETURNING id`,
    [c.companyId, lotCode, lotStatus, today.toISOString().slice(0, 10), opts.lotReference, company.currency, verifyOnTest, c.userId]);

  const results: ImportRowResult[] = [];
  let created = 0;
  for (let i = 0; i < opts.dataRows.length; i++) {
    const row = opts.dataRows[i];
    await c.db.query('SAVEPOINT import_row');
    try {
      if (countFilledMappedCells(opts.mapping, row) <= 1) {
        await c.db.query('RELEASE SAVEPOINT import_row');
        results.push({ rowIndex: i, ok: false, reason: 'empty_row' });
        continue;
      }
      const specs = await resolveRowSpecs(resolver, attrs, opts.mapping, row);
      const normSpecs = await normalizeSpecs(c.db, opts.equipmentTypeId, specs, 'draft', { attrs });
      const serialRaw = opts.mapping.serialCol === null ? '' : (row[opts.mapping.serialCol] ?? '');
      const serial = cleanSerial(serialRaw);
      const notes = buildNotes(opts.headers, opts.mapping, row);
      if (serial) {
        const dup = await c.db.opt<{ code: string }>('SELECT code FROM units WHERE lower(serial_number) = lower($1)', [serial]);
        if (dup) throw new AppError(409, 'serial_duplicate', { code: dup.code });
      }
      const u = await insertUnit(c, {
        lotId: lot.id, lotCode, lineId: null, equipmentTypeId: opts.equipmentTypeId, specs: normSpecs, serial, notes, available: !verifyOnTest,
      });
      if (verifyOnTest) {
        await c.db.query(
          `INSERT INTO unit_import_snapshots (company_id, unit_id, lot_id, serial_number, specs, notes) VALUES ($1,$2,$3,$4,$5,$6)`,
          [c.companyId, u.id, lot.id, serial, JSON.stringify(normSpecs), notes]);
      }
      await c.db.query('RELEASE SAVEPOINT import_row');
      created++;
      results.push({ rowIndex: i, ok: true, unitCode: u.code, serial, specs: normSpecs, notes });
    } catch (e) {
      await c.db.query('ROLLBACK TO SAVEPOINT import_row');
      const reason = e instanceof AppError ? e.code : 'row_error';
      results.push({ rowIndex: i, ok: false, reason });
    }
  }

  await c.audit('lot.imported', 'lot', lot.id, { code: lotCode, equipmentTypeId: opts.equipmentTypeId, created, skipped: results.length - created, verifyOnTest });
  return { lotId: lot.id, lotCode, created, skipped: results.length - created, results, newCatalogItems: resolver.created };
}
