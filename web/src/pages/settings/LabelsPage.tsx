import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowLeftRight, Copy, FileText, Package, Plus, Save, Tag, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { useMeta } from '../../lib/meta';
import { LABEL_PRESETS, uid, type LabelElement, type LabelKind, type LabelTemplate } from '../../lib/labels';
import { useLabelTemplates } from '../../lib/useLabels';
import { Alert } from '../../components/Alert';
import { Badge, Button, Card, Checkbox, Empty, Field, Input, PageHeader, Select, Spinner, useConfirm, useErr, useToast } from '../../components/ui';
import { LabelCanvas } from '../../components/LabelCanvas';
import { useIsMobile } from '../../lib/useIsMobile';

interface Draft {
  id: number | null;
  kind: LabelKind;
  name: string; widthMm: number; heightMm: number; rotation: 0 | 90 | 180 | 270;
  isDefault: boolean; isActive: boolean; typeIds: number[]; elements: LabelElement[];
}

const fromTemplate = (t: LabelTemplate): Draft => ({
  id: t.id, kind: t.kind ?? 'unit', name: t.name, widthMm: t.widthMm, heightMm: t.heightMm, rotation: t.rotation, isDefault: t.isDefault, isActive: t.isActive,
  typeIds: [...t.typeIds], elements: t.layout.elements.map((e) => ({ ...e })),
});

/** Punto de partida de una plantilla nueva: QR a la izquierda y el resto de los datos a la derecha, ajustado al tamaño. */
function starter(w: number, h: number): LabelElement[] {
  const m = 2, qr = Math.min(h - 2 * m, w * 0.45), x0 = m + qr + 2, tw = Math.max(10, w - x0 - m);
  const big = h >= 30;
  return [
    { id: uid(), type: 'qr', source: 'code', x: m, y: (h - qr) / 2, w: qr, h: qr },
    { id: uid(), type: 'field', source: 'code', x: x0, y: m, w: tw, h: big ? 4.5 : 4, fontSize: 9, bold: true, shrink: true },
    { id: uid(), type: 'field', source: 'type', x: x0, y: m + (big ? 4.5 : 4), w: tw, h: 3.5, fontSize: 7, bold: true, shrink: true },
    { id: uid(), type: 'field', source: 'specs_all', x: x0, y: m + (big ? 8 : 7.5), w: tw, h: Math.max(4, h - (big ? 8 : 7.5) - m - 9), fontSize: 6.5, shrink: true },
    { id: uid(), type: 'field', source: 'grades', label: true, x: x0, y: h - m - 8, w: tw, h: 4, fontSize: 8, bold: true, shrink: true },
    { id: uid(), type: 'field', source: 'serial', label: true, x: x0, y: h - m - 3.5, w: tw, h: 3.5, fontSize: 6, shrink: true },
  ];
}

/**
 * Punto de partida de una etiqueta de pedido (envío): cliente y dirección arriba, pedido / bulto / peso / medidas al centro y
 * QR con el código del pedido abajo. Se dibuja para 102 × 152 mm y se escala al tamaño elegido.
 */
