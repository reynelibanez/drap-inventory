import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ArrowLeft, CheckCircle2, FileText, Pencil, Plus, Tag, Trash2, XCircle, Zap } from 'lucide-react';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useMeta, type Specs } from '../../lib/meta';
import { useFmt } from '../../lib/useFmt';
import { useDoc } from '../../lib/docLang';
import { Alert } from '../../components/Alert';
import { Badge, Button, Card, Checkbox, Empty, Field, Input, ItemBadge, Modal, PageHeader, SearchInput, Select, Spinner, Tabs, useConfirm, useDebounced, useErr, useToast } from '../../components/ui';
import { CatalogSelect, Grades, SpecChips, StatusBadge, TypeLabel, TypeSelect } from '../../components/fields';
import { OrderHeaderModal } from './OrdersPage';
import { DataGrid, type GridColumn } from '../../components/grid/DataGrid';
import { useCatalogOpts, useTypeOpts } from '../../components/grid/helpers';
import { useUnitColumns, type UnitRow } from '../../components/UnitGrid';
import { useAllRows } from '../../lib/useAllRows';
import { PrintOrderLabelsModal } from '../../components/PrintOrderLabelsModal';
import type { Shipping } from '../../lib/orderLabels';
import { LinesTab, LocationsTab, PickTab, QuantityAdd, type OrderLine } from './OrderParts';
import { ExportMenu, type ExportOption } from '../../components/ExportMenu';
import { OrderPricingTab, type Adjustment, type Margin } from './OrderPricing';
import type { ExportTable } from '../../components/grid/exporters';

interface Item { id: number; unitId: number; unitPrice: number | null; code: string; serialNumber: string | null; specs: Specs; equipmentTypeId: number; cosmeticGradeId: number | null; functionalGradeId: number | null; lotId: number; lotCode: string; slotCode: string | null; lineId: number | null; matchStatus: 'ok' | 'no_match' | 'line_full' | null;
  /** Precio de lista y costo del equipo (según permisos). */
  listPrice?: number | null; unitCost?: number | null }
interface Order {
  id: number; code: string; statusId: number; statusKey: string; customerId: number | null; customerName: string | null; customerAddress: string | null; customerPhone: string | null; shipping: Shipping; isQuick: boolean; sellerId: number | null; sellerName: string | null; currency: string;
  reservedUntil: string | null; notes: string | null; completedAt: string | null; cancelledAt: string | null; createdAt: string; items: Item[]; itemCount: number; total: number | null; canSeePrices: boolean;
  subtotal: number | null; adjustments: Adjustment[]; margin: Margin | null; canSeeCosts: boolean; lines: OrderLine[]; requested: number; offOrder: number;
}

