import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, X } from 'lucide-react';
import { OPS, OP_GLYPH, defaultOp, isActive, isDateType, norm, type ColType, type Filter, type Op } from './filters';
import { Popover } from './Popover';

export interface Opt { value: string; label: string }

/** Celda de la fila de filtros: el editor cambia según el tipo de dato de la columna. */
export function FilterCell({ type, filter, options, onChange, title }: {
  type: ColType; filter: Filter | undefined; options: Opt[]; onChange: (f: Filter | undefined) => void; title: string;
}) {
  const { t } = useTranslation();
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [list, setList] = useState<HTMLElement | null>(null);
  const [opSel, setOpSel] = useState<Op | undefined>();
  const op = filter?.op ?? opSel ?? defaultOp(type);
  const set = (patch: Partial<Filter>) => {
    const next: Filter = { op, ...filter, ...patch };
    onChange(isActive(type, next) ? next : undefined);
  };
  const opLabel = (o: Op) => t(`grid.${isDateType(type) ? 'opd' : 'op'}.${o}`, { defaultValue: t(`grid.op.${o}`) });

  // Booleano: tres estados
  if (type === 'boolean') {
    return (
      <select className="dg-fi" aria-label={title} value={filter?.a ?? ''} onChange={(e) => onChange(e.target.value ? { op: 'is', a: e.target.value } : undefined)}>
        <option value="">{t('grid.all')}</option>
        <option value="true">{t('grid.yes')}</option>
        <option value="false">{t('grid.no')}</option>
      </select>
    );
  }

  const opButton = (
    <button type="button" className={`dg-op ${filter ? 'on' : ''}`} title={opLabel(op)} aria-label={opLabel(op)} onClick={(e) => setMenu(menu ? null : e.currentTarget)}>
      {OP_GLYPH[op]}
    </button>
  );
  const opMenu = menu && (
    <Popover anchor={menu} onClose={() => setMenu(null)} minWidth={190}>
      <ul className="pop-menu">
        {OPS[type].map((o) => (
          <li key={o}>
            <button type="button" className={o === op ? 'on' : ''} onClick={() => {
              setMenu(null); setOpSel(o);
              if (o === 'empty' || o === 'notEmpty') onChange({ op: o });
              else if (filter && filter.op !== 'empty' && filter.op !== 'notEmpty') onChange({ ...filter, op: o });
              else onChange(undefined);
            }}>
              <span className="dg-op-g">{OP_GLYPH[o]}</span>{opLabel(o)}{o === op && <Check size={14} />}
            </button>
          </li>
        ))}
      </ul>
    </Popover>
  );

  // Selección / múltiple: lista con búsqueda
  if (type === 'select' || type === 'multi') {
    const sel = filter?.list ?? [];
    const summary = op === 'empty' ? t('grid.op.empty') : op === 'notEmpty' ? t('grid.op.notEmpty')
      : sel.length === 0 ? t('grid.all') : sel.length === 1 ? (options.find((o) => o.value === sel[0])?.label ?? sel[0]!) : t('grid.n_selected', { count: sel.length });
    return (
      <div className="dg-fc">
        {opButton}
        <button type="button" className="dg-fi dg-fi-btn" title={title} onClick={(e) => setList(list ? null : e.currentTarget)}>
          <span className="truncate">{summary}</span><ChevronDown size={13} />
        </button>
        {opMenu}
        {list && <OptionsPopover anchor={list} onClose={() => setList(null)} options={options} selected={sel} onChange={(l) => set({ list: l })} />}
      </div>
    );
  }

  const noValue = op === 'empty' || op === 'notEmpty';
  const inType = isDateType(type) ? 'date' : type === 'number' || type === 'money' ? 'number' : 'text';
  return (
    <div className="dg-fc">
      {opButton}
      {noValue ? (
        <span className="dg-fi dg-fi-static truncate">{opLabel(op)}</span>
      ) : op === 'between' ? (
        <>
          <input className="dg-fi" type={inType} step="any" aria-label={title} value={filter?.a ?? ''} onChange={(e) => set({ a: e.target.value })} placeholder={t('grid.from')} />
          <input className="dg-fi" type={inType} step="any" aria-label={title} value={filter?.b ?? ''} onChange={(e) => set({ b: e.target.value })} placeholder={t('grid.to')} />
        </>
      ) : (
        <input className="dg-fi" type={inType} step="any" aria-label={title} value={filter?.a ?? ''} onChange={(e) => set({ a: e.target.value })} placeholder={t('grid.filter_ph')} />
      )}
      {filter && <button type="button" className="dg-x" aria-label={t('grid.clear_filter')} onClick={() => onChange(undefined)}><X size={12} /></button>}
      {opMenu}
    </div>
  );
}

function OptionsPopover({ anchor, onClose, options, selected, onChange }: {
  anchor: HTMLElement; onClose: () => void; options: Opt[]; selected: string[]; onChange: (l: string[]) => void;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const shown = useMemo(() => { const nq = norm(q); return nq ? options.filter((o) => norm(o.label).includes(nq)) : options; }, [options, q]);
  const toggle = (v: string) => onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  return (
    <Popover anchor={anchor} onClose={onClose} minWidth={230}>
      <div className="pop-body">
        {options.length > 8 && <input className="input" autoFocus placeholder={t('grid.search_options')} value={q} onChange={(e) => setQ(e.target.value)} />}
        <div className="row spread pop-links">
          <button type="button" className="link-btn" onClick={() => onChange(Array.from(new Set([...selected, ...shown.map((o) => o.value)])))}>{t('grid.select_all')}</button>
          <button type="button" className="link-btn" onClick={() => onChange([])}>{t('grid.select_none')}</button>
        </div>
        <ul className="pop-list">
          {shown.map((o) => (
            <li key={o.value}>
              <label className="checkbox"><input type="checkbox" checked={selected.includes(o.value)} onChange={() => toggle(o.value)} /><span>{o.label || '—'}</span></label>
            </li>
          ))}
          {shown.length === 0 && <li className="muted">{t('grid.no_options')}</li>}
        </ul>
      </div>
    </Popover>
  );
}
