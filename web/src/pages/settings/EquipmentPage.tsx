import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, Lock, Pencil, Plus, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useMeta, useReloadMeta, type Attribute, type EquipmentType } from '../../lib/meta';
import type { I18nText } from '../../lib/i18n';
import { Badge, Button, Card, Checkbox, Empty, Field, Input, Modal, PageHeader, Select, Tabs, TypeIcon, iconNames, useConfirm, useErr, useToast } from '../../components/ui';
import { I18nInput, completeI18n, i18nValid } from '../../components/I18nInput';

export default function EquipmentPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'types' | 'attrs'>('types');
  return (
    <>
      <PageHeader title={t('equipment.title')} subtitle={t('equipment.subtitle')} />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'types', label: t('equipment.tab_types') }, { id: 'attrs', label: t('equipment.tab_attrs') }]} />
      {tab === 'types' ? <TypesTab /> : <AttrsTab />}
    </>
  );
}

const slug = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

// ---------------------------------------------------------------------------
function TypesTab() {
  const { t } = useTranslation();
  const meta = useMeta();
  const { can } = useAuth();
  const [modal, setModal] = useState<{ type?: EquipmentType } | null>(null);
  const manage = can('equipment.manage');
  const types = meta.typeList(true);
  return (
    <>
      <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 12 }}>
        {manage && <Button variant="primary" icon={<Plus size={16} />} onClick={() => setModal({})}>{t('equipment.new_type')}</Button>}
      </div>
      <div className="grid grid-auto" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
        {types.map((ty) => (
          <Card key={ty.id} className={ty.isActive ? '' : 'inactive'}>
            <div className="row spread">
              <div className="row"><TypeIcon icon={ty.icon} size={22} /><div><strong>{meta.label(ty.name)}</strong><div className="sub">{ty.key}</div></div></div>
              {manage && <button className="icon-btn" onClick={() => setModal({ type: ty })} title={t('common.edit')}><Pencil size={16} /></button>}
            </div>
            <div className="tag-list" style={{ marginTop: 10 }}>
              {meta.typeAttrs(ty.id).map(({ attr, cfg }) => <span key={attr.key} className="chip">{meta.label(attr.label)}{cfg.inLotLine ? ' ▤' : ''}{cfg.requiredOnTest ? ' *' : ''}</span>)}
              {ty.attributes.length === 0 && <span className="muted">{t('fields.no_attributes')}</span>}
            </div>
            <div className="row gap-sm wrap" style={{ marginTop: 10 }}>
              {ty.tracksSerial && <Badge tone="info">{t('equipment.tracks_serial')}</Badge>}
              {ty.isSystem && <Badge><Lock size={11} />{t('catalogs.system')}</Badge>}
              {!ty.isActive && <Badge>{t('common.inactive')}</Badge>}
            </div>
          </Card>
        ))}
      </div>
      <p className="muted" style={{ marginTop: 12 }}>{t('equipment.legend')}</p>
      {modal && <TypeModal type={modal.type} onClose={() => setModal(null)} />}
    </>
  );
}

interface AttrRow { attributeId: number; inLotLine: boolean; requiredOnLot: boolean; requiredOnTest: boolean; isActive: boolean; suggestCatalogId: number | null; catalogId: number | null }

