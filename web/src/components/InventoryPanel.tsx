import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, GripVertical, Layers, Plus, SlidersHorizontal, X } from 'lucide-react';
import { useMeta, useReloadMeta } from '../lib/meta';
import type { GridColumn } from './grid/DataGrid';
import type { UnitRow } from './UnitGrid';

/**
 * Panel de inventario: filtra por estado (por defecto solo lo disponible) y agrupa los equipos por lo que el usuario elija:
 * tipo, grados, lote, ubicación... y TODAS las propiedades de los tipos de equipo (marca, modelo, procesador, RAM, disco, pantalla...).
 * Las propiedades que se ofrecen dependen de los tipos de equipo que haya en pantalla (al entrar a "Laptop" se ofrecen las de laptop).
 * Los grupos se anidan (hasta 6 niveles), se pueden reordenar (arrastrando o con las flechas) y también se puede ordenar a mano
 * cada grupo dentro de su nivel. Al tocar un grupo se filtra el listado.
 */

export interface PathItem { dim: string; value: string }
export interface Dimension {
  key: string; title: string; values: (u: UnitRow) => string[]; label: (v: string) => string; order: (a: string, b: string) => number;
  /** Propiedad de un tipo de equipo (marca, RAM...) o dato general (tipo, grado, lote...). */
  kind: 'general' | 'attr';
  /** Solo propiedades: los tipos de equipo que la tienen. */
  typeIds?: number[];
}

const NONE = '\u0000none';
/** Equipos de un tipo que no tiene esa propiedad (una laptop no tiene "resolución"). */
const NA = '\u0000na';
const MAX_LEVELS = 6;
const LS_DIMS = 'units.groupBy';
const LS_OPEN = 'units.panelOpen';
const LS_SORT = 'units.groupSort';
const LS_ORDER = 'units.groupOrder';

/** "2026-09-18" → fecha corta del idioma (sin correr el día por la zona horaria). */
const fmtDay = (v: string) => {
  const [y, m, d] = v.split('-').map(Number);
  return y && m && d ? new Date(y, m - 1, d).toLocaleDateString() : v;
};

const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } };

/** Columnas del grid por las que tiene sentido agrupar (estado aparte; códigos, series y fechas no). */
const GROUPABLE_EXTRA = new Set(['location', 'lot', 'tester']);

export function useUnitDimensions(columns: GridColumn<UnitRow>[]): Dimension[] {
  const { t, i18n } = useTranslation();
  const meta = useMeta();
  return useMemo(() => {
    const collator = new Intl.Collator(i18n.language, { numeric: true, sensitivity: 'base' });
    const out: Dimension[] = [];
    for (const c of columns) {
      if (c.actions || c.key === 'status') continue;
      const ty = c.type ?? 'text';
      const isAttr = c.key.startsWith('attr:');
      // Las propiedades se pueden agrupar sea cual sea su tipo de dato (texto, número, fecha, sí/no, listas); de lo general, solo lo que tiene "categorías".
      if (!isAttr && !(ty === 'select' || ty === 'multi' || ty === 'boolean' || GROUPABLE_EXTRA.has(c.key))) continue;
      const isDate = isAttr && (ty === 'date' || ty === 'datetime');
      let typeIds: number[] | undefined;
      if (isAttr) {
        const attr = meta.attrByKey(c.key.slice(5));
        if (!attr) continue;
        typeIds = meta.data.equipmentTypes.filter((et) => et.isActive && et.attributes.some((a) => a.attributeId === attr.id && a.isActive)).map((et) => et.id);
      }
      const opts = new Map((c.options ?? []).map((o, i) => [o.value, { label: o.label, i }]));
      const values = (u: UnitRow): string[] => {
        if (typeIds && !typeIds.includes(u.equipmentTypeId)) return [NA];
        const raw = c.value ? c.value(u) : ((u as unknown as Record<string, unknown>)[c.key] as unknown);
        const list = Array.isArray(raw) ? raw : [raw];
        const vs = list.filter((v) => v !== null && v !== undefined && v !== '').map((v) => (v instanceof Date ? v.toISOString() : String(v)).slice(0, isDate ? 10 : undefined));
        return vs.length ? [...new Set(vs)] : [NONE];
      };
      const label = (v: string) => (v === NA ? t('units.grp_na') : v === NONE ? t('units.grp_none') : ty === 'boolean' ? (v === 'true' ? t('grid.yes') : t('grid.no')) : isDate ? fmtDay(v) : opts.get(v)?.label ?? v);
      const order = (a: string, b: string) => {
        const rank = (v: string) => (v === NA ? 2 : v === NONE ? 1 : 0);
        if (rank(a) || rank(b)) return rank(a) - rank(b);
        const ia = opts.get(a)?.i, ib = opts.get(b)?.i;
        if (ia !== undefined && ib !== undefined) return ia - ib;
        return isDate ? (a < b ? -1 : a > b ? 1 : 0) : collator.compare(label(a), label(b));
      };
      out.push({ key: c.key, title: c.title, values, label, order, kind: isAttr ? 'attr' : 'general', typeIds });
    }
    return out;
  }, [columns, t, i18n.language, meta]);
}

