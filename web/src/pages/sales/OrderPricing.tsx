import { Fragment, useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Plus, Trash2, Wand2 } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useMeta, type Specs } from '../../lib/meta';
import { useFmt } from '../../lib/useFmt';
import { cleanPlan, EMPTY_PLAN, ruleUse, type AllocPlan, type AllocSummary, type AllocWarning } from '../../lib/alloc';
import { Alert } from '../../components/Alert';
import { Badge, Button, Card, Checkbox, Field, Input, Select, Spinner, useDebounced, useErr, useToast } from '../../components/ui';
import { AllocationEditor } from '../../components/AllocationEditor';

export interface PricingItem { id: number; code: string; unitPrice: number | null; listPrice?: number | null; unitCost?: number | null; equipmentTypeId: number; specs: Specs; lineId: number | null }
export interface Adjustment { label: string; kind: 'percent' | 'amount'; value: number; amount?: number }
export interface Margin { cost: number; revenue: number; profit: number; pct: number | null; missing: number }
export interface PricingOrder {
  id: number; currency: string; items: PricingItem[]; itemCount: number; subtotal: number | null; total: number | null;
  adjustments: Adjustment[]; margin: Margin | null; canSeeCosts: boolean;
  lines: { id: number; lineNo: number; equipmentTypeId: number; specs: Specs }[];
}

interface PlanPreview {
  items: { itemId: number; code: string; price: number; previous: number | null; listPrice: number | null; cost: number | null; ruleId: string | null }[];
  summary: AllocSummary; warnings: AllocWarning[]; subtotal: number; total: number;
}