export default function OrderDetailPage() {
  const { t } = useTranslation();
  const id = Number(useParams().id);
  const { can } = useAuth();
  const f = useFmt();
  const qc = useQueryClient();
  const err = useErr();
  const toast = useToast();
  const confirm = useConfirm();
  const [tab, setTab] = useState<'lines' | 'pick' | 'qty' | 'items' | 'pricing' | 'locations' | 'search'>('lines');
  const [edit, setEdit] = useState(false);
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [prices, setPrices] = useState<Record<number, string>>({});
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [bulkPrice, setBulkPrice] = useState('');
  const meta = useMeta();
  const { t: dt, meta: dmeta, fmt: dfmt } = useDoc();   // el documento sale en el idioma de la empresa
  const typeOpts = useTypeOpts();
  const cosOpts = useCatalogOpts('cosmetic_grade', true);
  const funOpts = useCatalogOpts('functional_grade', true);

  const q = useQuery({ queryKey: ['order', id], queryFn: () => api.get<Order>(`/orders/${id}`) });
  const o = q.data;
  // Una venta rápida no tiene líneas: se abre directo en sus equipos.
  useEffect(() => { if (o?.isQuick) setTab('items'); }, [o?.isQuick]);
  const setOrder = (x: Order) => { qc.setQueryData(['order', id], x); void qc.invalidateQueries({ queryKey: ['orders'] }); void qc.invalidateQueries({ queryKey: ['units'] }); void qc.invalidateQueries({ queryKey: ['dashboard'] }); };

  const remove = useMutation({
    mutationFn: (itemIds: number[]) => api.post<Order>(`/orders/${id}/items/remove`, { itemIds }),
    onSuccess: (x) => { setOrder(x); setSel(new Set()); }, onError: (e) => toast.error(err(e)),
  });
  const savePrices = useMutation({
    mutationFn: (body: object) => api.post<Order>(`/orders/${id}/prices`, body),
    onSuccess: (x) => { setOrder(x); setPrices({}); toast.success(t('common.saved')); }, onError: (e) => toast.error(err(e)),
  });

  if (q.isLoading) return <Spinner />;
  if (!o) return <Empty title={t('errors.order_not_found')} />;
  const open = o.statusKey === 'open';
  const editable = open && can('sales.edit');
  const dirtyPrices = Object.keys(prices).length > 0;

  async function complete() {
    const missing = o!.lines.reduce((a, l) => a + Math.max(0, l.quantity - l.picked), 0);
    const warn = [missing > 0 ? t('orders.complete_missing', { count: missing }) : '', o!.offOrder > 0 ? t('orders.complete_off', { count: o!.offOrder }) : ''].filter(Boolean).join(' ');
    if (!(await confirm({ title: t('orders.complete_title'), message: <>{t('orders.complete_msg', { count: o!.itemCount })}{warn && <><br /><strong>{warn}</strong></>}</>, confirmLabel: t('orders.complete') }))) return;
    try { setOrder(await api.post<Order>(`/orders/${id}/complete`)); toast.success(t('orders.completed')); } catch (e) { toast.error(err(e)); }
  }
  async function cancel() {
    if (!(await confirm({ title: t('orders.cancel_title'), message: t('orders.cancel_msg'), danger: true, confirmLabel: t('orders.cancel') }))) return;
    try { setOrder(await api.post<Order>(`/orders/${id}/cancel`)); toast.success(t('orders.cancelled')); } catch (e) { toast.error(err(e)); }
  }
  const lineNoOf = (i: Item) => (i.lineId ? o.lines.find((l) => l.id === i.lineId)?.lineNo ?? null : null);
  const itemCols: GridColumn<Item>[] = [
    { key: 'code', title: t('common.code'), width: 150, render: (i) => <><Link to={`/units/${i.unitId}`} className="mono"><strong>{i.code}</strong></Link>{i.serialNumber && <div className="sub">S/N {i.serialNumber}</div>}</> },
    { key: 'type', title: t('common.type'), type: 'select', options: typeOpts, width: 150, value: (i) => String(i.equipmentTypeId), render: (i) => <TypeLabel typeId={i.equipmentTypeId} /> },
    { key: 'description', title: t('units.description'), width: 300, value: (i) => meta.describe(i.equipmentTypeId, i.specs).join(' · '), render: (i) => <SpecChips typeId={i.equipmentTypeId} specs={i.specs} /> },
    { key: 'cosmetic', title: t('units.cosmetic'), type: 'select', options: cosOpts, width: 110, value: (i) => (i.cosmeticGradeId ? String(i.cosmeticGradeId) : null), render: (i) => <ItemBadge id={i.cosmeticGradeId} code /> },
    { key: 'functional', title: t('units.functional'), type: 'select', options: funOpts, width: 110, value: (i) => (i.functionalGradeId ? String(i.functionalGradeId) : null), render: (i) => <ItemBadge id={i.functionalGradeId} code /> },
    { key: 'lot', title: t('units.lot'), type: 'select', width: 120, hidden: true, value: (i) => i.lotCode },
    { key: 'location', title: t('units.location'), width: 130, value: (i) => i.slotCode },
    {
      key: 'line', title: t('orders.lines.line'), type: 'select', width: 130,
      options: [{ value: 'none', label: t('orders.pick.no_match_short') }, { value: 'full', label: t('orders.pick.line_full_short') }, ...o.lines.map((l) => ({ value: String(l.lineNo), label: `#${l.lineNo}` }))],
      value: (i) => (i.matchStatus === 'ok' && i.lineId ? String(lineNoOf(i)) : i.matchStatus === 'line_full' ? 'full' : i.matchStatus === 'no_match' ? 'none' : null),
      render: (i) => (i.matchStatus === 'ok' && i.lineId ? <span className="mono">#{lineNoOf(i)}</span>
        : i.matchStatus === 'line_full' ? <Badge tone="warn" title={t('orders.pick.line_full')}><AlertTriangle size={12} /> {t('orders.pick.line_full_short')}</Badge>
        : i.matchStatus === 'no_match' ? <Badge tone="warn" title={t('orders.pick.no_match')}><AlertTriangle size={12} /> {t('orders.pick.no_match_short')}</Badge>
        : <span className="muted">—</span>),
    },
    ...(o.canSeePrices ? [{
      key: 'price', title: t('orders.price'), type: 'money' as const, width: 130, value: (i: Item) => i.unitPrice,
      render: (i: Item) => (editable && can('sales.price')
        ? <Input className="count-input" type="number" min={0} step="0.01" value={prices[i.id] ?? (i.unitPrice === null ? '' : String(i.unitPrice))} onChange={(e) => setPrices((p) => ({ ...p, [i.id]: e.target.value }))} />
        : f.money(i.unitPrice, o.currency)),
    }] : []),
    ...(o.canSeePrices ? [{
      key: 'listPrice', title: t('pricing.col_list_price'), type: 'money' as const, width: 120, hidden: true, value: (i: Item) => i.listPrice ?? null,
      render: (i: Item) => (i.listPrice === null || i.listPrice === undefined ? <span className="muted">—</span> : f.money(i.listPrice, o.currency)),
    }] : []),
    ...(o.canSeeCosts ? [{
      key: 'cost', title: t('pricing.col_cost'), type: 'money' as const, width: 120, hidden: true, value: (i: Item) => i.unitCost ?? null,
      render: (i: Item) => (i.unitCost === null || i.unitCost === undefined ? <span className="muted">—</span> : f.money(i.unitCost, o.currency)),
    }, {
      key: 'margin', title: t('pricing.col_margin'), type: 'money' as const, width: 120, hidden: true,
      value: (i: Item) => (i.unitCost === null || i.unitCost === undefined || i.unitPrice === null ? null : Math.round((i.unitPrice - i.unitCost) * 100) / 100),
      render: (i: Item) => (i.unitCost === null || i.unitCost === undefined || i.unitPrice === null ? <span className="muted">—</span> : <span className={i.unitPrice < i.unitCost ? 'diff-neg' : undefined}>{f.money(i.unitPrice - i.unitCost, o.currency)}</span>),
    }] : []),
    ...(editable ? [{ key: '_actions', title: '', actions: true as const, width: 60, render: (i: Item) => <button className="icon-btn" onClick={() => remove.mutate([i.id])} title={t('common.remove')}><Trash2 size={16} /></button> }] : []),
  ];

  // ---- Lista de empaque (packing list): sin precios; detallada (un renglón por equipo) o resumida (agrupada)
  const plHead = (): NonNullable<ExportTable['preamble']> => [
    { cells: [dt('orders.packing_list')], bold: true },
    { cells: [dt('orders.pl.order'), o.code] },
    ...(o.customerName ? [{ cells: [dt('orders.pl.customer'), o.customerName] }] : []),
    ...(o.sellerName ? [{ cells: [dt('orders.seller'), o.sellerName] }] : []),
    { cells: [dt('common.date'), dfmt.date(o.completedAt ?? o.createdAt)] },
    { cells: [dt('orders.pl.total_units'), o.itemCount] },
  ];
  const plDesc = (i: Item) => dmeta.describe(i.equipmentTypeId, i.specs, false).join(' · ');
  const packingOptions: ExportOption[] = [
    {
      id: 'detail', label: t('orders.pl.detail'), hint: t('orders.pl.detail_hint'), filename: `PackingList_${o.code}`,
      build: () => {
        // Cada equipo se identifica por su número de serie (si no tiene, se usa su código).
        const sn = (i: Item) => i.serialNumber || i.code;
        const items = [...o.items].sort((a, b) => sn(a).localeCompare(sn(b), undefined, { numeric: true }));
        return {
          title: `${dt('orders.packing_list')} ${o.code}`, sheetName: dt('orders.packing_list'), preamble: plHead(),
          header: ['#', dt('units.serial'), dt('common.type'), dt('units.description'), dt('units.cosmetic'), dt('units.functional')],
          types: ['number', 'text', 'text', 'text', 'text', 'text'],
          rows: items.map((i, n) => [n + 1, sn(i), dmeta.typeName(i.equipmentTypeId), plDesc(i), dmeta.item(i.cosmeticGradeId)?.code ?? '', dmeta.item(i.functionalGradeId)?.code ?? '']),
          totals: ['', `${dt('orders.pl.total_units')}: ${items.length}`],
        };
      },
    },
    {
      id: 'summary', label: t('orders.pl.summary'), hint: t('orders.pl.summary_hint'), filename: `PackingListResumen_${o.code}`,
      build: () => {
        const groups = new Map<string, { type: string; desc: string; cos: string; fun: string; qty: number }>();
        for (const i of o.items) {
          const g = { type: dmeta.typeName(i.equipmentTypeId), desc: plDesc(i), cos: dmeta.item(i.cosmeticGradeId)?.code ?? '', fun: dmeta.item(i.functionalGradeId)?.code ?? '' };
          const k = JSON.stringify(g);
          const cur = groups.get(k);
          if (cur) cur.qty++; else groups.set(k, { ...g, qty: 1 });
        }
        const rows = [...groups.values()].sort((a, b) => a.type.localeCompare(b.type) || a.desc.localeCompare(b.desc) || a.cos.localeCompare(b.cos));
        return {
          title: `${dt('orders.packing_list')} ${o.code}`, sheetName: dt('orders.packing_list'), preamble: plHead(),
          header: ['#', dt('common.type'), dt('units.description'), dt('units.cosmetic'), dt('units.functional'), dt('orders.pl.qty')],
          types: ['number', 'text', 'text', 'text', 'text', 'number'],
          rows: rows.map((g, n) => [n + 1, g.type, g.desc, g.cos, g.fun, g.qty]),
          totals: ['', dt('orders.pl.total_units'), '', '', '', o.itemCount],
        };
      },
    },
  ];

  return (
    <>
      <PageHeader
        back={<Link to="/orders" className="row gap-sm muted" style={{ marginBottom: 6 }}><ArrowLeft size={14} />{t('orders.title')}</Link>}
        title={<span className="row"><span className="mono">{o.code}</span><StatusBadge id={o.statusId} />{o.isQuick && <Badge tone="info"><Zap size={11} /> {t('orders.quick.badge')}</Badge>}</span>}
        subtitle={<>{o.customerName ?? (o.isQuick ? t('orders.quick.no_customer_label') : '—')}{o.sellerName && <> · {t('orders.seller')}: {o.sellerName}</>} · {f.date(o.createdAt)}</>}
        actions={<>
          <ExportMenu label={t('orders.packing_list')} options={packingOptions}
            extra={[{ label: t('orders.pl.system_pdf'), icon: <FileText size={15} />, onClick: () => api.openFile(`/orders/${id}/packing-list.pdf`).catch((e: unknown) => toast.error(err(e))) }]} />
          {o.statusKey !== 'cancelled' && <Button icon={<Tag size={16} />} onClick={() => setLabelsOpen(true)}>{t('orders.labels.button')}</Button>}
          {editable && <Button icon={<Pencil size={16} />} onClick={() => setEdit(true)}>{t('common.edit')}</Button>}
          {open && can('sales.cancel') && <Button variant="ghost" icon={<XCircle size={16} />} onClick={cancel}>{t('orders.cancel')}</Button>}
          {open && can('sales.complete') && <Button variant="primary" icon={<CheckCircle2 size={16} />} disabled={o.itemCount === 0} onClick={complete}>{t('orders.complete')}</Button>}
        </>}
      />

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <div className="card kpi"><span className="kpi-value">{o.itemCount}{o.requested > 0 && <span className="muted" style={{ fontSize: 16 }}> / {o.requested}</span>}</span><span className="kpi-label">{t('orders.units')}{o.requested > 0 ? ` (${t('orders.kpi_requested')})` : ''}</span></div>
        {o.offOrder > 0 && <div className="card kpi"><span className="kpi-value" style={{ color: 'var(--warn)' }}>{o.offOrder}</span><span className="kpi-label">{t('orders.kpi_off')}</span></div>}
        {o.canSeePrices && <div className="card kpi"><span className="kpi-value">{f.money(o.total, o.currency)}</span><span className="kpi-label">{t('common.total_label')}{o.adjustments.length > 0 && ` · ${t('pricing.with_adjustments')}`}</span></div>}
        {o.margin && <div className="card kpi"><span className="kpi-value" style={{ color: o.margin.profit < 0 ? 'var(--danger)' : undefined }}>{f.money(o.margin.profit, o.currency)}</span><span className="kpi-label">{t('pricing.profit')}{o.margin.pct !== null && ` · ${o.margin.pct.toFixed(1)}%`}</span></div>}
        {open && <div className="card kpi"><span className="kpi-value" style={{ fontSize: 18 }}>{o.reservedUntil ? f.dateTime(o.reservedUntil) : t('orders.no_expiry')}</span><span className="kpi-label">{t('orders.reserved_until')}</span></div>}
        {o.completedAt && <div className="card kpi"><span className="kpi-value" style={{ fontSize: 18 }}>{f.dateTime(o.completedAt)}</span><span className="kpi-label">{t('orders.completed_at')}</span></div>}
        {o.cancelledAt && <div className="card kpi"><span className="kpi-value" style={{ fontSize: 18 }}>{f.dateTime(o.cancelledAt)}</span><span className="kpi-label">{t('orders.cancelled_at')}</span></div>}
      </div>
      {o.notes && <Alert kind="info">{o.notes}</Alert>}

      <Tabs value={(tab === 'search' || tab === 'qty' || tab === 'pick') && !editable ? 'lines' : tab} onChange={setTab} tabs={[
        ...(o.isQuick ? [] : [{ id: 'lines' as const, label: t('orders.tab_lines'), count: o.lines.length }]),
        ...(editable ? [{ id: 'pick' as const, label: t('orders.tab_pick') }, { id: 'qty' as const, label: t('orders.tab_qty') }] : []),
        { id: 'items', label: t('orders.tab_items'), count: o.itemCount },
        ...(o.canSeePrices ? [{ id: 'pricing' as const, label: t('pricing.tab') }] : []),
        { id: 'locations', label: t('orders.tab_locations') },
        ...(editable ? [{ id: 'search' as const, label: t('orders.tab_search') }] : []),
      ]} />
      {o.offOrder > 0 && tab !== 'pick' && <Alert kind="warn">{t('orders.off_alert', { count: o.offOrder })}</Alert>}

      {tab === 'lines' && <LinesTab order={o} editable={editable} onChanged={(x) => setOrder(x)} />}
      {editable && (tab === 'pick' || tab === 'qty' || tab === 'search') && o.lines.length === 0 && (
        <Alert kind="warn">
          <div className="row spread wrap"><span><strong>{t('orders.needs_lines_title')}</strong><br />{t('orders.needs_lines_msg')}</span>
            <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => setTab('lines')}>{t('orders.needs_lines_go')}</Button></div>
        </Alert>
      )}
      {editable && tab === 'pick' && o.lines.length > 0 && <PickTab order={o} onChanged={(x) => setOrder(x)} />}
      {editable && tab === 'qty' && o.lines.length > 0 && <QuantityAdd order={o} onChanged={(x) => setOrder(x)} />}
      {tab === 'pricing' && o.canSeePrices && <OrderPricingTab order={o} editable={editable} selected={[...sel]} onChanged={(x) => setOrder(x)} />}
      {tab === 'locations' && <LocationsTab orderId={id} orderCode={o.code} refreshKey={o.itemCount + ':' + o.lines.map((l) => l.picked).join(',')} />}

      {tab === 'items' && (
        <Card padded={false} title={t('orders.tab_items')} actions={editable && <>
          {o.canSeePrices && (
            <span className="row gap-sm">
              <Input type="number" min={0} step="0.01" placeholder={t('orders.price_placeholder')} value={bulkPrice} onChange={(e) => setBulkPrice(e.target.value)} style={{ width: 130 }} />
              <Button size="sm" disabled={bulkPrice === ''} loading={savePrices.isPending} onClick={() => savePrices.mutate({ itemIds: sel.size ? [...sel] : undefined, unitPrice: Number(bulkPrice) })}>{sel.size ? t('orders.price_selected', { count: sel.size }) : t('orders.price_all')}</Button>
            </span>
          )}
          {sel.size > 0 && <Button size="sm" variant="danger" icon={<Trash2 size={14} />} onClick={() => remove.mutate([...sel])}>{t('orders.remove_selected', { count: sel.size })}</Button>}
        </>}>
          <DataGrid id="order-items" bare rows={o.items} columns={itemCols} rowId={(i) => i.id} exportName={`${t('orders.tab_items')} ${o.code}`}
            selectable={editable} selected={sel} onSelectedChange={setSel} emptyTitle={t('orders.no_items')} emptyHint={editable ? t('orders.no_items_hint') : undefined} valueKey={o.lines.length} />
          {dirtyPrices && (
            <div className="sticky-actions">
              <span className="muted grow">{t('orders.unsaved_prices')}</span>
              <Button variant="ghost" onClick={() => setPrices({})}>{t('common.cancel')}</Button>
              <Button variant="primary" loading={savePrices.isPending} onClick={() => savePrices.mutate({ prices: Object.entries(prices).map(([itemId, v]) => ({ itemId: Number(itemId), unitPrice: v.trim() === '' ? null : Number(v) })) })}>{t('orders.save_prices')}</Button>
            </div>
          )}
        </Card>
      )}
      {editable && tab === 'search' && o.lines.length > 0 && <SearchAdd orderId={id} canPrice={can('sales.price')} onAdded={(x) => { setOrder(x); setTab('items'); }} />}
      {labelsOpen && <PrintOrderLabelsModal order={o} onClose={() => setLabelsOpen(false)} />}
      {edit && <OrderHeaderModal order={o} onClose={() => setEdit(false)} onSaved={() => { void qc.invalidateQueries({ queryKey: ['order', id] }); void qc.invalidateQueries({ queryKey: ['orders'] }); }} />}
    </>
  );
}

