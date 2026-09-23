import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowDown, ArrowUp, Check, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Columns3, Download, FileSpreadsheet, FileText, FilterX, ListFilter, Printer, RotateCcw, Search, X,
} from 'lucide-react';
import { Button, Empty, Spinner } from '../ui';
import { useFmt } from '../../lib/useFmt';
import { useIsMobile } from '../../lib/useIsMobile';
import { MobileGrid } from '../mobile/MobileGrid';
import { FilterCell, type Opt } from './FilterCell';
import { Popover } from './Popover';
import { dayKey, isActive, isEmptyVal, matches, norm, toDate, toNum, type ColType, type Filter, type Raw } from './filters';
import { toDoc } from '../../lib/docTrace';
import { runExport, safeFileName, stamp, type Cell, type ExportKind, type ExportTable } from './exporters';

export type { ColType, Filter, Raw } from './filters';
export type { Opt } from './FilterCell';

export interface GridColumn<T> {
  key: string;
  title: string;
  type?: ColType;
  /** Valor "crudo" de la celda (para ordenar, filtrar y exportar). Por defecto row[key]. */
  value?: (r: T) => Raw;
  /** Lista de valores para columnas select / multi (si falta, se toma de los datos). */
  options?: Opt[];
  /** Contenido visual de la celda (por defecto se formatea según el tipo). */
  render?: (r: T) => ReactNode;
  /** Valor exportado si difiere del valor crudo. */
  exportValue?: (r: T) => Cell;
  width?: number;
  hidden?: boolean;
  align?: 'left' | 'right' | 'center';
  noSort?: boolean; noFilter?: boolean; noExport?: boolean; noHide?: boolean;
  /** Columna de acciones: siempre al final, sin filtro, orden ni exportación. */
  actions?: boolean;
  /**
   * Cómo se muestra en la tarjeta del teléfono: título (por defecto la primera columna visible), estado (chip arriba a la derecha;
   * por defecto la columna "status"), ancha (ocupa toda la fila) u oculta. Solo afecta a la vista de teléfono.
   */
  mobile?: 'title' | 'badge' | 'wide' | 'hide';
}

export interface SortKey { key: string; dir: 'asc' | 'desc' }
interface Layout { order: string[]; vis: Record<string, boolean>; widths: Record<string, number>; sort?: SortKey[]; pageSize?: number; showFilters?: boolean }

const lsKey = (id: string) => `grid:${id}`;
function loadLayout(id: string): Layout {
  try {
    const raw = localStorage.getItem(lsKey(id));
    if (raw) { const l = JSON.parse(raw); return { order: l.order ?? [], vis: l.vis ?? {}, widths: l.widths ?? {}, sort: l.sort, pageSize: l.pageSize, showFilters: l.showFilters }; }
  } catch { /* sin almacenamiento */ }
  return { order: [], vis: {}, widths: {} };
}
function saveLayout(id: string, l: Layout) { try { localStorage.setItem(lsKey(id), JSON.stringify(l)); } catch { /* ignorar */ } }

const DEFAULT_W: Record<ColType, number> = { text: 170, number: 100, money: 120, date: 120, datetime: 160, boolean: 90, select: 150, multi: 190 };
const NO_OPTS: Opt[] = [];
const PAGE_SIZES = [25, 50, 100, 250, 500];

export interface DataGridProps<T> {
  /** Identificador para recordar el diseño (orden, columnas visibles, anchos). */
  id: string;
  rows: T[];
  columns: GridColumn<T>[];
  rowId: (r: T) => string | number;
  loading?: boolean;
  onRowClick?: (r: T) => void;
  rowClass?: (r: T) => string | undefined;
  selectable?: boolean;
  selected?: ReadonlySet<any>;
  onSelectedChange?: (s: Set<any>) => void;
  initialFilters?: Record<string, Filter>;
  /** Cambia cuando los filtros iniciales deben volver a aplicarse (ej. parámetros de la URL). */
  initialFiltersKey?: string;
  defaultSort?: SortKey[];
  /** Botones extra a la izquierda de la barra. */
  toolbar?: ReactNode;
  /** Nombre del archivo exportado y título del PDF. */
  exportName: string;
  exportTitle?: string;
  emptyTitle?: ReactNode; emptyHint?: ReactNode; emptyAction?: ReactNode;
  pageSize?: number;
  bare?: boolean;
  /** Fuerza a recalcular valores cuando cambian datos externos que usan las columnas. */
  valueKey?: unknown;
}

