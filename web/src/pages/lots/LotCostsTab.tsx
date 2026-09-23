import { useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, BookmarkPlus, CalendarCheck, Calculator, CheckCircle2, Pin, Plus, Trash2, Undo2 } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useMeta, type Specs } from '../../lib/meta';
import { useFmt } from '../../lib/useFmt';
import { useIsMobile } from '../../lib/useIsMobile';
import { cleanPlan, EMPTY_PLAN, newRule, round2, ruleUse, type AllocPlan, type AllocSummary, type AllocWarning } from '../../lib/alloc';
import { Alert } from '../../components/Alert';
import { Badge, Button, Card, Checkbox, Empty, Field, Input, Modal, Select, Spinner, useConfirm, useDebounced, useErr, useToast } from '../../components/ui';
import { SpecChips, TypeLabel } from '../../components/fields';
import { AllocationEditor } from '../../components/AllocationEditor';

interface CostRow {
  key: string; kind: 'line' | 'group'; lineId: number | null; lineNo: number | null; typeId: number; specs: Specs; expected: number | null; counted: number | null;
  units: number; frozenQty: number; qty: number; perUnit: number; total: number; ruleId: string | null; currentUnitCost: number | null;
}
interface Extra { id?: number; label: string; amount: number; distribute: boolean }
interface Overview {
  currency: string; merchandise: number | null; extras: Extra[]; extrasTotal: number; landed: number; pool: number; plan: AllocPlan;
  status: 'none' | 'ok' | 'stale'; appliedAt: string | null; rows: CostRow[]; summary: AllocSummary; warnings: AllocWarning[];
  stats: { units: number; withCost: number; manual: number; sum: number | null };
}
interface Draft { merchandise: string; extras: { label: string; amount: string; distribute: boolean }[]; plan: AllocPlan }
interface Template { id: number; name: string; plan: AllocPlan }

const toDraft = (o: Overview): Draft => ({
  merchandise: o.merchandise === null ? '' : String(o.merchandise),
  extras: o.extras.map((e) => ({ label: e.label, amount: String(e.amount), distribute: e.distribute })),
  plan: o.plan,
});
const num = (s: string) => (s.trim() === '' ? 0 : Math.max(0, Number(s) || 0));
const body = (d: Draft) => ({
  totalCost: d.merchandise.trim() === '' ? null : num(d.merchandise),
  extras: d.extras.filter((e) => e.label.trim()).map((e) => ({ label: e.label.trim(), amount: round2(num(e.amount)), distribute: e.distribute })),
  plan: cleanPlan(d.plan),
});

const QUICK = ['freight', 'duties', 'taxes', 'insurance', 'handling'] as const;

