import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, Check, ChevronDown, FileSpreadsheet, FileText, FilterX, Printer, RotateCcw, Search, SlidersHorizontal, X } from 'lucide-react';
import { Button, Empty, Spinner } from '../ui';
import { BottomSheet } from './BottomSheet';
import type { GridColumn, Opt, SortKey } from '../grid/DataGrid';
import { OPS, OP_GLYPH, defaultOp, isActive, isDateType, norm, type ColType, type Filter, type Op } from '../grid/filters';
import type { ExportKind } from '../grid/exporters';

const PAGE = 30;
const MAX_FIELDS = 6;

export interface MobileGridProps<T> {
  bare?: boolean;
  toolbar?: ReactNode;
  loading?: boolean;
  rows: T[];
  /** Posiciones (en rows) de las filas que pasan filtros y búsqueda, ya ordenadas. */
  idxs: number[];
  visible: GridColumn<T>[];
  actionCols: GridColumn<T>[];
  /** Todas las columnas de datos en su orden (para filtros y para elegir qué se ve). */
  ordered: GridColumn<T>[];
  isVisible: (c: GridColumn<T>) => boolean;
  onVisible: (key: string, on: boolean) => void;
  onResetLayout: () => void;
  layoutChanged: boolean;
  q: string;
  onQ: (v: string) => void;
  filters: Record<string, Filter>;
  activeFilterKeys: string[];
  onFilter: (key: string, f: Filter | undefined) => void;
  onClearFilters: () => void;
  sort: SortKey[];
  onSort: (s: SortKey[] | undefined) => void;
  typeOf: (c: GridColumn<T>) => ColType;
  optsOf: (c: GridColumn<T>) => Opt[];
  cell: (c: GridColumn<T>, i: number) => ReactNode;
  isEmptyCell: (c: GridColumn<T>, i: number) => boolean;
  rowId: (r: T) => string | number;
  onRowClick?: (r: T) => void;
  rowClass?: (r: T) => string | undefined;
  selectable?: boolean;
  selected?: ReadonlySet<any>;
  allOn: boolean;
  onToggleAll: (on: boolean) => void;
  onToggleOne: (id: string | number, on: boolean) => void;
  onExport: (kind: ExportKind) => void;
  exportNote: string;
  empty: { title?: ReactNode; hint?: ReactNode; action?: ReactNode };
}

/**
 * Versión del grid para teléfono: en vez de una tabla ancha, una lista de tarjetas (título, estado y datos clave),
 * con búsqueda arriba y una hoja para filtrar, ordenar, elegir columnas y exportar. Usa exactamente el mismo estado que la tabla.
 */
export function MobileGrid<T>(p: MobileGridProps<T>) {
  const { t } = useTranslation();
  const [sheet, setSheet] = useState(false);
  const nActive = p.activeFilterKeys.length;
  const listKey = `${p.q}|${JSON.stringify(p.filters)}|${JSON.stringify(p.sort)}`;

  return (
    <section className={`mg ${p.bare ? 'mg-bare' : ''}`}>
      {p.toolbar && <div className="mg-toolbar">{p.toolbar}</div>}
      <div className="mg-bar">
        <div className="search">
          <Search size={18} />
          <input className="input" type="search" value={p.q} onChange={(e) => p.onQ(e.target.value)} placeholder={t('grid.search')} aria-label={t('grid.search')} enterKeyHint="search" />
          {p.q && <button className="icon-btn" onClick={() => p.onQ('')} aria-label={t('grid.clear_filter')}><X size={16} /></button>}
        </div>
        <button className={`mg-filter-btn ${nActive || p.sort.length ? 'on' : ''}`} onClick={() => setSheet(true)} aria-label={t('mobile.filters')} title={t('mobile.filters')}>
          <SlidersHorizontal size={19} />{nActive > 0 && <b>{nActive}</b>}
        </button>
      </div>

      {nActive > 0 && (
        <div className="mg-chips">
          {p.activeFilterKeys.map((k) => {
            const c = p.ordered.find((x) => x.key === k)!;
            return (
              <button key={k} className="mg-chip" onClick={() => p.onFilter(k, undefined)}>
                <span className="truncate">{c.title}: {summarize(c, p.typeOf(c), p.filters[k]!, p.optsOf(c), t)}</span><X size={13} />
              </button>
            );
          })}
        </div>
      )}

      {p.loading && p.rows.length === 0 ? <Spinner /> : p.rows.length === 0 ? (
        <div className="card"><Empty title={p.empty.title ?? t('grid.empty')} hint={p.empty.hint} action={p.empty.action} /></div>
      ) : (
        <MobileList<T> key={listKey} {...p} onOpenSheet={() => setSheet(true)} />
      )}

      <BottomSheet open={sheet} onClose={() => setSheet(false)} title={t('mobile.filters_title')} full
        footer={<>
          {(nActive > 0 || p.q) && <Button variant="ghost" icon={<FilterX size={16} />} onClick={p.onClearFilters}>{t('mobile.clear_all')}</Button>}
          <Button variant="primary" onClick={() => setSheet(false)}>{t('mobile.show_results', { count: p.idxs.length })}</Button>
        </>}>
        <FilterSheet<T> {...p} />
      </BottomSheet>
    </section>
  );
}

