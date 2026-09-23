import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Printer } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { sourceLabel, type LabelCustom, type LabelElement, type LabelTemplate } from '../lib/labels';
import { printLabels } from '../lib/printLabels';
import { useLabelCtx, useLabelTemplates } from '../lib/useLabels';
import { Button, Field, Input, Modal, Select, Spinner, useErr, useToast } from './ui';
import { LabelStyles, ScaledLabel } from './LabelView';

/** Fuentes de datos que se llenan solas (no tiene sentido pedirlas a mano). */
const AUTO_SOURCES = new Set(['company', 'today']);

/** Fuentes distintas que usa una plantilla (campos, QR y código de barras con dato propio, salvo las automáticas). */
function templateSources(tpl: LabelTemplate): string[] {
  const set = new Set<string>();
  for (const el of tpl.layout.elements as LabelElement[]) {
    if ((el.type === 'field' || el.type === 'qr' || el.type === 'barcode') && el.source && el.source !== 'info' && !AUTO_SOURCES.has(el.source)) set.add(el.source);
  }
  return [...set];
}

/**
 * Imprime una etiqueta/documento con información escrita a mano, sin asociarla a ningún equipo, lote ni pedido real.
 * Útil para una etiqueta suelta con datos personalizados (por ejemplo, un rótulo para un estante o un paquete especial).
 */
export function CustomLabelModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const err = useErr();
  const toast = useToast();
  const docCtx = useLabelCtx();
  const uiCtx = useLabelCtx('ui');
  const tpls = useLabelTemplates();
  const templates = (tpls.data ?? []).filter((x) => x.isActive && (x.kind === 'unit' || !x.kind));
  const [templateId, setTemplateId] = useState<number | ''>('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [copies, setCopies] = useState(1);
  const [busy, setBusy] = useState(false);

  const tpl = templates.find((x) => x.id === templateId) ?? null;
  const sources = useMemo(() => (tpl ? templateSources(tpl) : []), [tpl]);
  const subject: LabelCustom = { kind: 'custom', values };

  async function print() {
    if (!tpl) return;
    setBusy(true);
    try {
      await printLabels({ template: tpl, units: Array.from({ length: copies }, () => subject), ctx: docCtx });
      onClose();
    } catch (e) { toast.error(err(e)); } finally { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} title={t('labels.custom.title')} size="lg"
      footer={<>
        <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" icon={<Printer size={16} />} loading={busy} disabled={!tpl} onClick={() => void print()}>{t('labels.print.print')}</Button>
      </>}>
      <LabelStyles />
      {tpls.isLoading ? <Spinner /> : !templates.length ? (
        <div className="alert alert-warn">{t('labels.print.no_template')} {can('labels.manage') && <Link to="/settings/labels">{t('labels.print.open_designer')}</Link>}</div>
      ) : (
        <div className="stack">
          <p className="muted">{t('labels.custom.hint')}</p>
          <div className="row wrap" style={{ alignItems: 'flex-end' }}>
            <Field label={t('labels.print.template')}>
              <Select value={templateId} style={{ minWidth: 240 }} onChange={(e) => { setTemplateId(e.target.value ? Number(e.target.value) : ''); setValues({}); }}>
                <option value="">—</option>
                {templates.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.widthMm} × {x.heightMm} mm)</option>)}
              </Select>
            </Field>
            <Field label={t('labels.print.copies')}>
              <Input type="number" min={1} max={20} style={{ width: 90 }} value={copies} onChange={(e) => setCopies(Math.min(20, Math.max(1, Number(e.target.value) || 1)))} />
            </Field>
          </div>

          {tpl && (
            <div className="row wrap" style={{ alignItems: 'flex-start', gap: 24 }}>
              <div className="stack sm grow" style={{ minWidth: 240 }}>
                {sources.length === 0 && <div className="muted">{t('labels.custom.no_fields')}</div>}
                {sources.map((s) => (
                  <Field key={s} label={sourceLabel(s, uiCtx)}>
                    <Input value={values[s] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [s]: e.target.value }))} />
                  </Field>
                ))}
              </div>
              <div className="lbl-print-preview">
                <ScaledLabel k={Math.min(2.2, 300 / (tpl.widthMm * 3.78))} widthMm={tpl.widthMm} heightMm={tpl.heightMm} elements={tpl.layout.elements} unit={subject} ctx={docCtx}
                  style={{ boxShadow: '0 0 0 1px var(--border-strong)' }} />
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

