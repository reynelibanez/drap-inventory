import { ArrowDown, ArrowUp, Copy, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useMeta } from '../lib/meta';
import { Button, Checkbox, Field, Select } from './ui';

/** Regla de un nivel de rack (espejo de rack_level_rules): qué va en ese nivel y cómo se agrupa. */
export interface LevelRule {
  typeId: number | null;
  cosmeticGradeIds: number[];
  functionalGradeIds: number[];
  groupBy: string[];
  strict: boolean;
}

export const emptyRule = (): LevelRule => ({ typeId: null, cosmeticGradeIds: [], functionalGradeIds: [], groupBy: [], strict: true });
export const cloneRule = (r: LevelRule): LevelRule => ({ ...r, cosmeticGradeIds: [...r.cosmeticGradeIds], functionalGradeIds: [...r.functionalGradeIds], groupBy: [...r.groupBy] });
export const isEmptyRule = (r: LevelRule) => r.typeId === null && !r.cosmeticGradeIds.length && !r.functionalGradeIds.length && !r.groupBy.length;

/** Resumen corto y legible: "Laptop · A, B · Marca › Modelo". */
export function useRuleSummary() {
  const meta = useMeta();
  const { t } = useTranslation();
  return (r: LevelRule | null | undefined): string => {
    if (!r || isEmptyRule(r)) return t('locations.rule.none');
    const parts: string[] = [];
    parts.push(r.typeId ? meta.typeName(r.typeId) : t('locations.rule.any_type'));
    if (r.cosmeticGradeIds.length) parts.push(r.cosmeticGradeIds.map((id) => meta.item(id)?.code || meta.name(id)).join(', '));
    if (r.functionalGradeIds.length) parts.push('F: ' + r.functionalGradeIds.map((id) => meta.item(id)?.code || meta.name(id)).join(', '));
    if (r.groupBy.length) parts.push(r.groupBy.map((k) => { const a = meta.attrByKey(k); return a ? meta.label(a.label) : k; }).join(' › ') + (r.strict ? '' : ` (${t('locations.rule.mix_ok')})`));
    return parts.join(' · ');
  };
}

export function LevelRuleEditor({ rule, onChange, onCopyAll }: { rule: LevelRule; onChange: (r: LevelRule) => void; onCopyAll?: () => void }) {
  const { t } = useTranslation();
  const meta = useMeta();
  const set = (p: Partial<LevelRule>) => onChange({ ...rule, ...p });
  const toggle = (list: number[], id: number, on: boolean) => (on ? [...new Set([...list, id])] : list.filter((x) => x !== id));

  // Propiedades que se pueden usar para agrupar: las del tipo elegido, o todas si el nivel admite cualquier tipo.
  const available = (rule.typeId ? meta.typeAttrs(rule.typeId).map((x) => x.attr) : meta.data.attributes.filter((a) => a.isActive))
    .filter((a) => !rule.groupBy.includes(a.key));

  const move = (i: number, d: -1 | 1) => {
    const g = [...rule.groupBy];
    const j = i + d;
    if (j < 0 || j >= g.length) return;
    [g[i], g[j]] = [g[j], g[i]];
    set({ groupBy: g });
  };

  return (
    <div className="stack" style={{ padding: 12, background: 'var(--surface-2)', borderRadius: 8 }}>
      <p className="muted">{t('locations.rule.hint')}</p>
      <div className="grid grid-2">
        <Field label={t('locations.rule.type')}>
          <Select value={rule.typeId ?? ''} onChange={(e) => {
            const typeId = e.target.value ? Number(e.target.value) : null;
            // Al cambiar de tipo se quitan las propiedades que ya no le pertenecen.
            const keep = typeId ? new Set(meta.typeAttrs(typeId).map((x) => x.attr.key)) : null;
            set({ typeId, groupBy: keep ? rule.groupBy.filter((k) => keep.has(k)) : rule.groupBy });
          }}>
            <option value="">{t('locations.rule.any_type')}</option>
            {meta.typeList().map((ty) => <option key={ty.id} value={ty.id}>{meta.label(ty.name)}</option>)}
          </Select>
        </Field>
      </div>
      <div className="grid grid-2">
        <Field label={t('locations.rule.cosmetic')} hint={t('locations.rule.grades_hint')}>
          <div className="row wrap gap-sm">
            {meta.catalogOptions('cosmetic_grade', false).map((it) => (
              <Checkbox key={it.id} checked={rule.cosmeticGradeIds.includes(it.id)} label={meta.nameWithCode(it.id)} onChange={(v) => set({ cosmeticGradeIds: toggle(rule.cosmeticGradeIds, it.id, v) })} />
            ))}
          </div>
        </Field>
        <Field label={t('locations.rule.functional')} hint={t('locations.rule.grades_hint')}>
          <div className="row wrap gap-sm">
            {meta.catalogOptions('functional_grade', false).map((it) => (
              <Checkbox key={it.id} checked={rule.functionalGradeIds.includes(it.id)} label={meta.nameWithCode(it.id)} onChange={(v) => set({ functionalGradeIds: toggle(rule.functionalGradeIds, it.id, v) })} />
            ))}
          </div>
        </Field>
      </div>
      <Field label={t('locations.rule.group_by')} hint={t('locations.rule.group_hint')}>
        <div className="stack sm">
          {rule.groupBy.length === 0 && <span className="muted">{t('locations.rule.no_group')}</span>}
          {rule.groupBy.map((k, i) => {
            const a = meta.attrByKey(k);
            return (
              <div key={k} className="row gap-sm">
                <span className="chip"><strong>{i + 1}</strong>&nbsp;{a ? meta.label(a.label) : k}</span>
                <button type="button" className="icon-btn" title={t('locations.rule.up')} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={14} /></button>
                <button type="button" className="icon-btn" title={t('locations.rule.down')} disabled={i === rule.groupBy.length - 1} onClick={() => move(i, 1)}><ArrowDown size={14} /></button>
                <button type="button" className="icon-btn" title={t('common.delete')} onClick={() => set({ groupBy: rule.groupBy.filter((x) => x !== k) })}><X size={14} /></button>
              </div>
            );
          })}
          {available.length > 0 && (
            <Select value="" onChange={(e) => { if (e.target.value) set({ groupBy: [...rule.groupBy, e.target.value] }); }} style={{ maxWidth: 260 }}>
              <option value="">{t('locations.rule.add_prop')}</option>
              {available.map((a) => <option key={a.key} value={a.key}>{meta.label(a.label)}</option>)}
            </Select>
          )}
        </div>
      </Field>
      <Checkbox checked={rule.strict} onChange={(v) => set({ strict: v })} label={t('locations.rule.strict')} disabled={!rule.groupBy.length} />
      <div className="row gap-sm">
        {onCopyAll && <Button size="sm" icon={<Copy size={14} />} onClick={onCopyAll}>{t('locations.rule.copy_all')}</Button>}
        <Button size="sm" variant="ghost" onClick={() => onChange(emptyRule())}>{t('locations.rule.clear')}</Button>
      </div>
    </div>
  );
}
