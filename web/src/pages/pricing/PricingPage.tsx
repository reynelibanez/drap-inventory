import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, Calculator, Eye, Plus, Save, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useFmt } from '../../lib/useFmt';
import { Alert } from '../../components/Alert';
import { Badge, Button, Card, Checkbox, Empty, Field, Input, PageHeader, Select, Spinner, useConfirm, useErr, useToast } from '../../components/ui';
import { MatchEditor, type MatchKind, type MatchValue } from '../../components/MatchEditor';
import { ROUNDINGS } from '../../components/PricingModals';

const METHODS = ['fixed', 'markup_pct', 'margin_pct', 'add_amount'] as const;
type PMethod = (typeof METHODS)[number];
type Rounding = (typeof ROUNDINGS)[number];

interface ServerRule { id: number; name: string; enabled: boolean; match: MatchValue; method: PMethod; value: number; rounding: Rounding; minPrice: number | null }
interface Rule { key: string; name: string; enabled: boolean; match: MatchValue; method: PMethod; value: string; rounding: Rounding; minPrice: string }
interface Preview { considered: number; changed: number; skippedManual: number; changes: { unitId: number; code: string; from: number | null; to: number | null; source: string | null; ruleId: number | null }[] }

const KINDS: MatchKind[] = ['typeIds', 'specs', 'cosmeticGradeIds', 'functionalGradeIds', 'lotIds', 'cost'];
let seq = 0;
const newKey = () => `p${Date.now().toString(36)}${seq++}`;
const fromServer = (r: ServerRule): Rule => ({ key: newKey(), name: r.name, enabled: r.enabled, match: r.match ?? {}, method: r.method, value: String(r.value), rounding: r.rounding, minPrice: r.minPrice === null ? '' : String(r.minPrice) });

/** Deja en el filtro solo lo que realmente filtra. */
function cleanMatch(m: MatchValue): MatchValue {
  const out: MatchValue = {};
  for (const k of ['typeIds', 'cosmeticGradeIds', 'functionalGradeIds', 'lotIds'] as const) if (m[k]?.length) out[k] = m[k];
  const specs = Object.fromEntries(Object.entries((m.specs ?? {}) as Record<string, unknown>)
    .map(([k, v]) => [k, Array.isArray(v) ? v.filter((x) => x !== '') : v] as const)
    .filter(([, v]) => !(v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0))));
  if (Object.keys(specs).length) out.specs = specs;
  if (typeof m.costMin === 'number') out.costMin = m.costMin;
  if (typeof m.costMax === 'number') out.costMax = m.costMax;
  return out;
}
const toBody = (rules: Rule[]) => rules.map((r) => ({
  name: r.name.trim(), enabled: r.enabled, match: cleanMatch(r.match), method: r.method, value: Math.max(0, Number(r.value) || 0),
  rounding: r.rounding, minPrice: r.minPrice.trim() === '' ? null : Math.max(0, Number(r.minPrice) || 0),
}));