function orderStarter(w: number, h: number): LabelElement[] {
  const sx = w / 102, sy = h / 152, fs = Math.max(0.5, Math.min(sx, sy));
  const el = (source: string, x: number, y: number, ew: number, eh: number, o: Partial<LabelElement> = {}): LabelElement => ({
    id: uid(), type: 'field', source, x: +(x * sx).toFixed(1), y: +(y * sy).toFixed(1), w: +(ew * sx).toFixed(1), h: +(eh * sy).toFixed(1), shrink: true, ...o,
    ...(o.fontSize ? { fontSize: Math.max(4, +(o.fontSize * fs).toFixed(1)) } : {}),
  });
  const line = (y: number): LabelElement => ({ id: uid(), type: 'rect', filled: true, x: +(4 * sx).toFixed(1), y: +(y * sy).toFixed(1), w: +(94 * sx).toFixed(1), h: 0.5 });
  const qr = Math.min(42 * sx, 42 * sy);
  return [
    el('company', 4, 4, 94, 6, { fontSize: 10, bold: true }),
    line(11),
    el('customer', 4, 14, 94, 16, { fontSize: 24, bold: true, valign: 'middle' }),
    el('customer_address', 4, 31, 94, 22, { fontSize: 12 }),
    line(55),
    el('order_code', 4, 58, 62, 8, { fontSize: 14, bold: true, label: true }),
    el('package_of', 66, 58, 32, 14, { fontSize: 28, bold: true, align: 'right' }),
    el('weight', 4, 68, 62, 8, { fontSize: 14, bold: true, label: true }),
    el('size', 4, 78, 94, 8, { fontSize: 14, label: true }),
    el('units', 4, 88, 46, 6, { fontSize: 11, label: true }),
    el('date', 52, 88, 46, 6, { fontSize: 11, label: true, align: 'right' }),
    line(96),
    { id: uid(), type: 'qr', source: 'code', x: +(4 * sx).toFixed(1), y: +(102 * sy).toFixed(1), w: +qr.toFixed(1), h: +qr.toFixed(1) },
    { id: uid(), type: 'barcode', source: 'code', showText: true, x: +(50 * sx).toFixed(1), y: +(108 * sy).toFixed(1), w: +(48 * sx).toFixed(1), h: +(26 * sy).toFixed(1) },
  ];
}

/**
 * Punto de partida de un documento de lote: título con ícono, datos del lote y un resumen de líneas, en tamaño carta.
 * Se dibuja para 210 × 297 mm (A4) y se escala al tamaño elegido.
 */
function lotStarter(w: number, h: number): LabelElement[] {
  const sx = w / 210, sy = h / 297, fs = Math.max(0.5, Math.min(sx, sy));
  const el = (source: string, x: number, y: number, ew: number, eh: number, o: Partial<LabelElement> = {}): LabelElement => ({
    id: uid(), type: 'field', source, x: +(x * sx).toFixed(1), y: +(y * sy).toFixed(1), w: +(ew * sx).toFixed(1), h: +(eh * sy).toFixed(1), shrink: true, ...o,
    ...(o.fontSize ? { fontSize: Math.max(4, +(o.fontSize * fs).toFixed(1)) } : {}),
  });
  const line = (y: number): LabelElement => ({ id: uid(), type: 'rect', filled: true, x: +(10 * sx).toFixed(1), y: +(y * sy).toFixed(1), w: +(190 * sx).toFixed(1), h: 0.5 });
  const icon = +(10 * Math.min(sx, sy)).toFixed(1);
  return [
    { id: uid(), type: 'icon', icon: 'PackageCheck', x: +(10 * sx).toFixed(1), y: +(10 * sy).toFixed(1), w: icon, h: icon },
    el('company', 22, 10, 120, 8, { fontSize: 14, bold: true }),
    el('lot_code', 22, 19, 120, 6, { fontSize: 11, label: true }),
    line(32),
    el('lot_supplier', 10, 38, 90, 8, { fontSize: 11, label: true }),
    el('lot_purchase_date', 105, 38, 95, 8, { fontSize: 11, label: true }),
    el('lot_reference', 10, 48, 90, 8, { fontSize: 11, label: true }),
    el('lot_status', 105, 48, 95, 8, { fontSize: 11, label: true }),
    el('lot_lines_summary', 10, 62, 190, 14, { fontSize: 12 }),
    el('lot_expected', 10, 80, 60, 8, { fontSize: 11, label: true }),
    el('lot_counted', 75, 80, 60, 8, { fontSize: 11, label: true }),
    el('lot_units', 140, 80, 60, 8, { fontSize: 11, label: true }),
    el('lot_notes', 10, 94, 190, 20, { fontSize: 10 }),
    line(280),
    { id: uid(), type: 'qr', source: 'code', x: +(170 * sx).toFixed(1), y: +(10 * sy).toFixed(1), w: +(30 * sx).toFixed(1), h: +(30 * sy).toFixed(1) },
    el('today', 10, 285, 190, 6, { fontSize: 9, label: true }),
  ];
}

