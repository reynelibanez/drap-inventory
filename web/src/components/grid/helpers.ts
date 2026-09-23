import { useMemo } from 'react';
import { useMeta } from '../../lib/meta';
import type { Opt } from './FilterCell';

/** Opciones de un catálogo (estados, grados...) para columnas select. */
export function useCatalogOpts(catalog: string, withCode = false): Opt[] {
  const meta = useMeta();
  return useMemo(() => meta.catalogOptions(catalog, true).map((i) => ({ value: String(i.id), label: withCode ? meta.nameWithCode(i.id) : meta.name(i.id) })), [meta, catalog, withCode]);
}
export function useTypeOpts(): Opt[] {
  const meta = useMeta();
  return useMemo(() => meta.typeList(true).map((t) => ({ value: String(t.id), label: meta.label(t.name) })), [meta]);
}
