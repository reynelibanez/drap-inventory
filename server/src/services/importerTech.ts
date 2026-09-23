import type { Ctx } from '../http.js';
import type { Db } from '../db.js';
import { AppError, badRequest } from '../errors.js';
import { getSettings, nextLotCode } from '../settings.js';
import { sysItemId } from './common.js';
import { insertUnit } from '../modules/units.js';
import { loadTypeAttrs, normalizeSpecs, type AttrConf } from './specs.js';
import {
  Resolver, type ImportMapping, type NewCatalogItem,
  cell, cleanSerial, parseStorage, normalizeOs, resolveRowSpecs,
} from './importer.js';

// ---------------------------------------------------------------------------------------------------------------------
// Importación independiente para la plantilla de "control técnico" (la que usan los técnicos como Reynel): a diferencia
// de la importación genérica (donde el usuario mapea columnas a mano y todo el archivo es de un solo tipo de equipo),
// acá las columnas son siempre las mismas (se ubican por su encabezado) y cada fila puede ser un tipo de equipo distinto
// (laptop, micro, PC SFF...), leído de su propia columna. Además el archivo trae varios lotes físicos distintos
// mezclados en una sola hoja (columna LOTE): esta importación crea un lote del sistema por cada uno.
// ---------------------------------------------------------------------------------------------------------------------

interface TechColumns {
  date: number; tech: number; lote: number; ref: number; serial: number; brand: number; model: number; type: number;
  processor: number; ram: number; hdd: number; diskType: number; lcdSize: number; cosmetic: number; notes: number; notes2: number;
  barcode: number; size: number; win: number; functionalGrade: number; touch: number;
}

const normHeader = (s: string): string => s.trim().toUpperCase().replace(/\s+/g, ' ');

/** Busca una columna por su encabezado exacto (ya normalizado). -1 si no está. */
function findCol(headers: string[], ...names: string[]): number {
  const norm = headers.map(normHeader);
  for (const name of names) {
    const i = norm.indexOf(name);
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * Ubica las columnas fijas de esta plantilla por su nombre de encabezado. La columna de "tipo de equipo" no tiene
 * encabezado (queda en blanco en el archivo real): se ubica por convención, justo después de la columna "Model".
 * Si el archivo no tiene la forma esperada (encabezados clave ausentes, o no se puede ubicar la columna de tipo),
 * se avisa con un error claro en vez de importar cualquier cosa mal interpretada.
 */
export function resolveTechColumns(headers: string[]): TechColumns {
  const modelCol = findCol(headers, 'MODEL');
  let typeCol = -1;
  if (modelCol >= 0 && modelCol + 1 < headers.length && normHeader(headers[modelCol + 1]) === '') typeCol = modelCol + 1;

  const cols: TechColumns = {
    date: findCol(headers, 'DATE', 'FECHA'),
    tech: findCol(headers, 'TECH', 'TECNICO'),
    lote: findCol(headers, 'LOTE'),
    ref: findCol(headers, 'REF'),
    serial: findCol(headers, 'SERIAL'),
    brand: findCol(headers, 'BRAND', 'MARCA'),
    model: modelCol,
    type: typeCol,
    processor: findCol(headers, 'PROCESSOR', 'PROCESADOR'),
    ram: findCol(headers, 'RAM'),
    hdd: findCol(headers, 'HDD', 'DISK'),
    diskType: findCol(headers, 'TIPO DISK', 'TIPO DISCO'),
    lcdSize: findCol(headers, 'LCD SIZE'),
    cosmetic: findCol(headers, 'COSMETIC', 'COSMETICO'),
    notes: findCol(headers, 'NOTES', 'NOTAS'),
    notes2: findCol(headers, 'NOTE 2', 'NOTA 2'),
    barcode: findCol(headers, 'BAR CODE', 'CODIGO DE BARRA'),
    size: findCol(headers, 'SIZE', 'TAMANO'),
    win: findCol(headers, 'WIN'),
    functionalGrade: findCol(headers, 'FUNCTIONAL GRADE', 'GRADO FUNCIONAL'),
    touch: findCol(headers, 'TOUCH', 'TACTIL'),
  };

  const required: [keyof TechColumns, string][] = [
    ['lote', 'LOTE'], ['serial', 'SERIAL'], ['brand', 'BRAND'], ['model', 'Model'], ['type', 'columna de tipo de equipo (después de Model)'],
    ['processor', 'Processor'], ['ram', 'RAM'], ['hdd', 'HDD'], ['diskType', 'TIPO DISK'], ['cosmetic', 'COSMETIC'], ['functionalGrade', 'FUNCTIONAL GRADE'],
  ];
  const missing = required.filter(([k]) => cols[k] < 0).map(([, label]) => label);
  if (missing.length) throw badRequest('tech_import_unrecognized_format', { missing });
  return cols;
}

/** Tipo de equipo (+ factor de forma, si aplica) según el valor de la columna de tipo. No reconocido/vacío → Genérico. */
const TYPE_MAP: Record<string, { typeKey: 'laptop' | 'desktop'; formFactor?: string }> = {
  LAPTOP: { typeKey: 'laptop' },
  MICRO: { typeKey: 'desktop', formFactor: 'Micro' },
  'MICRO PC': { typeKey: 'desktop', formFactor: 'Micro' },
  'PC SFF': { typeKey: 'desktop', formFactor: 'SFF (formato reducido)' },
  SFF: { typeKey: 'desktop', formFactor: 'SFF (formato reducido)' },
  TOWER: { typeKey: 'desktop', formFactor: 'Torre' },
  MT: { typeKey: 'desktop', formFactor: 'Torre' },
  AIO: { typeKey: 'desktop', formFactor: 'Todo en uno' },
  'ALL IN ONE': { typeKey: 'desktop', formFactor: 'Todo en uno' },
};

/** "SN"/"S N" sueltas (muy comunes en filas de accesorios sin serie real): se tratan como sin dato, además de lo que ya cubre `cleanSerial`. */
function cleanSerialTech(raw: string): string | null {
  const s = cleanSerial(raw);
  return s && /^s\s*\/?\s*n$/i.test(s) ? null : s;
}

function parseUsDate(raw: string): Date | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw.trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2])));
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface TechImportRowResult {
  rowIndex: number; ok: boolean; unitCode?: string; serial?: string | null; specs?: Record<string, unknown>; notes?: string | null;
  reason?: string; lotCode?: string; equipmentTypeKey?: string;
}
export interface TechLotOutcome { lotId: number; lotCode: string; lote: string; reference: string | null; created: number; skipped: number }
export interface TechImportOutcome {
  lots: TechLotOutcome[]; created: number; skipped: number; results: TechImportRowResult[]; newCatalogItems: NewCatalogItem[];
  /** Filas con un grado (cosmético o funcional) que traía un valor que no coincide con ningún código válido: no bloquea, queda sin grado y anotado en las notas del equipo. */
  gradeWarnings: number;
}

