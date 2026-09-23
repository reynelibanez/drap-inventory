import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Copy, Plus, Printer, Save, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useMeta } from '../lib/meta';
import { templateForOrder } from '../lib/labels';
import { EMPTY_PACKAGE, orderToLabels, type OrderForLabels, type Package, type Shipping } from '../lib/orderLabels';
import { printLabels } from '../lib/printLabels';
import { useLabelCtx, useLabelTemplates } from '../lib/useLabels';
import { Alert } from './Alert';
import { Button, Field, Input, Modal, Select, Spinner, useErr, useToast } from './ui';
import { LabelStyles, ScaledLabel } from './LabelView';

type Row = { weight: string; length: string; width: string; height: string };
const toRow = (p: Package): Row => ({ weight: p.weight === null ? '' : String(p.weight), length: p.length === null ? '' : String(p.length), width: p.width === null ? '' : String(p.width), height: p.height === null ? '' : String(p.height) });
const toNum = (v: string): number | null => { const n = Number(v.replace(',', '.')); return v.trim() === '' || !Number.isFinite(n) || n < 0 ? null : n; };
const toPackage = (r: Row): Package => ({ weight: toNum(r.weight), length: toNum(r.length), width: toNum(r.width), height: toNum(r.height) });
const EMPTY_ROW = toRow(EMPTY_PACKAGE);

/**
 * Etiquetas de envío de un pedido: una por bulto, con el nombre del cliente, el peso y las medidas de cada bulto.
 * Los datos de envío se guardan en el pedido, así que se pueden reimprimir después.
 */
