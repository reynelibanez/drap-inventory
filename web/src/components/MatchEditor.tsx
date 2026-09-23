import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { api } from '../lib/api';
import { useMeta } from '../lib/meta';
import { Input, Select } from './ui';

/**
 * Editor de "a qué equipos se aplica una regla": tipo, línea del lote, grados, propiedades (marca, RAM...), lote y rango de costo.
 * Sirve tanto para las reglas de reparto (costos / precio del pedido) como para las reglas de precio de lista.
 * Un filtro existe cuando su clave está presente en el objeto; los filtros vacíos no filtran nada (se limpian al guardar).
 */
export type MatchKind = 'typeIds' | 'lineIds' | 'cosmeticGradeIds' | 'functionalGradeIds' | 'specs' | 'unlinked' | 'lotIds' | 'cost';
export type MatchValue = Record<string, any>;
export interface Pickable { id: number; label: string }

export function ChipPicker({ options, value, onChange, disabled, empty }: {
  options: { value: number; label: string }[]; value: number[]; onChange: (v: number[]) => void; disabled?: boolean; empty?: string;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  if (!options.length) return <span className="muted">{empty ?? '—'}</span>;
  // Listas largas (p. ej. los modelos): se buscan escribiendo; siempre se ven los ya elegidos.
  const long = options.length > 30;
  const term = q.trim().toLowerCase();
  const shown = !long ? options : options.filter((o) => value.includes(o.value) || (term ? o.label.toLowerCase().includes(term) : false));
  return (
    <div className="stack sm">
      {long && !disabled && <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`${t('common.search')}… (${options.length})`} />}
    <div className="pick-chips">
      {shown.slice(0, 200).map((o) => {
        const on = value.includes(o.value);
        return (
          <button key={o.value} type="button" disabled={disabled} className={`pick-chip ${on ? 'on' : ''}`} aria-pressed={on}
            onClick={() => onChange(on ? value.filter((x) => x !== o.value) : [...value, o.value])}>{o.label}</button>
        );
      })}
    </div>
    </div>
  );
}

const present = (m: MatchValue, k: MatchKind) => (k === 'cost' ? m.costMin !== undefined || m.costMax !== undefined : m[k] !== undefined && m[k] !== false);

export function MatchEditor({ value, onChange, kinds, lines, disabled }: {
  value: MatchValue; onChange: (v: MatchValue) => void; kinds: MatchKind[]; lines?: Pickable[]; disabled?: boolean;
}) {
  const { t } = useTranslation();
  const meta = useMeta();
  const lotsQ = useQuery({ queryKey: ['lots', 'pick'], queryFn: () => api.get<{ items: { id: number; code: string }[] }>('/lots?pageSize=300'), enabled: kinds.includes('lotIds') });
  const active = kinds.filter((k) => present(value, k));
  const missing = kinds.filter((k) => !present(value, k) && (k !== 'lineIds' || !!lines?.length));

  const set = (patch: MatchValue) => onChange({ ...value, ...patch });
  const drop = (k: MatchKind) => {
    const n = { ...value };
    if (k === 'cost') { delete n.costMin; delete n.costMax; } else delete n[k];
    onChange(n);
  };
  const add = (k: MatchKind) => {
    if (k === 'unlinked') set({ unlinked: true });
    else if (k === 'specs') set({ specs: {} });
    else if (k === 'cost') set({ costMin: null, costMax: null });
    else set({ [k]: [] });
  };

  const typeOpts = meta.typeList().map((ty) => ({ value: ty.id, label: meta.label(ty.name) }));
  const gradeOpts = (cat: string) => meta.catalogOptions(cat, false).map((i) => ({ value: i.id, label: i.code ? `${i.code} — ${meta.label(i.name)}` : meta.label(i.name) }));

  const block = (k: MatchKind, title: string, body: React.ReactNode) => (
    <div key={k} className="match-block">
      <div className="match-head"><span>{title}</span>{!disabled && <button type="button" className="icon-btn" onClick={() => drop(k)} aria-label={t('common.remove')}><X size={14} /></button>}</div>
      {body}
    </div>
  );

  return (
    <div className="match-editor">
      {active.length === 0 && <span className="muted">{t('alloc.match_all')}</span>}
      {active.map((k) => {
        switch (k) {
          case 'typeIds': return block(k, t('alloc.f_type'), <ChipPicker disabled={disabled} options={typeOpts} value={value.typeIds ?? []} onChange={(v) => set({ typeIds: v })} />);
          case 'lineIds': return block(k, t('alloc.f_line'), <ChipPicker disabled={disabled} options={(lines ?? []).map((l) => ({ value: l.id, label: l.label }))} value={value.lineIds ?? []} onChange={(v) => set({ lineIds: v })} />);
          case 'cosmeticGradeIds': return block(k, t('alloc.f_cosmetic'), <ChipPicker disabled={disabled} options={gradeOpts('cosmetic_grade')} value={value.cosmeticGradeIds ?? []} onChange={(v) => set({ cosmeticGradeIds: v })} />);
          case 'functionalGradeIds': return block(k, t('alloc.f_functional'), <ChipPicker disabled={disabled} options={gradeOpts('functional_grade')} value={value.functionalGradeIds ?? []} onChange={(v) => set({ functionalGradeIds: v })} />);
          case 'lotIds': return block(k, t('alloc.f_lot'), <ChipPicker disabled={disabled} options={(lotsQ.data?.items ?? []).map((l) => ({ value: l.id, label: l.code }))} value={value.lotIds ?? []} onChange={(v) => set({ lotIds: v })} />);
          case 'unlinked': return block(k, t('alloc.f_unlinked'), <span className="muted">{t('alloc.f_unlinked_hint')}</span>);
          case 'specs': return block(k, t('alloc.f_specs'), <SpecsFilter value={value.specs ?? {}} onChange={(s) => set({ specs: s })} disabled={disabled} />);
          case 'cost': return block(k, t('alloc.f_cost'), (
            <div className="row gap-sm wrap">
              <Input className="num-input" type="number" min={0} step="0.01" inputMode="decimal" disabled={disabled} placeholder={t('alloc.cost_min')} value={value.costMin ?? ''}
                onChange={(e) => set({ costMin: e.target.value === '' ? null : Number(e.target.value) })} />
              <span className="muted">–</span>
              <Input className="num-input" type="number" min={0} step="0.01" inputMode="decimal" disabled={disabled} placeholder={t('alloc.cost_max')} value={value.costMax ?? ''}
                onChange={(e) => set({ costMax: e.target.value === '' ? null : Number(e.target.value) })} />
            </div>
          ));
        }
      })}
      {!disabled && missing.length > 0 && (
        <Select className="match-add" value="" onChange={(e) => { if (e.target.value) add(e.target.value as MatchKind); }}>
          <option value="">{t('alloc.add_filter')}</option>
          {missing.map((k) => <option key={k} value={k}>{t(`alloc.kind_${k}`)}</option>)}
        </Select>
      )}
    </div>
  );
}

