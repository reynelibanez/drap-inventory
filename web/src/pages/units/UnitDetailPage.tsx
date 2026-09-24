import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Coins, MapPin, Pencil, Pin, Printer, ShoppingCart, Tag, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useMeta } from '../../lib/meta';
import { useFmt } from '../../lib/useFmt';
import { Badge, Button, Card, Empty, Field, Modal, PageHeader, Select, Spinner, Textarea, useConfirm, useErr, useToast } from '../../components/ui';
import { Grades, StatusBadge, TypeLabel } from '../../components/fields';
import { UnitForm, type UnitData } from '../../components/UnitForm';
import { PlaceUnitsModal } from '../../components/PlaceUnitsModal';
import { AddToOrderModal } from '../../components/AddToOrderModal';
import { PrintLabelsModal } from '../../components/PrintLabelsModal';
import { BulkCostModal, BulkPriceModal } from '../../components/PricingModals';
import { useAuditText } from '../../components/AuditLine';

interface Detail extends UnitData { history: { id: number; at: string; action: string; data: any; userName: string | null }[]; createdAt: string }

export default function UnitDetailPage() {
  const { t, i18n } = useTranslation();
  const id = Number(useParams().id);
  const { can, company } = useAuth();
  const meta = useMeta();
  const f = useFmt();
  const qc = useQueryClient();
  const err = useErr();
  const toast = useToast();
  const confirm = useConfirm();
  const nav = useNavigate();
  const auditText = useAuditText();
  const [editing, setEditing] = useState(false);
  const [place, setPlace] = useState(false);
  const [order, setOrder] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [priceOpen, setPriceOpen] = useState(false);
  const [costOpen, setCostOpen] = useState(false);

  const q = useQuery({ queryKey: ['unit', id], queryFn: () => api.get<Detail>(`/units/${id}`) });
  const u = q.data;
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['unit', id] }); void qc.invalidateQueries({ queryKey: ['units'] }); void qc.invalidateQueries({ queryKey: ['dashboard'] }); };

  if (q.isLoading) return <Spinner />;
  if (!u) return <Empty title={t('errors.unit_not_found')} />;
  const type = meta.type(u.equipmentTypeId);
  const cur = u.lotCurrency ?? company?.currency ?? 'USD';
  const testing = u.statusKey === 'testing';
  const sold = u.statusKey === 'sold';

  /** Un equipo se puede eliminar mientras no esté vendido (un borrador de prueba solo pide permiso de probar). */
  const draft = testing && !u.testedAt;
  const canDelete = !sold && (draft ? can('units.test') : can('units.edit'));
  async function remove() {
    const reserved = u!.statusKey === 'reserved';
    if (!(await confirm({
      title: t('units.delete_title', { code: u!.code }),
      message: <>{t('units.delete_msg')}{reserved && <><br /><strong>{t('units.delete_reserved', { order: u!.orderCode ?? '' })}</strong></>}</>,
      danger: true, confirmLabel: t('common.delete'),
    }))) return;
    try {
      await api.del(`/units/${id}`);
      toast.success(t('units.deleted'));
      for (const k of ['units', 'orders', 'order', 'dashboard', 'locations', 'lots']) void qc.invalidateQueries({ queryKey: [k] });
      nav('/units');
    } catch (e) { toast.error(err(e)); }
  }

  async function unplace() {
    if (!(await confirm({ title: t('units.unassign_title', { count: 1 }), confirmLabel: t('units.unassign') }))) return;
    try { await api.post('/locations/unassign', { unitIds: [id] }); toast.success(t('common.saved')); refresh(); void qc.invalidateQueries({ queryKey: ['locations'] }); } catch (e) { toast.error(err(e)); }
  }

  return (
    <>
      <PageHeader
        back={<Link to="/units" className="row gap-sm muted" style={{ marginBottom: 6 }}><ArrowLeft size={14} />{t('units.title')}</Link>}
        title={<span className="row"><span className="mono">{u.code}</span><StatusBadge id={u.statusId} /></span>}
        subtitle={<span className="row wrap gap-sm"><TypeLabel typeId={u.equipmentTypeId} /><span>·</span><Link to={`/lots/${u.lotId}`}>{t('units.lot')} {u.lotCode}</Link>{u.serialNumber && <><span>·</span><span>S/N {u.serialNumber}</span></>}</span>}
        actions={<>
          <Button icon={<Printer size={16} />} onClick={() => setPrinting(true)}>{t('units.label')}</Button>
          {can('locations.assign') && !sold && <Button icon={<MapPin size={16} />} onClick={() => setPlace(true)}>{u.slotCode ? t('units.move') : t('units.place')}</Button>}
          {can('sales.edit') && u.statusKey === 'available' && <Button icon={<ShoppingCart size={16} />} onClick={() => setOrder(true)}>{t('units.add_to_order')}</Button>}
          {can('units.change_status') && !sold && u.statusKey !== 'reserved' && <Button onClick={() => setStatusOpen(true)}>{t('units.change_status')}</Button>}
          {canDelete && <Button variant="danger" icon={<Trash2 size={16} />} onClick={remove}>{t('common.delete')}</Button>}
        </>}
      />
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 3fr) minmax(0, 2fr)', alignItems: 'start' }}>
        <div className="stack">
          {testing && can('units.test') ? (
            <Card title={t('units.finish_test')}><UnitForm key={u.id + u.statusKey} unit={u} mode="test" onSaved={refresh} onFinished={() => { refresh(); if (can('locations.assign')) setPlace(true); }} /></Card>
          ) : editing && can('units.edit') ? (
            <Card title={t('units.edit_data')} actions={<Button size="sm" variant="ghost" onClick={() => setEditing(false)}>{t('common.cancel')}</Button>}>
              <UnitForm key={u.id} unit={u} mode="edit" onSaved={() => { setEditing(false); refresh(); }} />
            </Card>
          ) : (
            <Card title={t('units.data')} actions={can('units.edit') && !sold && <Button size="sm" icon={<Pencil size={14} />} onClick={() => setEditing(true)}>{t('common.edit')}</Button>}>
              <dl className="kv">
                <dt>{t('unitForm.serial')}</dt><dd>{u.serialNumber ?? <span className="muted">—</span>}</dd>
                {meta.typeAttrs(u.equipmentTypeId).map(({ attr }) => {
                  const v = u.specs[attr.key];
                  return <FragmentRow key={attr.key} label={meta.label(attr.label)} value={v === undefined || v === null || v === '' ? null : meta.specValue(attr, v)} />;
                })}
                <dt>{t('units.grades')}</dt><dd><Grades cosmeticId={u.cosmeticGradeId} functionalId={u.functionalGradeId} /></dd>
                {u.cosmeticGradeNote && <><dt>{t('unitForm.cosmetic_note')}</dt><dd className="pre">{u.cosmeticGradeNote}</dd></>}
                {u.functionalGradeNote && <><dt>{t('unitForm.functional_note')}</dt><dd className="pre">{u.functionalGradeNote}</dd></>}
                <dt>{t('units.location')}</dt><dd>{u.slotCode ? <span className="row gap-sm"><strong>{u.slotCode}</strong>{can('locations.assign') && !sold && <Button size="sm" variant="ghost" onClick={unplace}>{t('units.unassign')}</Button>}</span> : <span className="muted">{t('units.not_placed')}</span>}</dd>
                {u.orderCode && <><dt>{t('units.order')}</dt><dd><Link to={`/orders/${u.orderId}`}>{u.orderCode}</Link></dd></>}
                <dt>{t('units.tested_by')}</dt><dd>{t('shell.tech_number', { n: u.testerNumber })}{u.testedAt && ` · ${f.dateTime(u.testedAt)}`}</dd>
                {u.notes && <><dt>{t('common.notes')}</dt><dd className="pre">{u.notes}</dd></>}
              </dl>
              {!type && <Badge tone="warn">{t('common.unknown')}</Badge>}
            </Card>
          )}
        </div>
        <div className="stack">
        {(can('costs.view') || can('sales.price') || can('prices.manage')) && (u.cost !== undefined || u.listPrice !== undefined) && (
          <Card title={t('pricing.unit_card')}>
            <dl className="kv">
              {can('costs.view') && <>
                <dt>{t('pricing.col_cost')}</dt>
                <dd className="row gap-sm wrap">
                  <strong>{u.cost === null || u.cost === undefined ? '—' : f.money(u.cost, cur)}</strong>
                  {u.costSource && <Badge tone={u.costSource === 'manual' ? 'info' : 'neutral'}>{u.costSource === 'manual' ? <><Pin size={11} /> {t('pricing.manual')}</> : t('pricing.from_lot')}</Badge>}
                  {can('costs.manage') && !sold && <Button size="sm" variant="ghost" icon={<Coins size={14} />} onClick={() => setCostOpen(true)}>{t('common.edit')}</Button>}
                </dd>
              </>}
              <dt>{t('pricing.col_list_price')}</dt>
              <dd className="row gap-sm wrap">
                <strong>{u.listPrice === null || u.listPrice === undefined ? '—' : f.money(u.listPrice, cur)}</strong>
                {u.priceSource && <Badge tone={u.priceSource === 'manual' ? 'info' : 'neutral'}>{u.priceSource === 'manual' ? <><Pin size={11} /> {t('pricing.manual')}</> : t('pricing.from_rule')}</Badge>}
                {can('prices.manage') && !sold && <Button size="sm" variant="ghost" icon={<Tag size={14} />} onClick={() => setPriceOpen(true)}>{t('common.edit')}</Button>}
              </dd>
              {can('costs.view') && u.cost !== null && u.cost !== undefined && !!u.listPrice && <>
                <dt>{t('pricing.col_margin')}</dt>
                <dd>{f.money(u.listPrice - u.cost, cur)} · <span className={u.listPrice < u.cost ? 'diff-neg' : undefined}>{(((u.listPrice - u.cost) / u.listPrice) * 100).toFixed(1)}%</span></dd>
              </>}
            </dl>
          </Card>
        )}
        <Card title={t('units.history')}>
          {u.history.length === 0 ? <Empty title={t('common.empty')} /> : (
            <ul className="timeline">
              {u.history.map((h) => (
                <li key={h.id}><div><div>{auditText(h.action, h.data)}</div><div className="sub">{f.dateTime(h.at)}{h.userName && ` · ${h.userName}`}</div></div></li>
              ))}
            </ul>
          )}
        </Card>
        </div>
      </div>
      {priceOpen && <BulkPriceModal unitIds={[id]} canCost={can('costs.view')} onClose={() => setPriceOpen(false)} onDone={refresh} />}
      {costOpen && <BulkCostModal unitIds={[id]} onClose={() => setCostOpen(false)} onDone={refresh} />}
      {printing && <PrintLabelsModal unitIds={[id]} onClose={() => setPrinting(false)} />}
      {place && <PlaceUnitsModal unitIds={[id]} onClose={() => setPlace(false)} onDone={refresh} />}
      {order && <AddToOrderModal unitIds={[id]} onClose={() => setOrder(false)} onDone={refresh} />}
      {statusOpen && <StatusModal unit={u} onClose={() => setStatusOpen(false)} onDone={refresh} />}
    </>
  );
}

