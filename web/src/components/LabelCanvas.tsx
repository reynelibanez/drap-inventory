import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import * as LucideIcons from 'lucide-react';
import {
  AlignCenter, AlignLeft, AlignRight, ArrowDownToLine, ArrowUpToLine, Barcode, Bold, Copy, Italic, Minus, Plus, Printer, QrCode, Smile, Square, Trash2, Type,
} from 'lucide-react';
import { api, qs } from '../lib/api';
import { useMeta } from '../lib/meta';
import {
  barcodeSources, baseSources, qrSources, codeValue, DOCUMENT_ICONS, isSpecSource, sampleLot, sampleOrder, sampleUnit, sourceLabel, specKey, uid,
  type DocumentIcon, type LabelElement, type LabelKind, type LabelSubject, type LabelTemplate, type LabelUnit,
} from '../lib/labels';
import { orderToLabels, type OrderForLabels } from '../lib/orderLabels';
import { lotToLabel, type LotForLabels } from '../lib/lotLabels';
import { printLabels } from '../lib/printLabels';
import { useLabelCtx } from '../lib/useLabels';
import { Button, Checkbox, Field, Input, Select, Textarea, useErr, useToast } from './ui';
import { LabelStyles, LabelView, barcodeModuleMm } from './LabelView';

const PX_PER_MM = 96 / 25.4;
const snap = (v: number, step = 0.5) => Math.round(v / step) * step;
const round1 = (v: number) => Math.round(v * 10) / 10;

interface Props {
  template: Pick<LabelTemplate, 'name' | 'widthMm' | 'heightMm' | 'rotation'>;
  elements: LabelElement[];
  onChange: (els: LabelElement[]) => void;
  /** Tipos asociados a la plantilla: el primero se usa como vista previa inicial. */
  typeIds: number[];
  /** Clase de plantilla: de equipo (por tipo) o de pedido (envío). */
  kind?: LabelKind;
}

