import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Pencil, Printer, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useMeta } from '../../lib/meta';
import { useFmt } from '../../lib/useFmt';
import { Button, Card, Empty, Field, Modal, PageHeader, Spinner, useConfirm, useErr, useToast } from '../../components/ui';
import { CatalogSelect, StatusBadge, TypeLabel } from '../../components/fields';
import { AssetForm, type AssetData } from '../../components/AssetForm';
import { PrintLabelsModal } from '../../components/PrintLabelsModal';
import { useAuditText } from '../../components/AuditLine';

interface Detail extends AssetData { history: { id: number; at: string; action: string; data: any; userName: string | null }[] }

export default function AssetDetailPage() {
  const { t } = useTranslation();
  const id = Number(useParams().id);
  const { can } = useAuth();
  const meta = useMeta();
  const f = useFmt();
  const qc = useQueryClient();
  const err = useErr();
  const toast = useToast();
  const confirm = useConfirm();
  const nav = useNavigate();
  const auditText = useAuditText();
  const [editing, setEditing] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [printing, setPrinting] = useState(false);

  const q = useQuery({ queryKey: ['asset', id], queryFn: () => api.get<Detail>(`/assets/${id}`) });
  const a = q.data;
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['asset', id] }); void qc.invalidateQueries({ queryKey: ['assets'] }); };
  const manage = can('assets.manage');

  if (q.isLoading) return <Spinner />;
  if (!a) return <Empty title={t('errors.asset_not_found')} />;

  async function remove() {
    if (!(await confirm({ title: t('assets.delete_title', { code: a!.code }), message: t('assets.delete_msg'), danger: true, confirmLabel: t('common.delete') }))) return;
    try {
      await api.del(`/assets/${id}`);
      toast.success(t('assets.deleted'));
      void qc.invalidateQueries({ queryKey: ['assets'] });
      nav('/assets');
    } catch (e) { toast.error(err(e)); }
  }

  return (
    <>
      <PageHeader
        back={<Link to="/assets" className="row gap-sm muted" style={{ marginBottom: 6 }}><ArrowLeft size={14} />{t('assets.title')}</Link>}
        title={<span className="row"><span className="mono">{a.code}</span><StatusBadge id={a.statusId} /></span>}
        subtitle={<span className="row wrap gap-sm"><TypeLabel typeId={a.equipmentTypeId} />{a.name && <><span>·</span><span>{a.name}</span></>}{a.serialNumber && <><span>·</span><span>S/N {a.serialNumber}</span></>}</span>}
        actions={<>
          <Button icon={<Printer size={16} />} onClick={() => setPrinting(true)}>{t('units.label')}</Button>
          {manage && <Button onClick={() => setStatusOpen(true)}>{t('units.change_status')}</Button>}
          {manage && <Button variant="danger" icon={<Trash2 size={16} />} onClick={remove}>{t('common.delete')}</Button>}
        </>}
      />
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 3fr) minmax(0, 2fr)', alignItems: 'start' }}>
        {editing && manage ? (
          <Card title={t('units.edit_data')} actions={<Button size="sm" variant="ghost" onClick={() => setEditing(false)}>{t('common.cancel')}</Button>}>
            <AssetForm key={a.id + a.updatedAt} asset={a} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); refresh(); }} />
          </Card>
        ) : (
          <Card title={t('units.data')} actions={manage && <Button size="sm" icon={<Pencil size={14} />} onClick={() => setEditing(true)}>{t('common.edit')}</Button>}>
            <dl className="kv">
              <Row label={t('assets.name')} value={a.name} />
              <Row label={t('assets.serial')} value={a.serialNumber} />
              {meta.typeAttrs(a.equipmentTypeId).map(({ attr }) => {
                const v = a.specs[attr.key];
                return <Row key={attr.key} label={meta.label(attr.label)} value={v === undefined || v === null || v === '' ? null : meta.specValue(attr, v)} />;
              })}
              <Row label={t('assets.assigned_to')} value={a.assignedTo} />
              <Row label={t('assets.location')} value={a.location} />
              <Row label={t('assets.acquired_at')} value={a.acquiredAt ? f.date(a.acquiredAt) : null} />
              <Row label={t('assets.registered')} value={`${f.dateTime(a.createdAt)}${a.createdByName ? ` · ${a.createdByName}` : ''}`} />
              {a.notes && <><dt>{t('common.notes')}</dt><dd className="pre">{a.notes}</dd></>}
            </dl>
          </Card>
        )}
        <Card title={t('units.history')}>
          {a.history.length === 0 ? <Empty title={t('common.empty')} /> : (
            <ul className="timeline">
              {a.history.map((h) => (
                <li key={h.id}><div><div>{auditText(h.action, h.data)}</div><div className="sub">{f.dateTime(h.at)}{h.userName && ` · ${h.userName}`}</div></div></li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      {printing && <PrintLabelsModal unitIds={[id]} assets onClose={() => setPrinting(false)} />}
      {statusOpen && <StatusModal asset={a} onClose={() => setStatusOpen(false)} onDone={refresh} />}
    </>
  );
}

function Row({ label, value }: { label: string; value: string | null }) {
  return <><dt>{label}</dt><dd>{value ?? <span className="muted">—</span>}</dd></>;
}

function StatusModal({ asset, onClose, onDone }: { asset: AssetData; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const err = useErr();
  const toast = useToast();
  const [statusId, setStatusId] = useState<number | null>(asset.statusId);
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!statusId) return;
    setBusy(true);
    try { await api.patch(`/assets/${asset.id}`, { statusId }); toast.success(t('common.saved')); onDone(); onClose(); }
    catch (e) { toast.error(err(e)); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} size="sm" title={t('units.change_status')}
      footer={<><Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} disabled={!statusId || statusId === asset.statusId} onClick={save}>{t('common.save')}</Button></>}>
      <Field label={t('common.status')} hint={t('assets.status_hint')}><CatalogSelect catalog="asset_status" value={statusId} onChange={setStatusId} /></Field>
    </Modal>
  );
}