/** Reglas de precio de lista: "los laptops Dell con costo entre X y Y valen costo + 30 %, redondeado a .99". */
export default function PricingPage() {
  const { t } = useTranslation();
  const { can, company } = useAuth();
  const f = useFmt();
  const qc = useQueryClient();
  const err = useErr();
  const toast = useToast();
  const confirm = useConfirm();
  const cur = company?.currency ?? 'USD';
  const q = useQuery({ queryKey: ['price-rules'], queryFn: () => api.get<{ rules: ServerRule[]; autoPrice: boolean; canManage: boolean }>('/price-rules') });
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [scope, setScope] = useState<'available' | 'unsold'>('available');
  const [overwrite, setOverwrite] = useState(false);
  const [prev, setPrev] = useState<Preview | null>(null);
  const loaded = useRef(false);
  useEffect(() => { if (q.data && !loaded.current) { loaded.current = true; setRules(q.data.rules.map(fromServer)); } }, [q.data]);

  const saved = useMemo(() => JSON.stringify(q.data ? toBody(q.data.rules.map(fromServer)) : []), [q.data]);
  const dirty = !!rules && JSON.stringify(toBody(rules)) !== saved;
  const set = (fn: (r: Rule[]) => Rule[]) => { setRules(fn(rules ?? [])); setPrev(null); };
  const patch = (key: string, p: Partial<Rule>) => set((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));
  const move = (i: number, d: -1 | 1) => set((rs) => { const j = i + d; if (j < 0 || j >= rs.length) return rs; const c = [...rs]; [c[i], c[j]] = [c[j], c[i]]; return c; });

  const refresh = () => { for (const k of ['units', 'unit', 'lot', 'order', 'orders']) void qc.invalidateQueries({ queryKey: [k] }); };
  const save = useMutation({
    mutationFn: () => api.put<{ rules: ServerRule[] }>('/price-rules', { rules: toBody(rules!) }),
    onSuccess: (r) => { qc.setQueryData(['price-rules'], (o: any) => ({ ...o, rules: r.rules })); setRules(r.rules.map(fromServer)); toast.success(t('common.saved')); },
    onError: (e) => toast.error(err(e)),
  });
  const auto = useMutation({
    mutationFn: (enabled: boolean) => api.put('/price-rules/auto', { enabled }),
    onSuccess: (_, enabled) => { qc.setQueryData(['price-rules'], (o: any) => ({ ...o, autoPrice: enabled })); toast.success(t('common.saved')); }, onError: (e) => toast.error(err(e)),
  });
  const preview = useMutation({
    mutationFn: () => api.post<Preview>('/prices/preview', { scope, overwriteManual: overwrite, rules: toBody(rules!) }),
    onSuccess: setPrev, onError: (e) => toast.error(err(e)),
  });
  const recalc = useMutation({
    mutationFn: async () => {
      if (dirty) await save.mutateAsync();
      return api.post<Preview>('/prices/recalculate', { scope, overwriteManual: overwrite });
    },
    onSuccess: (r) => { toast.success(t('pricing.recalculated', { count: r.changed })); setPrev(null); refresh(); }, onError: (e) => toast.error(err(e)),
  });

  if (q.isLoading || !rules) return <Spinner />;
  if (!q.data) return <Empty title={t('errors.generic')} />;
  const canManage = can('prices.manage');

  async function doRecalc() {
    if (await confirm({ title: t('pricing.recalc_title'), message: t(overwrite ? 'pricing.recalc_msg_overwrite' : 'pricing.recalc_msg'), confirmLabel: t('pricing.recalc') })) recalc.mutate();
  }
  const valueLabel = (m: PMethod) => (m === 'fixed' || m === 'add_amount' ? cur : '%');

  return (
    <>
      <PageHeader title={t('pricing.title')} subtitle={t('pricing.subtitle')} actions={<Link className="btn btn-secondary btn-md" to="/units">{t('pricing.go_units')}</Link>} />
      <div className="stack">
        <Card title={t('pricing.auto_title')}>
          <div className="stack sm">
            <Checkbox disabled={!canManage || auto.isPending} checked={q.data.autoPrice} onChange={(v) => auto.mutate(v)} label={t('pricing.auto_label')} />
            <p className="muted">{t('pricing.auto_hint')}</p>
          </div>
        </Card>

        <Card title={t('pricing.rules_title')} actions={dirty && <Badge tone="warn">{t('pricing.unsaved')}</Badge>}>
          <div className="stack">
            <p className="muted">{t('pricing.rules_intro')}</p>
            {rules.length === 0 && <p className="muted">{t('pricing.no_rules')}</p>}
            {rules.map((r, i) => (
              <div key={r.key} className={`rule-card ${r.enabled ? '' : 'off'}`}>
                <div className="rule-head">
                  <span className="rule-no">{i + 1}</span>
                  <Input className="rule-name" disabled={!canManage} value={r.name} maxLength={80} placeholder={t('alloc.rule_name_ph')} onChange={(e) => patch(r.key, { name: e.target.value })} />
                  <Checkbox disabled={!canManage} checked={r.enabled} onChange={(v) => patch(r.key, { enabled: v })} label={t('alloc.rule_on')} />
                  {canManage && (
                    <span className="row gap-sm">
                      <button type="button" className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} aria-label={t('alloc.move_up')}><ArrowUp size={16} /></button>
                      <button type="button" className="icon-btn" disabled={i === rules.length - 1} onClick={() => move(i, 1)} aria-label={t('alloc.move_down')}><ArrowDown size={16} /></button>
                      <button type="button" className="icon-btn" onClick={() => set((rs) => rs.filter((x) => x.key !== r.key))} aria-label={t('common.delete')}><Trash2 size={16} /></button>
                    </span>
                  )}
                </div>
                <div className="rule-body">
                  <div className="rule-col">
                    <div className="rule-label">{t('alloc.applies_to')}</div>
                    <MatchEditor value={r.match} onChange={(m) => patch(r.key, { match: m })} kinds={KINDS} disabled={!canManage} />
                  </div>
                  <div className="rule-col">
                    <div className="rule-label">{t('pricing.price_is')}</div>
                    <Select disabled={!canManage} value={r.method} onChange={(e) => patch(r.key, { method: e.target.value as PMethod })}>
                      {METHODS.map((m) => <option key={m} value={m}>{t(`pricing.pr_${m}`)}</option>)}
                    </Select>
                    <div className="rule-value">
                      <Input type="number" min={0} step="any" inputMode="decimal" disabled={!canManage} value={r.value} onChange={(e) => patch(r.key, { value: e.target.value })} onFocus={(e) => e.currentTarget.select()} />
                      <span className="muted">{valueLabel(r.method)}</span>
                    </div>
                    <span className="field-hint">{t(`pricing.prh_${r.method}`)}</span>
                    <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', marginTop: 8 }}>
                      <Field label={t('pricing.rounding')}>
                        <Select disabled={!canManage} value={r.rounding} onChange={(e) => patch(r.key, { rounding: e.target.value as Rounding })}>{ROUNDINGS.map((x) => <option key={x} value={x}>{t(`pricing.r_${x}`)}</option>)}</Select>
                      </Field>
                      <Field label={t('pricing.min_price', { currency: cur })}>
                        <Input type="number" min={0} step="0.01" inputMode="decimal" disabled={!canManage} value={r.minPrice} onChange={(e) => patch(r.key, { minPrice: e.target.value })} />
                      </Field>
                    </div>
                  </div>
                </div>
              </div>
            ))}
            {canManage && (
              <div className="row spread wrap">
                <Button size="sm" icon={<Plus size={14} />} onClick={() => set((rs) => [...rs, { key: newKey(), name: '', enabled: true, match: {}, method: 'markup_pct', value: '30', rounding: 'x99', minPrice: '' }])}>{t('alloc.add_rule')}</Button>
                <span className="row gap-sm">
                  {dirty && <Button variant="ghost" onClick={() => { setRules(q.data!.rules.map(fromServer)); setPrev(null); }}>{t('costs.discard')}</Button>}
                  <Button variant="primary" icon={<Save size={16} />} disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>{t('common.save')}</Button>
                </span>
              </div>
            )}
          </div>
        </Card>

        {canManage && (
          <Card title={t('pricing.apply_title')}>
            <div className="stack">
              <p className="muted">{t('pricing.apply_intro')}</p>
              <div className="form-grid">
                <Field label={t('pricing.scope')}>
                  <Select value={scope} onChange={(e) => { setScope(e.target.value as 'available' | 'unsold'); setPrev(null); }}>
                    <option value="available">{t('pricing.scope_available')}</option><option value="unsold">{t('pricing.scope_unsold')}</option>
                  </Select>
                </Field>
                <Field label=" " className="field-check"><Checkbox checked={overwrite} onChange={(v) => { setOverwrite(v); setPrev(null); }} label={t('pricing.overwrite')} /><span className="field-hint">{t('pricing.overwrite_hint')}</span></Field>
              </div>
              <div className="row gap-sm wrap">
                <Button icon={<Eye size={16} />} loading={preview.isPending} onClick={() => preview.mutate()}>{t('pricing.preview')}</Button>
                <Button variant="primary" icon={<Calculator size={16} />} loading={recalc.isPending} onClick={doRecalc}>{t('pricing.recalc')}</Button>
              </div>
              {prev && (
                <div className="stack sm">
                  <Alert kind="info">{t('pricing.preview_result', { changed: prev.changed, considered: prev.considered, manual: prev.skippedManual })}</Alert>
                  {prev.changes.length > 0 && (
                    <div className="table-wrap" style={{ maxHeight: 300, overflowY: 'auto' }}>
                      <table className="table">
                        <thead><tr><th>{t('common.code')}</th><th className="num">{t('pricing.plan_before')}</th><th className="num">{t('pricing.plan_after')}</th></tr></thead>
                        <tbody>{prev.changes.map((c) => (
                          <tr key={c.unitId}><td><Link to={`/units/${c.unitId}`} className="mono">{c.code}</Link></td><td className="num muted">{c.from === null ? '—' : f.money(c.from, cur)}</td><td className="num"><strong>{c.to === null ? '—' : f.money(c.to, cur)}</strong></td></tr>
                        ))}</tbody>
                      </table>
                    </div>
                  )}
                  {prev.changed > prev.changes.length && <p className="muted">{t('pricing.plan_more', { count: prev.changed - prev.changes.length })}</p>}
                </div>
              )}
            </div>
          </Card>
        )}
      </div>
    </>
  );
}
