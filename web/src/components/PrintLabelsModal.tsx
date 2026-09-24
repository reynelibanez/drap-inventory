import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Printer } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { useMeta } from '../lib/meta';
import { fetchLabelAssets, fetchLabelUnits, groupByTemplate, logUnitPrints } from '../lib/printUnits';
import { printLabels } from '../lib/printLabels';
import { templateForType } from '../lib/labels';
import { useLabelCtx, useLabelTemplates } from '../lib/useLabels';
import { Button, Field, Input, Modal, Select, Spinner, useErr, useToast } from './ui';
import { LabelStyles, ScaledLabel } from './LabelView';

/** Ventana para imprimir las etiquetas de uno o varios equipos (o activos de la empresa): plantilla por tipo, copias y vista previa. */
export function PrintLabelsModal({ unitIds, assets = false, onClose }: { unitIds: number[]; assets?: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const meta = useMeta();
  const ctx = useLabelCtx();
  const err = useErr();
  const toast = useToast();
  const { can } = useAuth();
  const tpls = useLabelTemplates();
  const units = useQuery({ queryKey: [assets ? 'label-assets' : 'label-units', unitIds.join(',')], queryFn: () => (assets ? fetchLabelAssets(unitIds) : fetchLabelUnits(unitIds)) });
  const [copies, setCopies] = useState(1);
  const [over, setOver] = useState<Record<number, number>>({});   // tipo → plantilla elegida
  const [busy, setBusy] = useState(false);

  const templates = (tpls.data ?? []).filter((x) => x.isActive && (x.kind === 'unit' || !x.kind));
  const list = units.data ?? [];
  const typeIds = useMemo(() => [...new Set(list.map((u) => u.equipmentTypeId))], [list]);
  const jobs = useMemo(() => groupByTemplate(list, templates, over), [list, templates, over]);
  const total = jobs.reduce((a, j) => a + j.units.length, 0) * copies;

  async function print() {
    setBusy(true);
    try {
      for (const job of jobs) await printLabels({ template: job.template, units: job.units.flatMap((u) => Array.from({ length: copies }, () => u)), ctx });
      if (!assets) void logUnitPrints(unitIds);
      onClose();
    } catch (e) { toast.error(err(e)); } finally { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} title={t('labels.print.title')} size="lg"
      footer={<>
        <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" icon={<Printer size={16} />} loading={busy} disabled={!total} autoFocus onClick={() => void print()}>{t('labels.print.print')} ({total})</Button>
      </>}>
      <LabelStyles />
      {tpls.isLoading || units.isLoading ? <Spinner /> : !templates.length ? (
        <div className="alert alert-warn">{t('labels.print.no_template')} {can('labels.manage') && <Link to="/settings/labels">{t('labels.print.open_designer')}</Link>}</div>
      ) : (
        <div className="stack">
          <div className="row wrap">
            <strong>{t('labels.print.units', { count: list.length })}</strong>
            <span className="grow" />
            <Field label={t('labels.print.copies')}>
              <Input type="number" min={1} max={20} style={{ width: 90 }} value={copies} onChange={(e) => setCopies(Math.min(20, Math.max(1, Number(e.target.value) || 1)))} />
            </Field>
          </div>
          {typeIds.map((typeId) => {
            const sample = list.find((u) => u.equipmentTypeId === typeId)!;
            const count = list.filter((u) => u.equipmentTypeId === typeId).length;
            const tpl = templates.find((x) => x.id === over[typeId]) ?? templateForType(templates, typeId);
            return (
              <div key={typeId} className="lbl-print-row">
                <div className="stack sm" style={{ minWidth: 0 }}>
                  <strong>{t('labels.print.group', { count, type: meta.typeName(typeId) })}</strong>
                  <Field label={t('labels.print.template')}>
                    <Select value={tpl?.id ?? ''} onChange={(e) => setOver((o) => ({ ...o, [typeId]: Number(e.target.value) }))}>
                      {templates.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.widthMm} × {x.heightMm} mm){x.typeIds.includes(typeId) ? ' ★' : ''}</option>)}
                    </Select>
                  </Field>
                </div>
                <div className="lbl-print-preview">
                  {tpl && <ScaledLabel k={Math.min(2.2, 300 / (tpl.widthMm * 3.78))} widthMm={tpl.widthMm} heightMm={tpl.heightMm} elements={tpl.layout.elements} unit={sample} ctx={ctx}
                    style={{ boxShadow: '0 0 0 1px var(--border-strong)' }} />}
                </div>
              </div>
            );
          })}
          <div className="muted">{t('labels.print.total', { n: total })}</div>
          <div className="field-hint">{t('labels.print.hint')}</div>
        </div>
      )}
    </Modal>
  );
}
