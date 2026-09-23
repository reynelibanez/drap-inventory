import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { BadgeCheck, CalendarClock, CreditCard, ExternalLink, RefreshCw, ShieldAlert } from 'lucide-react';
import { api } from '../lib/api';
import { trText } from '../lib/i18n';
import { useFmt } from '../lib/useFmt';
import type { BillingInfo, PlanInfo } from '../lib/auth';
import { Badge, Button, Card, Progress, Spinner, useErr, useToast } from './ui';

export interface BillingStatus extends BillingInfo {
  stripeConfigured: boolean;
  plans: PlanInfo[];
  usage: { users: number; locations: number };
}

const STATUS_TONE: Record<string, 'good' | 'warn' | 'bad' | 'neutral' | 'info'> = {
  trialing: 'info', active: 'good', past_due: 'warn', canceled: 'bad', expired: 'bad',
};

function money(cents: number | null, lang: string) {
  if (cents == null) return null;
  return new Intl.NumberFormat(lang === 'en' ? 'en-US' : 'es-US', { style: 'currency', currency: 'USD', maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
}

/**
 * Estado de la suscripción + planes disponibles para suscribirse. Se usa tanto en Configuración →
 * Suscripción (con el resto de la pantalla alrededor) como en la pantalla de bloqueo por prueba
 * vencida (a pantalla completa, sin el resto del sistema).
 */
export function BillingPanel({ onData }: { onData?: (b: BillingStatus) => void }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language?.slice(0, 2) ?? 'es';
  const f = useFmt();
  const qc = useQueryClient();
  const err = useErr();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [interval, setInterval] = useState<'monthly' | 'annual'>('monthly');
  const [busy, setBusy] = useState<string | null>(null);

  const q = useQuery({ queryKey: ['billing', 'status'], queryFn: () => api.get<BillingStatus>('/billing/status'), staleTime: 0 });

  useEffect(() => {
    if (q.data?.billingInterval) setInterval(q.data.billingInterval);
  }, [q.data?.billingInterval]);

  useEffect(() => {
    if (q.data && onData) onData(q.data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data]);

  // Al volver del Checkout de Stripe, se vuelve a preguntar el estado (por si el aviso automático no puede llegar,
  // por ejemplo en un servidor local sin dirección pública) y se limpia la URL.
  useEffect(() => {
    const checkout = params.get('checkout');
    if (!checkout) return;
    (async () => {
      if (checkout === 'success') {
        try { await api.post('/billing/sync'); toast.success(t('billing.checkout_success')); }
        catch (e) { toast.error(err(e)); }
        void qc.invalidateQueries({ queryKey: ['billing'] });
      } else if (checkout === 'canceled') {
        toast.info(t('billing.checkout_canceled'));
      }
      params.delete('checkout'); params.delete('session_id');
      setParams(params, { replace: true });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function checkout(planKey: string) {
    setBusy(planKey);
    try {
      const r = await api.post<{ url: string }>('/billing/checkout', { planKey, interval });
      window.location.href = r.url;
    } catch (e) { toast.error(err(e)); setBusy(null); }
  }

  async function portal() {
    setBusy('portal');
    try {
      const r = await api.post<{ url: string }>('/billing/portal');
      window.location.href = r.url;
    } catch (e) { toast.error(err(e)); setBusy(null); }
  }

  async function sync() {
    setBusy('sync');
    try { await qc.fetchQuery({ queryKey: ['billing', 'status'], queryFn: () => api.post<BillingStatus>('/billing/sync') }); toast.success(t('common.saved')); }
    catch (e) { toast.error(err(e)); } finally { setBusy(null); }
  }

  if (!q.data) return <Spinner />;
  const b = q.data;
  const plan = b.plan;
  const daysLeft = b.trialEndsAt ? Math.ceil((new Date(b.trialEndsAt).getTime() - Date.now()) / 86_400_000) : null;

  return (
    <div className="stack">
      <Card>
        <div className="row spread" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 16 }}>
          <div>
            <div className="row gap-sm" style={{ alignItems: 'center' }}>
              <strong style={{ fontSize: 18 }}>{plan ? trText(plan.name, lang) : t('billing.no_plan')}</strong>
              <Badge tone={STATUS_TONE[b.status] ?? 'neutral'}>{t(`billing.status_${b.status}`)}</Badge>
            </div>
            {b.status === 'trialing' && (
              <p className="muted" style={{ marginTop: 6 }}>
                {daysLeft !== null && daysLeft >= 0 ? t('billing.trial_days_left', { count: daysLeft }) : t('billing.trial_expired')}
              </p>
            )}
            {b.status === 'active' && b.currentPeriodEnd && (
              <p className="muted" style={{ marginTop: 6 }}><CalendarClock size={14} style={{ verticalAlign: -2 }} /> {t('billing.renews_on', { date: f.date(b.currentPeriodEnd) })}</p>
            )}
            {b.status === 'past_due' && <p style={{ marginTop: 6, color: 'var(--warn)' }}><ShieldAlert size={14} style={{ verticalAlign: -2 }} /> {t('billing.past_due_hint')}</p>}
            {b.status === 'canceled' && <p className="muted" style={{ marginTop: 6 }}>{t('billing.canceled_hint')}</p>}
          </div>
          {b.hasStripeCustomer && (
            <Button variant="ghost" icon={<CreditCard size={16} />} loading={busy === 'portal'} onClick={portal}>{t('billing.manage_payment')}</Button>
          )}
        </div>
        <div className="form-grid" style={{ marginTop: 18 }}>
          <div>
            <div className="row spread"><span>{t('billing.users')}</span><span className="muted">{b.usage.users}{plan?.maxUsers != null ? ` / ${plan.maxUsers}` : ` (${t('billing.unlimited')})`}</span></div>
            {plan?.maxUsers != null && <Progress value={b.usage.users} max={plan.maxUsers} tone={b.usage.users >= plan.maxUsers ? 'bad' : b.usage.users >= plan.maxUsers * 0.8 ? 'warn' : 'good'} />}
          </div>
          <div>
            <div className="row spread"><span>{t('billing.locations')}</span><span className="muted">{b.usage.locations}{plan?.maxLocations != null ? ` / ${plan.maxLocations}` : ` (${t('billing.unlimited')})`}</span></div>
            {plan?.maxLocations != null && <Progress value={b.usage.locations} max={plan.maxLocations} tone={b.usage.locations >= plan.maxLocations ? 'bad' : b.usage.locations >= plan.maxLocations * 0.8 ? 'warn' : 'good'} />}
          </div>
        </div>
        <div className="row" style={{ marginTop: 14 }}>
          <Button variant="ghost" size="sm" icon={<RefreshCw size={14} />} loading={busy === 'sync'} onClick={sync}>{t('billing.sync')}</Button>
        </div>
      </Card>

      {!b.stripeConfigured && (
        <Card><p className="muted">{t('billing.stripe_not_configured')}</p></Card>
      )}

      {b.stripeConfigured && (
        <Card title={t('billing.plans_title')}>
          <div className="row" style={{ marginBottom: 14 }}>
            <div className="seg">
              <button type="button" className={interval === 'monthly' ? 'on' : ''} onClick={() => setInterval('monthly')}>{t('billing.monthly')}</button>
              <button type="button" className={interval === 'annual' ? 'on' : ''} onClick={() => setInterval('annual')}>{t('billing.annual')}</button>
            </div>
          </div>
          <div className="plan-grid">
            {b.plans.filter((p) => p.priceMonthlyCents != null || p.priceAnnualCents != null).map((p) => {
              const cents = interval === 'annual' ? p.priceAnnualCents : p.priceMonthlyCents;
              const current = plan?.id === p.id && b.status === 'active';
              // Falta correr la configuración de Stripe para este plan/intervalo (o solo se cargó uno de los dos).
              const purchasable = interval === 'annual' ? p.stripePriceIdAnnual != null : p.stripePriceIdMonthly != null;
              return (
                <div key={p.id} className={`plan-card ${current ? 'plan-current' : ''}`}>
                  <div className="row spread"><strong>{trText(p.name, lang)}</strong>{current && <Badge tone="good"><BadgeCheck size={12} /> {t('billing.current_plan')}</Badge>}</div>
                  <p className="muted" style={{ minHeight: 40 }}>{trText(p.description, lang)}</p>
                  <div style={{ fontSize: 26, fontWeight: 700, margin: '8px 0' }}>
                    {cents != null ? money(interval === 'annual' ? Math.round(cents / 12) : cents, lang) : '—'}
                    <span style={{ fontSize: 13, fontWeight: 400 }} className="muted">/{t('billing.per_month')}</span>
                  </div>
                  {interval === 'annual' && p.priceAnnualCents != null && <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>{t('billing.billed_annually', { amount: money(p.priceAnnualCents, lang) })}</div>}
                  <ul className="plan-features">
                    <li>{p.maxUsers != null ? t('billing.feature_users', { count: p.maxUsers }) : t('billing.feature_users_unlimited')}</li>
                    <li>{p.maxLocations != null ? t('billing.feature_locations', { count: p.maxLocations }) : t('billing.feature_locations_unlimited')}</li>
                    {p.features?.advancedReports && <li>{t('billing.feature_advanced_reports')}</li>}
                    {p.features?.prioritySupport && <li>{t('billing.feature_priority_support')}</li>}
                  </ul>
                  <Button variant={current ? 'ghost' : 'primary'} disabled={current || !purchasable} loading={busy === p.key} onClick={() => checkout(p.key)}
                    icon={<ExternalLink size={14} />} title={!current && !purchasable ? t('billing.not_purchasable_hint') : undefined}>
                    {current ? t('billing.current_plan') : purchasable ? t('billing.subscribe') : t('billing.not_purchasable_short')}
                  </Button>
                  {!current && !purchasable && <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>{t('billing.not_purchasable_hint')}</p>}
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}
