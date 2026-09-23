import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { RotateCcw } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useReloadMeta } from '../../lib/meta';
import { Button, Card, Checkbox, Field, Input, PageHeader, Select, Spinner, useErr, useToast } from '../../components/ui';

interface Placement { sameModel: number; sameBrand: number; sameType: number; sameGrade: number; preferredArea: number; emptySlot: number; fillStarted: number }
interface Settings { unitCodeFormat: string; lotCodeFormat: string; orderCodeFormat: string; assetCodeFormat: string; reservationDays: number | null; autoPlaceOnTest: boolean; placement: Placement }
interface CompanyData { company: { id: number; name: string; legalName: string | null; taxId: string | null; defaultLanguage: 'es' | 'en'; currency: string; timezone: string }; settings: Settings; defaults: Settings }

/** Vista previa de una plantilla de código (misma lógica que el servidor). */
function preview(format: string, v: { lot?: string; tech?: number; seq?: number; n?: number }) {
  const d = new Date();
  const yyyy = String(d.getFullYear());
  return format.replace(/\{(yyyy|yy|mm|lot|tech|seq|n+)\}/g, (_m, tok: string) => {
    switch (tok) {
      case 'yyyy': return yyyy;
      case 'yy': return yyyy.slice(2);
      case 'mm': return String(d.getMonth() + 1).padStart(2, '0');
      case 'lot': return v.lot ?? '';
      case 'tech': return String(v.tech ?? '');
      case 'seq': return String(v.seq ?? '');
      default: return String(v.n ?? 0).padStart(tok.length, '0');
    }
  });
}

const WEIGHTS: (keyof Placement)[] = ['sameModel', 'sameBrand', 'sameType', 'sameGrade', 'preferredArea', 'emptySlot', 'fillStarted'];