export function LabelCanvas({ template, elements, onChange, typeIds, kind = 'unit' }: Props) {
  const { t } = useTranslation();
  const meta = useMeta();
  const ctx = useLabelCtx();
  const uiCtx = useLabelCtx('ui');
  const err = useErr();
  const toast = useToast();
  const types = meta.typeList();
  const [typeId, setTypeId] = useState<number>(typeIds[0] ?? types[0]?.id ?? 0);
  const [realId, setRealId] = useState<number | ''>('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(0);            // 0 = ajustar al ancho disponible
  const [box, setBox] = useState(600);
  const wrapRef = useRef<HTMLDivElement>(null);
  const W = template.widthMm, H = template.heightMm;

  useEffect(() => { if (typeIds.length && !typeIds.includes(typeId) && !elements.length) setTypeId(typeIds[0]); }, [typeIds]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox(el.clientWidth));
    ro.observe(el);
    setBox(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const fit = Math.max(1, Math.min(8, (box - 40) / (W * PX_PER_MM)));
  const z = zoom || fit;
  const scale = PX_PER_MM * z;                   // px por mm en pantalla

  const isOrder = kind === 'order';
  const isLot = kind === 'lot';
  const realUnits = useQuery({
    queryKey: ['label-preview-units', typeId],
    queryFn: () => api.get<{ items: (LabelUnit & { id: number })[] }>(`/units${qs({ typeId, pageSize: 15, sort: 'newest' })}`),
    enabled: !!typeId && kind === 'unit',
  });
  const recentOrders = useQuery({
    queryKey: ['label-preview-orders'],
    queryFn: () => api.get<{ items: { id: number; code: string; customerName: string | null }[] }>(`/orders${qs({ pageSize: 15 })}`),
    enabled: isOrder,
  });
  const realOrder = useQuery({
    queryKey: ['label-preview-order', realId],
    queryFn: () => api.get<OrderForLabels>(`/orders/${realId}`),
    enabled: isOrder && !!realId,
  });
  const recentLots = useQuery({
    queryKey: ['label-preview-lots'],
    queryFn: () => api.get<{ items: { id: number; code: string }[] }>(`/lots${qs({ pageSize: 15 })}`),
    enabled: isLot,
  });
  const realLot = useQuery({
    queryKey: ['label-preview-lot', realId],
    queryFn: () => api.get<LotForLabels & { statusId: number }>(`/lots/${realId}`),
    enabled: isLot && !!realId,
  });
  const unit: LabelSubject = useMemo(() => {
    if (isOrder) return (realId && realOrder.data ? orderToLabels(realOrder.data, meta)[0] : null) ?? sampleOrder();
    if (isLot) return (realId && realLot.data ? lotToLabel(realLot.data, meta, meta.name(realLot.data.statusId)) : null) ?? sampleLot();
    const real = realId ? realUnits.data?.items.find((u) => u.id === realId) : null;
    return real ?? sampleUnit(meta, typeId);
  }, [isOrder, isLot, realId, realUnits.data, realOrder.data, realLot.data, meta, typeId]);

  const selected = elements.find((e) => e.id === selectedId) ?? null;
  const update = useCallback((id: string, patch: Partial<LabelElement>) => onChange(elements.map((e) => (e.id === id ? { ...e, ...patch } : e))), [elements, onChange]);

  // ----- Arrastrar y cambiar tamaño -----
  const drag = useRef<{ id: string; mode: 'move' | 'resize'; sx: number; sy: number; el: LabelElement } | null>(null);
  const live = useRef({ elements, scale, onChange });
  live.current = { elements, scale, onChange };

  const startDrag = (e: RPointerEvent, el: LabelElement, mode: 'move' | 'resize') => {
    e.stopPropagation();
    e.preventDefault();
    wrapRef.current?.focus();
    setSelectedId(el.id);
    drag.current = { id: el.id, mode, sx: e.clientX, sy: e.clientY, el: { ...el } };
  };
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = (e.clientX - d.sx) / live.current.scale, dy = (e.clientY - d.sy) / live.current.scale;
      const patch: Partial<LabelElement> = d.mode === 'move'
        ? { x: snap(d.el.x + dx), y: snap(d.el.y + dy) }
        : { w: Math.max(1, snap(d.el.w + dx)), h: Math.max(d.el.type === 'rect' ? 0.2 : 1, snap(d.el.h + dy)) };
      live.current.onChange(live.current.elements.map((x) => (x.id === d.id ? { ...x, ...patch } : x)));
    };
    const up = () => { drag.current = null; };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, []);

  // ----- Agregar / quitar -----
  const add = (el: Omit<LabelElement, 'id' | 'x' | 'y'>) => {
    const n = elements.length;
    const full: LabelElement = { id: uid(), x: 1, y: Math.min(Math.max(0, H - el.h), 1 + (n % 7) * 4), ...el };
    onChange([...elements, full]);
    setSelectedId(full.id);
  };
  const addField = (source: string) => add({ type: 'field', source, w: Math.min(30, W - 2), h: 4.5, fontSize: 8, shrink: true, label: isSpecSource(source) });
  const addOther = (kind: 'text' | 'qr' | 'barcode' | 'line' | 'box' | 'icon') => {
    if (kind === 'text') add({ type: 'text', text: t('labels.add_text'), w: Math.min(30, W - 2), h: 4.5, fontSize: 8, shrink: true });
    if (kind === 'qr') add({ type: 'qr', source: 'code', w: Math.min(20, H - 2), h: Math.min(20, H - 2) });
    if (kind === 'barcode') add({ type: 'barcode', source: 'code', w: Math.min(40, W - 2), h: Math.min(10, H - 2), showText: true });
    if (kind === 'line') add({ type: 'rect', w: Math.min(30, W - 2), h: 0.3, filled: true });
    if (kind === 'box') add({ type: 'rect', w: Math.min(20, W - 2), h: Math.min(10, H - 2), border: 0.3 });
    if (kind === 'icon') add({ type: 'icon', icon: 'Star', w: Math.min(10, H - 2), h: Math.min(10, H - 2) });
  };
  const remove = (id: string) => { onChange(elements.filter((e) => e.id !== id)); setSelectedId(null); };
  const duplicate = (el: LabelElement) => {
    const c = { ...el, id: uid(), x: Math.min(el.x + 2, Math.max(0, W - el.w)), y: Math.min(el.y + 2, Math.max(0, H - el.h)) };
    onChange([...elements, c]);
    setSelectedId(c.id);
  };
  const reorder = (id: string, dir: 1 | -1) => {
    const i = elements.findIndex((e) => e.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= elements.length) return;
    const next = [...elements];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (!selected) return;
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const step = e.shiftKey ? 2 : 0.5;
    const moves: Record<string, Partial<LabelElement>> = {
      ArrowLeft: { x: round1(selected.x - step) }, ArrowRight: { x: round1(selected.x + step) },
      ArrowUp: { y: round1(selected.y - step) }, ArrowDown: { y: round1(selected.y + step) },
    };
    if (moves[e.key]) { e.preventDefault(); update(selected.id, moves[e.key]); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remove(selected.id); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicate(selected); }
  };

  async function printTest() {
    try {
      await printLabels({ template: { ...template, layout: { elements } }, units: [unit], ctx });
    } catch (e) { toast.error(err(e)); }
  }

  const typeAttrs = kind === 'unit' ? meta.typeAttrs(typeId) : [];
  const fieldName = (el: LabelElement) => {
    if (el.type === 'field') return el.source ? sourceLabel(el.source, uiCtx) : t('labels.kind.field');
    if (el.type === 'text') return `“${(el.text ?? '').slice(0, 18)}”`;
    return t(`labels.kind.${el.type === 'rect' ? 'rect' : el.type}`);
  };

  const dense = selected?.type === 'barcode' ? barcodeModuleMm(codeValue(selected.source, unit, ctx, true), selected.w) : null;

  return (
    <div className="lbl-designer">
      <LabelStyles />
      {/* ---------- Paleta ---------- */}
      <div className="lbl-side">
        {kind === 'unit' && (
          <Field label={t('labels.preview_with')}>
            <Select value={typeId} onChange={(e) => { setTypeId(Number(e.target.value)); setRealId(''); }}>
              {types.map((ty) => <option key={ty.id} value={ty.id}>{meta.label(ty.name)}</option>)}
            </Select>
          </Field>
        )}
        <Field label={kind !== 'unit' ? t('labels.preview_with') : undefined}>
          <Select value={realId} onChange={(e) => setRealId(e.target.value ? Number(e.target.value) : '')}>
            <option value="">{t('labels.sample_data')}</option>
            {isOrder
              ? (recentOrders.data?.items ?? []).map((o) => <option key={o.id} value={o.id}>{t('labels.real_order')}: {o.code}{o.customerName ? ` · ${o.customerName}` : ''}</option>)
              : isLot
              ? (recentLots.data?.items ?? []).map((l) => <option key={l.id} value={l.id}>{t('labels.real_lot')}: {l.code}</option>)
              : (realUnits.data?.items ?? []).map((u) => <option key={u.id} value={u.id}>{t('labels.real_unit')}: {u.code}</option>)}
          </Select>
        </Field>

        <div className="lbl-group-title">{t(isOrder ? 'labels.group_order' : isLot ? 'labels.group_lot' : 'labels.group_base')}</div>
        <div className="lbl-chips">
          {baseSources(kind).map((s) => <button key={s} type="button" className="lbl-chip" onClick={() => addField(s)}><Plus size={12} />{t(`labels.src.${s}`)}</button>)}
        </div>
        {kind === 'unit' && (
          <>
            <div className="lbl-group-title">{t('labels.group_attrs', { type: meta.typeName(typeId) })}</div>
            <div className="lbl-chips">
              {typeAttrs.map(({ attr }) => <button key={attr.key} type="button" className="lbl-chip" onClick={() => addField(`spec:${attr.key}`)}><Plus size={12} />{meta.label(attr.label)}</button>)}
              {!typeAttrs.length && <span className="muted">—</span>}
            </div>
          </>
        )}
        <div className="lbl-group-title">{t('labels.group_other')}</div>
        <div className="lbl-chips">
          <button type="button" className="lbl-chip" onClick={() => addOther('text')}><Type size={12} />{t('labels.add_text')}</button>
          <button type="button" className="lbl-chip" onClick={() => addOther('qr')}><QrCode size={12} />{t('labels.add_qr')}</button>
          <button type="button" className="lbl-chip" onClick={() => addOther('barcode')}><Barcode size={12} />{t('labels.add_barcode')}</button>
          <button type="button" className="lbl-chip" onClick={() => addOther('line')}><Minus size={12} />{t('labels.add_line')}</button>
          <button type="button" className="lbl-chip" onClick={() => addOther('box')}><Square size={12} />{t('labels.add_box')}</button>
          <button type="button" className="lbl-chip" onClick={() => addOther('icon')}><Smile size={12} />{t('labels.add_icon')}</button>
        </div>
      </div>

      {/* ---------- Lienzo ---------- */}
      <div className="lbl-main">
        <div className="lbl-toolbar">
          <span className="muted">{W} × {H} mm</span>
          <span className="grow" />
          <Button size="sm" variant="ghost" icon={<Minus size={14} />} aria-label="-" onClick={() => setZoom(Math.max(1, +(z - 0.5).toFixed(2)))} />
          <span className="muted" style={{ minWidth: 44, textAlign: 'center' }}>{Math.round(z * 100)}%</span>
          <Button size="sm" variant="ghost" icon={<Plus size={14} />} aria-label="+" onClick={() => setZoom(Math.min(10, +(z + 0.5).toFixed(2)))} />
          <Button size="sm" variant="ghost" onClick={() => setZoom(0)}>{t('labels.fit')}</Button>
          <Button size="sm" icon={<Printer size={14} />} onClick={() => void printTest()}>{t('labels.print_test')}</Button>
        </div>
        <div ref={wrapRef} className="lbl-stage" tabIndex={0} onKeyDown={onKey}>
          <div style={{ width: W * scale, height: H * scale, position: 'relative', margin: '0 auto', boxShadow: '0 0 0 1px var(--border-strong), 0 6px 24px rgba(0,0,0,.25)' }}>
            <div style={{ transform: `scale(${z})`, transformOrigin: '0 0', width: `${W}mm`, height: `${H}mm`, position: 'relative' }}>
              <LabelView widthMm={W} heightMm={H} elements={elements} unit={unit} ctx={ctx}
                editor={{ selectedId, onPointerDown: startDrag, onBackground: () => setSelectedId(null) }} />
              {selected && (
                <div className="lbl-sel" style={{ left: `${selected.x}mm`, top: `${selected.y}mm`, width: `${selected.w}mm`, height: `${selected.h}mm`, outlineWidth: `${2 / scale}mm` }}>
                  <span className="lbl-handle" style={{ width: `${9 / scale}mm`, height: `${9 / scale}mm`, right: `${-4.5 / scale}mm`, bottom: `${-4.5 / scale}mm` }}
                    onPointerDown={(e) => startDrag(e, selected, 'resize')} />
                </div>
              )}
            </div>
          </div>
          {!elements.length && <div className="muted" style={{ textAlign: 'center', marginTop: 12 }}>{t('labels.empty_canvas')}</div>}
        </div>
        <div className="muted" style={{ fontSize: 12 }}>{t('labels.canvas_hint')}</div>

        <div className="lbl-layers">
          <div className="lbl-group-title">{t('labels.layers')}</div>
          <div className="lbl-chips">
            {elements.map((el) => (
              <button key={el.id} type="button" className={`lbl-chip ${el.id === selectedId ? 'on' : ''}`} onClick={() => { setSelectedId(el.id); wrapRef.current?.focus(); }}>
                {el.type === 'qr' ? <QrCode size={12} /> : el.type === 'barcode' ? <Barcode size={12} /> : el.type === 'rect' ? <Square size={12} /> : <Type size={12} />}{fieldName(el)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ---------- Propiedades ---------- */}
      <div className="lbl-side">
        {!selected ? <div className="muted">{t('labels.none_selected')}</div> : (
          <div className="stack sm">
            <strong>{t('labels.element')}: {t(`labels.kind.${selected.type}`)}</strong>

            {selected.type === 'field' && (
              <>
                <Field label={t('labels.data')}>
                  <Select value={selected.source ?? ''} onChange={(e) => update(selected.id, { source: e.target.value })}>
                    <optgroup label={t(isOrder ? 'labels.group_order' : isLot ? 'labels.group_lot' : 'labels.group_base')}>{baseSources(kind).map((s) => <option key={s} value={s}>{t(`labels.src.${s}`)}</option>)}</optgroup>
                    {kind === 'unit' && (
                      <optgroup label={t('labels.group_attrs', { type: meta.typeName(typeId) })}>
                        {typeAttrs.map(({ attr }) => <option key={attr.key} value={`spec:${attr.key}`}>{meta.label(attr.label)}</option>)}
                        {selected.source && isSpecSource(selected.source) && !typeAttrs.some(({ attr }) => attr.key === specKey(selected.source!)) &&
                          <option value={selected.source}>{sourceLabel(selected.source, uiCtx)}</option>}
                      </optgroup>
                    )}
                  </Select>
                </Field>
                <Checkbox checked={!!selected.label} onChange={(v) => update(selected.id, { label: v })} label={t('labels.show_name')} />
              </>
            )}
            {selected.type === 'text' && <Field label={t('labels.text')}><Textarea rows={2} value={selected.text ?? ''} onChange={(e) => update(selected.id, { text: e.target.value })} /></Field>}
            {selected.type === 'qr' && (
              <Field label={t('labels.content')}>
                <Select value={selected.source ?? 'code'} onChange={(e) => update(selected.id, { source: e.target.value })}>
                  {qrSources(kind).map((s) => <option key={s} value={s}>{t(`labels.src.${(isOrder || isLot) && s === 'code' ? `${kind}_code` : s}`)}</option>)}
                </Select>
              </Field>
            )}
            {selected.type === 'barcode' && (
              <>
                <Field label={t('labels.content')}>
                  <Select value={selected.source ?? 'code'} onChange={(e) => update(selected.id, { source: e.target.value })}>
                    {barcodeSources(kind).map((s) => <option key={s} value={s}>{t(`labels.src.${(isOrder || isLot) && s === 'code' ? `${kind}_code` : s}`)}</option>)}
                  </Select>
                </Field>
                <Checkbox checked={!!selected.showText} onChange={(v) => update(selected.id, { showText: v })} label={t('labels.show_text')} />
                {dense !== null && dense < 0.19 && <div className="alert alert-warn" style={{ fontSize: 12 }}>{t('labels.dense_warning', { mm: dense.toFixed(2) })}</div>}
              </>
            )}
            {selected.type === 'rect' && (
              <>
                <Checkbox checked={!!selected.filled} onChange={(v) => update(selected.id, { filled: v })} label={t('labels.filled')} />
                {!selected.filled && <Field label={t('labels.border')}><Input type="number" min={0.1} max={5} step={0.1} value={selected.border ?? 0.3} onChange={(e) => update(selected.id, { border: Number(e.target.value) || 0.3 })} /></Field>}
              </>
            )}
            {selected.type === 'icon' && (
              <Field label={t('labels.icon')}>
                <div className="lbl-icon-grid">
                  {DOCUMENT_ICONS.map((name) => {
                    const Cmp = (LucideIcons as unknown as Record<string, React.ComponentType<{ size?: number }>>)[name];
                    return (
                      <button key={name} type="button" className={`lbl-icon-opt ${selected.icon === name ? 'on' : ''}`} title={name}
                        onClick={() => update(selected.id, { icon: name as DocumentIcon })}>
                        {Cmp && <Cmp size={18} />}
                      </button>
                    );
                  })}
                </div>
              </Field>
            )}

            {(selected.type === 'field' || selected.type === 'text') && (
              <>
                <Field label={t('labels.font_size')}>
                  <Input type="number" min={3} max={96} step={0.5} value={selected.fontSize ?? 8} onChange={(e) => update(selected.id, { fontSize: Math.min(96, Math.max(3, Number(e.target.value) || 8)) })} />
                </Field>
                <div className="lbl-seg">
                  <button type="button" className={selected.bold ? 'on' : ''} title={t('labels.bold')} onClick={() => update(selected.id, { bold: !selected.bold })}><Bold size={14} /></button>
                  <button type="button" className={selected.italic ? 'on' : ''} title={t('labels.italic')} onClick={() => update(selected.id, { italic: !selected.italic })}><Italic size={14} /></button>
                  <span className="lbl-sep" />
                  <button type="button" className={(selected.align ?? 'left') === 'left' ? 'on' : ''} title={t('labels.a_left')} onClick={() => update(selected.id, { align: 'left' })}><AlignLeft size={14} /></button>
                  <button type="button" className={selected.align === 'center' ? 'on' : ''} title={t('labels.a_center')} onClick={() => update(selected.id, { align: 'center' })}><AlignCenter size={14} /></button>
                  <button type="button" className={selected.align === 'right' ? 'on' : ''} title={t('labels.a_right')} onClick={() => update(selected.id, { align: 'right' })}><AlignRight size={14} /></button>
                </div>
                <Field label={t('labels.valign')}>
                  <Select value={selected.valign ?? 'top'} onChange={(e) => update(selected.id, { valign: e.target.value as LabelElement['valign'] })}>
                    <option value="top">{t('labels.v_top')}</option><option value="middle">{t('labels.v_middle')}</option><option value="bottom">{t('labels.v_bottom')}</option>
                  </Select>
                </Field>
                <Checkbox checked={selected.shrink !== false} onChange={(v) => update(selected.id, { shrink: v })} label={t('labels.shrink')} />
                <Checkbox checked={!!selected.inverse} onChange={(v) => update(selected.id, { inverse: v })} label={t('labels.inverse')} />
              </>
            )}

            <div className="grid grid-2" style={{ gap: 8 }}>
              <Field label={t('labels.pos_x')}><Input type="number" step={0.5} value={selected.x} onChange={(e) => update(selected.id, { x: Number(e.target.value) || 0 })} /></Field>
              <Field label={t('labels.pos_y')}><Input type="number" step={0.5} value={selected.y} onChange={(e) => update(selected.id, { y: Number(e.target.value) || 0 })} /></Field>
              <Field label={`${t('labels.pos_w')} (mm)`}><Input type="number" step={0.5} min={0.2} value={selected.w} onChange={(e) => update(selected.id, { w: Math.max(0.2, Number(e.target.value) || 1) })} /></Field>
              <Field label={`${t('labels.pos_h')} (mm)`}><Input type="number" step={0.5} min={0.2} value={selected.h} onChange={(e) => update(selected.id, { h: Math.max(0.2, Number(e.target.value) || 1) })} /></Field>
            </div>
            <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
              <Button size="sm" icon={<ArrowUpToLine size={14} />} onClick={() => reorder(selected.id, 1)}>{t('labels.forward')}</Button>
              <Button size="sm" icon={<ArrowDownToLine size={14} />} onClick={() => reorder(selected.id, -1)}>{t('labels.backward')}</Button>
              <Button size="sm" icon={<Copy size={14} />} onClick={() => duplicate(selected)}>{t('labels.duplicate_el')}</Button>
              <Button size="sm" variant="danger" icon={<Trash2 size={14} />} onClick={() => remove(selected.id)}>{t('labels.delete_el')}</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