/** Pestaña "Precios" del pedido: totales, descuentos/cargos, margen y el precio total repartido entre los equipos. */
export function OrderPricingTab({ order, editable, selected, onChanged }: { order: PricingOrder; editable: boolean; selected: number[]; onChanged: (o: any) => void }) {
  const { can } = useAuth();
  const canEdit = editable && can('sales.price');
  return (
    <div className="stack">
      <TotalsCard order={order} />
      {canEdit && order.itemCount > 0 && <PricePlanCard order={order} selected={selected} onChanged={onChanged} />}
      {(canEdit || order.adjustments.length > 0) && <AdjustmentsCard order={order} editable={canEdit} onChanged={onChanged} />}
      {canEdit && order.itemCount > 0 && <ListPriceCard order={order} onChanged={onChanged} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
function TotalsCard({ order: o }: { order: PricingOrder }) {
  const { t } = useTranslation();
  const f = useFmt();
  const m = o.margin;
  return (
    <Card title={t('pricing.totals_title')}>
      <dl className="recon">
        <dt>{t('pricing.subtotal')}</dt><dd>{f.money(o.subtotal, o.currency)}</dd>
        {o.adjustments.map((a, i) => (
          <Fragment key={i}><dt>{a.label}{a.kind === 'percent' && <span className="muted"> ({a.value > 0 ? '+' : ''}{a.value}%)</span>}</dt><dd className={(a.amount ?? 0) < 0 ? 'diff-neg' : undefined}>{f.money(a.amount ?? 0, o.currency)}</dd></Fragment>
        ))}
        <dt><strong>{t('common.total_label')}</strong></dt><dd><strong>{f.money(o.total, o.currency)}</strong></dd>
        {m && <>
          <dt className="recon-sep">{t('pricing.cost_of_items')}</dt><dd className="recon-sep">{f.money(m.cost, o.currency)}</dd>
          <dt><strong>{t('pricing.profit')}</strong></dt>
          <dd><strong className={m.profit < 0 ? 'diff-neg' : 'diff-zero'}>{f.money(m.profit, o.currency)}{m.pct !== null && ` · ${m.pct.toFixed(1)}%`}</strong></dd>
        </>}
      </dl>
      {m && m.missing > 0 && <p className="field-hint" style={{ marginTop: 8 }}>{t('pricing.missing_cost', { count: m.missing })}</p>}
      {m && o.adjustments.some((a) => (a.amount ?? 0) > 0) && <p className="field-hint">{t('pricing.charges_not_profit')}</p>}
    </Card>
  );
}

// ---------------------------------------------------------------------------
type Dir = 'discount' | 'charge';
interface AdjDraft { label: string; kind: 'percent' | 'amount'; dir: Dir; value: string }
const toDraft = (a: Adjustment): AdjDraft => ({ label: a.label, kind: a.kind, dir: a.value < 0 ? 'discount' : 'charge', value: String(Math.abs(a.value)) });

function AdjustmentsCard({ order, editable, onChanged }: { order: PricingOrder; editable: boolean; onChanged: (o: any) => void }) {
  const { t } = useTranslation();
  const err = useErr();
  const toast = useToast();
  const f = useFmt();
  const [rows, setRows] = useState<AdjDraft[] | null>(null);
  const cur = rows ?? order.adjustments.map(toDraft);
  const set = (fn: (r: AdjDraft[]) => AdjDraft[]) => setRows(fn(cur));
  const patch = (i: number, p: Partial<AdjDraft>) => set((r) => r.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const signed = (r: AdjDraft) => (r.dir === 'discount' ? -1 : 1) * Math.abs(Number(r.value) || 0);

  const save = useMutation({
    mutationFn: () => api.put('/orders/' + order.id + '/adjustments', { adjustments: cur.filter((r) => r.label.trim() && Number(r.value)).map((r) => ({ label: r.label.trim(), kind: r.kind, value: signed(r) })) }),
    onSuccess: (o) => { onChanged(o); setRows(null); toast.success(t('common.saved')); }, onError: (e) => toast.error(err(e)),
  });
  // Vista previa del total con lo que se está escribiendo.
  const previewAdj = cur.filter((r) => r.label.trim() && Number(r.value)).map((r) => ({ kind: r.kind, value: signed(r) }));
  const sub = order.subtotal ?? 0;
  const total = Math.round((sub + previewAdj.reduce((a, x) => a + (x.kind === 'percent' ? (sub * x.value) / 100 : x.value), 0)) * 100) / 100;

  return (
    <Card title={t('pricing.adj_title')}>
      <div className="stack">
        <p className="muted">{t('pricing.adj_intro')}</p>
        {cur.length === 0 && <p className="muted">{t('pricing.adj_none')}</p>}
        {cur.map((r, i) => (
          <div key={i} className="adj-row">
            <Input disabled={!editable} value={r.label} maxLength={60} placeholder={t('pricing.adj_label_ph')} aria-label={t('pricing.adj_label_ph')} onChange={(e) => patch(i, { label: e.target.value })} />
            <Select disabled={!editable} value={r.dir} onChange={(e) => patch(i, { dir: e.target.value as Dir })} aria-label={t('pricing.adj_dir')}>
              <option value="discount">{t('pricing.adj_discount')}</option><option value="charge">{t('pricing.adj_charge')}</option>
            </Select>
            <Select disabled={!editable} value={r.kind} onChange={(e) => patch(i, { kind: e.target.value as 'percent' | 'amount' })} aria-label={t('pricing.adj_kind')}>
              <option value="percent">%</option><option value="amount">{order.currency}</option>
            </Select>
            <Input className="num-input" disabled={!editable} type="number" min={0} step="0.01" inputMode="decimal" value={r.value} onChange={(e) => patch(i, { value: e.target.value })} onFocus={(e) => e.currentTarget.select()} aria-label={t('pricing.adj_value')} />
            {editable && <button type="button" className="icon-btn" onClick={() => set((x) => x.filter((_, j) => j !== i))} aria-label={t('common.delete')}><Trash2 size={16} /></button>}
          </div>
        ))}
        {editable && (
          <div className="row spread wrap">
            <span className="row gap-sm wrap">
              <Button size="sm" icon={<Plus size={14} />} onClick={() => set((x) => [...x, { label: '', kind: 'percent', dir: 'discount', value: '' }])}>{t('pricing.adj_add')}</Button>
              <Button size="sm" variant="ghost" onClick={() => set((x) => [...x, { label: t('pricing.adj_shipping'), kind: 'amount', dir: 'charge', value: '' }])}>+ {t('pricing.adj_shipping')}</Button>
              <Button size="sm" variant="ghost" onClick={() => set((x) => [...x, { label: t('pricing.adj_tax'), kind: 'percent', dir: 'charge', value: '' }])}>+ {t('pricing.adj_tax')}</Button>
            </span>
            {rows && (
              <span className="row gap-sm">
                <span className="muted">{t('pricing.adj_new_total')}: <strong>{f.money(total, order.currency)}</strong></span>
                <Button size="sm" variant="ghost" onClick={() => setRows(null)}>{t('common.cancel')}</Button>
                <Button size="sm" variant="primary" loading={save.isPending} onClick={() => save.mutate()}>{t('common.save')}</Button>
              </span>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
/** "El cliente paga X en total": reparte ese monto entre los equipos con reglas (por tipo, línea, propiedades, proporcional al precio de lista...). */
function PricePlanCard({ order, selected, onChanged }: { order: PricingOrder; selected: number[]; onChanged: (o: any) => void }) {
  const { t } = useTranslation();
  const meta = useMeta();
  const f = useFmt();
  const err = useErr();
  const toast = useToast();
  const [target, setTarget] = useState<'total' | 'subtotal'>('total');
  const [amount, setAmount] = useState('');
  const [onlySel, setOnlySel] = useState(false);
  const [plan, setPlan] = useState<AllocPlan>({ ...EMPTY_PLAN, base: 'by_list' });
  const useSel = onlySel && selected.length > 0;
  const eff = useSel ? 'subtotal' : target;

  const lines = useMemo(() => order.lines.map((l) => ({ id: l.id, label: `#${l.lineNo} · ${meta.typeName(l.equipmentTypeId)}${meta.describe(l.equipmentTypeId, l.specs).length ? ' · ' + meta.describe(l.equipmentTypeId, l.specs).join(' ') : ''}` })), [order.lines, meta]);
  const req = amount.trim() !== '' && Number(amount) >= 0 ? JSON.stringify({ target: eff, amount: Number(amount), plan: cleanPlan(plan), itemIds: useSel ? selected : undefined }) : '';
  const debounced = useDebounced(req, 350);
  const q = useQuery({
    queryKey: ['price-plan', order.id, debounced, order.itemCount],
    queryFn: () => api.post<PlanPreview>(`/orders/${order.id}/price-plan/preview`, JSON.parse(debounced)),
    enabled: !!debounced, placeholderData: keepPreviousData, retry: false,
  });
  const use = useMemo(() => ruleUse((q.data?.items ?? []).map((i) => ({ ruleId: i.ruleId, qty: 1, total: i.price }))), [q.data]);
  const apply = useMutation({
    mutationFn: () => api.post(`/orders/${order.id}/price-plan/apply`, JSON.parse(req)),
    onSuccess: (o) => { onChanged(o); toast.success(t('pricing.plan_applied')); setAmount(''); }, onError: (e) => toast.error(err(e)),
  });
  const p = debounced ? q.data : undefined;
  const cost = order.canSeeCosts;

  return (
    <Card title={<span className="row gap-sm"><Wand2 size={16} />{t('pricing.plan_title')}</span>}>
      <div className="stack">
        <p className="muted">{t('pricing.plan_intro')}</p>
        <div className="form-grid">
          <Field label={t('pricing.plan_target')}>
            <Select value={eff} disabled={useSel} onChange={(e) => setTarget(e.target.value as 'total' | 'subtotal')}>
              <option value="total">{t('pricing.plan_t_total')}</option><option value="subtotal">{t('pricing.plan_t_subtotal')}</option>
            </Select>
          </Field>
          <Field label={t('pricing.plan_amount', { currency: order.currency })}>
            <Input type="number" min={0} step="0.01" inputMode="decimal" value={amount} placeholder={f.money(order.total ?? 0, order.currency)} onChange={(e) => setAmount(e.target.value)} onFocus={(e) => e.currentTarget.select()} />
          </Field>
          {selected.length > 0 && <Field label=" " className="field-check"><Checkbox checked={onlySel} onChange={setOnlySel} label={t('pricing.plan_only_selected', { count: selected.length })} /></Field>}
        </div>
        {useSel && <p className="field-hint">{t('pricing.plan_selected_hint')}</p>}

        <div className="rule-label">{t('pricing.plan_rules')}</div>
        <AllocationEditor plan={plan} onChange={setPlan} mode="price" currency={order.currency} lines={lines} use={p ? use : undefined} warnings={p?.warnings} allowByCost={cost} />

        {debounced && q.isLoading && <Spinner />}
        {debounced && q.isError && <Alert kind="warn">{err(q.error)}</Alert>}
        {p && (
          <div className="stack sm">
            <div className="table-wrap" style={{ maxHeight: 320, overflowY: 'auto' }}>
              <table className="table">
                <thead><tr>
                  <th>{t('common.code')}</th><th className="num">{t('pricing.col_list_price')}</th>{cost && <th className="num">{t('pricing.col_cost')}</th>}
                  <th className="num">{t('pricing.plan_before')}</th><th className="num">{t('pricing.plan_after')}</th>{cost && <th className="num">{t('pricing.col_margin')}</th>}
                </tr></thead>
                <tbody>
                  {p.items.slice(0, 200).map((i) => (
                    <tr key={i.itemId}>
                      <td className="mono">{i.code}</td>
                      <td className="num muted">{i.listPrice === null ? '—' : f.money(i.listPrice, order.currency)}</td>
                      {cost && <td className="num muted">{i.cost === null ? '—' : f.money(i.cost, order.currency)}</td>}
                      <td className="num muted">{i.previous === null ? '—' : f.money(i.previous, order.currency)}</td>
                      <td className="num"><strong>{f.money(i.price, order.currency)}</strong></td>
                      {cost && <td className="num">{i.cost === null || i.price <= 0 ? '—' : <span className={i.price < i.cost ? 'diff-neg' : undefined}>{(((i.price - i.cost) / i.price) * 100).toFixed(1)}%</span>}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {p.items.length > 200 && <p className="muted">{t('pricing.plan_more', { count: p.items.length - 200 })}</p>}
            <dl className="recon">
              <dt>{t('pricing.subtotal')}</dt><dd>{f.money(p.subtotal, order.currency)}</dd>
              <dt><strong>{t('common.total_label')}</strong></dt><dd><strong>{f.money(p.total, order.currency)}</strong></dd>
              <dt>{t('costs.r_diff')}</dt>
              <dd className={Math.abs(p.summary.difference) < 0.005 ? 'diff-zero' : 'diff-neg'}>{Math.abs(p.summary.difference) < 0.005 ? t('costs.r_balanced') : f.money(p.summary.difference, order.currency)}</dd>
            </dl>
            {p.warnings.filter((w) => w.code === 'over_allocated' || w.code === 'unallocated').map((w, i) => (
              <div key={i} className="alert alert-warn"><AlertTriangle size={16} /><span>{t(w.code === 'over_allocated' ? 'costs.w_over_allocated' : 'costs.w_unallocated', { amount: f.money((w as { amount: number }).amount, order.currency) })}</span></div>
            ))}
          </div>
        )}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button variant="primary" icon={<Wand2 size={16} />} loading={apply.isPending} disabled={!p || q.isFetching} onClick={() => apply.mutate()}>{t('pricing.plan_apply')}</Button>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
/** Atajos: copiar el precio de lista de cada equipo al pedido. */
function ListPriceCard({ order, onChanged }: { order: PricingOrder; onChanged: (o: any) => void }) {
  const { t } = useTranslation();
  const err = useErr();
  const toast = useToast();
  const withList = order.items.filter((i) => i.listPrice !== null && i.listPrice !== undefined);
  const missing = order.items.filter((i) => i.unitPrice === null && i.listPrice !== null && i.listPrice !== undefined);
  const run = useMutation({
    mutationFn: (only: 'missing' | 'all') => api.post(`/orders/${order.id}/prices`, { prices: (only === 'all' ? withList : missing).map((i) => ({ itemId: i.id, unitPrice: i.listPrice })) }),
    onSuccess: (o) => { onChanged(o); toast.success(t('common.saved')); }, onError: (e) => toast.error(err(e)),
  });
  if (!withList.length) return null;
  return (
    <Card title={t('pricing.list_title')}>
      <div className="stack sm">
        <p className="muted">{t('pricing.list_intro', { count: withList.length })}</p>
        <div className="row gap-sm wrap">
          {missing.length > 0 && <Button size="sm" loading={run.isPending && run.variables === 'missing'} onClick={() => run.mutate('missing')}>{t('pricing.list_missing', { count: missing.length })}</Button>}
          <Button size="sm" loading={run.isPending && run.variables === 'all'} onClick={() => run.mutate('all')}>{t('pricing.list_all')}</Button>
          {order.items.some((i) => i.unitPrice === null) && <Badge tone="warn">{t('pricing.no_price_count', { count: order.items.filter((i) => i.unitPrice === null).length })}</Badge>}
        </div>
      </div>
    </Card>
  );
}