function FragmentRow({ label, value }: { label: string; value: string | null }) {
  return <><dt>{label}</dt><dd>{value ?? <span className="muted">—</span>}</dd></>;
}

function StatusModal({ unit, onClose, onDone }: { unit: UnitData; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const meta = useMeta();
  const err = useErr();
  const toast = useToast();
  const [statusId, setStatusId] = useState(String(unit.statusId));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  // Reservado y Vendido los maneja Ventas.
  const opts = meta.catalogOptions('unit_status', false, unit.statusId).filter((i) => i.systemKey !== 'reserved' && i.systemKey !== 'sold');
  async function save() {
    setBusy(true);
    try { await api.post(`/units/${unit.id}/status`, { statusId: Number(statusId), note: note.trim() || null }); toast.success(t('common.saved')); onDone(); onClose(); }
    catch (e) { toast.error(err(e)); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} size="sm" title={t('units.change_status')}
      footer={<><Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} disabled={Number(statusId) === unit.statusId} onClick={save}>{t('common.save')}</Button></>}>
      <div className="stack">
        <Field label={t('common.status')}>
          <Select value={statusId} onChange={(e) => setStatusId(e.target.value)}>{opts.map((o) => <option key={o.id} value={o.id}>{meta.name(o.id)}</option>)}</Select>
        </Field>
        <Field label={t('units.status_note')}><Textarea value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