function TypeModal({ type, onClose }: { type?: EquipmentType; onClose: () => void }) {
  const { t } = useTranslation();
  const meta = useMeta();
  const reload = useReloadMeta();
  const err = useErr();
  const toast = useToast();
  const confirm = useConfirm();
  const [name, setName] = useState<I18nText>(type?.name ?? {});
  const [key, setKey] = useState('');
  const [icon, setIcon] = useState(type?.icon ?? 'package');
  const [serial, setSerial] = useState(type?.tracksSerial ?? true);
  const [active, setActive] = useState(type?.isActive ?? true);
  const [rows, setRows] = useState<AttrRow[]>(() => (type?.attributes ?? []).slice().sort((a, b) => a.sortOrder - b.sortOrder).map((a) => ({ attributeId: a.attributeId, inLotLine: a.inLotLine, requiredOnLot: a.requiredOnLot, requiredOnTest: a.requiredOnTest, isActive: a.isActive, suggestCatalogId: a.suggestCatalogId ?? null, catalogId: a.catalogId ?? null })));
  const [add, setAdd] = useState('');
  const [busy, setBusy] = useState(false);
  const free = meta.data.attributes.filter((a) => a.isActive && !rows.some((r) => r.attributeId === a.id));
  const patch = (i: number, p: Partial<AttrRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const move = (i: number, d: -1 | 1) => setRows((rs) => { const n = [...rs]; const j = i + d; if (j < 0 || j >= n.length) return rs; [n[i], n[j]] = [n[j], n[i]]; return n; });

  async function save() {
    setBusy(true);
    try {
      const body = { name: completeI18n(name), icon, tracksSerial: serial, attributes: rows };
      if (type) await api.put(`/equipment-types/${type.id}`, { ...body, isActive: active });
      else await api.post('/equipment-types', { ...body, key: key || slug(name.es ?? name.en ?? '') });
      await reload(); toast.success(t('common.saved')); onClose();
    } catch (e) { toast.error(err(e)); } finally { setBusy(false); }
  }
  async function del() {
    if (!type || !(await confirm({ title: t('equipment.delete_type_title'), message: t('equipment.delete_type_msg'), danger: true, confirmLabel: t('common.delete') }))) return;
    try { await api.del(`/equipment-types/${type.id}`); await reload(); toast.success(t('common.deleted')); onClose(); } catch (e) { toast.error(err(e)); }
  }
  return (
    <Modal open onClose={onClose} size="xl" title={type ? t('equipment.edit_type') : t('equipment.new_type')}
      footer={<>
        {type && !type.isSystem && <Button variant="ghost" icon={<Trash2 size={14} />} onClick={del} style={{ marginRight: 'auto' }}>{t('common.delete')}</Button>}
        <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" loading={busy} disabled={!i18nValid(name)} onClick={save}>{t('common.save')}</Button>
      </>}>
      <div className="stack">
        <div className="grid grid-2">
          <I18nInput label={t('common.name')} value={name} onChange={setName} required autoFocus />
          <div className="stack">
            {!type && <Field label={t('common.key')} hint={t('catalogs.key_hint')}><Input value={key} placeholder={slug(name.es ?? name.en ?? '')} onChange={(e) => setKey(e.target.value)} /></Field>}
            <Field label={t('equipment.icon')}>
              <div className="row wrap gap-sm">
                {iconNames.map((n) => <button key={n} type="button" className={`btn btn-sm ${icon === n ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setIcon(n)}><TypeIcon icon={n} size={16} /></button>)}
              </div>
            </Field>
            <Checkbox checked={serial} onChange={setSerial} label={t('equipment.serial_required')} />
            {type && <Checkbox checked={active} onChange={setActive} label={t('common.active')} />}
          </div>
        </div>
        <div>
          <div className="section-title">{t('equipment.attributes')}</div>
          <p className="muted" style={{ marginBottom: 8 }}>{t('equipment.attributes_hint')}</p>
          {rows.length > 0 && (
            <div className="table-wrap"><table className="table m-stack">
              <thead><tr><th style={{ width: 60 }} /><th>{t('equipment.attribute')}</th><th>{t('equipment.in_lot_line')}</th><th>{t('equipment.required_on_lot')}</th><th>{t('equipment.required_on_test')}</th><th>{t('common.active')}</th><th /></tr></thead>
              <tbody>
                {rows.map((r, i) => {
                  const a = meta.attr(r.attributeId);
                  return (
                    <tr key={r.attributeId}>
                      <td className="m-order"><span className="row gap-sm"><button className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={14} /></button><button className="icon-btn" disabled={i === rows.length - 1} onClick={() => move(i, 1)}><ArrowDown size={14} /></button></span></td>
                      <td className="m-primary"><strong>{a ? meta.label(a.label) : r.attributeId}</strong><div className="sub">{a && t(`equipment.datatype.${a.dataType}`)}</div>
                        {a?.dataType === 'text' && (
                          <Select aria-label={t('equipment.suggest_list')} title={t('equipment.suggest_hint')} value={r.suggestCatalogId ?? ''} style={{ marginTop: 4, maxWidth: 260 }}
                            onChange={(e) => patch(i, { suggestCatalogId: e.target.value ? Number(e.target.value) : null })}>
                            <option value="">{t('equipment.suggest_none')}</option>
                            {meta.data.catalogs.map((c) => <option key={c.id} value={c.id}>{t('equipment.suggest_from', { name: meta.label(c.name) })}</option>)}
                          </Select>
                        )}
                        {a?.dataType === 'select' && a.catalogId && (
                          <Select aria-label={t('equipment.type_list')} title={t('equipment.type_list_hint')} value={r.catalogId ?? ''} style={{ marginTop: 4, maxWidth: 260 }}
                            onChange={(e) => patch(i, { catalogId: e.target.value ? Number(e.target.value) : null })}>
                            <option value="">{t('equipment.type_list_general', { name: meta.label(meta.catalogById(a.catalogId)?.name) })}</option>
                            {meta.data.catalogs.filter((c) => c.id !== a.catalogId && c.parentCatalogId === (meta.catalogById(a.catalogId)?.parentCatalogId ?? null)).map((c) => <option key={c.id} value={c.id}>{meta.label(c.name)}</option>)}
                          </Select>
                        )}</td>
                      <td data-label={t('equipment.in_lot_line')}><input type="checkbox" checked={r.inLotLine} onChange={(e) => patch(i, { inLotLine: e.target.checked, requiredOnLot: e.target.checked ? r.requiredOnLot : false })} /></td>
                      <td data-label={t('equipment.required_on_lot')}><input type="checkbox" checked={r.requiredOnLot} disabled={!r.inLotLine} onChange={(e) => patch(i, { requiredOnLot: e.target.checked })} /></td>
                      <td data-label={t('equipment.required_on_test')}><input type="checkbox" checked={r.requiredOnTest} onChange={(e) => patch(i, { requiredOnTest: e.target.checked })} /></td>
                      <td data-label={t('common.active')}><input type="checkbox" checked={r.isActive} onChange={(e) => patch(i, { isActive: e.target.checked })} /></td>
                      <td className="cell-actions"><button className="icon-btn" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}><Trash2 size={16} /></button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>
          )}
          <div className="row" style={{ marginTop: 10 }}>
            <Select value={add} onChange={(e) => setAdd(e.target.value)} style={{ maxWidth: 320 }}>
              <option value="">{t('equipment.add_attribute')}</option>
              {free.map((a) => <option key={a.id} value={a.id}>{meta.label(a.label)}</option>)}
            </Select>
            <Button disabled={!add} icon={<Plus size={14} />} onClick={() => { setRows((rs) => [...rs, { attributeId: Number(add), inLotLine: false, requiredOnLot: false, requiredOnTest: false, isActive: true, suggestCatalogId: null, catalogId: null }]); setAdd(''); }}>{t('common.add')}</Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
function AttrsTab() {
  const { t } = useTranslation();
  const meta = useMeta();
  const { can } = useAuth();
  const [modal, setModal] = useState<{ attr?: Attribute } | null>(null);
  const manage = can('equipment.manage');
  return (
    <>
      <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 12 }}>
        {manage && <Button variant="primary" icon={<Plus size={16} />} onClick={() => setModal({})}>{t('equipment.new_attr')}</Button>}
      </div>
      <Card padded={false}>
        {meta.data.attributes.length === 0 ? <Empty title={t('common.empty')} /> : (
          <div className="table-wrap"><table className="table m-stack">
            <thead><tr><th>{t('common.name')}</th><th>{t('common.key')}</th><th>{t('common.type')}</th><th>{t('equipment.catalog')}</th><th>{t('common.unit')}</th><th /></tr></thead>
            <tbody>
              {meta.data.attributes.map((a) => (
                <tr key={a.id} style={a.isActive ? undefined : { opacity: 0.55 }}>
                  <td className="m-primary"><strong>{meta.label(a.label)}</strong>{!a.isActive && <> <Badge>{t('common.inactive')}</Badge></>}</td>
                  <td className="mono" data-label={t('common.key')}>{a.key}</td>
                  <td data-label={t('common.type')}>{t(`equipment.datatype.${a.dataType}`)}</td>
                  <td data-label={t('equipment.catalog')}>{a.catalogId ? meta.label(meta.data.catalogs.find((c) => c.id === a.catalogId)?.name) : <span className="muted">—</span>}</td>
                  <td data-label={t('common.unit')}>{a.unit ?? <span className="muted">—</span>}</td>
                  <td className="cell-actions">{manage && <button className="icon-btn" onClick={() => setModal({ attr: a })}><Pencil size={16} /></button>}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </Card>
      {modal && <AttrModal attr={modal.attr} onClose={() => setModal(null)} />}
    </>
  );
}

function AttrModal({ attr, onClose }: { attr?: Attribute; onClose: () => void }) {
  const { t } = useTranslation();
  const meta = useMeta();
  const reload = useReloadMeta();
  const err = useErr();
  const toast = useToast();
  const confirm = useConfirm();
  const [label, setLabel] = useState<I18nText>(attr?.label ?? {});
  const [key, setKey] = useState('');
  const [dataType, setDataType] = useState<Attribute['dataType']>(attr?.dataType ?? 'text');
  const [catalogId, setCatalogId] = useState(attr?.catalogId ? String(attr.catalogId) : '');
  const [unit, setUnit] = useState(attr?.unit ?? '');
  const [active, setActive] = useState(attr?.isActive ?? true);
  const [busy, setBusy] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const isSel = dataType === 'select' || dataType === 'multiselect';
  async function save() {
    setBusy(true);
    try {
      if (attr) await api.patch(`/attributes/${attr.id}`, { label: completeI18n(label), unit: unit.trim() || null, isActive: active });
      else await api.post('/attributes', { key: key || slug(label.es ?? label.en ?? ''), label: completeI18n(label), dataType, catalogId: isSel ? Number(catalogId) : null, unit: dataType === 'number' ? unit.trim() || null : null });
      await reload(); toast.success(t('common.saved')); onClose();
    } catch (e) { toast.error(err(e)); } finally { setBusy(false); }
  }
  /** Único cambio de tipo de dato permitido después de creado: de un solo valor a varios (p. ej. para poder cargar dos discos duros). No se pierde nada ya guardado. */
  async function enableMultiple() {
    if (!attr) return;
    if (!(await confirm({ title: t('equipment.enable_multiple_title'), message: t('equipment.enable_multiple_confirm', { name: meta.label(attr.label) }) }))) return;
    setEnabling(true);
    try {
      await api.post(`/attributes/${attr.id}/enable-multiple`, {});
      await reload();
      setDataType('multiselect');
      toast.success(t('equipment.enable_multiple_done'));
    } catch (e) { toast.error(err(e)); } finally { setEnabling(false); }
  }
  return (
    <Modal open onClose={onClose} size="md" title={attr ? t('equipment.edit_attr') : t('equipment.new_attr')}
      footer={<><Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} disabled={!i18nValid(label) || (isSel && !catalogId)} onClick={save}>{t('common.save')}</Button></>}>
      <div className="stack">
        <I18nInput label={t('common.name')} value={label} onChange={setLabel} required autoFocus />
        {!attr && <Field label={t('common.key')} hint={t('catalogs.key_hint')}><Input value={key} placeholder={slug(label.es ?? label.en ?? '')} onChange={(e) => setKey(e.target.value)} /></Field>}
        <Field label={t('common.type')} hint={attr ? t('equipment.datatype_locked') : undefined}>
          <Select value={dataType} disabled={!!attr} onChange={(e) => setDataType(e.target.value as Attribute['dataType'])}>
            {(['text', 'number', 'boolean', 'date', 'select', 'multiselect'] as const).map((d) => <option key={d} value={d}>{t(`equipment.datatype.${d}`)}</option>)}
          </Select>
        </Field>
        {attr && dataType === 'select' && (
          <div className="alert alert-info stack sm">
            <span>{t('equipment.enable_multiple_hint')}</span>
            <div><Button size="sm" loading={enabling} onClick={enableMultiple}>{t('equipment.enable_multiple_action')}</Button></div>
          </div>
        )}
        {isSel && (
          <Field label={t('equipment.catalog')} required>
            <Select value={catalogId} disabled={!!attr} onChange={(e) => setCatalogId(e.target.value)}>
              <option value="">{t('common.select')}</option>{meta.data.catalogs.map((c) => <option key={c.id} value={c.id}>{meta.label(c.name)}</option>)}
            </Select>
          </Field>
        )}
        {dataType === 'number' && <Field label={t('common.unit')} hint={t('equipment.unit_hint')}><Input value={unit} onChange={(e) => setUnit(e.target.value)} style={{ width: 120 }} /></Field>}
        {attr && <Checkbox checked={active} onChange={setActive} label={t('common.active')} />}
      </div>
    </Modal>
  );
}
