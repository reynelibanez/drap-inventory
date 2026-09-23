import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { BASES, METHODS, methodNeedsValue, newRule, type AllocPlan, type AllocRule, type AllocWarning, type Base, type Method, type RuleUse } from '../lib/alloc';
import { useFmt } from '../lib/useFmt';
import { Button, Checkbox, Field, Input, Select } from './ui';
import { MatchEditor, type MatchKind, type Pickable } from './MatchEditor';

/**
 * Editor del plan de reparto: lista ORDENADA de reglas ("a estos equipos, tanto") y qué hacer con lo que ninguna regla reclama.
 * La primera regla activa que corresponde a un grupo de equipos es la que manda.
 */
export function AllocationEditor({ plan, onChange, mode, currency, lines, use, warnings, disabled, allowByCost = false }: {
  plan: AllocPlan; onChange: (p: AllocPlan) => void;
  /** cost = costos de un lote · price = precio total de un pedido */
  mode: 'cost' | 'price';
  currency: string;
  /** Líneas entre las que se puede elegir en un filtro (líneas del lote o del pedido). */
  lines?: Pickable[];
  /** Lo que reclamó cada regla en el último cálculo. */
  use?: Record<string, RuleUse>;
  warnings?: AllocWarning[];
  disabled?: boolean;
  /** "Proporcional al costo": solo tiene sentido si se pueden ver los costos. */
  allowByCost?: boolean;
}) {
  const { t } = useTranslation();
  const f = useFmt();
  const kinds: MatchKind[] = mode === 'cost'
    ? ['typeIds', 'lineIds', 'specs', 'cosmeticGradeIds', 'functionalGradeIds', 'unlinked']
    : ['typeIds', 'lineIds', 'specs', 'cosmeticGradeIds', 'functionalGradeIds'];
  const methods = METHODS.filter((m) => m !== 'by_cost' || allowByCost);
  const bases = BASES.filter((b) => b !== 'by_cost' || allowByCost);

  const setRules = (rules: AllocRule[]) => onChange({ ...plan, rules });
  const patch = (id: string, p: Partial<AllocRule>) => setRules(plan.rules.map((r) => (r.id === id ? { ...r, ...p } : r)));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= plan.rules.length) return;
    const rs = [...plan.rules];
    [rs[i], rs[j]] = [rs[j], rs[i]];
    setRules(rs);
  };
  const unused = new Set(warnings?.filter((w) => w.code === 'rule_unused' || w.code === 'empty_group').map((w) => (w as { ruleId: string }).ruleId));

  const valueUnit = (m: Method) => (m === 'percent' ? '%' : m === 'weight' ? '×' : currency);

  return (
    <div className="stack">
      {plan.rules.length === 0 && <p className="muted">{t(mode === 'cost' ? 'alloc.no_rules_cost' : 'alloc.no_rules_price')}</p>}

      {plan.rules.map((r, i) => {
        const u = use?.[r.id];
        return (
          <div key={r.id} className={`rule-card ${r.enabled ? '' : 'off'} ${unused.has(r.id) && r.enabled ? 'unused' : ''}`}>
            <div className="rule-head">
              <span className="rule-no">{i + 1}</span>
              <Input className="rule-name" disabled={disabled} value={r.name ?? ''} placeholder={t('alloc.rule_name_ph')} maxLength={80} onChange={(e) => patch(r.id, { name: e.target.value })} />
              <Checkbox disabled={disabled} checked={r.enabled} onChange={(v) => patch(r.id, { enabled: v })} label={t('alloc.rule_on')} />
              {!disabled && (
                <span className="row gap-sm">
                  <button type="button" className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} aria-label={t('alloc.move_up')}><ArrowUp size={16} /></button>
                  <button type="button" className="icon-btn" disabled={i === plan.rules.length - 1} onClick={() => move(i, 1)} aria-label={t('alloc.move_down')}><ArrowDown size={16} /></button>
                  <button type="button" className="icon-btn" onClick={() => setRules(plan.rules.filter((x) => x.id !== r.id))} aria-label={t('common.delete')}><Trash2 size={16} /></button>
                </span>
              )}
            </div>

            <div className="rule-body">
              <div className="rule-col">
                <div className="rule-label">{t('alloc.applies_to')}</div>
                <MatchEditor value={r.match} onChange={(m) => patch(r.id, { match: m })} kinds={kinds} lines={lines} disabled={disabled} />
              </div>
              <div className="rule-col">
                <div className="rule-label">{t('alloc.how')}</div>
                <Select disabled={disabled} value={r.method} onChange={(e) => patch(r.id, { method: e.target.value as Method })}>
                  {methods.map((m) => <option key={m} value={m}>{t(`alloc.m_${m}`)}</option>)}
                </Select>
                {methodNeedsValue(r.method) && (
                  <div className="rule-value">
                    <Input type="number" min={0} step="any" inputMode="decimal" disabled={disabled} value={Number.isFinite(r.value) ? r.value : ''}
                      onChange={(e) => patch(r.id, { value: e.target.value === '' ? 0 : Number(e.target.value) })} onFocus={(e) => e.currentTarget.select()} />
                    <span className="muted">{valueUnit(r.method)}</span>
                  </div>
                )}
                <span className="field-hint">{t(`alloc.mh_${r.method}`)}</span>
              </div>
            </div>

            {r.enabled && (
              <div className="rule-foot">
                {u ? <span>{t('alloc.rule_use', { groups: u.targets, qty: u.qty, total: f.money(u.total, currency) })}</span>
                  : use ? <span className="warn-text">{t('alloc.rule_unused')}</span> : null}
              </div>
            )}
          </div>
        );
      })}

      {!disabled && (
        <div>
          <Button size="sm" icon={<Plus size={14} />} onClick={() => setRules([...plan.rules, newRule()])}>{t('alloc.add_rule')}</Button>
        </div>
      )}

      <Field label={t('alloc.base')} hint={t('alloc.base_hint')}>
        <Select disabled={disabled} value={plan.base} onChange={(e) => onChange({ ...plan, base: e.target.value as Base })}>
          {bases.map((b) => <option key={b} value={b}>{t(`alloc.b_${b}`)}</option>)}
        </Select>
      </Field>
    </div>
  );
}