/** Filtra las filas según el camino de grupos elegido. */
export function filterByPath(rows: UnitRow[], path: PathItem[], dims: Dimension[]): UnitRow[] {
  if (!path.length) return rows;
  const by = new Map(dims.map((d) => [d.key, d]));
  const fs = path.map((p) => ({ d: by.get(p.dim), v: p.value })).filter((x) => x.d) as { d: Dimension; v: string }[];
  return rows.filter((u) => fs.every((f) => f.d.values(u).includes(f.v)));
}

interface Node { dim: string; value: string; label: string; count: number; children: Node[] }

/**
 * Árbol de grupos. Si un nivel no aplica a ningún equipo de una rama (p. ej. "Procesador" dentro de "Monitor"), esa rama se salta
 * ese nivel y sigue con el siguiente, en vez de mostrar un grupo vacío de "No aplica".
 */
function build(rows: UnitRow[], dims: Dimension[], level: number, sortBy: SortBy, manual: Record<string, string[]>): Node[] {
  let i = level;
  while (i < dims.length && rows.every((u) => dims[i]!.values(u)[0] === NA)) i++;
  const d = dims[i];
  if (!d) return [];
  const groups = new Map<string, UnitRow[]>();
  for (const u of rows) for (const v of d.values(u)) { const g = groups.get(v); if (g) g.push(u); else groups.set(v, [u]); }
  const nodes = [...groups.entries()].map(([value, list]) => ({ dim: d.key, value, label: d.label(value), count: list.length, children: build(list, dims, i + 1, sortBy, manual) }));
  const custom = sortBy === 'manual' ? manual[d.key] ?? [] : [];
  const pos = (v: string) => { const k = custom.indexOf(v); return k < 0 ? Infinity : k; };
  nodes.sort((a, b) => {
    if (sortBy === 'manual') { const pa = pos(a.value), pb = pos(b.value); if (pa !== pb) return pa === Infinity ? 1 : pb === Infinity ? -1 : pa - pb; }
    const special = (v: string) => v === NONE || v === NA;
    return (sortBy === 'count' && !special(a.value) && !special(b.value) ? b.count - a.count : 0) || d.order(a.value, b.value);
  });
  return nodes;
}

type SortBy = 'name' | 'count' | 'manual';

export function loadGroupBy(dims: Dimension[]): string[] {
  let saved: string[] | null = null;
  try { const raw = lsGet(LS_DIMS); saved = raw ? (JSON.parse(raw) as string[]) : null; } catch { saved = null; }
  const ok = (saved ?? ['type']).filter((k, i, a) => dims.some((d) => d.key === k) && a.indexOf(k) === i).slice(0, MAX_LEVELS);
  return ok.length || saved ? ok : dims.slice(0, 1).map((d) => d.key);
}