export function DataGrid<T>(props: DataGridProps<T>) {
  const { id, rows, columns, rowId, loading, onRowClick, rowClass, selectable, selected, onSelectedChange, initialFilters, initialFiltersKey, defaultSort, toolbar, exportName, exportTitle, emptyTitle, emptyHint, emptyAction, bare } = props;
  const { t } = useTranslation();
  const fmt = useFmt();
  const lang = fmt.lang;
  const mobile = useIsMobile();

  const [layout, setLayoutState] = useState<Layout>(() => loadLayout(id));
  const setLayout = (fn: (l: Layout) => Layout) => setLayoutState((prev) => { const n = fn(prev); saveLayout(id, n); return n; });
  const [filters, setFilters] = useState<Record<string, Filter>>(initialFilters ?? {});
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [colsAnchor, setColsAnchor] = useState<HTMLElement | null>(null);
  const [expAnchor, setExpAnchor] = useState<HTMLElement | null>(null);
  const [onlySel, setOnlySel] = useState(false);
  const [drag, setDrag] = useState<{ key: string; over: string | null; after: boolean } | null>(null);
  const resizing = useRef(false);
  const pageSize = layout.pageSize ?? props.pageSize ?? 50;
  const showFilters = layout.showFilters ?? true;

  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    setFilters(initialFilters ?? {}); setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFiltersKey]);

  // ------------------------------------------------------------ columnas
  const colsRef = useRef(columns); colsRef.current = columns;
  const dataCols = columns.filter((c) => !c.actions);
  const actionCols = columns.filter((c) => c.actions);
  const sig = columns.map((c) => c.key).join('|');
  const typeOf = (c: GridColumn<T>): ColType => c.type ?? 'text';
  const colIndex = new Map(columns.map((c, i) => [c.key, i]));

  const ordered: GridColumn<T>[] = [];
  {
    const byKey = new Map(dataCols.map((c) => [c.key, c]));
    for (const k of layout.order) { const c = byKey.get(k); if (c) { ordered.push(c); byKey.delete(k); } }
    for (const c of dataCols) if (byKey.has(c.key)) ordered.push(c);
  }
  const visible = ordered.filter((c) => c.noHide || (layout.vis[c.key] ?? !c.hidden));
  const shown = [...visible, ...actionCols];
  const visKey = visible.map((c) => c.key).join('|');

  // ------------------------------------------------------------ valores crudos
  const vals = useMemo(() => {
    const cs = colsRef.current;
    return rows.map((r) => cs.map((c) => (c.actions ? null : c.value ? c.value(r) : ((r as any)[c.key] as Raw))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sig, lang, props.valueKey]);
  const val = (i: number, c: GridColumn<T>): Raw => vals[i]![colIndex.get(c.key)!];

  const derived = useMemo(() => {
    const m = new Map<string, Opt[]>();
    colsRef.current.forEach((c, ci) => {
      const ty = c.type ?? 'text';
      if (c.actions || c.options || (ty !== 'select' && ty !== 'multi')) return;
      const set = new Set<string>();
      for (const row of vals) { const v = row[ci]; if (Array.isArray(v)) v.forEach((x) => set.add(String(x))); else if (!isEmptyVal(v)) set.add(String(v)); }
      m.set(c.key, [...set].sort((a, b) => a.localeCompare(b, lang, { numeric: true })).map((v) => ({ value: v, label: v })));
    });
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vals, sig, lang, props.valueKey]);
  const lmCache = useRef(new WeakMap<Opt[], Map<string, string>>());
  const optsOf = (c: GridColumn<T>): Opt[] => c.options ?? derived.get(c.key) ?? NO_OPTS;
  const labelOf = (c: GridColumn<T>, v: unknown) => {
    const o = optsOf(c);
    let m = lmCache.current.get(o);
    if (!m) { m = new Map(o.map((x) => [x.value, x.label])); lmCache.current.set(o, m); }
    return m.get(String(v)) ?? String(v);
  };

  const textOf = (c: GridColumn<T>, v: Raw): string => {
    if (isEmptyVal(v)) return '';
    switch (typeOf(c)) {
      case 'select': return labelOf(c, v);
      case 'multi': return (v as (string | number)[]).map((x) => labelOf(c, x)).join(', ');
      case 'date': case 'datetime': return `${dayKey(v) ?? ''} ${fmt.date(v as any)}`;
      case 'boolean': return v ? t('grid.yes') : t('grid.no');
      default: return String(v);
    }
  };

  // ------------------------------------------------------------ filtrar + ordenar
  const activeFilters = Object.entries(filters).filter(([k, f]) => { const c = dataCols.find((x) => x.key === k); return c && isActive(typeOf(c), f); });
  const sort = layout.sort ?? defaultSort ?? [];
  const sortSig = JSON.stringify(sort);
  const collator = useMemo(() => new Intl.Collator(lang, { numeric: true, sensitivity: 'base' }), [lang]);

  const idxs = useMemo(() => {
    const nq = norm(q.trim());
    const fs = activeFilters.map(([k, f]) => ({ c: dataCols.find((x) => x.key === k)!, f }));
    const out: number[] = [];
    for (let i = 0; i < rows.length; i++) {
      let ok = true;
      for (const { c, f } of fs) if (!matches(typeOf(c), f, val(i, c))) { ok = false; break; }
      if (ok && nq) ok = visible.some((c) => norm(textOf(c, val(i, c))).includes(nq));
      if (ok) out.push(i);
    }
    const scs = sort.map((s) => ({ c: dataCols.find((x) => x.key === s.key), dir: s.dir === 'asc' ? 1 : -1 })).filter((s) => s.c);
    if (scs.length) {
      const sk = (c: GridColumn<T>, i: number): number | string | null => {
        const v = val(i, c);
        if (isEmptyVal(v)) return null;
        switch (typeOf(c)) {
          case 'number': case 'money': return toNum(v);
          case 'date': return dayKey(v);
          case 'datetime': return toDate(v)?.getTime() ?? null;
          case 'boolean': return v ? 1 : 0;
          default: return textOf(c, v);
        }
      };
      const keys = new Map<number, (number | string | null)[]>();
      for (const i of out) keys.set(i, scs.map((s) => sk(s.c!, i)));
      out.sort((a, b) => {
        const ka = keys.get(a)!, kb = keys.get(b)!;
        for (let n = 0; n < scs.length; n++) {
          const x = ka[n]!, y = kb[n]!;
          if (x === null && y === null) continue;
          if (x === null) return 1;
          if (y === null) return -1;
          const r = typeof x === 'number' && typeof y === 'number' ? x - y : collator.compare(String(x), String(y));
          if (r !== 0) return r * scs[n]!.dir;
        }
        return a - b;
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, vals, filters, q, visKey, sortSig, collator, lang, sig, props.valueKey]);

  const pages = Math.max(1, Math.ceil(idxs.length / pageSize));
  const cur = Math.min(page, pages);
  const pageIdx = idxs.slice((cur - 1) * pageSize, cur * pageSize);
  const filtered = activeFilters.length > 0 || q.trim() !== '';

  // ------------------------------------------------------------ acciones
  const setFilter = (key: string, f: Filter | undefined) => { setFilters((s) => { const n = { ...s }; if (f) n[key] = f; else delete n[key]; return n; }); setPage(1); };
  const clearFilters = () => { setFilters({}); setQ(''); setPage(1); };
  const toggleSort = (key: string, multi: boolean) => {
    setLayout((l) => {
      const base = l.sort ?? defaultSort ?? [];
      const ex = base.find((s) => s.key === key);
      let next: SortKey[];
      if (multi) next = ex ? (ex.dir === 'asc' ? base.map((s) => (s.key === key ? { ...s, dir: 'desc' as const } : s)) : base.filter((s) => s.key !== key)) : [...base, { key, dir: 'asc' }];
      else next = ex ? (ex.dir === 'asc' ? [{ key, dir: 'desc' }] : []) : [{ key, dir: 'asc' }];
      return { ...l, sort: next };
    });
  };
  const moveCol = (from: string, to: string, after: boolean) => {
    if (from === to) return;
    const keys = ordered.map((c) => c.key).filter((k) => k !== from);
    const at = keys.indexOf(to) + (after ? 1 : 0);
    keys.splice(at, 0, from);
    setLayout((l) => ({ ...l, order: keys }));
  };
  const startResize = (e: React.MouseEvent, c: GridColumn<T>) => {
    e.preventDefault(); e.stopPropagation();
    resizing.current = true;
    const startX = e.clientX;
    const th = (e.currentTarget as HTMLElement).parentElement!;
    const startW = th.offsetWidth;
    const move = (ev: MouseEvent) => { const w = Math.max(50, Math.round(startW + ev.clientX - startX)); setLayout((l) => ({ ...l, widths: { ...l.widths, [c.key]: w } })); };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); setTimeout(() => { resizing.current = false; }, 0); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  };
  /** Ancho mínimo para que el nombre de la columna se lea completo (mayúsculas con espaciado + flecha de orden). */
  const titleMin = (c: GridColumn<T>) => (c.actions || !c.title ? 0 : Math.ceil(String(c.title).length * 8.8) + 24 + 20);
  const widthOf = (c: GridColumn<T>) => layout.widths[c.key] ?? Math.max(c.width ?? (c.actions ? 110 : DEFAULT_W[typeOf(c)]), titleMin(c));
  const totalW = shown.reduce((s, c) => s + widthOf(c), selectable ? 40 : 0);

  // selección
  const allIds = useMemo(() => idxs.map((i) => rowId(rows[i]!)), [idxs, rows]);
  const allOn = !!selected && allIds.length > 0 && allIds.every((x) => selected.has(x));
  const toggleAll = (on: boolean) => {
    if (!onSelectedChange) return;
    const n = new Set(selected ?? []);
    for (const x of allIds) { if (on) n.add(x); else n.delete(x); }
    onSelectedChange(n);
  };
  const toggleOne = (x: string | number, on: boolean) => { const n = new Set(selected ?? []); if (on) n.add(x); else n.delete(x); onSelectedChange?.(n); };

  // exportación: exactamente lo que se ve (filtros + orden + columnas visibles); sin filtros, todo
  function buildTable(onlySelected: boolean): ExportTable {
    const cols = visible.filter((c) => !c.noExport);
    const src = onlySelected && selected ? idxs.filter((i) => selected.has(rowId(rows[i]!))) : idxs;
    const toCell = (c: GridColumn<T>, i: number): Cell => {
      if (c.exportValue) return c.exportValue(rows[i]!);
      const v = val(i, c);
      if (isEmptyVal(v)) return null;
      switch (typeOf(c)) {
        case 'number': case 'money': return toNum(v);
        case 'date': case 'datetime': return toDate(v);
        default: return textOf(c, v).replace(/^\s+/, '') || null;
      }
    };
    return {
      title: exportTitle ?? exportName,
      header: cols.map((c) => c.title),
      types: cols.map((c) => { const ty = typeOf(c); return ty === 'number' || ty === 'money' || ty === 'date' || ty === 'datetime' ? ty : 'text'; }),
      rows: src.map((i) => cols.map((c) => {
        if (!c.exportValue && (typeOf(c) === 'date')) { const v = val(i, c); const d = toDate(v); return d ? new Date(d.getFullYear(), d.getMonth(), d.getDate()) : null; }
        return toCell(c, i);
      })),
      subtitle: filtered ? t('grid.export_filtered_note', { count: src.length, total: rows.length }) : '',
    };
  }
  function doExport(kind: ExportKind) {
    setExpAnchor(null);
    runExport(kind, buildTable(onlySel && (selected?.size ?? 0) > 0), `${safeFileName(toDoc(exportName))}_${stamp()}`);
  }
  const selCount = selected?.size ?? 0;
  const expCount = onlySel && selCount > 0 ? selCount : idxs.length;

  // ------------------------------------------------------------ pintado de celdas
  const numFmt = (n: number, money: boolean) => n.toLocaleString(lang === 'en' ? 'en-US' : 'es-US', money ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : { maximumFractionDigits: 6 });
  function cell(c: GridColumn<T>, i: number): ReactNode {
    const r = rows[i]!;
    if (c.render) return c.render(r);
    const v = val(i, c);
    if (isEmptyVal(v)) return <span className="muted">—</span>;
    switch (typeOf(c)) {
      case 'number': { const n = toNum(v); return n === null ? String(v) : numFmt(n, false); }
      case 'money': { const n = toNum(v); return n === null ? String(v) : numFmt(n, true); }
      case 'date': return fmt.date(v as any);
      case 'datetime': return fmt.dateTime(v as any);
      case 'boolean': return v ? <Check size={15} /> : <span className="muted">—</span>;
      case 'select': return labelOf(c, v);
      case 'multi': return <span className="spec-chips">{(v as (string | number)[]).map((x) => <span key={String(x)} className="chip">{labelOf(c, x)}</span>)}</span>;
      default: return String(v);
    }
  }
  const alignOf = (c: GridColumn<T>) => c.align ?? (typeOf(c) === 'number' || typeOf(c) === 'money' ? 'right' : 'left');

  const from = idxs.length ? (cur - 1) * pageSize + 1 : 0;
  const to = Math.min(cur * pageSize, idxs.length);
  const layoutChanged = layout.order.length > 0 || Object.keys(layout.vis).length > 0 || Object.keys(layout.widths).length > 0 || layout.sort !== undefined;

  // En el teléfono se muestra como lista de tarjetas (mismo estado: filtros, orden, columnas y exportación).
  if (mobile) {
    return (
      <MobileGrid<T>
        bare={bare} toolbar={toolbar} loading={loading} rows={rows} idxs={idxs}
        visible={visible} actionCols={actionCols} ordered={ordered}
        isVisible={(c) => c.noHide || (layout.vis[c.key] ?? !c.hidden)}
        onVisible={(key, on) => setLayout((l) => ({ ...l, vis: { ...l.vis, [key]: on } }))}
        onResetLayout={() => setLayout(() => ({ order: [], vis: {}, widths: {} }))}
        layoutChanged={layoutChanged}
        q={q} onQ={(v) => { setQ(v); setPage(1); }}
        filters={filters} activeFilterKeys={activeFilters.map(([k]) => k)} onFilter={setFilter} onClearFilters={clearFilters}
        sort={sort} onSort={(s) => setLayout((l) => ({ ...l, sort: s }))}
        typeOf={typeOf} optsOf={optsOf} cell={cell}
        isEmptyCell={(c, i) => isEmptyVal(val(i, c))}
        rowId={rowId} onRowClick={onRowClick} rowClass={rowClass}
        selectable={selectable} selected={selected} allOn={allOn} onToggleAll={toggleAll} onToggleOne={toggleOne}
        onExport={(kind) => runExport(kind, buildTable(onlySel && (selected?.size ?? 0) > 0), `${safeFileName(toDoc(exportName))}_${stamp()}`)}
        exportNote={selCount > 0 && onlySel ? t('grid.export_selected_note', { count: selCount }) : filtered ? t('grid.export_filtered', { count: idxs.length, total: rows.length }) : t('grid.export_all', { count: idxs.length })}
        empty={{ title: emptyTitle, hint: emptyHint, action: emptyAction }}
      />
    );
  }

  return (
    <section className={`dg ${bare ? 'dg-bare' : 'card'}`}>
      <div className="dg-toolbar">
        <div className="row wrap gap-sm grow">
          {toolbar}
          <div className="search dg-search">
            <Search size={16} />
            <input className="input" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder={t('grid.search')} aria-label={t('grid.search')} />
            {q && <button className="icon-btn" onClick={() => setQ('')} aria-label={t('grid.clear_filter')}><X size={14} /></button>}
          </div>
        </div>
        <div className="row wrap gap-sm">
          {filtered && <Button size="sm" variant="ghost" icon={<FilterX size={15} />} onClick={clearFilters}>{t('grid.clear_filters')}{activeFilters.length > 0 && ` (${activeFilters.length})`}</Button>}
          <Button size="sm" variant={showFilters ? 'secondary' : 'ghost'} icon={<ListFilter size={15} />} aria-pressed={showFilters} onClick={() => setLayout((l) => ({ ...l, showFilters: !showFilters }))}>{t('grid.filter_row')}</Button>
          <Button size="sm" variant="ghost" icon={<Columns3 size={15} />} onClick={(e) => setColsAnchor(colsAnchor ? null : e.currentTarget)}>{t('grid.columns')}</Button>
          <Button size="sm" variant="secondary" icon={<Download size={15} />} onClick={(e) => setExpAnchor(expAnchor ? null : e.currentTarget)} disabled={idxs.length === 0}>{t('grid.export')}</Button>
        </div>
      </div>

      {loading && rows.length === 0 ? <Spinner /> : rows.length === 0 ? (
        <Empty title={emptyTitle ?? t('grid.empty')} hint={emptyHint} action={emptyAction} />
      ) : (
        <div className="dg-scroll">
          <table className="table dg-table" style={{ width: `max(100%, ${totalW}px)` }}>
            <colgroup>
              {selectable && <col style={{ width: 40 }} />}
              {shown.map((c) => <col key={c.key} style={{ width: widthOf(c) }} />)}
            </colgroup>
            <thead>
              <tr className="dg-head">
                {selectable && <th className="dg-sel"><input type="checkbox" checked={allOn} onChange={(e) => toggleAll(e.target.checked)} aria-label={t('grid.select_all')} title={t('grid.select_all')} /></th>}
                {shown.map((c) => {
                  const s = sort.findIndex((x) => x.key === c.key);
                  const sortable = !c.actions && !c.noSort;
                  const dg = drag && drag.over === c.key && drag.key !== c.key ? (drag.after ? 'drop-after' : 'drop-before') : '';
                  return (
                    <th key={c.key} className={`dg-th ${alignOf(c) === 'right' ? 'num' : ''} ${dg} ${drag?.key === c.key ? 'dragging' : ''}`}
                      draggable={!c.actions}
                      onDragStart={(e) => { if (resizing.current) { e.preventDefault(); return; } e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', c.key); setDrag({ key: c.key, over: null, after: false }); }}
                      onDragOver={(e) => { if (!drag || c.actions) return; e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); const after = e.clientX > r.left + r.width / 2; if (drag.over !== c.key || drag.after !== after) setDrag({ ...drag, over: c.key, after }); }}
                      onDrop={(e) => { e.preventDefault(); if (drag && drag.over && !c.actions) moveCol(drag.key, c.key, drag.after); setDrag(null); }}
                      onDragEnd={() => setDrag(null)}>
                      <div className={`dg-th-in ${sortable ? 'sortable' : ''}`} onClick={sortable ? (e) => toggleSort(c.key, e.shiftKey) : undefined} title={sortable ? t('grid.sort_hint') : undefined}>
                        <span className="dg-title truncate">{c.title}</span>
                        {s >= 0 && <span className="dg-sort">{sort[s]!.dir === 'asc' ? <ArrowUp size={13} /> : <ArrowDown size={13} />}{sort.length > 1 && <sup>{s + 1}</sup>}</span>}
                      </div>
                      {!c.actions && <span className="dg-resize" onMouseDown={(e) => startResize(e, c)} onClick={(e) => e.stopPropagation()} draggable={false} />}
                    </th>
                  );
                })}
              </tr>
              {showFilters && (
                <tr className="dg-filters">
                  {selectable && <th />}
                  {shown.map((c) => (
                    <th key={c.key}>
                      {!c.actions && !c.noFilter && <FilterCell type={typeOf(c)} filter={filters[c.key]} options={optsOf(c)} title={c.title} onChange={(f) => setFilter(c.key, f)} />}
                    </th>
                  ))}
                </tr>
              )}
            </thead>
            <tbody>
              {pageIdx.map((i) => {
                const r = rows[i]!;
                const rid = rowId(r);
                const isSel = !!selected?.has(rid);
                return (
                  <tr key={rid} className={`${onRowClick ? 'clickable' : ''} ${isSel ? 'selected' : ''} ${rowClass?.(r) ?? ''}`} onClick={onRowClick ? () => onRowClick(r) : undefined}>
                    {selectable && <td className="dg-sel" onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={isSel} onChange={(e) => toggleOne(rid, e.target.checked)} aria-label={t('grid.select_row')} /></td>}
                    {shown.map((c) => (
                      <td key={c.key} className={`${alignOf(c) === 'right' ? 'num' : alignOf(c) === 'center' ? 'ctr' : ''} ${c.actions ? 'cell-actions' : ''}`} onClick={c.actions ? (e) => e.stopPropagation() : undefined}>
                        {cell(c, i)}
                      </td>
                    ))}
                  </tr>
                );
              })}
              {idxs.length === 0 && (
                <tr><td colSpan={shown.length + (selectable ? 1 : 0)}>
                  <Empty title={t('grid.no_results')} action={<Button size="sm" onClick={clearFilters} icon={<FilterX size={14} />}>{t('grid.clear_filters')}</Button>} />
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {rows.length > 0 && (
        <div className="dg-foot">
          <span className="muted">
            {idxs.length === 0 ? t('grid.none') : t('grid.showing', { from, to, total: idxs.length })}
            {filtered && ` · ${t('grid.of_total', { total: rows.length })}`}
            {selCount > 0 && ` · ${t('grid.selected', { count: selCount })}`}
          </span>
          <div className="row gap-sm">
            <select className="input dg-ps" value={pageSize} onChange={(e) => { setLayout((l) => ({ ...l, pageSize: Number(e.target.value) })); setPage(1); }} aria-label={t('grid.page_size')}>
              {Array.from(new Set([...PAGE_SIZES, pageSize])).sort((a, b) => a - b).map((n) => <option key={n} value={n}>{t('grid.per_page', { count: n })}</option>)}
            </select>
            <Button size="sm" variant="ghost" disabled={cur <= 1} onClick={() => setPage(1)} icon={<ChevronsLeft size={16} />} aria-label="first" />
            <Button size="sm" variant="ghost" disabled={cur <= 1} onClick={() => setPage(cur - 1)} icon={<ChevronLeft size={16} />} aria-label="prev" />
            <span className="nowrap">{cur} / {pages}</span>
            <Button size="sm" variant="ghost" disabled={cur >= pages} onClick={() => setPage(cur + 1)} icon={<ChevronRight size={16} />} aria-label="next" />
            <Button size="sm" variant="ghost" disabled={cur >= pages} onClick={() => setPage(pages)} icon={<ChevronsRight size={16} />} aria-label="last" />
          </div>
        </div>
      )}

      {colsAnchor && (
        <Popover anchor={colsAnchor} onClose={() => setColsAnchor(null)} minWidth={240} align="right">
          <div className="pop-body">
            <div className="row spread"><strong>{t('grid.columns')}</strong>
              <button type="button" className="link-btn" disabled={!layoutChanged} onClick={() => { setLayout(() => ({ order: [], vis: {}, widths: {} })); }}><RotateCcw size={12} /> {t('grid.reset_layout')}</button>
            </div>
            <ul className="pop-list">
              {ordered.map((c) => (
                <li key={c.key}>
                  <label className={`checkbox ${c.noHide ? 'disabled' : ''}`}>
                    <input type="checkbox" disabled={c.noHide} checked={c.noHide || (layout.vis[c.key] ?? !c.hidden)} onChange={(e) => setLayout((l) => ({ ...l, vis: { ...l.vis, [c.key]: e.target.checked } }))} />
                    <span>{c.title}</span>
                  </label>
                </li>
              ))}
            </ul>
            <div className="muted pop-hint">{t('grid.columns_hint')}</div>
          </div>
        </Popover>
      )}

      {expAnchor && (
        <Popover anchor={expAnchor} onClose={() => setExpAnchor(null)} minWidth={260} align="right">
          <div className="pop-body">
            <div className="muted">{onlySel && selCount > 0 ? t('grid.export_selected_note', { count: selCount }) : filtered ? t('grid.export_filtered', { count: idxs.length, total: rows.length }) : t('grid.export_all', { count: idxs.length })}</div>
            {selCount > 0 && (
              <label className="checkbox"><input type="checkbox" checked={onlySel} onChange={(e) => setOnlySel(e.target.checked)} /><span>{t('grid.only_selected', { count: selCount })}</span></label>
            )}
            <ul className="pop-menu">
              <li><button type="button" onClick={() => doExport('xlsx')}><FileSpreadsheet size={15} /> {t('grid.export_xlsx')}</button></li>
              <li><button type="button" onClick={() => doExport('csv')}><FileText size={15} /> {t('grid.export_csv')}</button></li>
              <li><button type="button" onClick={() => doExport('pdf')}><Printer size={15} /> {t('grid.export_pdf')}</button></li>
            </ul>
            <div className="muted pop-hint">{t('grid.export_count', { count: expCount, cols: visible.filter((c) => !c.noExport).length })}</div>
          </div>
        </Popover>
      )}
    </section>
  );
}
