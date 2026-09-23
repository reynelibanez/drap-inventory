import { useMemo } from 'react';
import { DataGrid, type GridColumn } from '../../components/grid/DataGrid';
import type { RunResult } from './reportTypes';

const sig = (s: string) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };

/**
 * Resultado de un reporte en el grid del sistema: el usuario puede reordenar columnas, filtrar por columna
 * (los filtros se adaptan al tipo de dato) y exportar tal como lo ve.
 */
export function ResultGrid({ id, result, title, loading, emptyTitle }: { id: string; result: RunResult | undefined; title: string; loading?: boolean; emptyTitle?: string }) {
  const rows = useMemo(() => (result?.rows ?? []).map((r, i) => {
    const o: Record<string, any> = { __i: i };
    r.forEach((v, j) => { o[`c${j}`] = v; });
    return o;
  }), [result]);
  const columns = useMemo<GridColumn<any>[]>(() => (result?.columns ?? []).map((c, j) => ({
    key: `c${j}`, title: c.label, type: c.type, width: c.type === 'text' || c.type === 'select' ? 180 : undefined,
  })), [result]);
  // El diseño guardado del grid depende de las columnas del reporte: si cambian, se parte de cero.
  const layoutId = `${id}-${sig((result?.columns ?? []).map((c) => c.key + c.label).join('|'))}`;
  return <DataGrid id={layoutId} rows={rows} columns={columns} rowId={(r) => r.__i} loading={loading} exportName={title} exportTitle={title} emptyTitle={emptyTitle} />;
}