export default function CompanySettingsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { reload } = useAuth();
  const reloadMeta = useReloadMeta();
  const err = useErr();
  const toast = useToast();
  const q = useQuery({ queryKey: ['company'], queryFn: () => api.get<CompanyData>('/company'), staleTime: 0 });
  const [c, setC] = useState<CompanyData['company'] | null>(null);
  const [s, setS] = useState<Settings | null>(null);
  const [days, setDays] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (q.data) { setC(q.data.company); setS(q.data.settings); setDays(q.data.settings.reservationDays ? String(q.data.settings.reservationDays) : ''); }
  }, [q.data]);
  if (!c || !s || !q.data) return <Spinner />;
  const d = q.data.defaults;
  const zones: string[] = (Intl as any).supportedValuesOf ? (Intl as any).supportedValuesOf('timeZone') : [];

  async function save() {
    setBusy(true);
    try {
      await api.patch('/company', {
        name: c!.name.trim(), legalName: c!.legalName?.trim() || null, taxId: c!.taxId?.trim() || null, defaultLanguage: c!.defaultLanguage, currency: c!.currency.trim().toUpperCase(), timezone: c!.timezone,
        settings: { unitCodeFormat: s!.unitCodeFormat, lotCodeFormat: s!.lotCodeFormat, orderCodeFormat: s!.orderCodeFormat, assetCodeFormat: s!.assetCodeFormat, reservationDays: days.trim() ? Math.floor(Number(days)) : null, autoPlaceOnTest: s!.autoPlaceOnTest, placement: s!.placement },
      });
      toast.success(t('common.saved'));
      void qc.invalidateQueries({ queryKey: ['company'] }); await reloadMeta(); await reload();
    } catch (e) { toast.error(err(e)); } finally { setBusy(false); }
  }
  const setP = (k: keyof Placement, v: string) => setS({ ...s!, placement: { ...s!.placement, [k]: Math.max(0, Number(v) || 0) } });

  return (
    <>
      <PageHeader title={t('company.title')} subtitle={t('company.subtitle')} actions={<Button variant="primary" loading={busy} onClick={save}>{t('common.save')}</Button>} />
      <div className="stack">
        <Card title={t('company.data')}>
          <div className="form-grid">
            <Field label={t('common.name')} required><Input value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} /></Field>
            <Field label={t('company.legal_name')}><Input value={c.legalName ?? ''} onChange={(e) => setC({ ...c, legalName: e.target.value })} /></Field>
            <Field label={t('partners.tax_id')}><Input value={c.taxId ?? ''} onChange={(e) => setC({ ...c, taxId: e.target.value })} /></Field>
            <Field label={t('company.default_language')} hint={t('company.default_language_hint')}>
              <Select value={c.defaultLanguage} onChange={(e) => setC({ ...c, defaultLanguage: e.target.value as 'es' | 'en' })}><option value="es">{t('common.es')}</option><option value="en">{t('common.en')}</option></Select>
            </Field>
            <Field label={t('common.currency')} hint={t('company.currency_hint')}><Input value={c.currency} maxLength={3} onChange={(e) => setC({ ...c, currency: e.target.value.toUpperCase() })} style={{ width: 100 }} /></Field>
            <Field label={t('company.timezone')}>
              <Input list="tz-list" value={c.timezone} onChange={(e) => setC({ ...c, timezone: e.target.value })} />
              <datalist id="tz-list">{zones.map((z) => <option key={z} value={z} />)}</datalist>
            </Field>
          </div>
        </Card>

        <Card title={t('company.codes')}>
          <p className="muted" style={{ marginBottom: 12 }}>{t('company.codes_hint')}</p>
          <div className="form-grid">
            <Field label={t('company.lot_format')} hint={<>{t('company.example')}: <strong className="mono">{preview(s.lotCodeFormat, { n: 1 })}</strong></>}>
              <Input value={s.lotCodeFormat} onChange={(e) => setS({ ...s, lotCodeFormat: e.target.value })} />
            </Field>
            <Field label={t('company.unit_format')} hint={<>{t('company.example')}: <strong className="mono">{preview(s.unitCodeFormat, { lot: preview(s.lotCodeFormat, { n: 1 }), tech: 1, seq: 120 })}</strong> — {t('company.unit_format_hint')}</>}>
              <Input value={s.unitCodeFormat} onChange={(e) => setS({ ...s, unitCodeFormat: e.target.value })} />
            </Field>
            <Field label={t('company.order_format')} hint={<>{t('company.example')}: <strong className="mono">{preview(s.orderCodeFormat, { n: 1 })}</strong></>}>
              <Input value={s.orderCodeFormat} onChange={(e) => setS({ ...s, orderCodeFormat: e.target.value })} />
            </Field>
            <Field label={t('company.asset_format')} hint={<>{t('company.example')}: <strong className="mono">{preview(s.assetCodeFormat, { n: 1 })}</strong> — {t('company.asset_format_hint')}</>}>
              <Input value={s.assetCodeFormat} onChange={(e) => setS({ ...s, assetCodeFormat: e.target.value })} />
            </Field>
          </div>
          <p className="muted" style={{ marginTop: 12 }}>{t('company.tokens')}</p>
        </Card>

        <Card title={t('company.sales')}>
          <Field label={t('company.reservation_days')} hint={t('company.reservation_days_hint')}>
            <Input type="number" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} style={{ width: 140 }} placeholder={t('company.no_expiry')} />
          </Field>
        </Card>

        <Card title={t('company.placement')} actions={<Button size="sm" variant="ghost" icon={<RotateCcw size={14} />} onClick={() => setS({ ...s, placement: { ...d.placement } })}>{t('common.reset')}</Button>}>
          <div style={{ marginBottom: 12 }}><Checkbox checked={s.autoPlaceOnTest !== false} onChange={(v) => setS({ ...s, autoPlaceOnTest: v })} label={t('company.auto_place')} /><div className="sub">{t('company.auto_place_hint')}</div></div>
          <p className="muted" style={{ marginBottom: 12 }}>{t('company.placement_hint')}</p>
          <div className="form-grid">
            {WEIGHTS.map((k) => (
              <Field key={k} label={t(`company.w.${k}`)} hint={t(`company.w_hint.${k}`)}>
                <Input type="number" min={0} max={1000} value={s.placement[k]} onChange={(e) => setP(k, e.target.value)} style={{ width: 120 }} />
              </Field>
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}