// ---------------------------------------------------------------------------
/** Buscar equipos disponibles y reservarlos uno a uno o varios a la vez. */
function SearchAdd({ orderId, canPrice, onAdded }: { orderId: number; canPrice: boolean; onAdded: (o: Order) => void }) {
  const { t } = useTranslation();
  const err = useErr();
  const toast = useToast();
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [price, setPrice] = useState('');
  const [busy, setBusy] = useState(false);
  const list = useAllRows<UnitRow>(['units', 'available'], '/units', { statusKey: 'available', sort: 'oldest' });
  const columns = useUnitColumns(['status', 'order', 'tester']);

  async function add() {
    setBusy(true);
    try { onAdded(await api.post<Order>(`/orders/${orderId}/items`, { unitIds: [...sel], unitPrice: canPrice && price !== '' ? Number(price) : null })); setSel(new Set()); toast.success(t('addToOrder.done', { count: sel.size })); }
    catch (e) { toast.error(err(e)); } finally { setBusy(false); }
  }
  return (
    <Card padded={false} title={t('orders.available_units', { count: list.data?.length ?? 0 })}
      actions={<>
        {canPrice && <Input type="number" min={0} step="0.01" placeholder={t('orders.price_placeholder')} value={price} onChange={(e) => setPrice(e.target.value)} style={{ width: 130 }} />}
        <Button size="sm" variant="primary" icon={<Plus size={14} />} disabled={!sel.size} loading={busy} onClick={add}>{t('orders.reserve_selected', { count: sel.size })}</Button>
      </>}>
      <DataGrid id="order-available" bare rows={list.data ?? []} loading={list.isLoading} columns={columns} rowId={(u) => u.id} selectable selected={sel} onSelectedChange={setSel}
        exportName={t('orders.available_units', { count: list.data?.length ?? 0 })} emptyTitle={t('orders.no_available')}
        onRowClick={(u) => setSel((s) => { const n = new Set(s); if (n.has(u.id)) n.delete(u.id); else n.add(u.id); return n; })} />
    </Card>
  );
}
