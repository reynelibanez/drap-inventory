import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, Lock, Pencil, Plus, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useMeta, useReloadMeta, type Catalog, type CatalogItem } from '../../lib/meta';
import type { I18nText } from '../../lib/i18n';
import { Badge, Button, Card, Checkbox, Empty, Field, Input, Modal, PageHeader, Select, useConfirm, useErr, useToast } from '../../components/ui';
import { I18nInput, completeI18n, i18nValid } from '../../components/I18nInput';
import { DetailBack } from '../../components/mobile/DetailBack';
import { useIsMobile } from '../../lib/useIsMobile';

export default function CatalogsPage() {
  const { t } = useTranslation();
  const meta = useMeta();
  const { can } = useAuth();
  const reload = useReloadMeta();
  const err = useErr();
  const toast = useToast();
  const confirm = useConfirm();
  const manage = can('catalogs.manage');
  const [selKey, setSelKey] = useState<string | null>(null);
  const [catModal, setCatModal] = useState<{ cat?: Catalog } | null>(null);
  const [itemModal, setItemModal] = useState<{ item?: CatalogItem } | null>(null);

  const cats = meta.data.catalogs;
  const mobile = useIsMobile();
  // En escritorio arranca con el primer catálogo abierto; en el teléfono primero se ve la lista.
  useEffect(() => { if (!mobile && !selKey && cats.length) setSelKey(cats[0].key); }, [cats, selKey, mobile]);
  const cat = cats.find((c) => c.key === selKey) ?? null;
  const parentCat = cat?.parentCatalogId ? cats.find((c) => c.id === cat.parentCatalogId) ?? null : null;
  // Catálogos que dependen de otro (modelos → marcas): se puede filtrar por el valor del que dependen.
  const [parentFilter, setParentFilter] = useState<number | null>(null);
  useEffect(() => setParentFilter(null), [selKey]);
  const shown = cat ? (parentFilter ? cat.items.filter((i) => i.parentItemId === parentFilter) : cat.items) : [];
  const parentsUsed = parentCat ? parentCat.items.filter((p) => cat!.items.some((i) => i.parentItemId === p.id)) : [];

  async function move(item: CatalogItem, dir: -1 | 1) {
    if (!cat) return;
    const ids = cat.items.map((i) => i.id);
    // Se mueve respecto al vecino que se está viendo (con el filtro activo, el de la misma marca).
    const pos = shown.findIndex((x) => x.id === item.id); const neighbor = shown[pos + dir];
    if (!neighbor) return;
    const i = ids.indexOf(item.id); const j = ids.indexOf(neighbor.id);
    [ids[i], ids[j]] = [ids[j], ids[i]];
    try { await api.put(`/catalogs/${cat.id}/order`, { ids }); await reload(); } catch (e) { toast.error(err(e)); }
  }
  async function toggleActive(item: CatalogItem) {
    try { await api.patch(`/catalog-items/${item.id}`, { isActive: !item.isActive }); await reload(); } catch (e) { toast.error(err(e)); }
  }
  async function delItem(item: CatalogItem) {
    if (!(await confirm({ title: t('catalogs.delete_item_title'), message: t('catalogs.delete_item_msg'), danger: true, confirmLabel: t('common.delete') }))) return;
    try { await api.del(`/catalog-items/${item.id}`); await reload(); toast.success(t('common.deleted')); } catch (e) { toast.error(err(e)); }
  }
  async function delCat() {
    if (!cat || !(await confirm({ title: t('catalogs.delete_title'), message: t('catalogs.delete_msg'), danger: true, confirmLabel: t('common.delete') }))) return;
    try { await api.del(`/catalogs/${cat.id}`); setSelKey(null); await reload(); toast.success(t('common.deleted')); } catch (e) { toast.error(err(e)); }
  }

  return (
    <>
      <PageHeader title={t('catalogs.title')} subtitle={t('catalogs.subtitle')} actions={manage && <Button variant="primary" icon={<Plus size={16} />} onClick={() => setCatModal({})}>{t('catalogs.new')}</Button>} />
      <div className="grid md" data-detail={cat ? '1' : '0'} style={{ gridTemplateColumns: 'minmax(230px, 1fr) minmax(0, 3fr)', alignItems: 'start' }}>
        <Card padded={false} className="md-master">
          <div style={{ padding: 8 }} className="stack sm">
            {cats.map((c) => (
              <button key={c.id} className={`nav-link ${c.key === selKey ? 'active' : ''}`} style={{ border: 0, background: c.key === selKey ? undefined : 'transparent', font: 'inherit', textAlign: 'left', cursor: 'pointer' }} onClick={() => setSelKey(c.key)}>
                <span className="grow truncate">{meta.label(c.name)}</span>{c.isSystem && <Lock size={12} />}{!c.isActive && <Badge>{t('common.inactive')}</Badge>}<span className="sub">{c.items.length}</span>
              </button>
            ))}
          </div>
        </Card>
        {cat ? (
          <div className="md-detail">
          <DetailBack onClick={() => setSelKey(null)}>{t('catalogs.title')}</DetailBack>
          <Card padded={false} title={<span className="row">{meta.label(cat.name)}{cat.isSystem && <Badge tone="info"><Lock size={11} />{t('catalogs.system')}</Badge>}</span>}
            actions={manage && <>
              <Button size="sm" icon={<Pencil size={14} />} onClick={() => setCatModal({ cat })}>{t('catalogs.edit')}</Button>
              {!cat.isSystem && <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={delCat} aria-label={t('common.delete')} />}
              <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => setItemModal({})}>{t('catalogs.new_item')}</Button>
            </>}>
            {cat.description && <p className="muted" style={{ padding: '12px 16px 0' }}>{meta.label(cat.description)}</p>}
            {parentCat && (
              <div className="row wrap" style={{ padding: '12px 16px 0' }}>
                <Badge tone="info">{t('catalogs.depends_on', { name: meta.label(parentCat.name) })}</Badge>
                <Select value={parentFilter ?? ''} onChange={(e) => setParentFilter(e.target.value ? Number(e.target.value) : null)} style={{ maxWidth: 260 }} aria-label={meta.label(parentCat.name)}>
                  <option value="">{t('catalogs.filter_all', { name: meta.label(parentCat.name) })}</option>
                  {parentsUsed.map((p) => <option key={p.id} value={p.id}>{meta.label(p.name)}</option>)}
                </Select>
                <span className="muted">{t('catalogs.count_shown', { count: shown.length })}</span>
              </div>
            )}
            {cat.items.length === 0 ? <Empty title={t('catalogs.no_items')} /> : (
              <div className="table-wrap"><table className="table m-stack">
                <thead><tr><th style={{ width: 70 }} /><th>{t('common.code')}</th>{parentCat && <th>{meta.label(parentCat.name)}</th>}<th>{t('common.name')}</th><th>{t('common.color')}</th><th>{t('common.status')}</th><th /></tr></thead>
                <tbody>
                  {shown.map((it, i) => (
                    <tr key={it.id} style={it.isActive ? undefined : { opacity: 0.55 }}>
                      <td className="m-order">{manage && <span className="row gap-sm">
                        <button className="icon-btn" disabled={i === 0} onClick={() => move(it, -1)}><ArrowUp size={14} /></button>
                        <button className="icon-btn" disabled={i === shown.length - 1} onClick={() => move(it, 1)}><ArrowDown size={14} /></button></span>}</td>
                      <td className="mono" data-label={t('common.code')}>{it.code ?? <span className="muted">—</span>}</td>
                      {parentCat && <td data-label={meta.label(parentCat.name)}>{it.parentItemId ? meta.name(it.parentItemId) : <span className="muted">—</span>}</td>}
                      <td className="m-primary"><strong>{meta.label(it.name)}</strong><div className="sub">{it.name.es !== it.name.en ? `${it.name.es ?? ''} / ${it.name.en ?? ''}` : ''}</div>{it.meta?.sellable === false && <Badge tone="bad">{t('catalogs.not_sellable')}</Badge>}</td>
                      <td data-label={t('common.color')}>{it.color ? <span><span className="color-dot" style={{ background: it.color }} />{it.color}</span> : <span className="muted">—</span>}</td>
                      <td data-label={t('common.status')}>{(it.systemKey || !it.isActive) && <span className="tag-list">{it.systemKey && <Badge tone="info"><Lock size={11} />{t('catalogs.system')}</Badge>}{!it.isActive && <Badge>{t('common.inactive')}</Badge>}</span>}</td>
                      <td className="cell-actions">{manage && <>
                        <button className="icon-btn" title={t('common.edit')} onClick={() => setItemModal({ item: it })}><Pencil size={16} /></button>
                        {!it.systemKey && <button className="icon-btn" title={it.isActive ? t('catalogs.deactivate') : t('catalogs.activate')} onClick={() => toggleActive(it)}>{it.isActive ? '⏸' : '▶'}</button>}
                        {!it.systemKey && <button className="icon-btn" title={t('common.delete')} onClick={() => delItem(it)}><Trash2 size={16} /></button>}</>}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            )}
          </Card>
          </div>
        ) : <Card className="md-detail"><Empty title={t('catalogs.pick')} /></Card>}
      </div>
      {catModal && <CatalogModal cat={catModal.cat} onClose={() => setCatModal(null)} onSaved={async (key) => { await reload(); if (key) setSelKey(key); }} />}
      {itemModal && cat && <ItemModal cat={cat} item={itemModal.item} onClose={() => setItemModal(null)} onSaved={reload} />}
    </>
  );
}

function CatalogModal({ cat, onClose, onSaved }: { cat?: Catalog; onClose: () => void; onSaved: (key?: string) => void }) {
  const { t } = useTranslation();
  const err = useErr();
  const toast = useToast();
  const [key, setKey] = useState('');
  const [name, setName] = useState<I18nText>(cat?.name ?? {});
  const [desc, setDesc] = useState<I18nText>(cat?.description ?? {});
  const [active, setActive] = useState(cat?.isActive ?? true);
  const [parentId, setParentId] = useState<number | null>(cat?.parentCatalogId ?? null);
  const [busy, setBusy] = useState(false);
  const meta = useMeta();
  // Si ya hay valores asignados a un valor del catálogo padre, no se puede cambiar de padre (quedarían sin sentido).
  const parentLocked = !!cat && (cat.isSystem || cat.items.some((i) => i.parentItemId));
  const slug = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  async function save() {
    setBusy(true);
    try {
      const description = i18nValid(desc) ? completeI18n(desc) : null;
      if (cat) await api.patch(`/catalogs/${cat.id}`, { name: completeI18n(name), description, isActive: active, ...(parentLocked ? {} : { parentCatalogId: parentId }) });
      else await api.post('/catalogs', { key: key || slug(name.es ?? name.en ?? ''), name: completeI18n(name), description, parentCatalogId: parentId });
      toast.success(t('common.saved')); onSaved(cat?.key ?? (key || slug(name.es ?? name.en ?? ''))); onClose();
    } catch (e) { toast.error(err(e)); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title={cat ? t('catalogs.edit') : t('catalogs.new')}
      footer={<><Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} disabled={!i18nValid(name)} onClick={save}>{t('common.save')}</Button></>}>
      <div className="stack">
        <I18nInput label={t('common.name')} value={name} onChange={setName} required autoFocus />
        <I18nInput label={t('common.description')} value={desc} onChange={setDesc} />
        {!cat && <Field label={t('common.key')} hint={t('catalogs.key_hint')}><Input value={key} placeholder={slug(name.es ?? name.en ?? '')} onChange={(e) => setKey(e.target.value)} /></Field>}
        <Field label={t('catalogs.parent')} hint={parentLocked ? t('catalogs.parent_locked') : t('catalogs.parent_hint')}>
          <Select value={parentId ?? ''} disabled={parentLocked} onChange={(e) => setParentId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">{t('catalogs.no_parent')}</option>
            {meta.data.catalogs.filter((c) => c.id !== cat?.id).map((c) => <option key={c.id} value={c.id}>{meta.label(c.name)}</option>)}
          </Select>
        </Field>
        {cat && !cat.isSystem && <Checkbox checked={active} onChange={setActive} label={t('common.active')} />}
      </div>
    </Modal>
  );
}

function ItemModal({ cat, item, onClose, onSaved }: { cat: Catalog; item?: CatalogItem; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const err = useErr();
  const toast = useToast();
  const [code, setCode] = useState(item?.code ?? '');
  const [name, setName] = useState<I18nText>(item?.name ?? {});
  const [color, setColor] = useState(item?.color ?? '');
  const [sellable, setSellable] = useState(item?.meta?.sellable !== false);
  const [parentItem, setParentItem] = useState<number | null>(item?.parentItemId ?? null);
  const [busy, setBusy] = useState(false);
  const meta = useMeta();
  const parentCat = cat.parentCatalogId ? meta.data.catalogs.find((c) => c.id === cat.parentCatalogId) : undefined;
  const isFunctional = cat.key === 'functional_grade';
  async function save() {
    setBusy(true);
    try {
      const meta = { ...(item?.meta ?? {}) };
      if (isFunctional) { if (sellable) delete meta.sellable; else meta.sellable = false; }
      const body = { code: code.trim() || null, name: completeI18n(name), color: color || null, meta, ...(parentCat ? { parentItemId: parentItem } : {}) };
      if (item) await api.patch(`/catalog-items/${item.id}`, body); else await api.post(`/catalogs/${cat.id}/items`, body);
      toast.success(t('common.saved')); onSaved(); onClose();
    } catch (e) { toast.error(err(e)); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} size="sm" title={item ? t('catalogs.edit_item') : t('catalogs.new_item')}
      footer={<><Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} disabled={!i18nValid(name)} onClick={save}>{t('common.save')}</Button></>}>
      <div className="stack">
        {parentCat && (
          <Field label={meta.label(parentCat.name)} hint={t('catalogs.parent_item_hint')}>
            <Select value={parentItem ?? ''} onChange={(e) => setParentItem(e.target.value ? Number(e.target.value) : null)}>
              <option value="">—</option>
              {parentCat.items.filter((p) => p.isActive || p.id === parentItem).map((p) => <option key={p.id} value={p.id}>{meta.label(p.name)}</option>)}
            </Select>
          </Field>
        )}
        <I18nInput label={t('common.name')} value={name} onChange={setName} required autoFocus />
        <div className="row wrap">
          <Field label={t('common.code')} hint={t('catalogs.code_hint')}><Input value={code} onChange={(e) => setCode(e.target.value)} style={{ width: 120 }} /></Field>
          <Field label={t('common.color')}>
            <span className="row gap-sm"><Input type="color" className="color-input" value={color || '#64748b'} onChange={(e) => setColor(e.target.value)} />{color && <Button size="sm" variant="ghost" onClick={() => setColor('')}>{t('common.clear')}</Button>}</span>
          </Field>
        </div>
        {isFunctional && <Checkbox checked={sellable} onChange={setSellable} label={t('catalogs.sellable')} />}
        {isFunctional && !sellable && <p className="muted">{t('catalogs.not_sellable_hint')}</p>}
      </div>
    </Modal>
  );
}
