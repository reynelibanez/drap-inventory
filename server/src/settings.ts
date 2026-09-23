import { z } from 'zod';
import type { Db } from './db.js';
import { badRequest } from './errors.js';

/** Ajustes por empresa. En la base solo se guardan los cambios; lo demás usa estos valores. */
export const DEFAULT_SETTINGS = {
  /** Tokens: {lot} código del lote, {tech} número de técnico, {seq} registro del técnico. */
  unitCodeFormat: '{lot}-{tech}t{seq}',
  /** Tokens: {yy} {yyyy} {mm} y {nn} (consecutivo del mes; más "n" = más ceros: {nnnn}). */
  lotCodeFormat: 'L{yy}{mm}{nn}',
  orderCodeFormat: 'V{yy}{mm}-{nnnn}',
  /** Activos de la empresa (herramientas y equipos propios): {nnnn} consecutivo, o {yy}{mm} si se quiere. */
  assetCodeFormat: 'A-{nnnn}',
  /** Días que dura una reserva antes de liberarse sola (null = no vence). */
  reservationDays: null as number | null,
  /** Al terminar el testeo, el equipo se ubica solo en el espacio que le corresponde según las reglas. */
  autoPlaceOnTest: true,
  /** Pesos de la ubicación inteligente (mayor = más importante). */
  placement: {
    sameModel: 100,
    sameBrand: 60,
    sameType: 30,
    sameGrade: 15,
    preferredArea: 25,
    emptySlot: 5,
    /** Prefiere llenar espacios ya empezados antes que abrir uno vacío. */
    fillStarted: 10,
  },
};

export type Settings = typeof DEFAULT_SETTINGS;

export const settingsPatchSchema = z.object({
  unitCodeFormat: z.string().min(3).max(60).refine((s) => s.includes('{tech}') && s.includes('{seq}'), 'unit_code_needs_tech_seq').optional(),
  lotCodeFormat: z.string().min(3).max(60).refine((s) => /\{n+\}/.test(s), 'code_needs_counter').optional(),
  orderCodeFormat: z.string().min(3).max(60).refine((s) => /\{n+\}/.test(s), 'code_needs_counter').optional(),
  assetCodeFormat: z.string().min(3).max(60).refine((s) => /\{n+\}/.test(s), 'code_needs_counter').optional(),
  reservationDays: z.number().int().min(1).max(365).nullable().optional(),
  autoPlaceOnTest: z.boolean().optional(),
  placement: z.object({
    sameModel: z.number().min(0).max(1000),
    sameBrand: z.number().min(0).max(1000),
    sameType: z.number().min(0).max(1000),
    sameGrade: z.number().min(0).max(1000),
    preferredArea: z.number().min(0).max(1000),
    emptySlot: z.number().min(0).max(1000),
    fillStarted: z.number().min(0).max(1000),
  }).partial().optional(),
}).strict();

export async function getSettings(db: Db, companyId: number): Promise<Settings> {
  const row = await db.one<{ settings: Partial<Settings> }>('SELECT settings FROM companies WHERE id = $1', [companyId]);
  const s = row.settings ?? {};
  return { ...DEFAULT_SETTINGS, ...s, placement: { ...DEFAULT_SETTINGS.placement, ...(s.placement ?? {}) } };
}

/** Rellena una plantilla de código. */
export function renderCode(format: string, vars: { lot?: string; tech?: number; seq?: number; n?: number; date?: Date }): string {
  const d = vars.date ?? new Date();
  const yyyy = String(d.getUTCFullYear());
  return format.replace(/\{(yyyy|yy|mm|lot|tech|seq|n+)\}/g, (_m, tok: string) => {
    switch (tok) {
      case 'yyyy': return yyyy;
      case 'yy': return yyyy.slice(2);
      case 'mm': return String(d.getUTCMonth() + 1).padStart(2, '0');
      case 'lot': return vars.lot ?? '';
      case 'tech': return String(vars.tech ?? '');
      case 'seq': return String(vars.seq ?? '');
      default: return String(vars.n ?? 0).padStart(tok.length, '0'); // {nn}, {nnnn}
    }
  });
}

/** Siguiente código de lote (consecutivo por empresa y por mes). Debe llamarse dentro de una transacción. */
export async function nextLotCode(db: Db, s: Settings, date: Date): Promise<string> {
  const ym = `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  const { value } = await db.one<{ value: number }>('SELECT next_seq($1) AS value', [`lot:${ym}`]);
  return renderCode(s.lotCodeFormat, { n: value, date });
}

export async function nextOrderCode(db: Db, s: Settings, date: Date): Promise<string> {
  const ym = `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  const { value } = await db.one<{ value: number }>('SELECT next_seq($1) AS value', [`order:${ym}`]);
  return renderCode(s.orderCodeFormat, { n: value, date });
}

/** Código de un activo de la empresa (consecutivo único por empresa, no reinicia). */
export async function nextAssetCode(db: Db, s: Settings): Promise<string> {
  const { value } = await db.one<{ value: number }>('SELECT next_seq($1) AS value', ['asset']);
  return renderCode(s.assetCodeFormat, { n: value });
}

/** Código de unidad: registro propio del técnico (no reinicia por lote). */
export async function nextUnitCode(db: Db, s: Settings, lotCode: string, techNumber: number): Promise<{ code: string; seq: number }> {
  const { value } = await db.one<{ value: number }>('SELECT next_seq($1) AS value', [`tech:${techNumber}`]);
  return { code: renderCode(s.unitCodeFormat, { lot: lotCode, tech: techNumber, seq: value }), seq: value };
}

export function assertValidPatch(patch: unknown) {
  const r = settingsPatchSchema.safeParse(patch);
  if (!r.success) throw badRequest('validation', { issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  return r.data;
}
