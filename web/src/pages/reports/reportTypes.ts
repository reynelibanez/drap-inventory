import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';

export type FType = 'text' | 'number' | 'money' | 'date' | 'datetime' | 'boolean' | 'select';
export type Agg = 'count' | 'countDistinct' | 'sum' | 'avg' | 'min' | 'max';

export interface MetaField { key: string; label: string; type: FType; group: string; options?: { value: string; label: string }[] }
export interface MetaDataset { key: string; label: string; fields: MetaField[] }
export interface ReportsMeta { datasets: MetaDataset[]; ops: Record<FType, string[]>; canShare: boolean; canCreate: boolean }

export interface ReportDef {
  mode: 'detail' | 'summary';
  columns: { field: string; label?: string; agg?: Agg }[];
  filters: { field: string; op: string; a?: string; b?: string; list?: string[] }[];
  sort: { col: number; dir: 'asc' | 'desc' }[];
  limit?: number;
}

export interface ReportItem {
  id: number; name: string; description: string | null; dataset: string; visibility: 'private' | 'company'; systemKey: string | null;
  mode: 'detail' | 'summary'; columnCount: number; mine: boolean; ownerName: string | null; updatedAt: string; canEdit: boolean;
}
export interface ReportFull extends ReportItem { definition: ReportDef; ownerId: number | null }

export interface ResultCol { key: string; label: string; type: FType; agg?: Agg }
export interface RunResult { columns: ResultCol[]; rows: any[][]; truncated: boolean; limit: number }

export const useLang = () => (useTranslation().i18n.language ?? 'es').slice(0, 2) === 'en' ? 'en' : 'es';

export const useReportsMeta = () => {
  const lang = useLang();
  return useQuery({ queryKey: ['reports-meta', lang], queryFn: () => api.get<ReportsMeta>(`/reports/meta?lang=${lang}`), staleTime: 60_000 });
};

/** Cálculos que tienen sentido según el tipo de dato de la columna. */
export const AGGS_FOR: Record<FType, Agg[]> = {
  number: ['sum', 'avg', 'min', 'max', 'count', 'countDistinct'],
  money: ['sum', 'avg', 'min', 'max', 'count', 'countDistinct'],
  date: ['min', 'max', 'count', 'countDistinct'],
  datetime: ['min', 'max', 'count', 'countDistinct'],
  text: ['count', 'countDistinct', 'min', 'max'],
  select: ['count', 'countDistinct', 'min', 'max'],
  boolean: ['count'],
};

/** Nombre / descripción de un reporte de fábrica en el idioma actual (los demás usan el texto guardado). */
export function useReportText() {
  const { t } = useTranslation();
  return {
    name: (r: { name: string; systemKey: string | null }) => (r.systemKey ? t(`reportsSys.${r.systemKey}.name`, { defaultValue: r.name }) : r.name),
    desc: (r: { description: string | null; systemKey: string | null }) => (r.systemKey ? t(`reportsSys.${r.systemKey}.desc`, { defaultValue: r.description ?? '' }) : r.description ?? ''),
  };
}