export default function LabelsPage() {
  const { t } = useTranslation();
  const mobile = useIsMobile();
  const meta = useMeta();
  const qc = useQueryClient();
  const err = useErr();
  const toast = useToast();
  const confirm = useConfirm();
  const list = useLabelTemplates();
  const templates = list.data ?? [];
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState('');          // copia serializada del último estado guardado
  const [saving, setSaving] = useState(false);
  const ser = (d: Draft | null) => (d ? JSON.stringify(d) : '');
  const dirty = !!draft && ser(draft) !== saved;

  const open = (d: Draft) => { setDraft(d); setSaved(ser(d)); };
  // Al llegar las plantillas por primera vez, abre la predeterminada.
  useEffect(() => { if (!draft && templates.length) open(fromTemplate(templates.find((x) => x.isDefault) ?? templates[0])); }, [templates.length]); // eslint-disable-line react-hooks/exhaustive-deps

  async function guardIfDirty(): Promise<boolean> {
    if (!dirty) return true;
    return confirm({ title: t('labels.discard_title'), message: t('labels.discard_msg'), danger: true, confirmLabel: t('labels.discard') });
  }
  async function select(tpl: LabelTemplate) { if (draft?.id === tpl.id) return; if (await guardIfDirty()) open(fromTemplate(tpl)); }
  async function createNew(kind: LabelKind) {
    if (!(await guardIfDirty())) return;
    const p = LABEL_PRESETS.find((x) => x.id === (kind === 'order' ? 'ship-4x6' : kind === 'lot' ? 'a4' : 'dymo-30334')) ?? LABEL_PRESETS[0];
    const name = kind === 'order' ? t('labels.new_order_name') : kind === 'lot' ? t('labels.new_lot_name') : t('labels.new_name');
    const d: Draft = {
      id: null, kind, name, widthMm: p.w, heightMm: p.h, rotation: 0,
      isDefault: !templates.some((x) => x.kind === kind), isActive: true, typeIds: [],
      elements: kind === 'order' ? orderStarter(p.w, p.h) : kind === 'lot' ? lotStarter(p.w, p.h) : starter(p.w, p.h),
    };
    setDraft(d); setSaved('');
  }

  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const preset = LABEL_PRESETS.find((p) => p.w === draft?.widthMm && p.h === draft?.heightMm);

  async function save() {
    if (!draft) return;
    if (!draft.name.trim()) { toast.error(t('labels.name_required')); return; }
    setSaving(true);
    try {
      const body = {
        kind: draft.kind, name: draft.name.trim(), widthMm: draft.widthMm, heightMm: draft.heightMm, rotation: draft.rotation,
        layout: { elements: draft.elements }, isDefault: draft.isDefault, isActive: draft.isActive, typeIds: draft.typeIds,
      };
      const r = draft.id ? await api.put<LabelTemplate>(`/label-templates/${draft.id}`, body) : await api.post<LabelTemplate>('/label-templates', body);
      await qc.invalidateQueries({ queryKey: ['label-templates'] });
      open(fromTemplate(r));
      toast.success(t('labels.saved'));
    } catch (e) { toast.error(err(e)); } finally { setSaving(false); }
  }

  async function duplicate() {
    if (!draft?.id) return;
    if (!(await guardIfDirty())) return;
    try {
      const r = await api.post<LabelTemplate>(`/label-templates/${draft.id}/duplicate`, {});
      await qc.invalidateQueries({ queryKey: ['label-templates'] });
      open(fromTemplate(r));
    } catch (e) { toast.error(err(e)); }
  }

  async function remove() {
    if (!draft) return;
    if (!draft.id) { const first = templates[0]; if (first) open(fromTemplate(first)); else setDraft(null); return; }
    if (!(await confirm({ title: t('labels.delete_title', { name: draft.name }), message: t('labels.delete_msg'), danger: true, confirmLabel: t('labels.delete') }))) return;
    try {
      await api.del(`/label-templates/${draft.id}`);
      toast.success(t('labels.deleted'));
      const rest = templates.filter((x) => x.id !== draft.id);
      await qc.invalidateQueries({ queryKey: ['label-templates'] });
      if (rest[0]) open(fromTemplate(rest[0])); else { setDraft(null); setSaved(''); }
    } catch (e) { toast.error(err(e)); }
  }

  const usedBy = useMemo(() => {
    const map = new Map<number, string>();
    for (const tpl of templates) if (tpl.id !== draft?.id) for (const id of tpl.typeIds) map.set(id, tpl.name);
    return map;
  }, [templates, draft?.id]);

  // Avisa antes de salir de la página con cambios sin guardar.
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  if (list.isLoading) return <Spinner />;

  return (
    <>
      <PageHeader title={t('labels.title')} subtitle={t('labels.subtitle')}
        actions={<>
          <Button icon={<Package size={16} />} onClick={() => void createNew('lot')}>{t('labels.new_lot_template')}</Button>
          <Button icon={<FileText size={16} />} onClick={() => void createNew('order')}>{t('labels.new_order_template')}</Button>
          <Button variant="primary" icon={<Plus size={16} />} onClick={() => void createNew('unit')}>{t('labels.new_template')}</Button>
        </>} />
      {mobile && <Alert>{t('mobile.designer_hint')}</Alert>}
      <div className="lbl-layout">
        <Card title={t('labels.templates')}>
          {!templates.length && !draft ? <Empty icon={<Tag size={32} />} title={t('labels.no_templates')} /> : (
            <div className="lbl-tpl-list">
              {(['unit', 'order', 'lot'] as const).map((k) => {
                const group = templates.filter((x) => (x.kind ?? 'unit') === k);
                const pending = draft && !draft.id && draft.kind === k;
                if (!group.length && !pending) return null;
                return (
                  <div key={k} className="lbl-tpl-group">
                    <div className="lbl-group-title">{k === 'unit' ? t('labels.group_units') : k === 'lot' ? t('labels.group_lot_docs') : t('labels.group_docs')}</div>
                    {group.map((tpl) => (
                      <button key={tpl.id} type="button" className={`lbl-tpl ${draft?.id === tpl.id ? 'on' : ''}`} onClick={() => void select(tpl)}>
                        <span className="row" style={{ justifyContent: 'space-between' }}>
                          <strong>{tpl.name}</strong>
                          {tpl.isDefault && <Badge tone="info">{t('labels.default')}</Badge>}
                        </span>
                        <span className="muted">{tpl.widthMm} × {tpl.heightMm} mm{!tpl.isActive && ` · ${t('common.inactive', { defaultValue: 'inactiva' })}`}</span>
                        {k === 'order' && <span className="row" style={{ flexWrap: 'wrap', gap: 4 }}><span className="chip">{t('labels.doc_order')}</span></span>}
                        {k === 'lot' && <span className="row" style={{ flexWrap: 'wrap', gap: 4 }}><span className="chip">{t('labels.doc_lot')}</span></span>}
                        {tpl.typeIds.length > 0 && <span className="row" style={{ flexWrap: 'wrap', gap: 4 }}>{tpl.typeIds.map((id) => <span key={id} className="chip">{meta.typeName(id)}</span>)}</span>}
                      </button>
                    ))}
                    {pending && <div className="lbl-tpl on"><strong>{draft.name}</strong><span className="muted">{t('labels.unsaved')}</span></div>}
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        {draft ? (
          <div className="stack">
            <Card title={<span className="row"><span>{draft.name || t('labels.new_name')}</span>{dirty && <Badge tone="warn">{t('labels.unsaved')}</Badge>}</span>}
              actions={<>
                {draft.id && <Button size="sm" icon={<Copy size={14} />} onClick={() => void duplicate()}>{t('labels.duplicate')}</Button>}
                <Button size="sm" variant="danger" icon={<Trash2 size={14} />} onClick={() => void remove()}>{t('labels.delete')}</Button>
                <Button size="sm" variant="primary" icon={<Save size={14} />} loading={saving} disabled={!dirty && !!draft.id} onClick={() => void save()}>{t('labels.save')}</Button>
              </>}>
              <div className="stack">
                <div className="grid grid-2">
                  <Field label={t('labels.name')} required><Input value={draft.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} /></Field>
                  <Field label={t('labels.preset')}>
                    <Select value={preset?.id ?? 'custom'} onChange={(e) => { const p = LABEL_PRESETS.find((x) => x.id === e.target.value); if (p) set({ widthMm: p.w, heightMm: p.h }); }}>
                      {!preset && <option value="custom">{t('labels.custom')}</option>}
                      {LABEL_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </Select>
                  </Field>
                </div>
                <div className="grid grid-4" style={{ alignItems: 'start' }}>
                  <Field label={t('labels.width')}><Input type="number" min={10} max={300} step={0.5} value={draft.widthMm} onChange={(e) => set({ widthMm: Math.min(300, Math.max(10, Number(e.target.value) || 10)) })} /></Field>
                  <Field label={t('labels.height')}><Input type="number" min={10} max={300} step={0.5} value={draft.heightMm} onChange={(e) => set({ heightMm: Math.min(300, Math.max(10, Number(e.target.value) || 10)) })} /></Field>
                  <Field label=" "><Button icon={<ArrowLeftRight size={14} />} onClick={() => set({ widthMm: draft.heightMm, heightMm: draft.widthMm })}>{t('labels.swap')}</Button></Field>
                  <Field label={t('labels.rotation')} hint={t('labels.rotation_hint')}>
                    <Select value={draft.rotation} onChange={(e) => set({ rotation: Number(e.target.value) as Draft['rotation'] })}>
                      <option value={0}>0°</option><option value={90}>90°</option><option value={180}>180°</option><option value={270}>270°</option>
                    </Select>
                  </Field>
                </div>
                <div className="row" style={{ flexWrap: 'wrap', gap: 24 }}>
                  <div><Checkbox checked={draft.isDefault} onChange={(v) => set({ isDefault: v })} label={t('labels.default')} />
                    <div className="field-hint">{t(draft.kind === 'order' ? 'labels.default_hint_order' : draft.kind === 'lot' ? 'labels.default_hint_lot' : 'labels.default_hint')}</div></div>
                  <Checkbox checked={draft.isActive} onChange={(v) => set({ isActive: v })} label={t('labels.active')} />
                </div>
                {draft.kind === 'order' ? (
                  <Alert kind="info"><strong>{t('labels.doc_order')}</strong> — {t('labels.doc_order_hint')}</Alert>
                ) : draft.kind === 'lot' ? (
                  <Alert kind="info"><strong>{t('labels.doc_lot')}</strong> — {t('labels.doc_lot_hint')}</Alert>
                ) : (
                <div>
                  <div className="field-label">{t('labels.types')}</div>
                  <div className="field-hint" style={{ marginBottom: 6 }}>{t('labels.types_hint')}</div>
                  <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                    {meta.typeList().map((ty) => {
                      const on = draft.typeIds.includes(ty.id);
                      const other = usedBy.get(ty.id);
                      return (
                        <button key={ty.id} type="button" className={`lbl-chip ${on ? 'on' : ''}`} title={other && !on ? t('labels.used_by', { name: other }) : undefined}
                          onClick={() => set({ typeIds: on ? draft.typeIds.filter((x) => x !== ty.id) : [...draft.typeIds, ty.id] })}>
                          <input type="checkbox" readOnly checked={on} tabIndex={-1} style={{ pointerEvents: 'none' }} />{meta.label(ty.name)}
                          {other && !on && <span className="muted" style={{ fontSize: 11 }}>· {other}</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
                )}
              </div>
            </Card>

            <Card>
              <LabelCanvas key={draft.id ?? `new-${draft.kind}`} kind={draft.kind} template={draft} elements={draft.elements} onChange={(elements) => set({ elements })} typeIds={draft.typeIds} />
            </Card>
          </div>
        ) : <Card><Empty icon={<Tag size={32} />} title={t('labels.pick')} action={<Button variant="primary" icon={<Plus size={16} />} onClick={() => void createNew('unit')}>{t('labels.new_template')}</Button>} /></Card>}
      </div>
    </>
  );
}
