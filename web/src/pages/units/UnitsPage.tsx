import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Coins, Copy, MapPin, Pencil, Printer, ShoppingCart, Tag, Wand2, X, Zap } from 'lucide-react';
import { api } from '../../lib/api';
import { copyText } from '../../lib/clipboard';
import { useAuth } from '../../lib/auth';
import { useMeta } from '../../lib/meta';
import { useAllRows } from '../../lib/useAllRows';
import { Badge, Button, PageHeader, useConfirm, useErr, useToast } from '../../components/ui';
import { PlaceUnitsModal } from '../../components/PlaceUnitsModal';
import { AddToOrderModal } from '../../components/AddToOrderModal';
import { PrintLabelsModal } from '../../components/PrintLabelsModal';
import { CustomLabelModal } from '../../components/CustomLabelModal';
import { BulkCostModal, BulkPriceModal } from '../../components/PricingModals';
import { BulkEditUnitsModal } from '../../components/BulkEditUnitsModal';
import { DataGrid, type Filter } from '../../components/grid/DataGrid';
import { useUnitColumns, type UnitRow } from '../../components/UnitGrid';
import { InventoryPanel, filterByPath, loadGroupBy, useUnitDimensions, type PathItem } from '../../components/InventoryPanel';

export type { UnitRow } from '../../components/UnitGrid';

