/** Tipos de columna, operadores de filtro y evaluación de filtros del grid (todo en el navegador). */

export type ColType = 'text' | 'number' | 'money' | 'date' | 'datetime' | 'boolean' | 'select' | 'multi';
export type Op =
  | 'contains' | 'notContains' | 'startsWith' | 'endsWith' | 'eq' | 'ne' | 'gt' | 'ge' | 'lt' | 'le' | 'between'
  | 'empty' | 'notEmpty' | 'in' | 'notIn' | 'hasAny' | 'hasAll' | 'is';

export interface Filter { op: Op; a?: string; b?: string; list?: string[] }
export type Raw = string | number | boolean | Date | null | undefined | (string | number)[];

/** Operadores disponibles según el tipo de dato de la columna (filtros dinámicos). */
export const OPS: Record<ColType, Op[]> = {
  text: ['contains', 'notContains', 'startsWith', 'endsWith', 'eq', 'ne', 'empty', 'notEmpty'],
  number: ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'between', 'empty', 'notEmpty'],
  money: ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'between', 'empty', 'notEmpty'],
  date: ['eq', 'ne', 'lt', 'gt', 'le', 'ge', 'between', 'empty', 'notEmpty'],
  datetime: ['eq', 'ne', 'lt', 'gt', 'le', 'ge', 'between', 'empty', 'notEmpty'],
  boolean: ['is'],
  select: ['in', 'notIn', 'empty', 'notEmpty'],
  multi: ['hasAny', 'hasAll', 'empty', 'notEmpty'],
};
export const defaultOp = (t: ColType): Op => OPS[t][0]!;
export const OP_GLYPH: Record<Op, string> = {
  contains: '⊃', notContains: '⊅', startsWith: 'a…', endsWith: '…z', eq: '=', ne: '≠', gt: '>', ge: '≥', lt: '<', le: '≤', between: '↔',
  empty: '∅', notEmpty: '●', in: '∈', notIn: '∉', hasAny: '∈', hasAll: '⊇', is: '=',
};
export const isDateType = (t: ColType) => t === 'date' || t === 'datetime';

export const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function isEmptyVal(v: Raw): boolean {
  return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
}

export const toNum = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

const p2 = (n: number) => String(n).padStart(2, '0');
/** Día local yyyy-mm-dd de una fecha (o texto ISO). */
export function dayKey(v: Raw): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string' && v.length === 10) return v;
  const d = v instanceof Date ? v : new Date(v as string);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

export function toDate(v: Raw): Date | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const s = String(v);
  const d = new Date(s.length === 10 ? `${s}T00:00:00` : s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function isActive(type: ColType, f: Filter | undefined): boolean {
  if (!f) return false;
  if (f.op === 'empty' || f.op === 'notEmpty') return true;
  if (type === 'select' || type === 'multi') return !!f.list?.length;
  if (type === 'boolean') return !!f.a;
  return !!(f.a || f.b);
}

export function matches(type: ColType, f: Filter, v: Raw): boolean {
  if (f.op === 'empty') return isEmptyVal(v);
  if (f.op === 'notEmpty') return !isEmptyVal(v);
  switch (type) {
    case 'text': {
      const q = norm(f.a ?? '');
      if (!q) return true;
      const s = norm(String(v ?? ''));
      switch (f.op) {
        case 'contains': return s.includes(q);
        case 'notContains': return !s.includes(q);
        case 'startsWith': return s.startsWith(q);
        case 'endsWith': return s.endsWith(q);
        case 'eq': return s === q;
        case 'ne': return s !== q;
      }
      return true;
    }
    case 'number': case 'money': {
      const n = toNum(v);
      const a = toNum(f.a), b = toNum(f.b);
      if (n === null) return f.op === 'ne';
      switch (f.op) {
        case 'eq': return a === null || n === a;
        case 'ne': return a === null || n !== a;
        case 'gt': return a === null || n > a;
        case 'ge': return a === null || n >= a;
        case 'lt': return a === null || n < a;
        case 'le': return a === null || n <= a;
        case 'between': return (a === null || n >= a) && (b === null || n <= b);
      }
      return true;
    }
    case 'date': case 'datetime': {
      const d = dayKey(v);
      const a = f.a || null, b = f.b || null;
      if (d === null) return f.op === 'ne';
      switch (f.op) {
        case 'eq': return a === null || d === a;
        case 'ne': return a === null || d !== a;
        case 'gt': return a === null || d > a;
        case 'ge': return a === null || d >= a;
        case 'lt': return a === null || d < a;
        case 'le': return a === null || d <= a;
        case 'between': return (a === null || d >= a) && (b === null || d <= b);
      }
      return true;
    }
    case 'boolean':
      if (!f.a) return true;
      return f.a === 'true' ? v === true : !v;
    case 'select': {
      const list = f.list ?? [];
      if (!list.length) return true;
      const has = !isEmptyVal(v) && list.includes(String(v));
      return f.op === 'notIn' ? !has : has;
    }
    case 'multi': {
      const list = f.list ?? [];
      if (!list.length) return true;
      const arr = (Array.isArray(v) ? v : []).map(String);
      return f.op === 'hasAll' ? list.every((x) => arr.includes(x)) : list.some((x) => arr.includes(x));
    }
  }
}