/** Pestaña "Costos" de un lote: cuánto costó, qué costos extra tiene y cómo se reparte entre los equipos. */
export default function LotCostsTab({ lotId }: { lotId: number }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const meta = useMeta();
  const f = useFmt();
  const qc = useQueryClient();
  const err = useErr();
  const toast = useToast();
  const confirm = useConfirm();
  const mobile = useIsMobile();
  const canManage = can('costs.manage');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [tpl, setTpl] = useState(false);

  const base = useQuery({ queryKey: ['lot-costs', lotId], queryFn: () => api.get<Overview>(`/lots/${lotId}/costs`) });
  const dbody = draft ? JSON.stringify(body(draft)) : '';
  const debounced = useDebounced(dbody, 350);
  const preview = useQuery({
    queryKey: ['lot-costs-preview', lotId, debounced],
    queryFn: () => api.post<Overview>(`/lots/${lotId}/costs/preview`, JSON.parse(debounced)),
    enabled: !!draft && !!debounced && canManage,
    placeholderData: keepPreviousData,
  });

  const shown = draft && preview.data ? preview.data : base.data;
  const view: Draft | null = draft ?? (base.data ? toDraft(base.data) : null);
  const currency = shown?.currency ?? '';

  const lines = useMemo(() => (shown?.rows ?? []).filter((r) => r.kind === 'line').map((r) => ({
    id: r.lineId!, label: `#${r.lineNo} · ${meta.typeName(r.typeId)}${meta.describe(r.typeId, r.specs).length ? ' · ' + meta.describe(r.typeId, r.specs).join(' ') : ''}`,
  })), [shown?.rows, meta]);
  const use = useMemo(() => ruleUse(shown?.rows ?? []), [shown?.rows]);
  const ruleLabel = (id: string | null) => {
    if (!id || !view) return null;
    const i = view.plan.rules.findIndex((r) => r.id === id);
    return i < 0 ? null : view.plan.rules[i].name?.trim() || t('alloc.rule_n', { n: i + 1 });
  };

  const edit = (fn: (d: Draft) => Draft) => { if (view) setDraft(fn(view)); };

  const done = (o: Overview) => {
    qc.setQueryData(['lot-costs', lotId], o);
    setDraft(null);
    for (const k of ['lot', 'lots', 'units', 'unit', 'orders', 'order']) void qc.invalidateQueries({ queryKey: [k] });
  };
  const save = useMutation({
    mutationFn: (apply: boolean) => api.put<Overview>(`/lots/${lotId}/costs`, { ...body(view!), apply }),
    onSuccess: (o, apply) => { done(o); toast.success(t(apply ? 'costs.applied_ok' : 'common.saved')); },
    onError: (e) => toast.error(err(e)),
  });
  const reapply = useMutation({
    mutationFn: () => api.put<Overview>(`/lots/${lotId}/costs`, { plan: cleanPlan(base.data!.plan), apply: true }),
    onSuccess: (o) => { done(o); toast.success(t('costs.applied_ok')); }, onError: (e) => toast.error(err(e)),
  });
  const clear = useMutation({
    mutationFn: () => api.post<Overview>(`/lots/${lotId}/costs/clear`),
    onSuccess: (o) => { done(o); toast.success(t('costs.cleared_ok')); }, onError: (e) => toast.error(err(e)),
  });

  if (base.isLoading) return <Spinner />;
  if (!base.data || !shown || !view) return <Empty title={t('errors.generic')} />;
  const o = base.data;
  const dirty = !!draft;
  const S = shown.summary;
  const totalUnits = shown.rows.reduce((a, r) => a + r.qty + r.frozenQty, 0);
  const avg = totalUnits > 0 ? shown.landed / totalUnits : null;

  /** Fija el costo de una línea/grupo a mano: agrega una regla al principio (manda sobre las demás). */
  const pin = (r: CostRow) => edit((d) => ({
    ...d,
    plan: {
      ...d.plan,
      rules: [newRule({
        name: r.kind === 'line' ? t('costs.pin_line_name', { n: r.lineNo }) : t('costs.pin_group_name', { type: meta.typeName(r.typeId) }),
        match: r.kind === 'line' ? { lineIds: [r.lineId!] } : { unlinked: true, typeIds: [r.typeId], specs: Object.fromEntries(Object.entries(r.specs ?? {}).map(([k, v]) => [k, [v]])) },
        method: 'unit_amount', value: round2(r.perUnit),
      }), ...d.plan.rules],
    },
  }));

  async function clearAll() {
    if (await confirm({ title: t('costs.clear_title'), message: t('costs.clear_msg'), danger: true, confirmLabel: t('costs.clear') })) clear.mutate();
  }

  const status = shown.status;
  const badge = dirty ? <Badge tone="info">{t('costs.st_preview')}</Badge>
    : status === 'ok' ? <Badge tone="good">{t('costs.st_ok')}</Badge>
    : status === 'stale' ? <Badge tone="warn">{t('costs.st_stale')}</Badge> : <Badge>{t('costs.st_none')}</Badge>;

  return (
    <div className="stack">
      {!dirty && status === 'stale' && (
        <Alert kind="warn">
          <div className="row spread wrap"><span>{t('costs.stale_msg')}</span>
            {canManage && <Button size="sm" variant="primary" icon={<Calculator size={14} />} loading={reapply.isPending} onClick={() => reapply.mutate()}>{t('costs.recalculate')}</Button>}</div>
        </Alert>
      )}
      {!dirty && status === 'none' && <Alert kind="info">{t(canManage ? 'costs.none_msg' : 'costs.none_view_msg')}</Alert>}

      <div className="grid grid-4">
        <div className="card kpi"><span className="kpi-value">{f.money(shown.merchandise ?? 0, currency)}</span><span className="kpi-label">{t('costs.merchandise')}</span></div>
        <div className="card kpi"><span className="kpi-value">{f.money(shown.extrasTotal, currency)}</span><span className="kpi-label">{t('costs.extras')}</span></div>
        <div className="card kpi"><span className="kpi-value">{f.money(shown.landed, currency)}</span><span className="kpi-label">{t('costs.landed')}</span></div>
        <div className="card kpi"><span className="kpi-value">{avg === null ? '—' : f.money(avg, currency)}</span><span className="kpi-label">{t('costs.avg_unit')}</span></div>
      </div>

      <Card title={t('costs.amounts_title')} actions={badge}>
        <div className="stack">
          <div className="form-grid">
            <Field label={t('costs.merchandise_field', { currency })} hint={t('costs.merchandise_hint')}>
              <Input type="number" min={0} step="0.01" inputMode="decimal" disabled={!canManage} value={view.merchandise} onChange={(e) => edit((d) => ({ ...d, merchandise: e.target.value }))} onFocus={(e) => e.currentTarget.select()} />
            </Field>
          </div>
          <div>
            <div className="rule-label">{t('costs.extras_title')}</div>
            {view.extras.length === 0 && <p className="muted">{t('costs.no_extras')}</p>}
            <div className="stack sm">
              {view.extras.map((x, i) => (
                <div key={i} className="extra-row">
                  <Input disabled={!canManage} value={x.label} placeholder={t('costs.extra_label_ph')} maxLength={80} aria-label={t('costs.extra_label_ph')}
                    onChange={(e) => edit((d) => ({ ...d, extras: d.extras.map((y, j) => (j === i ? { ...y, label: e.target.value } : y)) }))} />
                  <Input className="num-input" type="number" min={0} step="0.01" inputMode="decimal" disabled={!canManage} value={x.amount} aria-label={t('costs.extra_amount')}
                    onChange={(e) => edit((d) => ({ ...d, extras: d.extras.map((y, j) => (j === i ? { ...y, amount: e.target.value } : y)) }))} onFocus={(e) => e.currentTarget.select()} />
                  <Checkbox disabled={!canManage} checked={x.distribute} label={t('costs.distribute')}
                    onChange={(v) => edit((d) => ({ ...d, extras: d.extras.map((y, j) => (j === i ? { ...y, distribute: v } : y)) }))} />
                  {canManage && <button type="button" className="icon-btn" onClick={() => edit((d) => ({ ...d, extras: d.extras.filter((_, j) => j !== i) }))} aria-label={t('common.delete')}><Trash2 size={16} /></button>}
                </div>
              ))}
            </div>
            {canManage && (
              <div className="row gap-sm wrap" style={{ marginTop: 10 }}>
                <Button size="sm" icon={<Plus size={14} />} onClick={() => edit((d) => ({ ...d, extras: [...d.extras, { label: '', amount: '', distribute: true }] }))}>{t('costs.add_extra')}</Button>
                {QUICK.map((k) => (
                  <Button key={k} size="sm" variant="ghost" onClick={() => edit((d) => ({ ...d, extras: [...d.extras, { label: t(`costs.q_${k}`), amount: '', distribute: true }] }))}>+ {t(`costs.q_${k}`)}</Button>
                ))}
              </div>
            )}
            {view.extras.some((x) => !x.label.trim()) && <p className="field-hint" style={{ marginTop: 6 }}>{t('costs.extra_needs_label')}</p>}
            <p className="field-hint" style={{ marginTop: 6 }}>{t('costs.distribute_hint')}</p>
          </div>
        </div>
      </Card>

      <Card title={t('costs.plan_title')}
        actions={<Button size="sm" variant="ghost" icon={<BookmarkPlus size={14} />} onClick={() => setTpl(true)}>{t('costs.templates')}</Button>}>
        <div className="stack">
          <p className="muted">{t('costs.plan_intro')}</p>
          <AllocationEditor plan={view.plan} onChange={(plan) => edit((d) => ({ ...d, plan }))} mode="cost" currency={currency} lines={lines} use={use} warnings={shown.warnings} disabled={!canManage} />
          <div className="form-grid">
            <Field label={t('costs.qty_basis')} hint={t('costs.qty_basis_hint')}>
              <Select disabled={!canManage} value={view.plan.qtyBasis} onChange={(e) => edit((d) => ({ ...d, plan: { ...d.plan, qtyBasis: e.target.value as AllocPlan['qtyBasis'] } }))}>
                <option value="auto">{t('costs.qb_auto')}</option><option value="expected">{t('costs.qb_expected')}</option><option value="actual">{t('costs.qb_actual')}</option>
              </Select>
            </Field>
            <Field label=" " className="field-check">
              <Checkbox disabled={!canManage} checked={view.plan.auto} onChange={(v) => edit((d) => ({ ...d, plan: { ...d.plan, auto: v } }))} label={t('costs.auto')} />
              <span className="field-hint">{t('costs.auto_hint')}</span>
            </Field>
          </div>
        </div>
      </Card>

      <Card padded={false} title={<span className="row gap-sm">{t('costs.result_title')}{preview.isFetching && dirty && <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />}</span>}>
        {shown.rows.length === 0 ? <Empty title={t('costs.no_targets')} hint={t('costs.no_targets_hint')} /> : mobile ? (
          <ul className="ml-lines">
            {shown.rows.map((r) => (
              <li key={r.key} className="ml-line">
                <div className="ml-head"><span className="muted ml-no">{r.kind === 'line' ? `#${r.lineNo}` : '—'}</span><span className="grow"><TypeLabel typeId={r.typeId} /></span>{r.kind === 'group' && <Badge tone="warn">{t('lots.off_lines')}</Badge>}</div>
                <SpecChips typeId={r.typeId} specs={r.specs} />
                <div className="ml-stats">
                  <div><span className="ml-k">{t('costs.col_qty')}</span><strong>{r.qty}</strong>{r.frozenQty > 0 && <span className="sub">+{r.frozenQty} {t('costs.fixed_short')}</span>}</div>
                  <div><span className="ml-k">{t('costs.col_unit')}</span><strong>{f.money(r.perUnit, currency)}</strong></div>
                  <div><span className="ml-k">{t('costs.col_total')}</span><strong>{f.money(r.total, currency)}</strong></div>
                </div>
                <div className="row spread"><span className="sub">{ruleLabel(r.ruleId) ?? t('costs.by_base')}</span>{canManage && <Button size="sm" variant="ghost" icon={<Pin size={14} />} onClick={() => pin(r)}>{t('costs.pin')}</Button>}</div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr>
                <th>#</th><th>{t('common.type')}</th><th>{t('lots.description')}</th><th className="num">{t('costs.col_qty')}</th>
                <th className="num">{t('costs.col_unit')}</th><th className="num">{t('costs.col_total')}</th><th>{t('costs.col_rule')}</th><th />
              </tr></thead>
              <tbody>
                {shown.rows.map((r) => (
                  <tr key={r.key}>
                    <td className="muted">{r.kind === 'line' ? r.lineNo : '—'}</td>
                    <td><TypeLabel typeId={r.typeId} />{r.kind === 'group' && <div><Badge tone="warn" title={t('lots.off_lines_hint')}>{t('lots.off_lines')}</Badge></div>}</td>
                    <td><SpecChips typeId={r.typeId} specs={r.specs} /></td>
                    <td className="num">{r.qty}{r.frozenQty > 0 && <div className="sub" title={t('costs.fixed_hint')}>+{r.frozenQty} {t('costs.fixed_short')}</div>}</td>
                    <td className="num"><strong>{f.money(r.perUnit, currency)}</strong></td>
                    <td className="num">{f.money(r.total, currency)}</td>
                    <td className="sub" style={{ fontSize: 13 }}>{ruleLabel(r.ruleId) ?? <span className="muted">{t('costs.by_base')}</span>}</td>
                    <td className="cell-actions">{canManage && <Button size="sm" variant="ghost" icon={<Pin size={14} />} title={t('costs.pin_hint')} onClick={() => pin(r)}>{t('costs.pin')}</Button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="card-body stack sm">
          <dl className="recon">
            <dt>{t('costs.r_pool')}</dt><dd>{f.money(S.pool, currency)}</dd>
            {S.frozen > 0 && <><dt>{t('costs.r_frozen')}</dt><dd>{f.money(S.frozen, currency)}</dd></>}
            {S.fixed > 0 && <><dt>{t('costs.r_fixed')}</dt><dd>{f.money(S.fixed, currency)}</dd></>}
            <dt>{t('costs.r_remainder')}</dt><dd>{f.money(S.remainder, currency)}</dd>
            <dt><strong>{t('costs.r_diff')}</strong></dt>
            <dd><strong className={Math.abs(S.difference) < 0.005 ? 'diff-zero' : 'diff-neg'}>{Math.abs(S.difference) < 0.005 ? <><CheckCircle2 size={14} /> {t('costs.r_balanced')}</> : f.money(S.difference, currency)}</strong></dd>
          </dl>
          {shown.warnings.map((w, i) => (
            <div key={i} className="alert alert-warn"><AlertTriangle size={16} /><span>{warnText(w, t, f.money, currency, ruleLabel)}</span></div>
          ))}
          {o.stats.units > 0 && <p className="muted">{t('costs.stats', { withCost: o.stats.withCost, units: o.stats.units, manual: o.stats.manual })}</p>}
          {o.appliedAt && !dirty && <p className="muted row gap-sm"><CalendarCheck size={14} />{t('costs.applied_at', { date: f.dateTime(o.appliedAt) })}</p>}
        </div>
      </Card>

      {canManage && (
        <div className="sticky-actions" style={{ borderRadius: 10 }}>
          {!dirty && o.appliedAt && <Button variant="ghost" icon={<Undo2 size={16} />} loading={clear.isPending} onClick={clearAll}>{t('costs.clear')}</Button>}
          <span className="grow" />
          {dirty && <Button variant="ghost" onClick={() => setDraft(null)}>{t('costs.discard')}</Button>}
          {dirty && <Button loading={save.isPending && save.variables === false} onClick={() => save.mutate(false)}>{t('costs.save_only')}</Button>}
          <Button variant="primary" icon={<Calculator size={16} />} loading={save.isPending && save.variables === true} disabled={!dirty && status === 'ok'}
            onClick={() => (dirty ? save.mutate(true) : reapply.mutate())}>{t('costs.save_apply')}</Button>
        </div>
      )}

      {tpl && <TemplatesModal plan={view.plan} canManage={canManage} onUse={(p) => { edit((d) => ({ ...d, plan: p })); setTpl(false); }} onClose={() => setTpl(false)} />}
    </div>
  );
}

function warnText(w: AllocWarning, t: (k: string, o?: Record<string, unknown>) => string, money: (n: number, c: string) => string, cur: string, ruleLabel: (id: string | null) => string | null) {
  switch (w.code) {
    case 'over_allocated': return t('costs.w_over_allocated', { amount: money(w.amount, cur) });
    case 'unallocated': return t('costs.w_unallocated', { amount: money(w.amount, cur) });
    case 'rule_unused': return t('costs.w_rule_unused', { name: ruleLabel(w.ruleId) ?? w.ruleId });
    case 'empty_group': return t('costs.w_empty_group', { name: ruleLabel(w.ruleId) ?? w.ruleId });
  }
}

/** Planes guardados: reutilizar el mismo reparto en otros lotes. */
function TemplatesModal({ plan, canManage, onUse, onClose }: { plan: AllocPlan; canManage: boolean; onUse: (p: AllocPlan) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const err = useErr();
  const toast = useToast();
  const confirm = useConfirm();
  const [name, setName] = useState('');
  const q = useQuery({ queryKey: ['cost-templates'], queryFn: () => api.get<{ items: Template[] }>('/cost-templates') });
  const add = useMutation({
    mutationFn: () => api.post('/cost-templates', { name: name.trim(), plan: cleanPlan(plan) }),
    onSuccess: () => { setName(''); toast.success(t('common.saved')); void qc.invalidateQueries({ queryKey: ['cost-templates'] }); }, onError: (e) => toast.error(err(e)),
  });
  async function del(x: Template) {
    if (!(await confirm({ title: t('costs.tpl_delete', { name: x.name }), danger: true, confirmLabel: t('common.delete') }))) return;
    try { await api.del(`/cost-templates/${x.id}`); void qc.invalidateQueries({ queryKey: ['cost-templates'] }); } catch (e) { toast.error(err(e)); }
  }
  return (
    <Modal open onClose={onClose} title={t('costs.templates')} footer={<Button variant="ghost" onClick={onClose}>{t('common.close')}</Button>}>
      <div className="stack">
        <p className="muted">{t('costs.tpl_intro')}</p>
        {q.isLoading ? <Spinner /> : (q.data?.items.length ?? 0) === 0 ? <p className="muted">{t('costs.tpl_none')}</p> : (
          <ul className="tpl-list">
            {q.data!.items.map((x) => (
              <li key={x.id}>
                <div className="grow"><strong>{x.name}</strong><div className="sub">{t('costs.tpl_rules', { count: x.plan.rules?.length ?? 0 })}</div></div>
                {canManage && <Button size="sm" variant="primary" onClick={() => onUse({ ...EMPTY_PLAN, ...x.plan, rules: (x.plan.rules ?? []).map((r) => ({ ...r, match: { ...r.match } })) })}>{t('costs.tpl_use')}</Button>}
                {canManage && <button type="button" className="icon-btn" onClick={() => del(x)} aria-label={t('common.delete')}><Trash2 size={16} /></button>}
              </li>
            ))}
          </ul>
        )}
        {canManage && (
          <form className="row gap-sm" onSubmit={(e) => { e.preventDefault(); if (name.trim()) add.mutate(); }}>
            <Input className="grow" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('costs.tpl_name_ph')} maxLength={80} />
            <Button type="submit" variant="primary" loading={add.isPending} disabled={!name.trim() || plan.rules.length === 0}>{t('costs.tpl_save')}</Button>
          </form>
        )}
      </div>
    </Modal>
  );
}