/* ------------------------------------------------------------------ lista de tarjetas */

function MobileList<T>(p: MobileGridProps<T> & { onOpenSheet: () => void }) {
  const { t } = useTranslation();
  const [limit, setLimit] = useState(PAGE);
  const shown = p.idxs.slice(0, limit);
  const filtered = p.activeFilterKeys.length > 0 || p.q.trim() !== '';

  // Título = primera columna visible; estado = columna marcada (o "status"); el resto, como pares etiqueta / valor.
  const cols = p.visible.filter((c) => c.mobile !== 'hide');
  const title = cols.find((c) => c.mobile === 'title') ?? cols[0];
  const badge = cols.find((c) => c !== title && c.mobile === 'badge') ?? cols.find((c) => c !== title && c.key === 'status');
  const fields = cols.filter((c) => c !== title && c !== badge);

  return (
    <>
      <div className="mg-meta">
        <span className="muted">{filtered ? `${t('mobile.results', { count: p.idxs.length })} · ${t('grid.of_total', { total: p.rows.length })}` : t('mobile.results', { count: p.idxs.length })}
          {p.selected && p.selected.size > 0 && ` · ${t('grid.selected', { count: p.selected.size })}`}</span>
        {p.selectable && p.idxs.length > 0 && (
          <label className="checkbox"><input type="checkbox" checked={p.allOn} onChange={(e) => p.onToggleAll(e.target.checked)} /><span>{t('grid.select_all')}</span></label>
        )}
      </div>

      {p.idxs.length === 0 ? (
        <div className="card"><Empty title={t('grid.no_results')} action={<Button size="sm" onClick={p.onClearFilters} icon={<FilterX size={14} />}>{t('grid.clear_filters')}</Button>} /></div>
      ) : (
        <ul className="mg-list">
          {shown.map((i) => <MobileCard<T> key={p.rowId(p.rows[i]!)} i={i} p={p} title={title} badge={badge} fields={fields} />)}
        </ul>
      )}

      {p.idxs.length > limit && (
        <button className="btn btn-secondary mg-more" onClick={() => setLimit((l) => l + PAGE)}>
          <ChevronDown size={18} />{t('mobile.load_more')} <span className="muted">({t('mobile.remaining', { count: p.idxs.length - limit })})</span>
        </button>
      )}
    </>
  );
}

