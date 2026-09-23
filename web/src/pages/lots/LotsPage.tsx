import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, Upload } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useMeta } from '../../lib/meta';
import { useFmt } from '../../lib/useFmt';
import { useAllRows } from '../../lib/useAllRows';
import { Button, PageHeader, Progress, useConfirm, useErr, useToast } from '../../components/ui';
import { PendingMark } from '../../components/PendingMark';
import { StatusBadge } from '../../components/fields';
import { DataGrid, type Filter, type GridColumn } from '../../components/grid/DataGrid';
import { useCatalogOpts } from '../../components/grid/helpers';

export interface LotRow {
  id: number; code: string; statusId: number; statusKey: string; supplierName: string | null; purchaseDate: string; reference: string | null;
  expected: number; counted: number; lines: number; uncountedLines: number; units: number; inTesting: number; createdAt?: string;
  /** El lote no está cerrado: todavía se puede eliminar (con sus equipos, si tiene). */
  deletable?: boolean;
  /** Guardado en este dispositivo, aún sin enviar al servidor. */
  pendingSync?: boolean;
}

export default function LotsPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const meta = useMeta();
  const f = useFmt();
  const nav = useNavigate();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const err = useErr();
  const statusOpts = useCatalogOpts('lot_status');
  const list = useAllRows<LotRow>(['lots'], '/lots');
  const closedId = meta.sysId('lot_status', 'closed');
  // Por defecto no se muestran los lotes cerrados (se puede cambiar en el filtro de estado).
  const initial = useMemo<Record<string, Filter>>(() => {
    const r: Record<string, Filter> = {};
    if (closedId) r.status = { op: 'notIn', list: [String(closedId)] };
    return r;
  }, [closedId]);

  const columns: GridColumn<LotRow>[] = [
    { key: 'code', title: t('lots.code'), width: 150, value: (l) => l.code, render: (l) => <><Link to={`/lots/${l.id}`} className="mono" onClick={(e) => e.stopPropagation()}><strong>{l.code}</strong></Link>{l.pendingSync && <PendingMark />}{l.reference && <div className="sub">{l.reference}</div>}</>, exportValue: (l) => l.code },
    { key: 'reference', title: t('lots.reference'), hidden: true, value: (l) => l.reference },
    { key: 'supplier', title: t('lots.supplier'), type: 'select', value: (l) => l.supplierName },
    { key: 'purchaseDate', title: t('lots.purchase_date'), type: 'date', width: 130 },
    { key: 'status', title: t('common.status'), type: 'select', options: statusOpts, width: 140, value: (l) => String(l.statusId), render: (l) => <StatusBadge id={l.statusId} keyName={meta.sysKey(l.statusId) ?? ''} /> },
    { key: 'lines', title: t('lots.lines'), type: 'number', width: 90 },
    { key: 'expected', title: t('lots.expected'), type: 'number', width: 100, hidden: true },
    {
      key: 'counted', title: t('lots.counted_vs_expected'), type: 'number', width: 190, mobile: 'wide',
      render: (l) => (
        <>
          <Progress value={l.counted} max={l.expected || l.counted || 1} tone={l.uncountedLines ? 'warn' : l.counted === l.expected ? 'good' : 'bad'} />
          <div className="sub">{f.int(l.counted)} / {f.int(l.expected)}{l.uncountedLines > 0 && ` · ${t('lots.uncounted_lines', { n: l.uncountedLines })}`}</div>
        </>
      ),
    },
    { key: 'units', title: t('lots.units'), type: 'number', width: 100, render: (l) => <>{f.int(l.units)}{l.inTesting > 0 && <div className="sub">{t('lots.in_testing', { n: l.inTesting })}</div>}</> },
    { key: 'inTesting', title: t('lots.in_testing_col'), type: 'number', width: 100, hidden: true },
    { key: 'createdAt', title: t('common.created'), type: 'datetime', hidden: true },
    {
      key: '_actions', title: '', actions: true as const, width: 60,
      render: (l) => (can('lots.delete') && l.deletable
        ? <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} title={t('lots.delete_lot')} aria-label={t('lots.delete_lot')} onClick={(e) => { e.stopPropagation(); void remove(l); }} />
        : null),
    },
  ];

  /** Cualquier lote no cerrado se puede eliminar desde la lista; si tiene equipos, se eliminan con él. */
  async function remove(l: LotRow) {
    const msg = l.units > 0 ? t('lots.delete_lot_msg_units', { code: l.code, count: l.units }) : t('lots.delete_empty_msg', { code: l.code });
    if (!(await confirm({ title: t('lots.delete_lot_title'), message: msg, danger: true, confirmLabel: t('common.delete') }))) return;
    try { await api.del(`/lots/${l.id}`); toast.success(t('common.deleted')); void qc.invalidateQueries({ queryKey: ['lots'] }); void qc.invalidateQueries({ queryKey: ['dashboard'] }); }
    catch (e) { toast.error(err(e)); }
  }

  return (
    <>
      <PageHeader title={t('lots.title')} subtitle={t('lots.subtitle')}
        actions={<>
          {can('lots.import') && <Button variant="ghost" icon={<Upload size={16} />} onClick={() => nav('/lots/import')}>{t('nav.import_equipment')}</Button>}
          {can('lots.import') && <Button variant="ghost" icon={<Upload size={16} />} onClick={() => nav('/lots/import-tech')}>{t('nav.import_equipment_tech')}</Button>}
          {can('lots.create') && <Button variant="primary" icon={<Plus size={16} />} onClick={() => nav('/lots/new')}>{t('lots.new')}</Button>}
        </>} />
      <DataGrid id="lots" rows={list.data ?? []} loading={list.isLoading} columns={columns} rowId={(l) => l.id} onRowClick={(l) => nav(`/lots/${l.id}`)}
        initialFilters={initial} initialFiltersKey={String(closedId)} exportName={t('lots.title')}
        emptyTitle={t('lots.empty')} emptyHint={can('lots.create') ? t('lots.empty_hint') : undefined}
        emptyAction={can('lots.create') ? <Button variant="primary" onClick={() => nav('/lots/new')}>{t('lots.new')}</Button> : undefined} />
    </>
  );
}
