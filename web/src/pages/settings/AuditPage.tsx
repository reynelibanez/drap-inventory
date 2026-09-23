import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFmt } from '../../lib/useFmt';
import { useAllRows } from '../../lib/useAllRows';
import { Badge, Input, PageHeader } from '../../components/ui';
import { EntityLink, useAuditText } from '../../components/AuditLine';
import { DataGrid, type GridColumn } from '../../components/grid/DataGrid';

interface AuditRow { id: number; at: string; action: string; entity: string; entityId: number | null; data: any; userName: string | null }

export default function AuditPage() {
  const { t } = useTranslation();
  const auditText = useAuditText();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  useFmt();
  const list = useAllRows<AuditRow>(['audit'], '/audit', { from, to });

  const columns: GridColumn<AuditRow>[] = [
    { key: 'at', title: t('common.at'), type: 'datetime', width: 170 },
    { key: 'user', title: t('common.user'), type: 'select', width: 160, value: (r) => r.userName, render: (r) => (r.userName ? <Badge>{r.userName}</Badge> : <span className="muted">—</span>) },
    { key: 'event', title: t('audit.event'), width: 360, value: (r) => auditText(r.action, r.data) },
    { key: 'entity', title: t('audit.entity'), type: 'select', width: 200, value: (r) => t(`audit.entities.${r.entity}`, { defaultValue: r.entity }), render: (r) => <EntityLink entity={r.entity} id={r.entityId} /> },
    { key: 'entityId', title: t('audit.entity_id'), type: 'number', hidden: true, width: 100 },
    { key: 'action', title: t('audit.action'), hidden: true, width: 160 },
  ];
  return (
    <>
      <PageHeader title={t('audit.title')} subtitle={t('audit.subtitle')} />
      <DataGrid id="audit" rows={list.data ?? []} loading={list.isLoading} columns={columns} rowId={(r) => r.id} exportName={t('audit.title')} defaultSort={[{ key: 'at', dir: 'desc' }]}
        emptyTitle={t('common.empty')}
        toolbar={<>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label={t('audit.from')} title={t('audit.from')} style={{ width: 150 }} />
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label={t('audit.to')} title={t('audit.to')} style={{ width: 150 }} />
        </>} />
    </>
  );
}