export function PrintOrderLabelsModal({ order, onClose }: { order: OrderForLabels & { id: number; statusKey: string }; onClose: () => void }) {
  const { t } = useTranslation();
  const meta = useMeta();
  const ctx = useLabelCtx();
  const err = useErr();
  const toast = useToast();
  const qc = useQueryClient();
  const { can } = useAuth();
  const tpls = useLabelTemplates();
  const templates = (tpls.data ?? []).filter((x) => x.kind === 'order' && x.isActive);
  const canSave = can('sales.edit') && order.statusKey !== 'cancelled';

  const start = order.shipping;
  const [weightUnit, setWeightUnit] = useState<Shipping['weightUnit']>(start.weightUnit);
  const [dimUnit, setDimUnit] = useState<Shipping['dimUnit']>(start.dimUnit);
  const [rows, setRows] = useState<Row[]>(start.packages.length ? start.packages.map(toRow) : [{ ...EMPTY_ROW }]);
  const [tplId, setTplId] = useState<number | ''>('');
  const [preview, setPreview] = useState(0);
  const [busy, setBusy] = useState<'save' | 'print' | null>(null);

  const shipping: Shipping = useMemo(() => ({ weightUnit, dimUnit, packages: rows.map(toPackage) }), [weightUnit, dimUnit, rows]);
  const dirty = JSON.stringify(shipping) !== JSON.stringify(start.packages.length ? start : { ...start, packages: [EMPTY_PACKAGE] });
  const labels = useMemo(() => orderToLabels(order, meta, shipping, t('orders.quick.no_customer_label')), [order, meta, shipping, t]);
  const tpl = templates.find((x) => x.id === tplId) ?? templateForOrder(templates);
  const shown = labels[Math.min(preview, labels.length - 1)];

  const setRow = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const setCount = (n: number) => setRows((rs) => {
    const c = Math.min(200, Math.max(1, n || 1));
    return c <= rs.length ? rs.slice(0, c) : [...rs, ...Array.from({ length: c - rs.length }, () => ({ ...EMPTY_ROW }))];
  });
  const copyFirst = () => setRows((rs) => rs.map((r, i) => (i === 0 ? r : { ...rs[0] })));

  async function persist(): Promise<void> {
    await api.put(`/orders/${order.id}/shipping`, shipping);
    void qc.invalidateQueries({ queryKey: ['order', order.id] });
  }
  async function save() {
    setBusy('save');
    try { await persist(); toast.success(t('common.saved')); } catch (e) { toast.error(err(e)); } finally { setBusy(null); }
  }
  async function print() {
    if (!tpl) return;
    setBusy('print');
    try {
      if (canSave && dirty) await persist();
      await printLabels({ template: tpl, units: labels, ctx });
      onClose();
    } catch (e) { toast.error(err(e)); } finally { setBusy(null); }
  }

  const numInput = (i: number, key: keyof Row, w = 84) => (
    <Input type="number" min={0} step="0.01" inputMode="decimal" className="count-input" style={{ width: w }} value={rows[i][key]} onChange={(e) => setRow(i, { [key]: e.target.value })} />
  );

  return (
    <Modal open onClose={onClose} size="lg" title={t('orders.labels.title', { code: order.code })}
      footer={<>
        <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
        {canSave && <Button icon={<Save size={16} />} loading={busy === 'save'} disabled={!dirty} onClick={() => void save()}>{t('orders.labels.save')}</Button>}
        <Button variant="primary" icon={<Printer size={16} />} loading={busy === 'print'} disabled={!tpl || !labels.length} onClick={() => void print()}>{t('labels.print.print')} ({labels.length})</Button>
      </>}>
      <LabelStyles />
      {tpls.isLoading ? <Spinner /> : !templates.length ? (
        <Alert kind="warn">{t('orders.labels.no_template')} {can('labels.manage') && <Link to="/settings/labels">{t('labels.print.open_designer')}</Link>}</Alert>
      ) : (
        <div className="stack">
          <div className="row wrap" style={{ alignItems: 'flex-end' }}>
            <Field label={t('labels.print.template')} className="grow">
              <Select value={tpl?.id ?? ''} onChange={(e) => setTplId(Number(e.target.value))}>
                {templates.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.widthMm} × {x.heightMm} mm){x.isDefault ? ' ★' : ''}</option>)}
              </Select>
            </Field>
            <Field label={t('orders.labels.weight_unit')}>
              <Select value={weightUnit} onChange={(e) => setWeightUnit(e.target.value as Shipping['weightUnit'])}><option value="lb">lb</option><option value="kg">kg</option></Select>
            </Field>
            <Field label={t('orders.labels.dim_unit')}>
              <Select value={dimUnit} onChange={(e) => setDimUnit(e.target.value as Shipping['dimUnit'])}><option value="in">in</option><option value="cm">cm</option></Select>
            </Field>
            <Field label={t('orders.labels.packages')}>
              <Input type="number" min={1} max={200} style={{ width: 90 }} value={rows.length} onChange={(e) => setCount(Number(e.target.value))} />
            </Field>
          </div>

          <div className="stack">
            <div className="stack sm" style={{ minWidth: 0 }}>
              <div className="table-wrap">
                <table className="table m-stack">
                  <thead>
                    <tr>
                      <th>{t('orders.labels.package')}</th><th>{t('orders.labels.weight')} ({weightUnit})</th>
                      <th>{t('orders.labels.length')} ({dimUnit})</th><th>{t('orders.labels.width')} ({dimUnit})</th><th>{t('orders.labels.height')} ({dimUnit})</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((_, i) => (
                      <tr key={i} onClick={() => setPreview(i)} style={{ cursor: 'pointer', background: i === Math.min(preview, rows.length - 1) ? 'var(--surface-2, transparent)' : undefined }}>
                        <td className="mono m-primary"><strong>{t('orders.labels.package')} {i + 1}/{rows.length}</strong></td>
                        <td data-label={`${t('orders.labels.weight')} (${weightUnit})`}>{numInput(i, 'weight')}</td><td data-label={`${t('orders.labels.length')} (${dimUnit})`}>{numInput(i, 'length', 70)}</td><td data-label={`${t('orders.labels.width')} (${dimUnit})`}>{numInput(i, 'width', 70)}</td><td data-label={`${t('orders.labels.height')} (${dimUnit})`}>{numInput(i, 'height', 70)}</td>
                        <td>{rows.length > 1 && <button type="button" className="icon-btn" title={t('common.remove')} onClick={(e) => { e.stopPropagation(); setRows((rs) => rs.filter((_r, j) => j !== i)); }}><Trash2 size={15} /></button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="row gap-sm wrap">
                <Button size="sm" icon={<Plus size={14} />} onClick={() => setCount(rows.length + 1)}>{t('orders.labels.add_package')}</Button>
                {rows.length > 1 && <Button size="sm" icon={<Copy size={14} />} onClick={copyFirst}>{t('orders.labels.copy_first')}</Button>}
              </div>
              <div className="field-hint">{canSave ? t('orders.labels.hint') : t('orders.labels.hint_readonly')}</div>
            </div>
            <div className="lbl-print-preview" style={{ flexDirection: 'column', alignItems: 'center' }}>
              {tpl && shown && <ScaledLabel k={Math.min(1.6, 260 / (tpl.widthMm * 3.78))} widthMm={tpl.widthMm} heightMm={tpl.heightMm} elements={tpl.layout.elements} unit={shown} ctx={ctx}
                style={{ boxShadow: '0 0 0 1px var(--border-strong)' }} />}
              {labels.length > 1 && <div className="muted" style={{ textAlign: 'center', marginTop: 8 }}>{t('orders.labels.preview_of', { n: shown.packageNo, total: labels.length })}</div>}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
