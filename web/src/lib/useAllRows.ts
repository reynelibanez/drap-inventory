import { useQuery } from '@tanstack/react-query';
import { api, qs } from './api';

/** Trae TODAS las filas de un listado paginado (el grid filtra, ordena y pagina en el navegador). */
export async function fetchAll<T>(path: string, params: Record<string, unknown> = {}, chunk = 2000, maxRows = 60000): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; ; page++) {
    const r = await api.get<{ items: T[]; total: number }>(`${path}${qs({ ...params, page, pageSize: chunk })}`);
    out.push(...r.items);
    if (r.items.length < chunk || out.length >= r.total || out.length >= maxRows) break;
  }
  return out;
}

export function useAllRows<T>(key: readonly unknown[], path: string, params: Record<string, unknown> = {}, enabled = true) {
  return useQuery({ queryKey: [...key, 'all', params], queryFn: () => fetchAll<T>(path, params), enabled });
}
