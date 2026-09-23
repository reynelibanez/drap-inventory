import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, BadgeDollarSign, LogIn, Plus, UserPlus } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useFmt } from '../../lib/useFmt';
import { trText, type I18nText } from '../../lib/i18n';
import { I18nInput } from '../../components/I18nInput';
import { Badge, Button, Checkbox, Field, Input, Modal, PageHeader, Select, useErr, useToast } from '../../components/ui';
import { DataGrid, type GridColumn } from '../../components/grid/DataGrid';

interface Co {
  id: number; slug: string; name: string; legalName: string | null; defaultLanguage: string; currency: string; isActive: boolean; createdAt: string;
  members: number; locations: number; iAmMember: boolean;
  planKey: string | null; planName: I18nText | null; subscriptionStatus: string; billingInterval: string | null;
  trialEndsAt: string | null; subscriptionCurrentPeriodEnd: string | null;
}

const STATUS_TONE: Record<string, 'good' | 'warn' | 'bad' | 'neutral' | 'info'> = {
  trialing: 'info', active: 'good', past_due: 'warn', canceled: 'bad', expired: 'bad',
};

/** Administración de empresas (solo administradores de la plataforma). */
export default function PlatformPage({ standalone, onBack }: { standalone?: boolean; onBack?: () => void }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language?.slice(0, 2) ?? 'es';
  const { selectCompany, company } = useAuth();
  const f = useFmt();
  const qc = useQueryClient();
  const err = useErr();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [editingPlans, setEditingPlans] = useState(false);
  const [overriding, setOverriding] = useState<Co | null>(null);
  const q = useQuery({ queryKey: ['platform', 'companies'], queryFn: () => api.get<{ items: Co[] }>('/platform/companies'), staleTime: 0 });
  const refresh = () => qc.invalidateQueries({ queryKey: ['platform'] });

  async function join(c: Co) {
    try { await api.post(`/platform/companies/${c.id}/join`); toast.success(t('platform.joined')); await refresh(); } catch (e) { toast.error(err(e)); }
  }
  async function toggle(c: Co) {
    try { await api.patch(`/platform/companies/${c.id}`, { isActive: !c.isActive }); await refresh(); } catch (e) { toast.error(err(e)); }
  }
  const columns: GridColumn<Co>[] = [
    { key: 'name', title: t('common.name'), width: 220, render: (c) => <><strong>{c.name}</strong>{c.legalName && <div className="sub">{c.legalName}</div>}{company?.id === c.id && <> <Badge tone="info">{t('platform.current')}</Badge></>}</> },
    { key: 'legalName', title: t('platform.legal_name'), hidden: true },
    { key: 'slug', title: t('platform.slug'), width: 130, render: (c) => <span className="mono">{c.slug}</span> },
    { key: 'members', title: t('platform.members'), type: 'number', width: 90 },
    { key: 'locations', title: t('platform.locations'), type: 'number', width: 90 },
    {
      key: 'planKey', title: t('platform.plan'), type: 'select', width: 150,
      value: (c) => c.planName ? trText(c.planName, lang) : '—',
      render: (c) => <Badge tone={STATUS_TONE[c.subscriptionStatus] ?? 'neutral'}>{c.planName ? trText(c.planName, lang) : '—'} · {t(`billing.status_${c.subscriptionStatus}`, { defaultValue: c.subscriptionStatus })}</Badge>,
    },
    { key: 'subscriptionCurrentPeriodEnd', title: t('platform.period_end'), type: 'date', width: 120, hidden: true },
    { key: 'defaultLanguage', title: t('common.language'), type: 'select', width: 100, value: (c) => c.defaultLanguage.toUpperCase() },
    { key: 'currency', title: t('platform.currency'), type: 'select', width: 90 },
    { key: 'createdAt', title: t('common.date'), type: 'date', width: 120 },
    { key: 'isActive', title: t('common.status'), type: 'boolean', width: 100, render: (c) => (c.isActive ? <Badge tone="good">{t('common.active')}</Badge> : <Badge>{t('common.inactive')}</Badge>) },
    {
      key: '_actions', title: '', actions: true as const, width: 330,
      render: (c) => (
        <span className="row gap-sm" style={{ justifyContent: 'flex-end' }}>
          <Button size="sm" variant="ghost" onClick={() => setOverriding(c)}>{t('platform.change_plan')}</Button>
          {c.iAmMember ? <Button size="sm" icon={<LogIn size={14} />} disabled={!c.isActive || company?.id === c.id} onClick={() => selectCompany(c.id).catch((e) => toast.error(err(e)))}>{t('platform.enter')}</Button>
            : <Button size="sm" icon={<UserPlus size={14} />} onClick={() => join(c)}>{t('platform.join')}</Button>}
          <Button size="sm" variant="ghost" onClick={() => toggle(c)}>{c.isActive ? t('platform.disable') : t('platform.enable')}</Button>
        </span>
      ),
    },
  ];
  return (
    <>
      <PageHeader
        back={standalone && onBack ? <button className="btn btn-ghost btn-sm" onClick={onBack} style={{ marginBottom: 6 }}><ArrowLeft size={14} />{t('common.back')}</button> : undefined}
        title={t('platform.title')} subtitle={t('platform.subtitle')}
        actions={<span className="row gap-sm">
          <Button variant="ghost" icon={<BadgeDollarSign size={16} />} onClick={() => setEditingPlans(true)}>{t('platform.manage_plans')}</Button>
          <Button variant="primary" icon={<Plus size={16} />} onClick={() => setCreating(true)}>{t('platform.new_company')}</Button>
        </span>} />
      <DataGrid id="platform-companies" rows={q.data?.items ?? []} loading={q.isLoading} columns={columns} rowId={(c) => c.id} exportName={t('platform.title')} emptyTitle={t('platform.empty')}
        rowClass={(c) => (c.isActive ? undefined : 'row-inactive')} />
      {creating && <CompanyModal onClose={() => setCreating(false)} onSaved={refresh} />}
      {editingPlans && <PlansModal onClose={() => setEditingPlans(false)} />}
      {overriding && <PlanOverrideModal company={overriding} onClose={() => setOverriding(null)} onSaved={refresh} />}
    </>
  );
}

function CompanyModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const err = useErr();
  const toast = useToast();
  const { user } = useAuth();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [legal, setLegal] = useState('');
  const [taxId, setTaxId] = useState('');
  const [lang, setLang] = useState<'es' | 'en'>('es');
  const [currency, setCurrency] = useState('USD');
  const [tz, setTz] = useState('America/New_York');
  const [existing, setExisting] = useState(false);
  const [existingId, setExistingId] = useState(user ? String(user.id) : '');
  const [username, setUsername] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const users = useQuery({ queryKey: ['platform', 'users'], queryFn: () => api.get<{ items: { id: number; username: string; fullName: string }[] }>('/platform/users'), enabled: existing });

  async function save() {
    setBusy(true);
    try {
      await api.post('/platform/companies', {
        name: name.trim(), slug: slug.trim() || undefined, legalName: legal.trim() || null, taxId: taxId.trim() || null, defaultLanguage: lang, currency, timezone: tz,
        admin: existing ? { existingUserId: Number(existingId) } : { username: username.trim(), fullName: fullName.trim(), email: email.trim() || null, password },
      });
      toast.success(t('platform.created')); onSaved(); onClose();
    } catch (e) { toast.error(err(e)); } finally { setBusy(false); }
  }
  const ok = name.trim().length >= 2 && (existing ? !!existingId : username.trim().length >= 3 && fullName.trim().length >= 2 && password.length >= 8);
  return (
    <Modal open onClose={onClose} size="lg" title={t('platform.new_company')}
      footer={<><Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} disabled={!ok} onClick={save}>{t('common.create')}</Button></>}>
      <div className="stack">
        <div className="form-grid">
          <Field label={t('common.name')} required><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
          <Field label={t('platform.slug')} hint={t('platform.slug_hint')}><Input value={slug} onChange={(e) => setSlug(e.target.value)} /></Field>
          <Field label={t('company.legal_name')}><Input value={legal} onChange={(e) => setLegal(e.target.value)} /></Field>
          <Field label={t('partners.tax_id')}><Input value={taxId} onChange={(e) => setTaxId(e.target.value)} /></Field>
          <Field label={t('company.default_language')}><Select value={lang} onChange={(e) => setLang(e.target.value as 'es' | 'en')}><option value="es">{t('common.es')}</option><option value="en">{t('common.en')}</option></Select></Field>
          <Field label={t('common.currency')}><Input value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase())} /></Field>
          <Field label={t('company.timezone')}><Input value={tz} onChange={(e) => setTz(e.target.value)} /></Field>
        </div>
        <div>
          <div className="section-title">{t('platform.first_admin')}</div>
          <Checkbox checked={existing} onChange={setExisting} label={t('platform.use_existing')} />
          {existing ? (
            <Field label={t('common.user')} className="" ><Select value={existingId} onChange={(e) => setExistingId(e.target.value)}>{users.data?.items.map((u) => <option key={u.id} value={u.id}>{u.fullName} ({u.username})</option>)}</Select></Field>
          ) : (
            <div className="form-grid" style={{ marginTop: 10 }}>
              <Field label={t('users.username')} required><Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" /></Field>
              <Field label={t('users.full_name')} required><Input value={fullName} onChange={(e) => setFullName(e.target.value)} /></Field>
              <Field label={t('common.email')}><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
              <Field label={t('auth.password')} required hint={t('auth.password_rule')}><Input type="text" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" /></Field>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** El admin de plataforma asigna un plan a una empresa sin pasar por Stripe (sin cobro). */
function PlanOverrideModal({ company, onClose, onSaved }: { company: Co; onClose: () => void; onSaved: () => void }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language?.slice(0, 2) ?? 'es';
  const err = useErr();
  const toast = useToast();
  const plansQ = useQuery({ queryKey: ['platform', 'plans'], queryFn: () => api.get<{ items: { key: string; name: I18nText; isActive: boolean }[] }>('/platform/plans') });
  const [planKey, setPlanKey] = useState(company.planKey ?? '');
  const [status, setStatus] = useState(company.subscriptionStatus === 'trialing' ? 'active' : company.subscriptionStatus);
  const [interval, setInterval] = useState(company.billingInterval ?? '');
  const [periodEnd, setPeriodEnd] = useState(company.subscriptionCurrentPeriodEnd ? company.subscriptionCurrentPeriodEnd.slice(0, 10) : '');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!planKey && plansQ.data?.items.length) setPlanKey(plansQ.data.items[0].key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plansQ.data]);

  async function save() {
    setBusy(true);
    try {
      await api.post(`/platform/companies/${company.id}/plan`, {
        planKey, status, interval: interval || null, periodEnd: periodEnd ? new Date(`${periodEnd}T00:00:00Z`).toISOString() : null,
      });
      toast.success(t('platform.plan_updated')); onSaved(); onClose();
    } catch (e) { toast.error(err(e)); } finally { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} title={t('platform.override_title', { company: company.name })}
      footer={<><Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} disabled={!planKey} onClick={save}>{t('common.save')}</Button></>}>
      <div className="stack">
        <p className="muted">{t('platform.override_hint')}</p>
        <Field label={t('platform.plan')} required>
          <Select value={planKey} onChange={(e) => setPlanKey(e.target.value)}>
            {plansQ.data?.items.map((p) => <option key={p.key} value={p.key}>{trText(p.name, lang)}{!p.isActive ? ` (${t('common.inactive')})` : ''}</option>)}
          </Select>
        </Field>
        <Field label={t('platform.status_field')}>
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="active">{t('billing.status_active')}</option>
            <option value="trialing">{t('billing.status_trialing')}</option>
            <option value="past_due">{t('billing.status_past_due')}</option>
            <option value="canceled">{t('billing.status_canceled')}</option>
            <option value="expired">{t('billing.status_expired')}</option>
          </Select>
        </Field>
        <Field label={t('platform.interval_field')}>
          <Select value={interval} onChange={(e) => setInterval(e.target.value)}>
            <option value="">{t('platform.no_interval')}</option>
            <option value="monthly">{t('billing.monthly')}</option>
            <option value="annual">{t('billing.annual')}</option>
          </Select>
        </Field>
        <Field label={t('platform.period_end')} hint={t('platform.period_end_hint')}>
          <Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

interface PlatformPlan {
  id: number; key: string; name: I18nText; description: I18nText;
  priceMonthlyCents: number | null; priceAnnualCents: number | null; maxUsers: number | null; maxLocations: number | null;
  features: Record<string, boolean>; stripePriceIdMonthly: string | null; stripePriceIdAnnual: string | null; isActive: boolean;
}

/** Catálogo de planes editable: precios, límites y funciones incluidas de cada plan. */
function PlansModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['platform', 'plans'], queryFn: () => api.get<{ items: PlatformPlan[] }>('/platform/plans') });
  return (
    <Modal open onClose={onClose} size="xl" title={t('platform.edit_plans_title')} footer={<Button onClick={onClose}>{t('common.close')}</Button>}>
      <p className="muted" style={{ marginTop: -6, marginBottom: 14 }}>{t('platform.edit_plans_subtitle')}</p>
      <div className="stack">
        {q.data?.items.map((p) => (
          <PlanEditor key={p.id} plan={p} onSaved={() => qc.invalidateQueries({ queryKey: ['platform', 'plans'] })} />
        ))}
      </div>
    </Modal>
  );
}

