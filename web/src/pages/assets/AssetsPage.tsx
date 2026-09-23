import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Copy, Plus, Printer } from 'lucide-react';
import { copyText } from '../../lib/clipboard';
import { useAuth } from '../../lib/auth';
import { useMeta } from '../../lib/meta';
import { useAllRows } from '../../lib/useAllRows';
import { Button, Modal, PageHeader, useToast } from '../../components/ui';
import { SpecChips, StatusBadge, TypeLabel } from '../../components/fields';
import { AssetForm, type AssetData } from '../../components/AssetForm';
import { PrintLabelsModal } from '../../components/PrintLabelsModal';
import { DataGrid, type GridColumn } from '../../components/grid/DataGrid';
import { specColumns } from '../../components/UnitGrid';
import { useCatalogOpts, useTypeOpts } from '../../components/grid/helpers';

/** Activos de la empresa: herramientas y equipos propios (no son mercancía para vender). */
export default function AssetsPage() {
  const { t } = useTranslation();
  const meta = useMeta();
  const { can } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [creating, setCreating] = useState(false);
  const [print, setPrint] = useState<number[] | null>(null);
  const list = useAllRows<AssetData>(['assets'], '/assets', { sort: 'newest' });
  const typeOpts = useTypeOpts();
  const statusOpts = useCatalogOpts('asset_status');

  const columns = useMemo<GridColumn<AssetData>[]>(() => [
    { key: 'code', title: t('common.code'), width: 130, value: (a) => a.code, render: (a) => <><Link to={`/assets/${a.id}`} className="mono" onClick={(e) => e.stopPropagation()}><strong>{a.code}</strong></Link>{a.serialNumber && <div className="sub">S/N {a.serialNumber}</div>}</> },
    { key: 'name', title: t('assets.name'), width: 200, value: (a) => a.name },
    { key: 'type', title: t('common.type'), type: 'select', options: typeOpts, width: 140, value: (a) => String(a.equipmentTypeId), render: (a) => <TypeLabel typeId={a.equipmentTypeId} /> },
    { key: 'description', title: t('units.description'), width: 260, value: (a) => meta.describe(a.equipmentTypeId, a.specs, false).join(' · '), render: (a) => <SpecChips typeId={a.equipmentTypeId} specs={a.specs} all /> },
    { key: 'status', title: t('common.status'), type: 'select', options: statusOpts, width: 140, value: (a) => String(a.statusId), render: (a) => <StatusBadge id={a.statusId} /> },
    { key: 'assignedTo', title: t('assets.assigned_to'), width: 160, value: (a) => a.assignedTo },
    { key: 'location', title: t('assets.location'), width: 160, value: (a) => a.location },
    { key: 'serialNumber', title: t('assets.serial'), hidden: true, width: 140 },
    { key: 'acquiredAt', title: t('assets.acquired_at'), type: 'date', hidden: true, width: 130 },
    { key: 'notes', title: t('common.notes'), hidden: true, width: 220 },
    { key: 'createdAt', title: t('common.created'), type: 'datetime', hidden: true, width: 160 },
    ...specColumns<AssetData>(meta, (a) => a.specs),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [t, meta, typeOpts, statusOpts]);

  async function copyCodes() {
    const rows = (list.data ?? []).filter((a) => sel.has(a.id));
    if (await copyText(rows.map((a) => a.code).join('\n'))) toast.success(t('units.codes_copied', { count: rows.length }));
    else toast.error(`${t('units.copy_failed')} ${rows.map((a) => a.code).join(', ')}`);
  }

  function created(items: AssetData[]) {
    setCreating(false);
    void qc.invalidateQueries({ queryKey: ['assets'] });
    if (items.length === 1) nav(`/assets/${items[0].id}`);
    else setSel(new Set(items.map((a) => a.id)));   // quedan marcados: a un clic de imprimir sus etiquetas
  }

  return (
    <>
      <PageHeader title={t('assets.title')} subtitle={t('assets.subtitle')}
        actions={can('assets.manage') && <Button variant="primary" icon={<Plus size={16} />} onClick={() => setCreating(true)}>{t('assets.new')}</Button>} />
      {sel.size > 0 && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="card-body row wrap">
            <strong>{t('common.selected', { count: sel.size })}</strong>
            <Button size="sm" icon={<Copy size={14} />} onClick={copyCodes}>{t('units.copy_codes')}</Button>
            <Button size="sm" icon={<Printer size={14} />} onClick={() => setPrint([...sel])}>{t('units.labels')}</Button>
            <Button size="sm" variant="ghost" onClick={() => setSel(new Set())}>{t('common.clear')}</Button>
          </div>
        </div>
      )}
      <DataGrid id="assets" rows={list.data ?? []} loading={list.isLoading} columns={columns} rowId={(a) => a.id} onRowClick={(a) => nav(`/assets/${a.id}`)}
        selectable selected={sel} onSelectedChange={setSel} exportName={t('assets.title')}
        emptyTitle={t('assets.empty')} emptyHint={can('assets.manage') ? t('assets.empty_hint') : undefined} />
      {creating && (
        <Modal open onClose={() => setCreating(false)} title={t('assets.new')} size="lg">
          <p className="muted" style={{ marginBottom: 12 }}>{t('assets.new_hint')}</p>
          <AssetForm onSaved={created} onCancel={() => setCreating(false)} />
        </Modal>
      )}
      {print && <PrintLabelsModal unitIds={print} assets onClose={() => setPrint(null)} />}
    </>
  );
}