export default function UnitsPage() {
  const { t } = useTranslation();
  const meta = useMeta();
  const { can } = useAuth();
  const nav = useNavigate();
  const err = useErr();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [sp, setSp] = useSearchParams();
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [place, setPlace] = useState<number[] | null>(null);
  const [order, setOrder] = useState<number[] | null>(null);
  const [print, setPrint] = useState<number[] | null>(null);
  const [customLabel, setCustomLabel] = useState(false);
  const [priceFor, setPriceFor] = useState<number[] | null>(null);
  const [costFor, setCostFor] = useState<number[] | null>(null);
  const [bulkEdit, setBulkEdit] = useState(false);
  const statusKey = sp.get('statusKey') ?? '';
  const placed = sp.get('placed') ?? '';
  const lotId = Number(sp.get('lotId')) || null;

  const list = useAllRows<UnitRow>(['units'], '/units', { lotId, sort: 'newest' });
  const columns = useUnitColumns();
  // Los enlaces del panel principal (sin ubicar...) llegan como filtros ya aplicados en las columnas.
  const initial = useMemo(() => {
    const r: Record<string, Filter> = {};
    if (placed === 'no') r.location = { op: 'empty' };
    if (placed === 'yes') r.location = { op: 'notEmpty' };
    return r;
  }, [placed]);

  // Por defecto solo lo DISPONIBLE. Si se llega con un estado en el enlace, o desde un lote o "sin ubicar", se muestra eso (o todo).
  const defaultStatuses = () => (statusKey ? [statusKey] : lotId || placed ? [] : ['available']);
  const [statuses, setStatuses] = useState<string[]>(defaultStatuses);
  const [path, setPath] = useState<PathItem[]>([]);
  const dims = useUnitDimensions(columns);
  const [groupBy, setGroupBy] = useState<string[] | null>(null);
  const groups = groupBy ?? (dims.length ? loadGroupBy(dims) : []);
  useEffect(() => { setStatuses(defaultStatuses()); setPath([]); }, [statusKey, lotId, placed]); // eslint-disable-line react-hooks/exhaustive-deps
  const allRows = list.data ?? [];
  const scoped = useMemo(() => (statuses.length ? allRows.filter((u) => statuses.includes(u.statusKey)) : allRows), [allRows, statuses]);
  const shown = useMemo(() => filterByPath(scoped, path, dims), [scoped, path, dims]);

  async function unassign() {
    if (!(await confirm({ title: t('units.unassign_title', { count: sel.size }), confirmLabel: t('units.unassign') }))) return;
    try {
      await api.post('/locations/unassign', { unitIds: [...sel] });
      toast.success(t('common.saved')); void qc.invalidateQueries({ queryKey: ['units'] }); void qc.invalidateQueries({ queryKey: ['locations'] });
    } catch (e) { toast.error(err(e)); }
  }
  /** Copia los códigos de los equipos seleccionados, uno por línea (listos para pegar en un pedido, Excel, etc.). */
  async function copyCodes() {
    const rows = (list.data ?? []).filter((u) => sel.has(u.id));
    const text = rows.map((u) => u.code).join('\n');
    if (await copyText(text)) toast.success(t('units.codes_copied', { count: rows.length }));
    else toast.error(`${t('units.copy_failed')} ${rows.map((u) => u.code).join(', ')}`);
  }
  /** Venta rápida con los equipos seleccionados: abre la pantalla con los códigos ya cargados. */
  function quickSale() {
    const codes = (list.data ?? []).filter((u) => sel.has(u.id)).map((u) => u.code);
    nav('/orders/quick', { state: { codes } });
  }
  const clearLot = () => { const n = new URLSearchParams(sp); n.delete('lotId'); setSp(n); };
  const pathLabel = path.map((p) => dims.find((d) => d.key === p.dim)?.label(p.value) ?? p.value).join(' › ');
  const onlyAvailable = statuses.length === 1 && statuses[0] === 'available';

  return (
    <>
      <PageHeader title={t('units.title')} subtitle={t('units.subtitle')}
        actions={<Button variant="ghost" icon={<Wand2 size={16} />} onClick={() => setCustomLabel(true)}>{t('labels.custom.action')}</Button>} />
      {sel.size > 0 && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="card-body row wrap">
            <strong>{t('common.selected', { count: sel.size })}</strong>
            <Button size="sm" icon={<Copy size={14} />} onClick={copyCodes}>{t('units.copy_codes')}</Button>
            <Button size="sm" icon={<Printer size={14} />} onClick={() => setPrint([...sel])}>{t('units.labels')}</Button>
            {can('units.edit') && <Button size="sm" icon={<Pencil size={14} />} onClick={() => setBulkEdit(true)}>{t('units.edit_data')}</Button>}
            {can('locations.assign') && <Button size="sm" icon={<MapPin size={14} />} onClick={() => setPlace([...sel])}>{t('units.place')}</Button>}
            {can('locations.assign') && <Button size="sm" variant="ghost" onClick={unassign}>{t('units.unassign')}</Button>}
            {can('sales.edit') && <Button size="sm" icon={<ShoppingCart size={14} />} onClick={() => setOrder([...sel])}>{t('units.add_to_order')}</Button>}
            {can('sales.create') && can('sales.complete') && <Button size="sm" icon={<Zap size={14} />} onClick={quickSale}>{t('units.quick_sale')}</Button>}
            {can('prices.manage') && <Button size="sm" icon={<Tag size={14} />} onClick={() => setPriceFor([...sel])}>{t('pricing.set_price')}</Button>}
            {can('costs.manage') && <Button size="sm" icon={<Coins size={14} />} onClick={() => setCostFor([...sel])}>{t('pricing.set_cost')}</Button>}
            <Button size="sm" variant="ghost" onClick={() => setSel(new Set())}>{t('common.clear')}</Button>
          </div>
        </div>
      )}
      <div className="inv-layout">
        <InventoryPanel rows={allRows} scoped={scoped} dims={dims} statuses={statuses} onStatuses={(x) => { setStatuses(x); setPath([]); }}
          groupBy={groups} onGroupBy={setGroupBy} path={path} onPath={setPath} />
        <div className="inv-main">
          <DataGrid id="units" rows={shown} loading={list.isLoading} columns={columns} rowId={(u) => u.id} onRowClick={(u) => nav(`/units/${u.id}`)}
            selectable selected={sel} onSelectedChange={setSel} initialFilters={initial} initialFiltersKey={placed} exportName={t('units.title')}
            emptyTitle={onlyAvailable && allRows.length > 0 && path.length === 0 ? t('units.empty_available') : t('units.empty')}
            emptyHint={onlyAvailable && allRows.length > 0 && path.length === 0 ? t('units.empty_available_hint') : t('units.empty_hint')}
            toolbar={(lotId || path.length > 0 || onlyAvailable) ? (
              <>
                {onlyAvailable && <Badge tone="good"><span>{t('units.only_available')}</span><button className="icon-btn" title={t('units.grp_all_status')} onClick={() => { setStatuses([]); setPath([]); }}><X size={12} /></button></Badge>}
                {path.length > 0 && <Badge tone="info"><span>{t('units.grp_badge', { name: pathLabel })}</span><button className="icon-btn" title={t('units.grp_clear')} onClick={() => setPath([])}><X size={12} /></button></Badge>}
                {lotId && <Badge tone="info"><span>{t('units.lot_filter')}</span><button className="icon-btn" onClick={clearLot}><X size={12} /></button></Badge>}
              </>
            ) : undefined} />
        </div>
      </div>
      {print && <PrintLabelsModal unitIds={print} onClose={() => setPrint(null)} />}
      {customLabel && <CustomLabelModal onClose={() => setCustomLabel(false)} />}
      {place && <PlaceUnitsModal unitIds={place} onClose={() => setPlace(null)} onDone={() => setSel(new Set())} />}
      {order && <AddToOrderModal unitIds={order} onClose={() => setOrder(null)} onDone={() => setSel(new Set())} />}
      {priceFor && <BulkPriceModal unitIds={priceFor} canCost={can('costs.view')} onClose={() => setPriceFor(null)} onDone={() => setSel(new Set())} />}
      {costFor && <BulkCostModal unitIds={costFor} onClose={() => setCostFor(null)} onDone={() => setSel(new Set())} />}
      {bulkEdit && <BulkEditUnitsModal units={(list.data ?? []).filter((u) => sel.has(u.id))} onClose={() => setBulkEdit(false)} onDone={() => setSel(new Set())} />}
    </>
  );
}