async function catalogIdByKey(db: Db, key: string): Promise<number | null> {
  return (await db.opt<{ id: number }>('SELECT id FROM catalogs WHERE key = $1', [key]))?.id ?? null;
}

/** Cuenta cuántas de las columnas "de peso" de esta fila tienen algo escrito: evita dar de alta una fila prácticamente vacía. */
function rowHasData(row: string[], cols: TechColumns): boolean {
  const check = [cols.serial, cols.brand, cols.model, cols.type, cols.processor, cols.ram, cols.hdd, cols.notes, cols.notes2, cols.barcode];
  let n = 0;
  for (const c of check) if (c >= 0 && cell(row[c] ?? '')) n++;
  return n > 1;
}

/**
 * Ejecuta toda la importación de la plantilla de control técnico: agrupa las filas por la columna LOTE (cada valor
 * distinto es un lote nuevo del sistema, con su propia referencia y fecha), y da de alta un equipo por fila, con el
 * tipo que indique su propia columna. Igual que la importación genérica, cada fila corre en su propio SAVEPOINT y
 * vista previa/confirmar comparten el mismo código (revierte con SAVEPOINT al final si es solo vista previa).
 */
export async function performImportTech(c: Ctx, headers: string[], dataRows: string[][]): Promise<TechImportOutcome> {
  const cols = resolveTechColumns(headers);

  const typeRows = await c.db.rows<{ id: number; key: string; is_active: boolean }>(
    `SELECT id, key, is_active FROM equipment_types WHERE key = ANY($1::text[])`, [['laptop', 'desktop', 'generic']]);
  const typesByKey = new Map(typeRows.map((t) => [t.key, t]));
  for (const key of ['laptop', 'desktop', 'generic']) {
    const t = typesByKey.get(key);
    if (!t || !t.is_active) throw badRequest('tech_import_missing_equipment_type', { key });
  }
  const attrsByType = new Map<number, AttrConf[]>();
  for (const t of typeRows) attrsByType.set(t.id, await loadTypeAttrs(c.db, t.id));

  const resolver = new Resolver(c.db, c.companyId);
  const cosmeticGradeCatalogId = await catalogIdByKey(c.db, 'cosmetic_grade');
  const functionalGradeCatalogId = await catalogIdByKey(c.db, 'functional_grade');

  const settings = await getSettings(c.db, c.companyId);
  const company = await c.db.one<{ currency: string }>('SELECT currency FROM companies WHERE id = $1', [c.companyId]);
  const lotStatus = await sysItemId(c.db, 'lot_status', 'counted');
  const today = new Date();

  // ---- Agrupa las filas por LOTE, conservando el orden en que aparecen en el archivo ----
  interface Group { ref: string | null; date: Date | null; rows: { row: string[]; idx: number }[] }
  const groups = new Map<string, Group>();
  const loteOrder: string[] = [];
  dataRows.forEach((row, idx) => {
    const lote = cell(row[cols.lote] ?? '') || `SIN-LOTE-${idx + 1}`;
    let g = groups.get(lote);
    if (!g) { g = { ref: null, date: null, rows: [] }; groups.set(lote, g); loteOrder.push(lote); }
    if (!g.ref) { const r = cell(row[cols.ref] ?? ''); if (r) g.ref = r; }
    if (cols.date >= 0) {
      const d = parseUsDate(cell(row[cols.date] ?? ''));
      if (d && (!g.date || d < g.date)) g.date = d;
    }
    g.rows.push({ row, idx });
  });

  const mapping: ImportMapping = {
    serialCol: null, referenceCol: null, notesCol: null, extraCols: [],
    attrs: {
      brand: cols.brand, model: cols.model,
      processor: cols.processor, generation: cols.processor,
      ram: cols.ram, storage_type: cols.diskType, storage_size: cols.hdd,
      screen_size: cols.lcdSize >= 0 ? cols.lcdSize : cols.size,
      os: cols.win, touch_screen: cols.touch,
    },
  };

  const results: TechImportRowResult[] = [];
  const lots: TechLotOutcome[] = [];
  let totalCreated = 0, totalSkipped = 0, gradeWarnings = 0;

  for (const lote of loteOrder) {
    const g = groups.get(lote)!;
    const lotCode = await nextLotCode(c.db, settings, g.date ?? today);
    const lot = await c.db.one<{ id: number }>(
      `INSERT INTO lots (company_id, code, status_id, purchase_date, reference, currency, requires_testing, counted_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,false,now(),$7) RETURNING id`,
      [c.companyId, lotCode, lotStatus, (g.date ?? today).toISOString().slice(0, 10), g.ref ?? lote, company.currency, c.userId]);

    let created = 0, skipped = 0;
    for (const { row, idx } of g.rows) {
      await c.db.query('SAVEPOINT tech_import_row');
      try {
        if (!rowHasData(row, cols)) {
          await c.db.query('RELEASE SAVEPOINT tech_import_row');
          results.push({ rowIndex: idx, ok: false, reason: 'empty_row', lotCode });
          skipped++; totalSkipped++;
          continue;
        }

        const typeRaw = cell(row[cols.type] ?? '');
        const mapped = TYPE_MAP[typeRaw.toUpperCase()];
        const typeKey = mapped?.typeKey ?? 'generic';
        const type = typesByKey.get(typeKey)!;
        const attrs = attrsByType.get(type.id)!;
        const byKey = new Map(attrs.map((a) => [a.key, a]));

        // Columnas que necesitan un pequeño ajuste antes de reutilizar la resolución genérica de especificaciones:
        // el tipo de disco viene como "NVME"/"SSD"/"HDD" (hay que traducirlo al nombre del catálogo), el tamaño de
        // pantalla puede venir en "LCD SIZE" o en "SIZE" según quién cargó la fila, y el sistema operativo viene
        // abreviado ("WIN 11").
        const workRow = [...row];
        if (cols.diskType >= 0) {
          const raw = cell(row[cols.diskType] ?? '');
          workRow[cols.diskType] = raw ? (parseStorage(raw).typeName ?? '') : '';
        }
        if (cols.lcdSize >= 0) {
          const lcd = cell(row[cols.lcdSize] ?? '');
          const alt = cols.size >= 0 ? cell(row[cols.size] ?? '') : '';
          workRow[cols.lcdSize] = lcd || alt;
        }
        if (cols.win >= 0) {
          const raw = cell(row[cols.win] ?? '');
          workRow[cols.win] = raw ? normalizeOs(raw) : '';
        }

        const specs = await resolveRowSpecs(resolver, attrs, mapping, workRow);

        // Factor de forma (solo escritorio): se resuelve del tipo detectado, no de una columna de texto.
        const formFactorAttr = byKey.get('form_factor');
        if (mapped?.formFactor && formFactorAttr?.catalogId) {
          specs.form_factor = await resolver.fuzzy(formFactorAttr.catalogId, 'form_factor', null, mapped.formFactor);
        }

        // Descripción (solo genérico): NOTES si trae algo, si no marca/modelo, si no un texto por defecto.
        const descAttr = byKey.get('description');
        if (descAttr) {
          const notesRaw = cols.notes >= 0 ? cell(row[cols.notes] ?? '') : '';
          const brandRaw = cols.brand >= 0 ? cell(row[cols.brand] ?? '') : '';
          const modelRaw = cols.model >= 0 ? cell(row[cols.model] ?? '') : '';
          const bm = [brandRaw, modelRaw].filter(Boolean).join(' ');
          specs.description = (notesRaw || bm || 'Equipo importado sin tipo reconocido').slice(0, 300);
        }

        const normSpecs = await normalizeSpecs(c.db, type.id, specs, 'draft', { attrs });

        const serial = cleanSerialTech(row[cols.serial] ?? '');
        if (serial) {
          const dup = await c.db.opt<{ code: string }>('SELECT code FROM units WHERE lower(serial_number) = lower($1)', [serial]);
          if (dup) throw new AppError(409, 'serial_duplicate', { code: dup.code });
        }

        // Grados: coincidencia exacta de código contra los catálogos cerrados de grados; si el valor no coincide con
        // ningún código válido (p. ej. la palabra "COSMETIC" tipeada por error, o una "D" que no es un grado funcional
        // válido) no se inventa ni se bloquea la fila: el equipo queda sin ese grado y se anota en sus notas.
        let cosmeticGradeId: number | null = null;
        let functionalGradeId: number | null = null;
        const gradeNotes: string[] = [];
        if (cols.cosmetic >= 0 && cosmeticGradeCatalogId) {
          const raw = cell(row[cols.cosmetic] ?? '');
          if (raw) {
            cosmeticGradeId = await resolver.exactCode(cosmeticGradeCatalogId, raw);
            if (cosmeticGradeId == null) gradeNotes.push(`Grado cosmético "${raw}" no reconocido`);
          }
        }
        if (cols.functionalGrade >= 0 && functionalGradeCatalogId) {
          const raw = cell(row[cols.functionalGrade] ?? '');
          if (raw) {
            functionalGradeId = await resolver.exactCode(functionalGradeCatalogId, raw);
            if (functionalGradeId == null) gradeNotes.push(`Grado funcional "${raw}" no reconocido`);
          }
        }
        if (gradeNotes.length) gradeWarnings++;

        const typeWarning = typeRaw && !mapped ? [`Tipo "${typeRaw}" no reconocido: importado como Genérico`] : [];

        const noteParts: string[] = [];
        if (cols.barcode >= 0) { const v = cell(row[cols.barcode] ?? ''); if (v) noteParts.push(`Cód.: ${v}`); }
        if (cols.notes >= 0) { const v = cell(row[cols.notes] ?? ''); if (v) noteParts.push(v); }
        if (cols.notes2 >= 0) { const v = cell(row[cols.notes2] ?? ''); if (v) noteParts.push(v); }
        noteParts.push(...typeWarning, ...gradeNotes);
        const notes = noteParts.length ? noteParts.join(' | ').slice(0, 1000) : null;

        const u = await insertUnit(c, {
          lotId: lot.id, lotCode, lineId: null, equipmentTypeId: type.id, specs: normSpecs, serial, notes, available: true,
          cosmeticGradeId, functionalGradeId,
        });
        await c.db.query('RELEASE SAVEPOINT tech_import_row');
        created++; totalCreated++;
        results.push({ rowIndex: idx, ok: true, unitCode: u.code, serial, specs: normSpecs, notes, lotCode, equipmentTypeKey: typeKey });
      } catch (e) {
        await c.db.query('ROLLBACK TO SAVEPOINT tech_import_row');
        const reason = e instanceof AppError ? e.code : 'row_error';
        results.push({ rowIndex: idx, ok: false, reason, lotCode });
        skipped++; totalSkipped++;
      }
    }

    await c.audit('lot.imported', 'lot', lot.id, { code: lotCode, source: 'tech_csv', lote, created, skipped });
    lots.push({ lotId: lot.id, lotCode, lote, reference: g.ref ?? lote, created, skipped });
  }

  results.sort((a, b) => a.rowIndex - b.rowIndex);
  return { lots, created: totalCreated, skipped: totalSkipped, results, newCatalogItems: resolver.created, gradeWarnings };
}
