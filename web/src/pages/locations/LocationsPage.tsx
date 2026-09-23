import { Fragment, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Building, ChevronDown, ChevronRight, Grid3x3, MapPin, Pencil, Plus, SlidersHorizontal, Sparkles, Trash2, Warehouse } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useMeta } from '../../lib/meta';
import { Badge, Button, Card, Checkbox, Empty, Field, Input, Modal, PageHeader, Progress, Select, Spinner, Textarea, useConfirm, useErr, useToast } from '../../components/ui';
import { Grades, SpecChips, TypeLabel } from '../../components/fields';
import { DetailBack } from '../../components/mobile/DetailBack';
import { PlaceUnitsModal } from '../../components/PlaceUnitsModal';
import { LevelRuleEditor, cloneRule, emptyRule, isEmptyRule, useRuleSummary, type LevelRule } from '../../components/LevelRuleEditor';

interface Slot { id: number; rackId: number; levelNo: number; slotNo: number; code: string; capacity: number; isActive: boolean; occupied: number }
interface Rack { id: number; areaId: number; code: string; name: string | null; notes: string | null; isActive: boolean; capacity: number; occupied: number; levels: { levelNo: number; slots: Slot[]; rule: LevelRule | null }[] }
interface Area { id: number; warehouseId: number; code: string; name: string; description: string | null; isActive: boolean; preferredTypeIds: number[]; capacity: number; occupied: number; racks: Rack[] }
interface Wh { id: number; code: string; name: string; address: string | null; isActive: boolean; capacity: number; occupied: number; areas: Area[] }
type Sel = { kind: 'wh' | 'area' | 'rack'; id: number } | null;

const Occ = ({ occupied, capacity }: { occupied: number; capacity: number }) => (
  <span className="occupancy">
    <Progress value={occupied} max={capacity} tone={capacity && occupied / capacity >= 1 ? 'bad' : capacity && occupied / capacity > 0.8 ? 'warn' : 'good'} />
    <span className="sub nowrap">{occupied}/{capacity}</span>
  </span>
);

