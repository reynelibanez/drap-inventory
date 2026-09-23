import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { Button, Field, Input, Modal, Select, useErr, useToast } from './ui';

type CostMode = 'set' | 'pct' | 'add' | 'plan';
type PriceMode = 'set' | 'pct' | 'add' | 'margin' | 'rules' | 'clear';
export const ROUNDINGS = ['none', 'unit', 'five', 'ten', 'x99'] as const;

function useRefreshAll() {
  const qc = useQueryClient();
  return () => { for (const k of ['units', 'unit', 'lot', 'lot-costs', 'lots', 'orders', 'order', 'dashboard']) void qc.invalidateQueries({ queryKey: [k] }); };
}

/** Cambiar el costo de uno o varios equipos: costo exacto, subir/bajar un porcentaje o un monto, o volver al reparto del lote. */
export function BulkCostModal({ unitIds, onClose, onDone }: { unitIds: number[]; onClose: () => void; onDone?: () => void }) {
  const { t } = useTranslation();
  const err = useErr();
  const toast = useToast();
  const refresh = useRefreshAll();
  const [mode, setMode] = useState<CostMode>('set');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const needs = mode !== 'plan';
  const ok = !needs || (value.trim() !== '' && Number.isFinite(Number(value)) && (mode !== 'set' || Number(value) >= 0));

  async function save() {
    setBusy(true);
    try {
      await api.post('/units/costs', { unitIds, mode, value: needs ? Number(value) : undefined });
      toast.success(t('pricing.cost_saved', { count: unitIds.length }));
      refresh(); onDone?.(); onClose();
    } catch (e) { toast.error(err(e)); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} size="sm" title={t('pricing.cost_title', { count: unitIds.length })}
      footer={<><Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} disabled={!ok} onClick={save}>{t('common.apply')}</Button></>}>
      <div className="stack">
        <Field label={t('pricing.how')}>
          <Select value={mode} onChange={(e) => setMode(e.target.value as CostMode)}>
            <option value="set">{t('pricing.cm_set')}</option><option value="pct">{t('pricing.cm_pct')}</option><option value="add">{t('pricing.cm_add')}</option><option value="plan">{t('pricing.cm_plan')}</option>
          </Select>
        </Field>
        {needs && (
          <Field label={t(mode === 'set' ? 'pricing.v_amount' : mode === 'pct' ? 'pricing.v_pct' : 'pricing.v_delta')} hint={mode !== 'set' ? t('pricing.v_signed_hint') : undefined}>
            <Input type="number" step="0.01" inputMode="decimal" autoFocus value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && ok) void save(); }} />
          </Field>
        )}
        <p className="field-hint">{t(mode === 'plan' ? 'pricing.cost_plan_hint' : 'pricing.cost_manual_hint')}</p>
      </div>
    </Modal>
  );
}

/** Cambiar el precio de lista de uno o varios equipos. */
export function BulkPriceModal({ unitIds, canCost, onClose, onDone }: { unitIds: number[]; canCost: boolean; onClose: () => void; onDone?: () => void }) {
  const { t } = useTranslation();
  const err = useErr();
  const toast = useToast();
  const refresh = useRefreshAll();
  const [mode, setMode] = useState<PriceMode>('set');
  const [value, setValue] = useState('');
  const [rounding, setRounding] = useState<(typeof ROUNDINGS)[number]>('none');
  const [busy, setBusy] = useState(false);
  const needs = mode !== 'rules' && mode !== 'clear';
  const rounds = mode === 'pct' || mode === 'add' || mode === 'margin';
  const n = Number(value);
  const ok = !needs || (value.trim() !== '' && Number.isFinite(n) && (mode !== 'set' || n >= 0) && (mode !== 'margin' || n < 100));

  async function save() {
    setBusy(true);
    try {
      const r = await api.post<{ changed: number; skipped: number }>('/units/prices', { unitIds, mode, value: needs ? n : undefined, rounding: rounds ? rounding : 'none' });
      toast.success(t('pricing.price_saved', { count: r.changed }) + (r.skipped ? ` ${t('pricing.price_skipped', { count: r.skipped })}` : ''));
      refresh(); onDone?.(); onClose();
    } catch (e) { toast.error(err(e)); } finally { setBusy(false); }
  }
  const hints: Record<PriceMode, string> = { set: 'pricing.pm_set_hint', pct: 'pricing.pm_pct_hint', add: 'pricing.pm_add_hint', margin: 'pricing.pm_margin_hint', rules: 'pricing.pm_rules_hint', clear: 'pricing.pm_clear_hint' };
  return (
    <Modal open onClose={onClose} size="sm" title={t('pricing.price_title', { count: unitIds.length })}
      footer={<><Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} disabled={!ok} onClick={save}>{t('common.apply')}</Button></>}>
      <div className="stack">
        <Field label={t('pricing.how')}>
          <Select value={mode} onChange={(e) => setMode(e.target.value as PriceMode)}>
            <option value="set">{t('pricing.pm_set')}</option><option value="pct">{t('pricing.pm_pct')}</option><option value="add">{t('pricing.pm_add')}</option>
            {canCost && <option value="margin">{t('pricing.pm_margin')}</option>}
            <option value="rules">{t('pricing.pm_rules')}</option><option value="clear">{t('pricing.pm_clear')}</option>
          </Select>
        </Field>
        {needs && (
          <Field label={t(mode === 'set' ? 'pricing.v_amount' : mode === 'pct' ? 'pricing.v_pct' : mode === 'margin' ? 'pricing.v_margin' : 'pricing.v_delta')} hint={mode === 'pct' || mode === 'add' ? t('pricing.v_signed_hint') : undefined}>
            <Input type="number" step="0.01" inputMode="decimal" autoFocus value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && ok) void save(); }} />
          </Field>
        )}
        {rounds && (
          <Field label={t('pricing.rounding')}>
            <Select value={rounding} onChange={(e) => setRounding(e.target.value as (typeof ROUNDINGS)[number])}>{ROUNDINGS.map((r) => <option key={r} value={r}>{t(`pricing.r_${r}`)}</option>)}</Select>
          </Field>
        )}
        <p className="field-hint">{t(hints[mode])}</p>
      </div>
    </Modal>
  );
}
