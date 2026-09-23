import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, ClipboardPaste, MapPin, Pencil, Plus, ScanLine, Sparkles, Trash2, XCircle } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useMeta, type Specs } from '../../lib/meta';
import { useFmt } from '../../lib/useFmt';
import { Alert } from '../../components/Alert';
import { Badge, Button, Card, Checkbox, Empty, Field, Input, Modal, Progress, Select, Spinner, Textarea, useConfirm, useErr, useToast } from '../../components/ui';
import { SpecChips, TypeLabel, TypeSelect } from '../../components/fields';
import { DataGrid, type GridColumn } from '../../components/grid/DataGrid';
import { useTypeOpts } from '../../components/grid/helpers';
import { useAllRows } from '../../lib/useAllRows';
import { pasteText } from '../../lib/clipboard';

export interface OrderLine {
  id: number; lineNo: number; equipmentTypeId: number; specs: Specs; cosmeticGradeIds: number[]; functionalGradeIds: number[];
  quantity: number; unitPrice: number | null; notes: string | null; picked: number; available: number;
}
export type OrderData = {
  id: number; code?: string; statusKey: string; currency: string; canSeePrices: boolean; lines: OrderLine[]; requested: number; offOrder: number; itemCount: number;
};

/** Grados que exige una línea, como chips ("A, B"), o nada si acepta cualquiera. */
function GradeChips({ line }: { line: Pick<OrderLine, 'cosmeticGradeIds' | 'functionalGradeIds'> }) {
  const meta = useMeta();
  const { t } = useTranslation();
  const code = (id: number) => meta.item(id)?.code || meta.name(id);
  if (!line.cosmeticGradeIds.length && !line.functionalGradeIds.length) return <span className="muted">{t('orders.lines.any_grade')}</span>;
  return (
    <span className="spec-chips">
      {line.cosmeticGradeIds.length > 0 && <span className="chip">{t('orders.lines.cos_short')} {line.cosmeticGradeIds.map(code).join('/')}</span>}
      {line.functionalGradeIds.length > 0 && <span className="chip">{t('orders.lines.fun_short')} {line.functionalGradeIds.map(code).join('/')}</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Líneas del pedido
// ---------------------------------------------------------------------------
export function LinesTab({ order, editable, onChanged }: { order: OrderData; editable: boolean; onChanged: (o: any) => void }) {
  const { t } = useTranslation();
  const f = useFmt();
  const err = useErr();
  const toast = useToast();
  const confirm = useConfirm();
  const [modal, setModal] = useState<{ line?: OrderLine } | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const typeOpts = useTypeOpts();
  const meta = useMeta();
  const gradeCodes = (ids: number[]) => ids.map((id) => meta.item(id)?.code || meta.name(id)).join('/');
  const cols: GridColumn<OrderLine>[] = [
    { key: 'lineNo', title: '#', type: 'number', width: 70, render: (l) => <span className="mono">{l.lineNo}</span> },
    { key: 'type', title: t('common.type'), type: 'select', options: typeOpts, width: 150, value: (l) => String(l.equipmentTypeId), render: (l) => <TypeLabel typeId={l.equipmentTypeId} /> },
    { key: 'description', title: t('units.description'), width: 300, value: (l) => meta.describe(l.equipmentTypeId, l.specs, false).join(' · '), render: (l) => <><SpecChips typeId={l.equipmentTypeId} specs={l.specs} all />{l.notes && <div className="sub">{l.notes}</div>}</> },
    { key: 'cosmetic', title: t('units.cosmetic'), width: 120, value: (l) => gradeCodes(l.cosmeticGradeIds) || null, render: (l) => <GradeChips line={{ cosmeticGradeIds: l.cosmeticGradeIds, functionalGradeIds: [] }} />, hidden: true },
    { key: 'grades', title: t('units.grades'), width: 150, value: (l) => [gradeCodes(l.cosmeticGradeIds) && `${t('orders.lines.cos_short')} ${gradeCodes(l.cosmeticGradeIds)}`, gradeCodes(l.functionalGradeIds) && `${t('orders.lines.fun_short')} ${gradeCodes(l.functionalGradeIds)}`].filter(Boolean).join(' · ') || t('orders.lines.any_grade'), render: (l) => <GradeChips line={l} /> },
    { key: 'quantity', title: t('orders.lines.quantity'), type: 'number', width: 100 },
    {
      key: 'picked', title: t('orders.lines.progress'), type: 'number', width: 190,
      render: (l) => (<>
        <span className="occupancy"><Progress value={Math.min(l.picked, l.quantity)} max={l.quantity} tone={l.picked >= l.quantity ? 'good' : 'warn'} /><span className="sub nowrap">{l.picked}/{l.quantity}</span></span>
        {l.picked > l.quantity && <div className="sub" style={{ color: 'var(--danger)' }}>+{l.picked - l.quantity}</div>}
      </>),
    },
    { key: 'remaining', title: t('orders.loc.missing'), type: 'number', width: 100, hidden: true, value: (l) => Math.max(0, l.quantity - l.picked) },
    ...(order.statusKey === 'open' ? [{
      key: 'available', title: t('orders.lines.in_stock'), type: 'number' as const, width: 100,
      render: (l: OrderLine) => { const remaining = Math.max(0, l.quantity - l.picked); return remaining > 0 && l.available < remaining ? <Badge tone="bad" title={t('orders.lines.not_enough')}>{l.available}</Badge> : <span>{l.available}</span>; },
    }] : []),
    ...(order.canSeePrices ? [{ key: 'unitPrice', title: t('orders.price'), type: 'money' as const, width: 120, render: (l: OrderLine) => f.money(l.unitPrice, order.currency) }] : []),
    ...(editable ? [{
      key: '_actions', title: '', actions: true as const, width: 170,
      render: (l: OrderLine) => {
        const remaining = Math.max(0, l.quantity - l.picked);
        return (<>
          {remaining > 0 && l.available > 0 && <Button size="sm" icon={<Sparkles size={14} />} loading={busy === l.id} onClick={() => fill(l)} title={t('orders.lines.fill_hint')}>{t('orders.lines.fill')}</Button>}
          <button className="icon-btn" title={t('common.edit')} onClick={() => setModal({ line: l })}><Pencil size={16} /></button>
          <button className="icon-btn" title={t('common.delete')} onClick={() => remove(l)}><Trash2 size={16} /></button>
        </>);
      },
    }] : []),
  ];

  async function fill(l: OrderLine) {
    setBusy(l.id);
    try {
      const r = await api.post<{ filled: number; missing: number } & OrderData>(`/orders/${order.id}/lines/${l.id}/fill`);
      onChanged(r);
      if (r.filled === 0) toast.error(t('orders.lines.fill_none'));
      else if (r.missing > 0) toast.info(t('orders.lines.fill_partial', { filled: r.filled, missing: r.missing }));
      else toast.success(t('orders.lines.fill_done', { count: r.filled }));
    } catch (e) { toast.error(err(e)); } finally { setBusy(null); }
  }
  async function remove(l: OrderLine) {
    if (!(await confirm({ title: t('orders.lines.delete_title'), message: l.picked ? t('orders.lines.delete_msg_items', { count: l.picked }) : t('orders.lines.delete_msg'), danger: true, confirmLabel: t('common.delete') }))) return;
    try { onChanged(await api.del<OrderData>(`/orders/${order.id}/lines/${l.id}`)); } catch (e) { toast.error(err(e)); }
  }

  return (
    <Card padded={false} title={t('orders.tab_lines')} actions={editable && <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => setModal({})}>{t('orders.lines.add')}</Button>}>
      <DataGrid id="order-lines" bare rows={order.lines} columns={cols} rowId={(l) => l.id} exportName={`${t('orders.tab_lines')} ${order.code ?? order.id}`}
        emptyTitle={t('orders.lines.empty')} emptyHint={editable ? t('orders.lines.empty_hint') : undefined}
        emptyAction={editable ? <Button variant="primary" icon={<Plus size={16} />} onClick={() => setModal({})}>{t('orders.lines.add')}</Button> : undefined} />
      {modal && <LineModal orderId={order.id} line={modal.line} onClose={() => setModal(null)} onSaved={(o) => { onChanged(o); setModal(null); }} />}
    </Card>
  );
}

function LineModal({ orderId, line, onClose, onSaved }: { orderId: number; line?: OrderLine; onClose: () => void; onSaved: (o: OrderData) => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const meta = useMeta();
  const err = useErr();
  const toast = useToast();
  const [typeId, setTypeId] = useState<number | null>(line?.equipmentTypeId ?? null);
  const [specs, setSpecs] = useState<Specs>(line?.specs ?? {});
  const [cos, setCos] = useState<number[]>(line?.cosmeticGradeIds ?? []);
  const [fun, setFun] = useState<number[]>(line?.functionalGradeIds ?? []);
  const [qty, setQty] = useState(String(line?.quantity ?? 1));
  const [price, setPrice] = useState(line?.unitPrice != null ? String(line.unitPrice) : '');
  const [notes, setNotes] = useState(line?.notes ?? '');
  const [busy, setBusy] = useState(false);
  // Se pueden pedir marca, modelo, RAM, procesador... (listas y textos; los demás tipos de dato no se usan para pedir).
  const attrs = useMemo(() => meta.typeAttrs(typeId).filter((x) => ['select', 'text', 'number'].includes(x.attr.dataType)), [meta, typeId]);
  const toggle = (arr: number[], v: number, set: (a: number[]) => void) => set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  const setSpec = (key: string, v: string | number | null) => setSpecs((s) => { const n = { ...s }; if (v === null || v === '') delete n[key]; else n[key] = v; return meta.dropStaleChildren(typeId, n, key); });

  async function save() {
    if (!typeId) return;
    setBusy(true);
    try {
      const body = {
        equipmentTypeId: typeId, specs, cosmeticGradeIds: cos, functionalGradeIds: fun,
        quantity: Math.max(1, Math.floor(Number(qty) || 1)), unitPrice: price.trim() === '' ? null : Number(price), notes: notes.trim() || null,
      };
      const o = line ? await api.put<OrderData>(`/orders/${orderId}/lines/${line.id}`, body) : await api.post<OrderData>(`/orders/${orderId}/lines`, body);
      toast.success(t('common.saved')); onSaved(o);
    } catch (e) { toast.error(err(e)); } finally { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} size="lg" title={line ? t('orders.lines.edit') : t('orders.lines.add')}
      footer={<><Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} disabled={!typeId} onClick={save}>{t('common.save')}</Button></>}>
      <div className="stack">
        <p className="muted">{t('orders.lines.hint')}</p>
        <div className="form-grid">
          <Field label={t('common.type')} required><TypeSelect value={typeId} onChange={(v) => { setTypeId(v); setSpecs({}); }} /></Field>
          {attrs.map(({ attr }) => (
            <Field key={attr.key} label={meta.label(attr.label)}>
              {attr.dataType === 'select' ? (
                <Select disabled={!!meta.parentAttr(typeId, attr) && typeof specs[meta.parentAttr(typeId, attr)!.key] !== 'number' && specs[attr.key] === undefined}
                  value={(specs[attr.key] as number | undefined) ?? ''} onChange={(e) => setSpec(attr.key, e.target.value ? Number(e.target.value) : null)}>
                  <option value="">{meta.parentAttr(typeId, attr) && typeof specs[meta.parentAttr(typeId, attr)!.key] !== 'number' ? t('fields.pick_first', { name: meta.label(meta.parentAttr(typeId, attr)!.label) }) : t('orders.lines.any')}</option>
                  {meta.attrOptions(typeId, attr, specs, specs[attr.key] as number | undefined).map((i) => <option key={i.id} value={i.id}>{meta.name(i.id)}</option>)}
                </Select>
              ) : attr.dataType === 'number' ? (
                <Input type="number" value={(specs[attr.key] as number | undefined) ?? ''} placeholder={t('orders.lines.any')} onChange={(e) => setSpec(attr.key, e.target.value === '' ? null : Number(e.target.value))} />
              ) : (
                <Input value={(specs[attr.key] as string | undefined) ?? ''} placeholder={t('orders.lines.any')} onChange={(e) => setSpec(attr.key, e.target.value)} />
              )}
            </Field>
          ))}
        </div>
        <Field label={t('unitForm.cosmetic')} hint={t('orders.grades_hint')}>
          <div className="row wrap gap-sm">{meta.catalogOptions('cosmetic_grade').map((g) => <Checkbox key={g.id} checked={cos.includes(g.id)} label={meta.nameWithCode(g.id)} onChange={() => toggle(cos, g.id, setCos)} />)}</div>
        </Field>
        <Field label={t('unitForm.functional')}>
          <div className="row wrap gap-sm">{meta.catalogOptions('functional_grade').filter((g) => g.meta?.sellable !== false).map((g) => <Checkbox key={g.id} checked={fun.includes(g.id)} label={meta.nameWithCode(g.id)} onChange={() => toggle(fun, g.id, setFun)} />)}</div>
        </Field>
        <div className="row wrap">
          <Field label={t('common.quantity')} required><Input type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} style={{ width: 120 }} /></Field>
          {can('sales.price') && <Field label={t('orders.price')}><Input type="number" min={0} step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} style={{ width: 140 }} /></Field>}
          <Field label={t('common.notes')}><Input value={notes} onChange={(e) => setNotes(e.target.value)} style={{ minWidth: 240 }} /></Field>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Agregar equipos del rack por código: una a una (escaneo) o por lote (lista pegada)
// ---------------------------------------------------------------------------
interface PickResult { input: string; outcome: 'added' | 'already_in_order' | 'not_found' | 'not_available' | 'duplicate'; code?: string; status?: string; match?: 'ok' | 'no_match' | 'line_full'; lineId?: number | null }

type PickMode = 'one' | 'batch';
const MODE_KEY = 'ui:pick-mode';
const readMode = (): PickMode => { try { return localStorage.getItem(MODE_KEY) === 'batch' ? 'batch' : 'one'; } catch { return 'one'; } };
const MAX_HISTORY = 200;

export function PickTab({ order, onChanged }: { order: OrderData; onChanged: (o: any) => void }) {
  const { t } = useTranslation();
  const meta = useMeta();
  const err = useErr();
  const toast = useToast();
  const oneBox = useRef<HTMLInputElement>(null);
  const batchBox = useRef<HTMLTextAreaElement>(null);
  const [mode, setModeState] = useState<PickMode>(readMode);
  const [one, setOne] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<PickResult[]>([]);
  const [last, setLast] = useState<PickResult | null>(null);
  const [addedCount, setAddedCount] = useState(0);

  const setMode = (m: PickMode) => { setModeState(m); try { localStorage.setItem(MODE_KEY, m); } catch { /* sin almacenamiento */ } };
  const focusBox = () => setTimeout(() => (mode === 'one' ? oneBox.current : batchBox.current)?.focus(), 0);
  useEffect(() => { focusBox(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [mode]);

  const codes = useMemo(() => text.split(/[\s,;]+/).map((c) => c.trim()).filter(Boolean), [text]);
  const lineNo = (id: number | null | undefined) => order.lines.find((l) => l.id === id)?.lineNo;

  /** Envía los códigos al pedido; devuelve los resultados (o null si falló la llamada). */
  async function send(list: string[]): Promise<PickResult[] | null> {
    setBusy(true);
    try {
      const r = await api.post<{ results: PickResult[]; order: OrderData }>(`/orders/${order.id}/pick`, { codes: list });
      onChanged(r.order);
      setAddedCount((n) => n + r.results.filter((x) => x.outcome === 'added').length);
      return r.results;
    } catch (e) { toast.error(err(e)); return null; } finally { setBusy(false); }
  }

  /** Una a una: cada código escrito o escaneado + Enter se agrega en el momento. */
  async function addOne(e?: React.FormEvent) {
    e?.preventDefault();
    const code = one.trim();
    if (!code || busy) return;
    const r = await send([code]);
    if (r?.length) {
      const x = r[0]!;
      setLast(x);
      setResults((prev) => [x, ...prev].slice(0, MAX_HISTORY));
      if (x.outcome === 'added' && x.match !== 'ok') toast.info(t('orders.pick.off_toast', { count: 1 }));
      setOne(x.outcome === 'not_found' || x.outcome === 'not_available' ? one : '');
    }
    oneBox.current?.focus();
    if (r?.[0] && (r[0].outcome === 'not_found' || r[0].outcome === 'not_available')) oneBox.current?.select();
  }

  /** Si se pegan varios códigos de una vez en el cuadro de "una a una" (p. ej. copiados de Inventario), se agregan todos. */
  function onPasteOne(e: React.ClipboardEvent<HTMLInputElement>) {
    const list = e.clipboardData.getData('text').split(/[\s,;]+/).map((c) => c.trim()).filter(Boolean);
    if (list.length > 1) { e.preventDefault(); setOne(''); void addBatch(list); }
  }

  /** Por lote: se pega o escribe una lista de códigos y se agregan todos juntos. */
  async function addBatch(list: string[] = codes, fromPaste = false) {
    if (!list.length) return;
    const r = await send(list);
    if (!r) return;
    if (fromPaste || mode === 'one') setResults((prev) => [...r, ...prev].slice(0, MAX_HISTORY)); else setResults(r);
    setLast(null);
    const added = r.filter((x) => x.outcome === 'added');
    const off = added.filter((x) => x.match !== 'ok').length;
    const failed = r.filter((x) => x.outcome === 'not_found' || x.outcome === 'not_available');
    if (added.length) toast.success(t('orders.pick.added', { count: added.length }));
    if (off) toast.info(t('orders.pick.off_toast', { count: off }));
    if (failed.length) toast.error(t('orders.pick.failed_toast', { count: failed.length }));
    // Lo que no se pudo agregar se conserva para corregirlo (en lote); lo demás se limpia.
    if (mode === 'batch') { setText(failed.map((x) => x.input).join('\n')); batchBox.current?.focus(); } else oneBox.current?.focus();
  }

  async function pasteFromClipboard() {
    const v = await pasteText();
    if (v === null) { toast.info(t('orders.pick.paste_manual')); batchBox.current?.focus(); return; }
    setText((cur) => (cur.trim() ? `${cur.trimEnd()}\n${v.trim()}` : v.trim()));
    batchBox.current?.focus();
  }

  const badge = (r: PickResult) => {
    if (r.outcome === 'added') {
      if (r.match === 'ok') return <Badge tone="good"><CheckCircle2 size={12} /> {t('orders.pick.ok', { line: lineNo(r.lineId) })}</Badge>;
      if (r.match === 'line_full') return <Badge tone="warn"><AlertTriangle size={12} /> {t('orders.pick.line_full')}</Badge>;
      return <Badge tone="warn"><AlertTriangle size={12} /> {t('orders.pick.no_match')}</Badge>;
    }
    if (r.outcome === 'already_in_order') return <Badge tone="info">{t('orders.pick.already')}</Badge>;
    if (r.outcome === 'duplicate') return <Badge>{t('orders.pick.duplicate')}</Badge>;
    if (r.outcome === 'not_found') return <Badge tone="bad"><XCircle size={12} /> {t('orders.pick.not_found')}</Badge>;
    return <Badge tone="bad"><XCircle size={12} /> {t('orders.pick.not_available', { status: r.status ? meta.name(meta.sysId('unit_status', r.status)) || r.status : '' })}</Badge>;
  };

  const lastKind = (r: PickResult): 'good' | 'warn' | 'bad' | 'info' =>
    r.outcome === 'added' ? (r.match === 'ok' ? 'good' : 'warn') : r.outcome === 'not_found' || r.outcome === 'not_available' ? 'bad' : 'info';

  const off = results.filter((r) => r.outcome === 'added' && r.match !== 'ok');
  return (
    <div className="stack">
      <Card title={<span className="row gap-sm"><ScanLine size={18} />{t('orders.pick.title')}</span>}
        actions={(
          <div className="lang-toggle" role="group" aria-label={t('orders.pick.mode')}>
            <button className={mode === 'one' ? 'on' : ''} onClick={() => setMode('one')}>{t('orders.pick.mode_one')}</button>
            <button className={mode === 'batch' ? 'on' : ''} onClick={() => setMode('batch')}>{t('orders.pick.mode_batch')}</button>
          </div>
        )}>
        {mode === 'one' ? (
          <form className="stack" onSubmit={addOne}>
            <p className="muted">{t('orders.pick.hint_one')}</p>
            <div className="row gap-sm">
              <Input ref={oneBox} className="mono grow" value={one} onChange={(e) => setOne(e.target.value)} onPaste={onPasteOne} placeholder={t('orders.pick.placeholder_one')} autoComplete="off" spellCheck={false} />
              <Button type="submit" variant="primary" icon={<Plus size={16} />} loading={busy} disabled={!one.trim()}>{t('orders.pick.add_one')}</Button>
            </div>
            {last && <Alert kind={lastKind(last)}><div className="row gap-sm wrap"><strong className="mono">{last.code ?? last.input}</strong>{badge(last)}</div></Alert>}
            {addedCount > 0 && <span className="muted">{t('orders.pick.session_count', { count: addedCount })}</span>}
          </form>
        ) : (
          <div className="stack">
            <p className="muted">{t('orders.pick.hint')}</p>
            <Textarea ref={batchBox} rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('orders.pick.placeholder')} className="mono"
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void addBatch(); } }} />
            <div className="row spread wrap">
              <span className="row gap-sm">
                <span className="muted">{t('orders.pick.count', { count: codes.length })}</span>
                <Button size="sm" variant="ghost" icon={<ClipboardPaste size={14} />} onClick={pasteFromClipboard}>{t('orders.pick.paste')}</Button>
                {text && <Button size="sm" variant="ghost" onClick={() => { setText(''); batchBox.current?.focus(); }}>{t('common.clear')}</Button>}
              </span>
              <Button variant="primary" icon={<Plus size={16} />} loading={busy} disabled={!codes.length} onClick={() => void addBatch()}>{t('orders.pick.add', { count: codes.length })}</Button>
            </div>
          </div>
        )}
      </Card>

      {off.length > 0 && (
        <Alert kind="warn">
          <strong>{t('orders.pick.warn_title', { count: off.length })}</strong>
          <div className="sub">{t('orders.pick.warn_hint')}</div>
          <div className="tag-list" style={{ marginTop: 6 }}>{off.map((r, i) => <span key={`${r.input}-${i}`} className="chip mono">{r.code}</span>)}</div>
        </Alert>
      )}

      {results.length > 0 && (
        <Card padded={false} title={mode === 'one' ? t('orders.pick.history') : t('orders.pick.results')}
          actions={mode === 'one' ? <Button size="sm" variant="ghost" onClick={() => { setResults([]); setLast(null); }}>{t('common.clear')}</Button> : undefined}>
          <div className="table-wrap"><table className="table"><tbody>
            {results.map((r, i) => (
              <tr key={i}>
                <td className="mono"><strong>{r.code ?? r.input}</strong>{r.code && r.code !== r.input && <div className="sub">{r.input}</div>}</td>
                <td>{badge(r)}</td>
              </tr>
            ))}
          </tbody></table></div>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dónde están los equipos del pedido
// ---------------------------------------------------------------------------
interface PickList {
  picked: { slotCode: string | null; units: { code: string; serialNumber: string | null; equipmentTypeId: number; specs: Specs; lineNo: number | null; matchStatus: string | null }[] }[];
  pending: { lineId: number; lineNo: number; equipmentTypeId: number; specs: Specs; quantity: number; picked: number; remaining: number; where: { slotCode: string | null; take: number; available: number }[]; shortage: number }[];
}

export function LocationsTab({ orderId, refreshKey, orderCode }: { orderId: number; refreshKey: unknown; orderCode?: string }) {
  const { t } = useTranslation();
  const meta = useMeta();
  const typeOpts = useTypeOpts();
  const q = useQuery({ queryKey: ['order', orderId, 'pick-list', refreshKey], queryFn: () => api.get<PickList>(`/orders/${orderId}/pick-list`), staleTime: 0 });
  const d = q.data;
  const flat = useMemo(() => (d?.picked ?? []).flatMap((g) => g.units.map((u) => ({ ...u, slotCode: g.slotCode }))), [d]);
  if (q.isLoading) return <Spinner />;
  if (!d) return null;
  const nowhere = t('orders.loc.unlocated');
  type Flat = (typeof flat)[number];
  const pickedCols: GridColumn<Flat>[] = [
    { key: 'slot', title: t('units.location'), width: 150, value: (u) => u.slotCode ?? nowhere, render: (u) => <span className="mono"><strong>{u.slotCode ?? <span className="muted">{nowhere}</span>}</strong></span> },
    { key: 'code', title: t('common.code'), width: 140, render: (u) => <span className="mono">{u.code}</span> },
    { key: 'serialNumber', title: t('units.serial'), width: 140 },
    { key: 'type', title: t('common.type'), type: 'select', options: typeOpts, width: 140, value: (u) => String(u.equipmentTypeId), render: (u) => <TypeLabel typeId={u.equipmentTypeId} /> },
    { key: 'description', title: t('units.description'), width: 280, value: (u) => meta.describe(u.equipmentTypeId, u.specs).join(' · '), render: (u) => <SpecChips typeId={u.equipmentTypeId} specs={u.specs} /> },
    { key: 'line', title: t('orders.lines.line'), type: 'number', width: 90, value: (u) => u.lineNo, render: (u) => (u.matchStatus && u.matchStatus !== 'ok' ? <Badge tone="warn"><AlertTriangle size={12} /> {u.matchStatus === 'line_full' ? t('orders.pick.line_full_short') : t('orders.pick.no_match_short')}</Badge> : u.lineNo ? <span className="mono">#{u.lineNo}</span> : <span className="muted">—</span>) },
  ];
  type Pend = PickList['pending'][number];
  const pendCols: GridColumn<Pend>[] = [
    { key: 'lineNo', title: '#', type: 'number', width: 70 },
    { key: 'line', title: t('orders.lines.line'), width: 320, value: (p) => `${meta.typeName(p.equipmentTypeId)} ${meta.describe(p.equipmentTypeId, p.specs, false).join(' · ')}`, render: (p) => <><TypeLabel typeId={p.equipmentTypeId} /> <SpecChips typeId={p.equipmentTypeId} specs={p.specs} all /></> },
    { key: 'remaining', title: t('orders.loc.missing'), type: 'number', width: 100, render: (p) => <strong>{p.remaining}</strong> },
    {
      key: 'where', title: t('orders.loc.where'), width: 380,
      value: (p) => p.where.map((w) => `${w.slotCode ?? nowhere}: ${w.take}`).join(', '),
      render: (p) => (<>
        <span className="tag-list">{p.where.map((w, i) => <span key={i} className="chip"><span className="mono">{w.slotCode ?? nowhere}</span>: {w.take}{w.available > w.take ? ` (${t('orders.loc.of', { count: w.available })})` : ''}</span>)}</span>
        {p.shortage > 0 && <div><Badge tone="bad">{t('orders.loc.shortage', { count: p.shortage })}</Badge></div>}
      </>),
    },
    { key: 'shortage', title: t('orders.loc.shortage_col'), type: 'number', width: 100, hidden: true },
  ];
  return (
    <div className="stack">
      <Card padded={false} title={<span className="row gap-sm"><MapPin size={18} />{t('orders.loc.picked_title')}</span>}>
        <DataGrid id="order-pick-list" bare rows={flat} columns={pickedCols} rowId={(u) => u.code} exportName={`${t('orders.loc.picked_title')} ${orderCode ?? ''}`.trim()}
          defaultSort={[{ key: 'slot', dir: 'asc' }, { key: 'code', dir: 'asc' }]} emptyTitle={t('orders.loc.none_picked')} />
      </Card>
      {d.pending.length > 0 && (
        <Card padded={false} title={t('orders.loc.pending_title')}>
          <DataGrid id="order-pending" bare rows={d.pending} columns={pendCols} rowId={(p) => p.lineId} exportName={`${t('orders.loc.pending_title')} ${orderCode ?? ''}`.trim()} />
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agregar por cantidad: equipos disponibles agrupados por tipo y características, sin escoger códigos
// ---------------------------------------------------------------------------
interface AvailUnit { id: number; equipmentTypeId: number; specs: Specs; cosmeticGradeId: number | null; functionalGradeId: number | null }
interface Group { key: string; typeId: number; specs: Specs; cosId: number | null; funId: number | null; ids: number[] }

/** ¿Este grupo de equipos cubre la línea? (mismo tipo, mismas características de la línea y grados aceptados). */
function lineOfGroup(g: Group, lines: OrderLine[]): OrderLine | undefined {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  return lines.find((l) => l.equipmentTypeId === g.typeId
    && Object.entries(l.specs ?? {}).every(([k, v]) => v === null || v === undefined || v === '' || same(v, g.specs?.[k]))
    && (!l.cosmeticGradeIds.length || (g.cosId !== null && l.cosmeticGradeIds.includes(g.cosId)))
    && (!l.functionalGradeIds.length || (g.funId !== null && l.functionalGradeIds.includes(g.funId))));
}

export function QuantityAdd({ order, onChanged }: { order: OrderData; onChanged: (o: any) => void }) {
  const { t } = useTranslation();
  const meta = useMeta();
  const err = useErr();
  const toast = useToast();
  const typeOpts = useTypeOpts();
  const [qty, setQty] = useState<Record<string, string>>({});
  const [price, setPrice] = useState('');
  const [busy, setBusy] = useState(false);
  const list = useAllRows<AvailUnit>(['units', 'available'], '/units', { statusKey: 'available', sort: 'oldest' });

  // Se agrupa por tipo + características que se piden en las líneas + grados. Dentro de cada grupo se usan primero los más antiguos.
  const groups = useMemo<Group[]>(() => {
    const m = new Map<string, Group>();
    for (const u of list.data ?? []) {
      const attrs = meta.typeAttrs(u.equipmentTypeId, { lotLine: true }).map((x) => x.attr.key);
      const specs: Specs = {};
      for (const k of attrs) { const v = u.specs?.[k]; if (v !== undefined && v !== null && v !== '') specs[k] = v; }
      const key = JSON.stringify([u.equipmentTypeId, specs, u.cosmeticGradeId, u.functionalGradeId]);
      const g = m.get(key);
      if (g) g.ids.push(u.id); else m.set(key, { key, typeId: u.equipmentTypeId, specs, cosId: u.cosmeticGradeId, funId: u.functionalGradeId, ids: [u.id] });
    }
    return [...m.values()].sort((a, b) => meta.typeName(a.typeId).localeCompare(meta.typeName(b.typeId)) || meta.describe(a.typeId, a.specs).join().localeCompare(meta.describe(b.typeId, b.specs).join()));
  }, [list.data, meta]);

  const num = (g: Group) => Math.min(g.ids.length, Math.max(0, Math.floor(Number(qty[g.key]) || 0)));
  const total = groups.reduce((a, g) => a + num(g), 0);
  const setQ = (g: Group, v: string) => setQty((s) => ({ ...s, [g.key]: v }));

  async function add() {
    const unitIds = groups.flatMap((g) => g.ids.slice(0, num(g)));
    if (!unitIds.length) return;
    setBusy(true);
    try {
      const canPrice = order.canSeePrices && price !== '';
      onChanged(await api.post<OrderData>(`/orders/${order.id}/items`, { unitIds, unitPrice: canPrice ? Number(price) : null }));
      setQty({}); toast.success(t('addToOrder.done', { count: unitIds.length }));
      void list.refetch();
    } catch (e) { toast.error(err(e)); } finally { setBusy(false); }
  }

  const columns: GridColumn<Group>[] = [
    { key: 'type', title: t('common.type'), type: 'select', options: typeOpts, width: 160, value: (g) => String(g.typeId), render: (g) => <TypeLabel typeId={g.typeId} /> },
    { key: 'description', title: t('units.description'), width: 300, value: (g) => meta.describe(g.typeId, g.specs).join(' · '), render: (g) => <SpecChips typeId={g.typeId} specs={g.specs} /> },
    { key: 'cosmetic', title: t('units.cosmetic'), width: 110, value: (g) => (g.cosId ? meta.name(g.cosId) : null), render: (g) => (g.cosId ? <Badge color={meta.color(g.cosId)}>{meta.item(g.cosId)?.code || meta.name(g.cosId)}</Badge> : <span className="muted">—</span>) },
    { key: 'functional', title: t('units.functional'), width: 110, value: (g) => (g.funId ? meta.name(g.funId) : null), render: (g) => (g.funId ? <Badge color={meta.color(g.funId)}>{meta.item(g.funId)?.code || meta.name(g.funId)}</Badge> : <span className="muted">—</span>) },
    {
      key: 'line', title: t('orders.lines.line'), width: 200, value: (g) => { const l = lineOfGroup(g, order.lines); return l ? `#${l.lineNo}` : t('orders.pick.no_match_short'); },
      render: (g) => { const l = lineOfGroup(g, order.lines); return l ? <span className="mono">#{l.lineNo} <span className="muted">({t('orders.qty.pending', { count: Math.max(0, l.quantity - l.picked) })})</span></span> : <Badge tone="warn" title={t('orders.pick.no_match')}><AlertTriangle size={12} /> {t('orders.pick.no_match_short')}</Badge>; },
    },
    { key: 'count', title: t('orders.qty.available'), type: 'number', width: 110, value: (g) => g.ids.length },
    {
      key: '_qty', title: t('orders.qty.add'), width: 120, actions: true,
      render: (g) => <Input className="count-input" style={{ width: 80 }} type="number" min={0} max={g.ids.length} value={qty[g.key] ?? ''} placeholder="0" onChange={(e) => setQ(g, e.target.value)} onClick={(e) => e.stopPropagation()} />,
    },
  ];

  return (
    <Card padded={false} title={t('orders.qty.title', { count: list.data?.length ?? 0 })}
      actions={<>
        {order.canSeePrices && <Input type="number" min={0} step="0.01" placeholder={t('orders.price_placeholder')} value={price} onChange={(e) => setPrice(e.target.value)} style={{ width: 130 }} />}
        <Button size="sm" variant="primary" icon={<Plus size={14} />} disabled={!total} loading={busy} onClick={add}>{t('orders.qty.add_n', { count: total })}</Button>
      </>}>
      <p className="muted" style={{ margin: '0 16px 10px' }}>{t('orders.qty.hint')}</p>
      <DataGrid id="order-quantity" bare rows={groups} loading={list.isLoading} columns={columns} rowId={(g) => g.key} exportName={t('orders.qty.title', { count: list.data?.length ?? 0 })}
        emptyTitle={t('orders.no_available')} valueKey={qty} />
    </Card>
  );
}