function centsToStr(c: number | null): string { return c == null ? '' : (c / 100).toFixed(2).replace(/\.00$/, ''); }
function strToCents(s: string): number | null { const v = s.trim(); if (!v) return null; const n = Math.round(Number(v) * 100); return Number.isFinite(n) && n >= 0 ? n : null; }
function numToStr(n: number | null): string { return n == null ? '' : String(n); }
function strToNum(s: string): number | null { const v = s.trim(); if (!v) return null; const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : null; }

function PlanEditor({ plan, onSaved }: { plan: PlatformPlan; onSaved: () => void }) {
  const { t } = useTranslation();
  const err = useErr();
  const toast = useToast();
  const [name, setName] = useState(plan.name);
  const [description, setDescription] = useState(plan.description);
  const [priceMonthly, setPriceMonthly] = useState(centsToStr(plan.priceMonthlyCents));
  const [priceAnnual, setPriceAnnual] = useState(centsToStr(plan.priceAnnualCents));
  const [maxUsers, setMaxUsers] = useState(numToStr(plan.maxUsers));
  const [maxLocations, setMaxLocations] = useState(numToStr(plan.maxLocations));
  const [advancedReports, setAdvancedReports] = useState(!!plan.features?.advancedReports);
  const [prioritySupport, setPrioritySupport] = useState(!!plan.features?.prioritySupport);
  const [isActive, setIsActive] = useState(plan.isActive);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await api.patch(`/platform/plans/${plan.id}`, {
        name, description,
        priceMonthlyCents: strToCents(priceMonthly), priceAnnualCents: strToCents(priceAnnual),
        maxUsers: strToNum(maxUsers), maxLocations: strToNum(maxLocations),
        features: { advancedReports, prioritySupport }, isActive,
      });
      toast.success(t('platform.plan_saved')); onSaved();
    } catch (e) { toast.error(err(e)); } finally { setBusy(false); }
  }

  return (
    <div className="card" style={{ padding: 16 }}>
      <div className="row spread" style={{ marginBottom: 10 }}>
        <strong>{plan.key}</strong>
        <Checkbox checked={isActive} onChange={setIsActive} label={t('common.active')} />
      </div>
      <div className="form-grid">
        <I18nInput label={t('platform.plan_name')} value={name} onChange={setName} />
        <I18nInput label={t('platform.plan_description')} value={description} onChange={setDescription} />
        <Field label={t('platform.price_monthly')} hint={t('platform.price_empty_hint')}><Input value={priceMonthly} onChange={(e) => setPriceMonthly(e.target.value)} placeholder="69" inputMode="decimal" /></Field>
        <Field label={t('platform.price_annual')} hint={t('platform.price_annual_hint')}><Input value={priceAnnual} onChange={(e) => setPriceAnnual(e.target.value)} placeholder="660" inputMode="decimal" /></Field>
        <Field label={t('platform.max_users_field')} hint={t('platform.max_empty_hint')}><Input value={maxUsers} onChange={(e) => setMaxUsers(e.target.value)} placeholder="5" inputMode="numeric" /></Field>
        <Field label={t('platform.max_locations_field')} hint={t('platform.max_empty_hint')}><Input value={maxLocations} onChange={(e) => setMaxLocations(e.target.value)} placeholder="2" inputMode="numeric" /></Field>
      </div>
      <div className="row gap-sm" style={{ margin: '10px 0' }}>
        <Checkbox checked={advancedReports} onChange={setAdvancedReports} label={t('billing.feature_advanced_reports')} />
        <Checkbox checked={prioritySupport} onChange={setPrioritySupport} label={t('billing.feature_priority_support')} />
      </div>
      {(plan.stripePriceIdMonthly || plan.stripePriceIdAnnual) && (
        <p className="muted" style={{ fontSize: 12 }}>
          {t('platform.stripe_price_hint')}<br />
          {plan.stripePriceIdMonthly && <>{t('platform.stripe_price_monthly')}: <span className="mono">{plan.stripePriceIdMonthly}</span><br /></>}
          {plan.stripePriceIdAnnual && <>{t('platform.stripe_price_annual')}: <span className="mono">{plan.stripePriceIdAnnual}</span></>}
        </p>
      )}
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
        <Button variant="primary" size="sm" loading={busy} onClick={save}>{t('platform.save_plan')}</Button>
      </div>
    </div>
  );
}