/** Propiedades: una fila por propiedad elegida (marca = Dell o HP, RAM = 16...). */
function SpecsFilter({ value, onChange, disabled }: { value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  const meta = useMeta();
  const [adding, setAdding] = useState('');
  const attrs = meta.data.attributes.filter((a) => a.isActive);
  const keys = Object.keys(value);
  const free = attrs.filter((a) => !keys.includes(a.key));
  const setKey = (k: string, v: unknown) => onChange({ ...value, [k]: v });
  const dropKey = (k: string) => { const n = { ...value }; delete n[k]; onChange(n); };

  return (
    <div className="stack sm">
      {keys.map((k) => {
        const a = meta.attrByKey(k);
        if (!a) return <div key={k} className="row gap-sm"><span className="muted grow">{k}</span>{!disabled && <button type="button" className="icon-btn" onClick={() => dropKey(k)}><X size={14} /></button>}</div>;
        const v = value[k];
        let control: React.ReactNode;
        if (a.dataType === 'select' || a.dataType === 'multiselect') {
          const cur = (Array.isArray(v) ? v : v === undefined || v === '' ? [] : [v]).map(Number);
          control = <ChipPicker disabled={disabled} options={meta.attrChoices(a, false, cur).map((i) => ({ value: i.id, label: i.label }))} value={cur} onChange={(x) => setKey(k, x)} />;
        } else if (a.dataType === 'boolean') {
          control = (
            <Select disabled={disabled} value={v === true ? 'true' : v === false ? 'false' : ''} onChange={(e) => setKey(k, e.target.value === '' ? [] : e.target.value === 'true')}>
              <option value="">—</option><option value="true">{t('common.yes')}</option><option value="false">{t('common.no')}</option>
            </Select>
          );
        } else {
          // Texto/número/fecha: uno o varios valores separados por coma.
          const txt = (Array.isArray(v) ? v : v === undefined ? [] : [v]).join(', ');
          control = (
            <Input disabled={disabled} value={txt} placeholder={t('alloc.spec_values_hint')}
              onChange={(e) => { const parts = e.target.value.split(',').map((s) => s.trim()); setKey(k, parts.some(Boolean) ? parts : []); }} />
          );
        }
        return (
          <div key={k} className="spec-filter">
            <div className="spec-filter-head"><strong>{meta.label(a.label)}</strong>{!disabled && <button type="button" className="icon-btn" onClick={() => dropKey(k)} aria-label={t('common.remove')}><X size={14} /></button>}</div>
            {control}
          </div>
        );
      })}
      {!disabled && (
        <Select value={adding} onChange={(e) => { if (e.target.value) { setKey(e.target.value, []); } setAdding(''); }}>
          <option value="">{t('alloc.add_spec')}</option>
          {free.map((a) => <option key={a.key} value={a.key}>{meta.label(a.label)}</option>)}
        </Select>
      )}
    </div>
  );
}

/** Texto corto que resume un filtro (para mostrarlo en un renglón de resultados). */
export function useMatchSummary() {
  const { t } = useTranslation();
  const meta = useMeta();
  return (m: MatchValue, lines?: Pickable[]): string => {
    const parts: string[] = [];
    if (m.typeIds?.length) parts.push(m.typeIds.map((i: number) => meta.typeName(i)).join(' / '));
    if (m.lineIds?.length) parts.push(m.lineIds.map((i: number) => lines?.find((l) => l.id === i)?.label ?? `#${i}`).join(', '));
    if (m.unlinked) parts.push(t('alloc.f_unlinked'));
    if (m.cosmeticGradeIds?.length) parts.push(m.cosmeticGradeIds.map((i: number) => meta.item(i)?.code ?? meta.name(i)).join('/'));
    if (m.functionalGradeIds?.length) parts.push(m.functionalGradeIds.map((i: number) => meta.item(i)?.code ?? meta.name(i)).join('/'));
    for (const [k, v] of Object.entries(m.specs ?? {})) {
      const a = meta.attrByKey(k);
      if (!a || v === undefined || (Array.isArray(v) && !v.length)) continue;
      const vals = (Array.isArray(v) ? v : [v]).map((x) => (a.dataType === 'select' || a.dataType === 'multiselect' ? meta.name(Number(x)) : String(x))).join('/');
      parts.push(`${meta.label(a.label)}: ${vals}`);
    }
    return parts.join(' · ');
  };
}