interface Props {
  /** Todas las filas cargadas (el panel cuenta por estado y agrupa las que tienen los estados elegidos). */
  rows: UnitRow[];
  dims: Dimension[];
  statuses: string[];
  onStatuses: (s: string[]) => void;
  groupBy: string[];
  onGroupBy: (g: string[]) => void;
  path: PathItem[];
  onPath: (p: PathItem[]) => void;
  /** Filas que cumplen los estados elegidos (base de los grupos). */
  scoped: UnitRow[];
}

export function InventoryPanel({ rows, dims, statuses, onStatuses, groupBy, onGroupBy, path, onPath, scoped }: Props) {
  const { t } = useTranslation();
  const meta = useMeta();
  const [open, setOpen] = useState(() => (lsGet(LS_OPEN) ?? (window.matchMedia?.('(max-width: 900px)').matches ? '0' : '1')) === '1');
  const [config, setConfig] = useState(false);
  // Propiedades nuevas (agregadas en Tipos de equipo, quizá desde otra pantalla o equipo): se vuelven a pedir al entrar y al abrir los ajustes.
  const reloadMeta = useReloadMeta();
  useEffect(() => { void reloadMeta(); }, [config]);  // eslint-disable-line react-hooks/exhaustive-deps
  const [sortBy, setSortBy] = useState<SortBy>(() => { const v = lsGet(LS_SORT); return v === 'count' || v === 'manual' ? v : 'name'; });
  const [manual, setManual] = useState<Record<string, string[]>>(() => { try { return JSON.parse(lsGet(LS_ORDER) ?? '{}') as Record<string, string[]>; } catch { return {}; } });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dragLevel, setDragLevel] = useState<number | null>(null);
  const [dragNode, setDragNode] = useState<{ dim: string; value: string } | null>(null);
  const [overNode, setOverNode] = useState<string | null>(null);
  useEffect(() => lsSet(LS_OPEN, open ? '1' : '0'), [open]);

  const statusItems = useMemo(() => meta.catalogOptions('unit_status', true), [meta]);
  const perStatus = useMemo(() => {
    const m = new Map<string, number>();
    for (const u of rows) m.set(u.statusKey, (m.get(u.statusKey) ?? 0) + 1);
    return m;
  }, [rows]);
  const activeDims = groupBy.map((k) => dims.find((d) => d.key === k)).filter(Boolean) as Dimension[];
  const tree = useMemo(() => build(scoped, activeDims, 0, sortBy, manual), [scoped, activeDims.map((d) => d.key).join('|'), sortBy, manual]); // eslint-disable-line react-hooks/exhaustive-deps

  // Qué se ofrece para agrupar: lo general y las propiedades de los tipos de equipo que hay a la vista (si ya se entró a un grupo, los de ese grupo).
  const visible = useMemo(() => (path.length ? filterByPath(scoped, path, dims) : scoped), [scoped, path, dims]);
  const typesShown = useMemo(() => [...new Set(visible.map((u) => u.equipmentTypeId))], [visible]);
  // Se ofrecen TODAS las propiedades (aunque no haya equipos de ese tipo a la vista o aún no estén asignadas a un tipo):
  // primero las de los tipos que se ven y después las demás, con el tipo al que pertenecen entre paréntesis.
  const offered = useMemo(() => dims.filter((d) => !groupBy.includes(d.key)), [dims, groupBy]);
  const general = offered.filter((d) => d.kind === 'general');
  const attrs = offered.filter((d) => d.kind === 'attr' && d.typeIds!.some((id) => typesShown.includes(id)));
  const attrsOther = offered.filter((d) => d.kind === 'attr' && !d.typeIds!.some((id) => typesShown.includes(id)));
  /** "Procesador (Laptop, Desktop)": para qué tipos aplica cuando no es para todos los que están a la vista. */
  const appliesTo = (d: Dimension) => {
    if (d.kind !== 'attr') return '';
    if (!d.typeIds!.length) return ` (${t('units.grp_unassigned')})`;
    const own = typesShown.filter((id) => d.typeIds!.includes(id));
    if (!own.length) return ` (${d.typeIds!.map((id) => meta.typeName(id)).join(', ')})`;
    return own.length < typesShown.length ? ` (${own.map((id) => meta.typeName(id)).join(', ')})` : '';
  };

  const allStatuses = statuses.length === 0;
  const toggleStatus = (k: string) => {
    const has = statuses.includes(k);
    const next = has ? statuses.filter((x) => x !== k) : [...statuses, k];
    onStatuses(next);
  };
  const setLevels = (keys: string[]) => {
    const clean = keys.filter((k, j) => k && keys.indexOf(k) === j).slice(0, MAX_LEVELS);
    lsSet(LS_DIMS, JSON.stringify(clean));
    onGroupBy(clean);
    onPath([]);
    setExpanded(new Set());
  };
  const moveLevel = (from: number, to: number) => {
    if (from === to || to < 0 || to >= groupBy.length) return;
    const next = [...groupBy];
    const [x] = next.splice(from, 1);
    next.splice(to, 0, x!);
    setLevels(next);
  };
  const changeSort = (v: SortBy) => { setSortBy(v); lsSet(LS_SORT, v); };

  /** Orden manual de los grupos de un nivel: se guarda por propiedad (el orden de esa lista manda sobre el resto). */
  const moveNode = (dim: string, siblings: string[], from: number, to: number) => {
    if (from === to || to < 0 || to >= siblings.length) return;
    const next = [...siblings];
    const [x] = next.splice(from, 1);
    next.splice(to, 0, x!);
    const merged = { ...manual, [dim]: [...next, ...(manual[dim] ?? []).filter((v) => !next.includes(v))] };
    setManual(merged);
    lsSet(LS_ORDER, JSON.stringify(merged));
  };

  const pathKey = (p: PathItem[]) => p.map((x) => `${x.dim}=${x.value}`).join('/');
  const isOn = (p: PathItem[]) => pathKey(p) === pathKey(path);
  const inPath = (p: PathItem[]) => p.length <= path.length && p.every((x, i) => path[i]!.dim === x.dim && path[i]!.value === x.value);

  const renderNodes = (nodes: Node[], parent: PathItem[], level: number, max: number): React.ReactNode => nodes.map((n, idx) => {
    const p = [...parent, { dim: n.dim, value: n.value }];
    const k = pathKey(p);
    const hasKids = n.children.length > 0;
    const isOpen = expanded.has(k) || inPath(p);
    const pct = max > 0 ? Math.max(4, Math.round((n.count / max) * 100)) : 0;
    const manualMode = sortBy === 'manual';
    const siblings = nodes.map((x) => x.value);
    return (
      <li key={k}>
        <div className={`inv-node ${isOn(p) ? 'on' : inPath(p) ? 'in' : ''} ${manualMode && overNode === k && dragNode?.dim === n.dim ? 'drop' : ''}`} style={{ paddingLeft: 6 + level * 14 }}
          draggable={manualMode}
          onDragStart={manualMode ? (e) => { e.stopPropagation(); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', n.value); setDragNode({ dim: n.dim, value: n.value }); } : undefined}
          onDragOver={manualMode && dragNode?.dim === n.dim ? (e) => { e.preventDefault(); if (overNode !== k) setOverNode(k); } : undefined}
          onDrop={manualMode && dragNode?.dim === n.dim ? (e) => { e.preventDefault(); e.stopPropagation(); moveNode(n.dim, siblings, siblings.indexOf(dragNode.value), idx); setDragNode(null); setOverNode(null); } : undefined}
          onDragEnd={() => { setDragNode(null); setOverNode(null); }}>
          {manualMode && <span className="inv-grip" title={t('units.grp_drag')}><GripVertical size={13} /></span>}
          {hasKids
            ? <button type="button" className="inv-caret" aria-label={isOpen ? t('units.grp_collapse') : t('units.grp_expand')} onClick={() => setExpanded((s) => { const x = new Set(s); if (x.has(k)) x.delete(k); else x.add(k); return x; })}>{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
            : <span className="inv-caret" />}
          <button type="button" className="inv-pick" onClick={() => { onPath(isOn(p) ? parent : p); if (hasKids) setExpanded((s) => new Set(s).add(k)); }} aria-pressed={isOn(p)}>
            <span className="inv-bar" style={{ width: `${pct}%` }} />
            <span className="inv-label">{n.label}</span>
            <span className="inv-count">{n.count}</span>
          </button>
          {manualMode && (
            <span className="inv-mv">
              <button type="button" title={t('units.grp_move_up')} aria-label={t('units.grp_move_up')} disabled={idx === 0} onClick={() => moveNode(n.dim, siblings, idx, idx - 1)}><ArrowUp size={12} /></button>
              <button type="button" title={t('units.grp_move_down')} aria-label={t('units.grp_move_down')} disabled={idx === nodes.length - 1} onClick={() => moveNode(n.dim, siblings, idx, idx + 1)}><ArrowDown size={12} /></button>
            </span>
          )}
        </div>
        {hasKids && isOpen && <ul>{renderNodes(n.children, p, level + 1, Math.max(...n.children.map((c) => c.count)))}</ul>}
      </li>
    );
  });

  const maxTop = tree.length ? Math.max(...tree.map((n) => n.count)) : 0;
  const summary = path.length ? path.map((p) => dims.find((d) => d.key === p.dim)?.label(p.value) ?? p.value).join(' › ') : t('units.grp_all');

  return (
    <aside className={`inv-panel ${open ? 'open' : 'closed'}`}>
      <div className="inv-head">
        <button type="button" className="inv-title" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <Layers size={16} /><strong>{t('units.panel_title')}</strong>
          {!open && <span className="muted inv-summary">{summary}</span>}
          <span className="inv-toggle">{open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</span>
        </button>
        {open && <button type="button" className={`icon-btn ${config ? 'on' : ''}`} title={t('units.grp_configure')} aria-pressed={config} onClick={() => setConfig((c) => !c)}><SlidersHorizontal size={16} /></button>}
      </div>

      {open && (
        <div className="inv-body">
          <div>
            <div className="inv-sub">{t('units.grp_status')}</div>
            <div className="inv-chips">
              <button type="button" className={`inv-chip ${allStatuses ? 'on' : ''}`} aria-pressed={allStatuses} onClick={() => onStatuses([])}>{t('units.grp_all_status')} <span>{rows.length}</span></button>
              {statusItems.map((s) => {
                const k = s.systemKey ?? String(s.id);
                const on = statuses.includes(k);
                return (
                  <button key={s.id} type="button" className={`inv-chip ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => toggleStatus(k)}>
                    <i className="inv-dot" style={{ background: s.color ?? 'var(--muted)' }} />{meta.name(s.id)} <span>{perStatus.get(k) ?? 0}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {config && (
            <div className="inv-config">
              <div className="inv-sub">{t('units.grp_group_by')}</div>
              {activeDims.length === 0 && <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>{t('units.grp_no_group')}</p>}
              <ol className="inv-levels">
                {activeDims.map((d, i) => (
                  <li key={d.key} className={`inv-lvl ${dragLevel !== null && dragLevel !== i ? 'target' : ''}`} draggable
                    onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', d.key); setDragLevel(i); }}
                    onDragOver={(e) => { if (dragLevel !== null) e.preventDefault(); }}
                    onDrop={(e) => { e.preventDefault(); if (dragLevel !== null) moveLevel(dragLevel, i); setDragLevel(null); }}
                    onDragEnd={() => setDragLevel(null)}>
                    <span className="inv-grip" title={t('units.grp_drag')}><GripVertical size={14} /></span>
                    <span className="inv-lvl-n">{i + 1}</span>
                    <span className="inv-lvl-name" title={d.title}>{d.title}</span>
                    <button type="button" title={t('units.grp_move_up')} aria-label={t('units.grp_move_up')} disabled={i === 0} onClick={() => moveLevel(i, i - 1)}><ArrowUp size={13} /></button>
                    <button type="button" title={t('units.grp_move_down')} aria-label={t('units.grp_move_down')} disabled={i === activeDims.length - 1} onClick={() => moveLevel(i, i + 1)}><ArrowDown size={13} /></button>
                    <button type="button" title={t('units.grp_remove_level')} aria-label={t('units.grp_remove_level')} onClick={() => setLevels(groupBy.filter((k) => k !== d.key))}><X size={13} /></button>
                  </li>
                ))}
              </ol>
              {groupBy.length < MAX_LEVELS && offered.length > 0 && (
                <label className="inv-add">
                  <Plus size={14} />
                  <select value="" onChange={(e) => { if (e.target.value) setLevels([...groupBy, e.target.value]); }} aria-label={t('units.grp_add')}>
                    <option value="">{groupBy.length ? t('units.grp_add_then') : t('units.grp_add')}</option>
                    {general.length > 0 && <optgroup label={t('units.grp_general')}>{general.map((d) => <option key={d.key} value={d.key}>{d.title}</option>)}</optgroup>}
                    {attrs.length > 0 && <optgroup label={t('units.grp_attrs')}>{attrs.map((d) => <option key={d.key} value={d.key}>{d.title}{appliesTo(d)}</option>)}</optgroup>}
                    {attrsOther.length > 0 && <optgroup label={t('units.grp_attrs_other')}>{attrsOther.map((d) => <option key={d.key} value={d.key}>{d.title}{appliesTo(d)}</option>)}</optgroup>}
                  </select>
                </label>
              )}
              <div className="row gap-sm wrap" style={{ marginTop: 6 }}>
                <span className="muted">{t('units.grp_sort')}</span>
                <span className="tri">
                  <button type="button" className={sortBy === 'name' ? 'on-inherit' : ''} onClick={() => changeSort('name')}>{t('units.grp_sort_name')}</button>
                  <button type="button" className={sortBy === 'count' ? 'on-inherit' : ''} onClick={() => changeSort('count')}>{t('units.grp_sort_count')}</button>
                  <button type="button" className={sortBy === 'manual' ? 'on-inherit' : ''} onClick={() => changeSort('manual')}>{t('units.grp_sort_manual')}</button>
                </span>
              </div>
              <p className="muted" style={{ fontSize: 12, margin: 0 }}>{sortBy === 'manual' ? t('units.grp_manual_hint') : t('units.grp_config_hint')}</p>
            </div>
          )}

          <div>
            <div className="inv-sub row spread">
              <span>{activeDims.length ? activeDims.map((d) => d.title).join(' › ') : t('units.grp_no_group')}</span>
              {path.length > 0 && <button type="button" className="inv-clear" onClick={() => onPath([])}><X size={12} /> {t('units.grp_clear')}</button>}
            </div>
            <button type="button" className={`inv-all ${path.length === 0 ? 'on' : ''}`} onClick={() => onPath([])}>
              <span>{t('units.grp_all')}</span><span className="inv-count">{scoped.length}</span>
            </button>
            {activeDims.length === 0
              ? <p className="muted" style={{ padding: '6px 4px' }}>{t('units.grp_pick_hint')}</p>
              : tree.length === 0
                ? <p className="muted" style={{ padding: '6px 4px' }}>{t('units.grp_empty')}</p>
                : <ul className="inv-tree">{renderNodes(tree, [], 0, maxTop)}</ul>}
          </div>
        </div>
      )}
    </aside>
  );
}