function MobileCard<T>({ i, p, title, badge, fields }: { i: number; p: MobileGridProps<T>; title: GridColumn<T> | undefined; badge: GridColumn<T> | undefined; fields: GridColumn<T>[] }) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const r = p.rows[i]!;
  const rid = p.rowId(r);
  const isSel = !!p.selected?.has(rid);
  // Los datos vacíos no ocupan lugar en la tarjeta.
  const filled = fields.filter((c) => c.render || !p.isEmptyCell(c, i));
  const list = all ? filled : filled.slice(0, MAX_FIELDS);
  const extra = filled.length - list.length;
  const click = p.onRowClick ? () => p.onRowClick!(r) : undefined;

  return (
    <li className={`mg-card ${click ? 'clickable' : ''} ${isSel ? 'selected' : ''} ${p.rowClass?.(r) ?? ''}`} onClick={click}>
      {p.selectable && (
        <label className="mg-check" onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" checked={isSel} onChange={(e) => p.onToggleOne(rid, e.target.checked)} aria-label={t('grid.select_row')} />
        </label>
      )}
      <div className="mg-main">
        {(title || badge) && (
          <div className="mg-head">
            {title && <div className="mg-title">{p.cell(title, i)}</div>}
            {badge && <div className="mg-badge">{p.cell(badge, i)}</div>}
          </div>
        )}
        {list.length > 0 && (
          <dl className="mg-fields">
            {list.map((c) => (
              <div key={c.key} className={`mg-f ${p.typeOf(c) === 'multi' || c.mobile === 'wide' ? 'wide' : ''}`}>
                <dt>{c.title}</dt>
                <dd>{p.cell(c, i)}</dd>
              </div>
            ))}
          </dl>
        )}
        {extra > 0 && <button type="button" className="mg-expand" onClick={(e) => { e.stopPropagation(); setAll(true); }}>+{extra}</button>}
        {all && filled.length > MAX_FIELDS && <button type="button" className="mg-expand" onClick={(e) => { e.stopPropagation(); setAll(false); }}>−</button>}
        {p.actionCols.length > 0 && (
          <div className="mg-actions" onClick={(e) => e.stopPropagation()}>
            {p.actionCols.map((c) => <span key={c.key} className="mg-act">{p.cell(c, i)}</span>)}
          </div>
        )}
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------ hoja: ordenar, filtrar, columnas, exportar */

function FilterSheet<T>(p: MobileGridProps<T>) {
  const { t } = useTranslation();
  const sortable = p.ordered.filter((c) => !c.noSort);
  const filterable = p.ordered.filter((c) => !c.noFilter);
  const cur = p.sort[0];
  const [open, setOpen] = useState<string | null>(null);

  return (
    <div className="mg-sheet">
      {sortable.length > 0 && (
        <section>
          <h4>{t('mobile.sort_by')}</h4>
          <div className="row gap-sm">
            <select className="input" value={cur?.key ?? ''} aria-label={t('mobile.sort_by')}
              onChange={(e) => p.onSort(e.target.value ? [{ key: e.target.value, dir: cur?.dir ?? 'asc' }] : undefined)}>
              <option value="">{t('mobile.sort_none')}</option>
              {sortable.map((c) => <option key={c.key} value={c.key}>{c.title}</option>)}
            </select>
            <div className="seg mg-dir" role="group">
              <button className={cur?.dir !== 'desc' ? 'on' : ''} disabled={!cur} onClick={() => cur && p.onSort([{ key: cur.key, dir: 'asc' }])} aria-label={t('mobile.sort_asc')} title={t('mobile.sort_asc')}><ArrowUp size={16} /></button>
              <button className={cur?.dir === 'desc' ? 'on' : ''} disabled={!cur} onClick={() => cur && p.onSort([{ key: cur.key, dir: 'desc' }])} aria-label={t('mobile.sort_desc')} title={t('mobile.sort_desc')}><ArrowDown size={16} /></button>
            </div>
          </div>
        </section>
      )}

      {filterable.length > 0 && (
        <section>
          <h4>{t('grid.filter_row')}</h4>
          <ul className="mg-filters">
            {filterable.map((c) => {
              const f = p.filters[c.key];
              const on = isActive(p.typeOf(c), f);
              const isOpen = open === c.key;
              return (
                <li key={c.key} className={on ? 'on' : ''}>
                  <button type="button" className="mg-filter-head" onClick={() => setOpen(isOpen ? null : c.key)} aria-expanded={isOpen}>
                    <span className="grow truncate">{c.title}</span>
                    {on && <span className="mg-filter-sum truncate">{summarize(c, p.typeOf(c), f!, p.optsOf(c), t)}</span>}
                    <ChevronDown size={16} className={isOpen ? 'flip' : ''} />
                  </button>
                  {isOpen && <div className="mg-filter-body"><FilterEditor type={p.typeOf(c)} filter={f} options={p.optsOf(c)} title={c.title} onChange={(nf) => p.onFilter(c.key, nf)} /></div>}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section>
        <div className="row spread"><h4>{t('mobile.columns_title')}</h4>
          <button type="button" className="link-btn" disabled={!p.layoutChanged} onClick={p.onResetLayout}><RotateCcw size={13} /> {t('grid.reset_layout')}</button>
        </div>
        <ul className="mg-cols">
          {p.ordered.map((c) => (
            <li key={c.key}>
              <label className={`checkbox ${c.noHide ? 'disabled' : ''}`}>
                <input type="checkbox" disabled={c.noHide} checked={c.noHide || p.isVisible(c)} onChange={(e) => p.onVisible(c.key, e.target.checked)} />
                <span>{c.title}</span>
              </label>
            </li>
          ))}
        </ul>
      </section>

      {p.rows.length > 0 && (
        <section>
          <h4>{t('mobile.export_title')}</h4>
          <p className="muted mg-note">{p.exportNote}</p>
          <div className="mg-export">
            <Button icon={<FileSpreadsheet size={17} />} onClick={() => p.onExport('xlsx')} disabled={p.idxs.length === 0}>Excel</Button>
            <Button icon={<FileText size={17} />} onClick={() => p.onExport('csv')} disabled={p.idxs.length === 0}>CSV</Button>
            <Button icon={<Printer size={17} />} onClick={() => p.onExport('pdf')} disabled={p.idxs.length === 0}>PDF</Button>
          </div>
        </section>
      )}
    </div>
  );
}

/** Editor de un filtro (mismas reglas que la fila de filtros de la tabla, con controles grandes para el dedo). */
function FilterEditor({ type, filter, options, onChange, title }: {
  type: ColType; filter: Filter | undefined; options: Opt[]; onChange: (f: Filter | undefined) => void; title: string;
}) {
  const { t } = useTranslation();
  const [opSel, setOpSel] = useState<Op | undefined>();
  const [oq, setOq] = useState('');
  const op = filter?.op ?? opSel ?? defaultOp(type);
  const set = (patch: Partial<Filter>) => {
    const next: Filter = { op, ...filter, ...patch };
    onChange(isActive(type, next) ? next : undefined);
  };
  const opLabel = (o: Op) => t(`grid.${isDateType(type) ? 'opd' : 'op'}.${o}`, { defaultValue: t(`grid.op.${o}`) });
  const chooseOp = (o: Op) => {
    setOpSel(o);
    if (o === 'empty' || o === 'notEmpty') onChange({ op: o });
    else if (filter && filter.op !== 'empty' && filter.op !== 'notEmpty') onChange({ ...filter, op: o });
    else onChange(undefined);
  };

  if (type === 'boolean') {
    const v = filter?.a ?? '';
    return (
      <div className="seg mg-seg" role="group" aria-label={title}>
        {[['', t('grid.all')], ['true', t('grid.yes')], ['false', t('grid.no')]].map(([k, label]) => (
          <button key={k} className={v === k ? 'on' : ''} onClick={() => onChange(k ? { op: 'is', a: k } : undefined)}>{label}</button>
        ))}
      </div>
    );
  }

  const noValue = op === 'empty' || op === 'notEmpty';
  const opSelect = (
    <select className="input" value={op} onChange={(e) => chooseOp(e.target.value as Op)} aria-label={t('grid.op.eq')}>
      {OPS[type].map((o) => <option key={o} value={o}>{OP_GLYPH[o]}  {opLabel(o)}</option>)}
    </select>
  );

  if (type === 'select' || type === 'multi') {
    const sel = filter?.list ?? [];
    const nq = norm(oq);
    const shown = nq ? options.filter((o) => norm(o.label).includes(nq)) : options;
    const toggle = (v: string) => set({ list: sel.includes(v) ? sel.filter((x) => x !== v) : [...sel, v] });
    return (
      <div className="stack sm">
        {opSelect}
        {!noValue && (
          <>
            {options.length > 8 && <input className="input" type="search" placeholder={t('grid.search_options')} value={oq} onChange={(e) => setOq(e.target.value)} />}
            <div className="mg-opts">
              {shown.map((o) => (
                <button key={o.value} type="button" className={`mg-opt ${sel.includes(o.value) ? 'on' : ''}`} aria-pressed={sel.includes(o.value)} onClick={() => toggle(o.value)}>
                  {sel.includes(o.value) && <Check size={14} />}{o.label || '—'}
                </button>
              ))}
              {shown.length === 0 && <span className="muted">{t('grid.no_options')}</span>}
            </div>
          </>
        )}
      </div>
    );
  }

  const inType = isDateType(type) ? 'date' : type === 'number' || type === 'money' ? 'number' : 'text';
  return (
    <div className="stack sm">
      {opSelect}
      {!noValue && (op === 'between' ? (
        <div className="row gap-sm">
          <input className="input" type={inType} step="any" inputMode={inType === 'number' ? 'decimal' : undefined} aria-label={title} value={filter?.a ?? ''} onChange={(e) => set({ a: e.target.value })} placeholder={t('grid.from')} />
          <input className="input" type={inType} step="any" inputMode={inType === 'number' ? 'decimal' : undefined} aria-label={title} value={filter?.b ?? ''} onChange={(e) => set({ b: e.target.value })} placeholder={t('grid.to')} />
        </div>
      ) : (
        <input className="input" type={inType} step="any" inputMode={inType === 'number' ? 'decimal' : undefined} aria-label={title} value={filter?.a ?? ''} onChange={(e) => set({ a: e.target.value })} placeholder={t('grid.filter_ph')} />
      ))}
      {filter && <button type="button" className="link-btn" onClick={() => onChange(undefined)}><X size={13} /> {t('grid.clear_filter')}</button>}
    </div>
  );
}

function summarize<T>(_c: GridColumn<T>, type: ColType, f: Filter, options: Opt[], t: (k: string, o?: any) => string): string {
  if (f.op === 'empty') return t('grid.op.empty');
  if (f.op === 'notEmpty') return t('grid.op.notEmpty');
  if (type === 'select' || type === 'multi') {
    const l = f.list ?? [];
    const first = options.find((o) => o.value === l[0])?.label ?? l[0] ?? '';
    return `${f.op === 'notIn' ? '≠ ' : ''}${first}${l.length > 1 ? ` +${l.length - 1}` : ''}`;
  }
  if (type === 'boolean') return f.a === 'true' ? t('grid.yes') : t('grid.no');
  if (f.op === 'between') return `${f.a ?? ''} – ${f.b ?? ''}`;
  return `${OP_GLYPH[f.op]} ${f.a ?? ''}`;
}