export default function LocationsPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const err = useErr();
  const toast = useToast();
  const manage = can('locations.manage');
  const [sel, setSel] = useState<Sel>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [modal, setModal] = useState<{ kind: 'wh' | 'area' | 'rack'; item?: any; parent?: number } | null>(null);
  const [placeIds, setPlaceIds] = useState<number[] | null>(null);

  const tree = useQuery({ queryKey: ['locations', 'tree'], queryFn: () => api.get<{ warehouses: Wh[] }>('/locations/tree') });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['locations'] }); void qc.invalidateQueries({ queryKey: ['units'] }); void qc.invalidateQueries({ queryKey: ['slots'] }); };

  const whs = tree.data?.warehouses ?? [];
  const found = useMemo(() => {
    if (!sel) return null;
    for (const w of whs) {
      if (sel.kind === 'wh' && w.id === sel.id) return { wh: w };
      for (const a of w.areas) {
        if (sel.kind === 'area' && a.id === sel.id) return { wh: w, area: a };
        for (const r of a.racks) if (sel.kind === 'rack' && r.id === sel.id) return { wh: w, area: a, rack: r };
      }
    }
    return null;
  }, [sel, whs]);

  const toggle = (k: string) => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  async function placeUnplaced() {
    try {
      const r = await api.get<{ items: { id: number; statusKey: string }[] }>('/units?placed=no&pageSize=200&sort=oldest');
      const ids = r.items.filter((u) => u.statusKey !== 'sold').map((u) => u.id);
      if (!ids.length) { toast.info(t('locations.nothing_to_place')); return; }
      setPlaceIds(ids);
    } catch (e) { toast.error(err(e)); }
  }

  if (tree.isLoading) return <Spinner />;

  return (
    <>
      <PageHeader title={t('locations.title')} subtitle={t('locations.subtitle')}
        actions={<>
          {can('locations.assign') && <Button icon={<Sparkles size={16} />} onClick={placeUnplaced}>{t('locations.place_unplaced')}</Button>}
          {manage && <Button variant="primary" icon={<Plus size={16} />} onClick={() => setModal({ kind: 'wh' })}>{t('locations.new_warehouse')}</Button>}
        </>} />
      {whs.length === 0 ? (
        <Card><Empty icon={<Warehouse size={32} />} title={t('locations.empty')} hint={manage ? t('locations.empty_hint') : undefined}
          action={manage ? <Button variant="primary" onClick={() => setModal({ kind: 'wh' })}>{t('locations.new_warehouse')}</Button> : undefined} /></Card>
      ) : (
        <div className="grid md" data-detail={found ? '1' : '0'} style={{ gridTemplateColumns: 'minmax(260px, 1fr) minmax(0, 2.4fr)', alignItems: 'start' }}>
          <Card padded={false} title={t('locations.structure')} className="md-master">
            <div style={{ padding: 8 }}>
              {whs.map((w) => (
                <div key={w.id}>
                  <div className={`nav-link ${sel?.kind === 'wh' && sel.id === w.id ? 'active' : ''}`} style={{ cursor: 'pointer' }} onClick={() => { setSel({ kind: 'wh', id: w.id }); setOpen((s) => new Set(s).add(`w${w.id}`)); }}>
                    <span onClick={(e) => { e.stopPropagation(); toggle(`w${w.id}`); }} style={{ display: 'inline-flex' }}>{open.has(`w${w.id}`) ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</span>
                    <Warehouse size={16} /><span className="grow truncate">{w.name}</span>{!w.isActive && <Badge>{t('common.inactive')}</Badge>}<span className="sub">{w.occupied}/{w.capacity}</span>
                  </div>
                  {open.has(`w${w.id}`) && (
                    <div className="tree-node">
                      {w.areas.map((a) => (
                        <div key={a.id}>
                          <div className={`nav-link ${sel?.kind === 'area' && sel.id === a.id ? 'active' : ''}`} style={{ cursor: 'pointer' }} onClick={() => { setSel({ kind: 'area', id: a.id }); setOpen((s) => new Set(s).add(`a${a.id}`)); }}>
                            <span onClick={(e) => { e.stopPropagation(); toggle(`a${a.id}`); }} style={{ display: 'inline-flex' }}>{open.has(`a${a.id}`) ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</span>
                            <Building size={16} /><span className="grow truncate">{a.name}</span>{!a.isActive && <Badge>{t('common.inactive')}</Badge>}<span className="sub">{a.occupied}/{a.capacity}</span>
                          </div>
                          {open.has(`a${a.id}`) && (
                            <div className="tree-node">
                              {a.racks.map((r) => (
                                <div key={r.id} className={`nav-link ${sel?.kind === 'rack' && sel.id === r.id ? 'active' : ''}`} style={{ cursor: 'pointer' }} onClick={() => setSel({ kind: 'rack', id: r.id })}>
                                  <Grid3x3 size={16} /><span className="grow truncate">{r.code}{r.name ? ` · ${r.name}` : ''}</span>{!r.isActive && <Badge>{t('common.inactive')}</Badge>}<span className="sub">{r.occupied}/{r.capacity}</span>
                                </div>
                              ))}
                              {manage && <button className="btn btn-ghost btn-sm" onClick={() => setModal({ kind: 'rack', parent: a.id })}><Plus size={14} />{t('locations.new_rack')}</button>}
                            </div>
                          )}
                        </div>
                      ))}
                      {manage && <button className="btn btn-ghost btn-sm" onClick={() => setModal({ kind: 'area', parent: w.id })}><Plus size={14} />{t('locations.new_area')}</button>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Card>

          <div className="md-detail">
            <DetailBack onClick={() => setSel(null)}>{t('locations.structure')}</DetailBack>
            {!found ? <Card><Empty icon={<MapPin size={32} />} title={t('locations.pick')} hint={t('locations.pick_hint')} /></Card>
              : found.rack ? <RackView rack={found.rack} area={found.area!} wh={found.wh} manage={manage} onEdit={() => setModal({ kind: 'rack', item: found.rack, parent: found.area!.id })} onChanged={refresh} onDeleted={() => { setSel(null); refresh(); }} />
              : found.area ? <AreaView area={found.area} wh={found.wh} manage={manage} onSelectRack={(id) => setSel({ kind: 'rack', id })} onAddRack={() => setModal({ kind: 'rack', parent: found.area!.id })} onEdit={() => setModal({ kind: 'area', item: found.area, parent: found.wh.id })} onDeleted={() => { setSel(null); refresh(); }} />
              : <WhView wh={found.wh} manage={manage} onSelectArea={(id) => { setSel({ kind: 'area', id }); }} onAddArea={() => setModal({ kind: 'area', parent: found.wh.id })} onEdit={() => setModal({ kind: 'wh', item: found.wh })} onDeleted={() => { setSel(null); refresh(); }} />}
          </div>
        </div>
      )}
      {modal?.kind === 'wh' && <WarehouseModal item={modal.item} onClose={() => setModal(null)} onSaved={refresh} />}
      {modal?.kind === 'area' && <AreaModal item={modal.item} warehouses={whs} defaultWh={modal.parent} onClose={() => setModal(null)} onSaved={refresh} />}
      {modal?.kind === 'rack' && <RackModal item={modal.item} areas={whs.flatMap((w) => w.areas.map((a) => ({ ...a, whName: w.name })))} defaultArea={modal.parent} onClose={() => setModal(null)} onSaved={refresh} />}
      {placeIds && <PlaceUnitsModal unitIds={placeIds} onClose={() => setPlaceIds(null)} onDone={refresh} />}
    </>
  );
}

// ---------------------------------------------------------------------------
function Header({ icon, title, sub, onEdit, onDelete, manage }: { icon: React.ReactNode; title: string; sub?: React.ReactNode; onEdit: () => void; onDelete: () => void; manage: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="row spread" style={{ marginBottom: 12 }}>
      <div className="row">{icon}<div><h3>{title}</h3>{sub && <div className="muted">{sub}</div>}</div></div>
      {manage && <div className="row gap-sm"><Button size="sm" icon={<Pencil size={14} />} onClick={onEdit}>{t('common.edit')}</Button><Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={onDelete} aria-label={t('common.delete')} /></div>}
    </div>
  );
}

function useDelete(path: string, onDeleted: () => void) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const err = useErr();
  const toast = useToast();
  return async () => {
    if (!(await confirm({ title: t('locations.confirm_delete'), message: t('locations.confirm_delete_msg'), danger: true, confirmLabel: t('common.delete') }))) return;
    try { await api.del(path); toast.success(t('common.deleted')); onDeleted(); } catch (e) { toast.error(err(e)); }
  };
}

function WhView({ wh, manage, onSelectArea, onAddArea, onEdit, onDeleted }: { wh: Wh; manage: boolean; onSelectArea: (id: number) => void; onAddArea: () => void; onEdit: () => void; onDeleted: () => void }) {
  const { t } = useTranslation();
  const del = useDelete(`/warehouses/${wh.id}`, onDeleted);
  return (
    <Card>
      <Header icon={<Warehouse size={22} />} title={`${wh.code} — ${wh.name}`} sub={wh.address} onEdit={onEdit} onDelete={del} manage={manage} />
      <Occ occupied={wh.occupied} capacity={wh.capacity} />
      <div className="section-title" style={{ marginTop: 16 }}>{t('locations.areas')}</div>
      {wh.areas.length === 0 ? <p className="muted">{t('locations.no_areas')}</p> : (
        <div className="grid grid-auto">
          {wh.areas.map((a) => (
            <button key={a.id} className="slot" onClick={() => onSelectArea(a.id)}><strong>{a.name}</strong><small>{a.code} · {a.racks.length} {t('locations.racks').toLowerCase()}</small><Occ occupied={a.occupied} capacity={a.capacity} /></button>
          ))}
        </div>
      )}
      {manage && <div style={{ marginTop: 12 }}><Button size="sm" icon={<Plus size={14} />} onClick={onAddArea}>{t('locations.new_area')}</Button></div>}
    </Card>
  );
}

function AreaView({ area, wh, manage, onSelectRack, onAddRack, onEdit, onDeleted }: { area: Area; wh: Wh; manage: boolean; onSelectRack: (id: number) => void; onAddRack: () => void; onEdit: () => void; onDeleted: () => void }) {
  const { t } = useTranslation();
  const del = useDelete(`/areas/${area.id}`, onDeleted);
  return (
    <Card>
      <Header icon={<Building size={22} />} title={`${area.code} — ${area.name}`} sub={`${wh.name}${area.description ? ' · ' + area.description : ''}`} onEdit={onEdit} onDelete={del} manage={manage} />
      <Occ occupied={area.occupied} capacity={area.capacity} />
      <div className="section-title" style={{ marginTop: 16 }}>{t('locations.preferred_types')}</div>
      <div className="tag-list">{area.preferredTypeIds.length ? area.preferredTypeIds.map((id) => <Badge key={id}><TypeLabel typeId={id} /></Badge>) : <span className="muted">{t('locations.no_preferred')}</span>}</div>
      <div className="section-title" style={{ marginTop: 16 }}>{t('locations.racks')}</div>
      {area.racks.length === 0 ? <p className="muted">{t('locations.no_racks')}</p> : (
        <div className="grid grid-auto">
          {area.racks.map((r) => (
            <button key={r.id} className={`slot ${r.isActive ? '' : 'inactive'}`} onClick={() => onSelectRack(r.id)}><strong>{r.code}</strong><small>{r.name ?? ''} · {r.levels.length} {t('locations.levels').toLowerCase()}</small><Occ occupied={r.occupied} capacity={r.capacity} /></button>
          ))}
        </div>
      )}
      {manage && <div style={{ marginTop: 12 }}><Button size="sm" icon={<Plus size={14} />} onClick={onAddRack}>{t('locations.new_rack')}</Button></div>}
    </Card>
  );
}

function RackView({ rack, area, wh, manage, onEdit, onChanged, onDeleted }: { rack: Rack; area: Area; wh: Wh; manage: boolean; onEdit: () => void; onChanged: () => void; onDeleted: () => void }) {
  const { t } = useTranslation();
  const del = useDelete(`/racks/${rack.id}`, onDeleted);
  const [slot, setSlot] = useState<Slot | null>(null);
  const summary = useRuleSummary();
  const ruled = rack.levels.filter((l) => l.rule && !isEmptyRule(l.rule));
  return (
    <Card>
      <Header icon={<Grid3x3 size={22} />} title={`${rack.code}${rack.name ? ' — ' + rack.name : ''}`} sub={`${wh.name} › ${area.name}`} onEdit={onEdit} onDelete={del} manage={manage} />
      <Occ occupied={rack.occupied} capacity={rack.capacity} />
      {rack.notes && <p className="muted" style={{ marginTop: 8 }}>{rack.notes}</p>}
      {rack.levels.length === 0 ? <p className="muted" style={{ marginTop: 12 }}>{t('locations.no_slots')}</p> : (
        <div className="rack-view" style={{ marginTop: 16 }}>
          {rack.levels.map((lv) => (
            <div key={lv.levelNo} className="rack-level">
              <div className="rack-level-label" title={summary(lv.rule)}>{lv.levelNo}</div>
              {lv.slots.map((s) => (
                <button key={s.id} className={`slot ${!s.isActive ? 'inactive' : s.occupied >= s.capacity ? 'full' : s.occupied > 0 ? 'some' : 'empty-slot'}`} onClick={() => setSlot(s)}>
                  <strong>{lv.levelNo}-{s.slotNo}</strong><small>{s.occupied}/{s.capacity}</small>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
      {ruled.length > 0 && (
        <div className="stack sm" style={{ marginTop: 12 }}>
          <div className="section-title">{t('locations.rule.title')}</div>
          {ruled.map((l) => <div key={l.levelNo} className="sub"><strong>{t('locations.level')} {l.levelNo}:</strong> {summary(l.rule)}</div>)}
        </div>
      )}
      <div className="row gap-sm wrap sub" style={{ marginTop: 12 }}>
        <span className="chip" style={{ background: 'var(--surface-2)' }}>{t('locations.legend_empty')}</span>
        <span className="chip" style={{ background: 'var(--warn-soft)' }}>{t('locations.legend_some')}</span>
        <span className="chip" style={{ background: 'var(--danger-soft)' }}>{t('locations.legend_full')}</span>
      </div>
      {slot && <SlotModal slot={rack.levels.flatMap((l) => l.slots).find((s) => s.id === slot.id) ?? slot} manage={manage} onClose={() => setSlot(null)} onChanged={onChanged} />}
    </Card>
  );
}

function SlotModal({ slot, manage, onClose, onChanged }: { slot: Slot; manage: boolean; onClose: () => void; onChanged: () => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const err = useErr();
  const toast = useToast();
  const [cap, setCap] = useState(String(slot.capacity));
  const units = useQuery({ queryKey: ['units', { slotId: slot.id }], queryFn: () => api.get<{ items: any[] }>(`/units?slotId=${slot.id}&pageSize=100`) });

  async function patch(p: object) {
    try { await api.patch(`/slots/${slot.id}`, p); toast.success(t('common.saved')); onChanged(); } catch (e) { toast.error(err(e)); }
  }
  async function remove(id: number) {
    try { await api.post('/locations/unassign', { unitIds: [id] }); onChanged(); void units.refetch(); } catch (e) { toast.error(err(e)); }
  }
  return (
    <Modal open onClose={onClose} title={<span className="mono">{slot.code}</span>}
      footer={<Button onClick={onClose}>{t('common.close')}</Button>}>
      <div className="stack">
        <div className="row wrap">
          <Field label={t('locations.capacity')}><Input type="number" min={1} value={cap} onChange={(e) => setCap(e.target.value)} disabled={!manage} style={{ width: 120 }} /></Field>
          {manage && <Button disabled={Number(cap) === slot.capacity || !Number(cap)} onClick={() => patch({ capacity: Number(cap) })}>{t('common.save')}</Button>}
          {manage && <Checkbox checked={slot.isActive} onChange={(v) => patch({ isActive: v })} label={t('common.active')} />}
        </div>
        <div className="section-title">{t('locations.units_here', { count: slot.occupied })}</div>
        {units.isLoading ? <Spinner /> : units.data?.items.length === 0 ? <p className="muted">{t('locations.slot_empty')}</p> : (
          <div className="table-wrap"><table className="table m-stack"><tbody>
            {units.data?.items.map((u) => (
              <tr key={u.id}>
                <td className="m-primary"><Link to={`/units/${u.id}`} className="mono"><strong>{u.code}</strong></Link></td>
                <td><SpecChips typeId={u.equipmentTypeId} specs={u.specs} /></td>
                <td><Grades cosmeticId={u.cosmeticGradeId} functionalId={u.functionalGradeId} /></td>
                <td className="cell-actions">{can('locations.assign') && <Button size="sm" variant="ghost" onClick={() => remove(u.id)}>{t('units.unassign')}</Button>}</td>
              </tr>
            ))}
          </tbody></table></div>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
function WarehouseModal({ item, onClose, onSaved }: { item?: Wh; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const err = useErr();
  const toast = useToast();
  const [code, setCode] = useState(item?.code ?? '');
  const [name, setName] = useState(item?.name ?? '');
  const [address, setAddress] = useState(item?.address ?? '');
  const [active, setActive] = useState(item?.isActive ?? true);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      const body = { code: code.trim(), name: name.trim(), address: address.trim() || null, isActive: active };
      if (item) await api.put(`/warehouses/${item.id}`, body); else await api.post('/warehouses', body);
      toast.success(t('common.saved')); onSaved(); onClose();
    } catch (e) { toast.error(err(e)); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} size="sm" title={item ? t('locations.edit_warehouse') : t('locations.new_warehouse')}
      footer={<><Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} disabled={!code.trim() || !name.trim()} onClick={save}>{t('common.save')}</Button></>}>
      <div className="stack">
        <Field label={t('common.code')} required hint={t('locations.code_hint')}><Input value={code} onChange={(e) => setCode(e.target.value)} autoFocus /></Field>
        <Field label={t('common.name')} required><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label={t('common.address')}><Input value={address} onChange={(e) => setAddress(e.target.value)} /></Field>
        {item && <Checkbox checked={active} onChange={setActive} label={t('common.active')} />}
      </div>
    </Modal>
  );
}

function AreaModal({ item, warehouses, defaultWh, onClose, onSaved }: { item?: Area; warehouses: Wh[]; defaultWh?: number; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const meta = useMeta();
  const err = useErr();
  const toast = useToast();
  const [whId, setWhId] = useState(String(item?.warehouseId ?? defaultWh ?? warehouses[0]?.id ?? ''));
  const [code, setCode] = useState(item?.code ?? '');
  const [name, setName] = useState(item?.name ?? '');
  const [desc, setDesc] = useState(item?.description ?? '');
  const [prefs, setPrefs] = useState<number[]>(item?.preferredTypeIds ?? []);
  const [active, setActive] = useState(item?.isActive ?? true);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      const body = { warehouseId: Number(whId), code: code.trim(), name: name.trim(), description: desc.trim() || null, preferredTypeIds: prefs, isActive: active };
      if (item) await api.put(`/areas/${item.id}`, body); else await api.post('/areas', body);
      toast.success(t('common.saved')); onSaved(); onClose();
    } catch (e) { toast.error(err(e)); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title={item ? t('locations.edit_area') : t('locations.new_area')}
      footer={<><Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} disabled={!code.trim() || !name.trim() || !whId} onClick={save}>{t('common.save')}</Button></>}>
      <div className="stack">
        <Field label={t('locations.warehouse')} required><Select value={whId} onChange={(e) => setWhId(e.target.value)}>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select></Field>
        <div className="grid grid-2">
          <Field label={t('common.code')} required hint={t('locations.code_hint')}><Input value={code} onChange={(e) => setCode(e.target.value)} autoFocus /></Field>
          <Field label={t('common.name')} required><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        </div>
        <Field label={t('common.description')}><Textarea value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
        <Field label={t('locations.preferred_types')} hint={t('locations.preferred_hint')}>
          <div className="row wrap gap-sm">
            {meta.typeList().map((ty) => <Checkbox key={ty.id} checked={prefs.includes(ty.id)} label={meta.label(ty.name)} onChange={(c) => setPrefs((p) => (c ? [...p, ty.id] : p.filter((x) => x !== ty.id)))} />)}
          </div>
        </Field>
        {item && <Checkbox checked={active} onChange={setActive} label={t('common.active')} />}
      </div>
    </Modal>
  );
}

function RackModal({ item, areas, defaultArea, onClose, onSaved }: { item?: Rack; areas: (Area & { whName: string })[]; defaultArea?: number; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const err = useErr();
  const toast = useToast();
  const [areaId, setAreaId] = useState(String(item?.areaId ?? defaultArea ?? areas[0]?.id ?? ''));
  const [code, setCode] = useState(item?.code ?? '');
  const [name, setName] = useState(item?.name ?? '');
  const [notes, setNotes] = useState(item?.notes ?? '');
  const [active, setActive] = useState(item?.isActive ?? true);
  type Lv = { slots: string; capacity: string; rule: LevelRule };
  const [levels, setLevels] = useState<Lv[]>(
    item?.levels.length ? item.levels.map((l) => ({ slots: String(l.slots.length), capacity: String(l.slots[0]?.capacity ?? 10), rule: l.rule ? cloneRule(l.rule) : emptyRule() }))
      : [1, 2, 3].map(() => ({ slots: '4', capacity: '10', rule: emptyRule() })),
  );
  const [ruleOpen, setRuleOpen] = useState<number | null>(null);
  const summary = useRuleSummary();
  const [gen, setGen] = useState({ levels: '3', slots: '4', capacity: '10' });
  const [busy, setBusy] = useState(false);
  const total = levels.reduce((a, l) => a + (Number(l.slots) || 0) * (Number(l.capacity) || 0), 0);

  async function save() {
    setBusy(true);
    try {
      const layout = { levels: levels.map((l) => ({ slots: Math.max(1, Math.floor(Number(l.slots) || 1)), capacity: Math.max(1, Math.floor(Number(l.capacity) || 1)), rule: isEmptyRule(l.rule) ? null : l.rule })) };
      const body = { areaId: Number(areaId), code: code.trim(), name: name.trim() || null, notes: notes.trim() || null, isActive: active, layout };
      if (item) await api.put(`/racks/${item.id}`, body); else await api.post('/racks', body);
      toast.success(t('common.saved')); onSaved(); onClose();
    } catch (e) { toast.error(err(e)); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} size="lg" title={item ? t('locations.edit_rack') : t('locations.new_rack')}
      footer={<><Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} disabled={!code.trim() || !areaId || !levels.length} onClick={save}>{t('common.save')}</Button></>}>
      <div className="stack">
        <Field label={t('locations.area')} required>
          <Select value={areaId} onChange={(e) => setAreaId(e.target.value)}>{areas.map((a) => <option key={a.id} value={a.id}>{a.whName} › {a.name}</option>)}</Select>
        </Field>
        <div className="grid grid-2">
          <Field label={t('common.code')} required hint={t('locations.code_hint')}><Input value={code} onChange={(e) => setCode(e.target.value)} autoFocus /></Field>
          <Field label={t('common.name')}><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        </div>
        <Field label={t('common.notes')}><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>

        <div>
          <div className="section-title">{t('locations.layout')}</div>
          <p className="muted" style={{ marginBottom: 8 }}>{t('locations.layout_hint')}</p>
          <div className="row wrap" style={{ marginBottom: 12 }}>
            <Field label={t('locations.levels')}><Input type="number" min={1} max={50} value={gen.levels} onChange={(e) => setGen({ ...gen, levels: e.target.value })} style={{ width: 90 }} /></Field>
            <Field label={t('locations.slots_per_level')}><Input type="number" min={1} max={200} value={gen.slots} onChange={(e) => setGen({ ...gen, slots: e.target.value })} style={{ width: 110 }} /></Field>
            <Field label={t('locations.capacity_per_slot')}><Input type="number" min={1} value={gen.capacity} onChange={(e) => setGen({ ...gen, capacity: e.target.value })} style={{ width: 110 }} /></Field>
            <Button style={{ alignSelf: 'flex-end' }} onClick={() => setLevels(Array.from({ length: Math.min(50, Math.max(1, Number(gen.levels) || 1)) }, (_, i) => ({ slots: gen.slots, capacity: gen.capacity, rule: levels[i]?.rule ?? emptyRule() })))}>{t('locations.generate')}</Button>
          </div>
          <div className="table-wrap"><table className="table m-stack">
            <thead><tr><th>{t('locations.level')}</th><th>{t('locations.slots_per_level')}</th><th>{t('locations.capacity_per_slot')}</th><th>{t('locations.rule.title')}</th><th /></tr></thead>
            <tbody>
              {levels.map((l, i) => (
                <Fragment key={i}>
                  <tr>
                    <td className="m-primary"><strong>{t('locations.level')} {i + 1}</strong></td>
                    <td data-label={t('locations.slots_per_level')}><Input type="number" min={1} max={200} value={l.slots} onChange={(e) => setLevels((ls) => ls.map((x, j) => (j === i ? { ...x, slots: e.target.value } : x)))} style={{ width: 100 }} /></td>
                    <td data-label={t('locations.capacity_per_slot')}><Input type="number" min={1} value={l.capacity} onChange={(e) => setLevels((ls) => ls.map((x, j) => (j === i ? { ...x, capacity: e.target.value } : x)))} style={{ width: 100 }} /></td>
                    <td data-label={t('locations.rule.title')}><Button size="sm" variant={isEmptyRule(l.rule) ? 'ghost' : 'secondary'} icon={<SlidersHorizontal size={14} />} onClick={() => setRuleOpen(ruleOpen === i ? null : i)}>{isEmptyRule(l.rule) ? t('locations.rule.edit') : summary(l.rule)}</Button></td>
                    <td className="cell-actions">{levels.length > 1 && <button className="icon-btn" onClick={() => { setLevels((ls) => ls.filter((_, j) => j !== i)); setRuleOpen(null); }}><Trash2 size={16} /></button>}</td>
                  </tr>
                  {ruleOpen === i && (
                    <tr><td colSpan={5}>
                      <LevelRuleEditor rule={l.rule} onChange={(r) => setLevels((ls) => ls.map((x, j) => (j === i ? { ...x, rule: r } : x)))}
                        onCopyAll={() => setLevels((ls) => ls.map((x) => ({ ...x, rule: cloneRule(l.rule) })))} />
                    </td></tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table></div>
          <div className="row spread" style={{ marginTop: 8 }}>
            <Button size="sm" icon={<Plus size={14} />} onClick={() => setLevels((ls) => [...ls, { ...(ls.at(-1) ?? { slots: '4', capacity: '10', rule: emptyRule() }), rule: cloneRule(ls.at(-1)?.rule ?? emptyRule()) }])}>{t('locations.add_level')}</Button>
            <span className="muted">{t('locations.total_capacity', { count: total })}</span>
          </div>
        </div>
        {item && <Checkbox checked={active} onChange={setActive} label={t('common.active')} />}
      </div>
    </Modal>
  );
}
