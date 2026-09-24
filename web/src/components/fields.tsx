import { useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, X } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useMeta, useReloadMeta, type Attribute, type Catalog, type CatalogItem, type Specs } from '../lib/meta';
import { Badge, Button, Checkbox, Field, Input, Modal, Select, TypeIcon, useErr, useToast } from './ui';
import { useIsMobile } from '../lib/useIsMobile';
import { ChoiceChips } from './mobile/ChoiceChips';

// ---------------------------------------------------------------------------
// Valor de catálogo con selector
// ---------------------------------------------------------------------------
export function CatalogSelect({ catalog, value, onChange, withCode = false, empty, disabled, className }: {
  catalog: string; value: number | null | undefined; onChange: (v: number | null) => void; withCode?: boolean; empty?: string; disabled?: boolean; className?: string;
}) {
  const meta = useMeta();
  const { t } = useTranslation();
  const mobile = useIsMobile();
  const opts = meta.catalogOptions(catalog, false, value);
  // En el teléfono, los grados (pocas opciones con código) se eligen con botones grandes.
  if (mobile && withCode && opts.length > 0 && opts.length <= 6) {
    return (
      <ChoiceChips disabled={disabled} value={value} onChange={onChange}
        options={opts.map((i) => ({ value: i.id, label: i.code ?? meta.name(i.id), sub: i.code ? meta.name(i.id) : undefined, color: i.color }))} />
    );
  }
  return (
    <Select className={className} disabled={disabled} value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      <option value="">{empty ?? t('common.select')}</option>
      {opts.map((i) => <option key={i.id} value={i.id}>{withCode ? meta.nameWithCode(i.id) : meta.name(i.id)}{i.isActive ? '' : ' ✕'}</option>)}
    </Select>
  );
}

export function TypeSelect({ value, onChange, includeInactive, disabled, empty }: {
  value: number | null | undefined; onChange: (v: number | null) => void; includeInactive?: boolean; disabled?: boolean; empty?: string;
}) {
  const meta = useMeta();
  const { t } = useTranslation();
  return (
    <Select disabled={disabled} value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      <option value="">{empty ?? t('common.select')}</option>
      {meta.typeList(includeInactive).map((ty) => <option key={ty.id} value={ty.id}>{meta.label(ty.name)}</option>)}
    </Select>
  );
}

export const TypeLabel = ({ typeId }: { typeId: number | null | undefined }) => {
  const meta = useMeta();
  const ty = meta.type(typeId);
  return <span className="row gap-sm" style={{ display: 'inline-flex' }}><TypeIcon icon={ty?.icon} size={16} />{meta.label(ty?.name)}</span>;
};

/** Resumen corto de las especificaciones como "chips": Dell · Latitude 7490 · 16 GB. */
export function SpecChips({ typeId, specs, all = false }: { typeId: number; specs: Specs | null | undefined; all?: boolean }) {
  const meta = useMeta();
  const parts = meta.describe(typeId, specs, !all);
  if (!parts.length) return <span className="muted">—</span>;
  return <span className="spec-chips">{parts.map((p, i) => <span key={i} className="chip">{p}</span>)}</span>;
}

// ---------------------------------------------------------------------------
// Alta rápida de un valor de catálogo sin salir del formulario
// ---------------------------------------------------------------------------
function QuickAddItem({ attr, catalog, parent, onCreated, onClose }: {
  attr: Attribute; catalog: Catalog; parent: CatalogItem | null; onCreated: (id: number) => void; onClose: () => void;
}) {
  const { t } = useTranslation();
  const meta = useMeta();
  const reload = useReloadMeta();
  const err = useErr();
  const toast = useToast();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    const n = name.trim().replace(/\s+/g, ' ');
    if (!n) return;
    setBusy(true);
    try {
      // Si ya existe (mismo nombre bajo la misma marca) devuelve ese, así no se duplica.
      const r = await api.post<{ id: number }>(`/catalogs/${catalog.id}/quick-item`, { name: n, parentItemId: parent?.id ?? null });
      await reload();
      onCreated(r.id);
      toast.success(t('fields.value_added'));
      onClose();
    } catch (e) { toast.error(err(e)); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} size="sm" title={t('fields.add_value_title', { name: meta.label(attr.label) })}
      footer={<><Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} onClick={save} disabled={!name.trim()}>{t('common.add')}</Button></>}>
      {parent && <p className="muted" style={{ marginTop: 0 }}>{t('fields.add_value_under', { name: meta.name(parent.id) })}</p>}
      <Field label={t('common.name')} hint={t(parent ? 'fields.add_value_hint_child' : 'fields.add_value_hint')}>
        <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus onKeyDown={(e) => { if (e.key === 'Enter') void save(); }} />
      </Field>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Campos dinámicos según el tipo de equipo
// ---------------------------------------------------------------------------
/** Quienes pueden agregar un modelo nuevo al registrar o testear equipos (sin administrar catálogos). */
const QUICK_ADD_PERMS = ['catalogs.manage', 'units.test', 'units.edit', 'lots.create', 'lots.edit'];

/**
 * Dibuja los atributos configurados para un tipo de equipo.
 *  - mode "lot": solo los atributos marcados como "en la línea del lote".
 *  - mode "unit": todos.
 * `value` es el objeto specs; los valores vacíos se eliminan del objeto.
 */
export function SpecFields({ typeId, value, onChange, mode, disabled, only, optional }: {
  typeId: number | null | undefined; value: Specs; onChange: (v: Specs) => void; mode: 'lot' | 'unit'; disabled?: boolean; only?: (key: string) => boolean;
  /** Sin marcas de "obligatorio" (p. ej. activos de la empresa, que no tienen testeo). */
  optional?: boolean;
}) {
  const meta = useMeta();
  const { can } = useAuth();
  const { t } = useTranslation();
  const [adding, setAdding] = useState<{ attr: Attribute; catalog: Catalog; parent: CatalogItem | null; index?: number } | null>(null);
  const listId = useId();
  const rows = meta.typeAttrs(typeId, { lotLine: mode === 'lot' }).filter((r) => !only || only(r.attr.key));

  const set = (key: string, v: unknown) => {
    const next = { ...value };
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) delete next[key]; else next[key] = v as any;
    onChange(meta.dropStaleChildren(typeId, next, key));   // al cambiar de marca se quita el modelo que era de otra marca
  };
  if (!typeId) return null;
  if (!rows.length) return <p className="muted">{t('fields.no_attributes')}</p>;

  return (
    <>
      <div className="form-grid">
        {rows.map(({ attr, cfg }) => {
          const label = meta.label(attr.label) + (attr.unit && attr.dataType === 'number' ? ` (${attr.unit})` : '');
          const required = !optional && (mode === 'lot' ? cfg.requiredOnLot : cfg.requiredOnTest);
          const v = value[attr.key];
          let control: ReactNode;
          switch (attr.dataType) {
            case 'number':
              control = <Input type="number" step="any" inputMode="decimal" disabled={disabled} value={v === undefined ? '' : String(v)} onChange={(e) => set(attr.key, e.target.value === '' ? undefined : Number(e.target.value))} />;
              break;
            case 'date':
              control = <Input type="date" disabled={disabled} value={typeof v === 'string' ? v : ''} onChange={(e) => set(attr.key, e.target.value)} />;
              break;
            case 'boolean':
              return (
                <Field key={attr.key} label={<>&nbsp;</>} className="field-check">
                  <Checkbox disabled={disabled} checked={v === true} onChange={(c) => set(attr.key, c ? true : undefined)} label={<>{label}{required && <span className="req"> *</span>}</>} />
                </Field>
              );
            case 'select': {
              const cat = meta.attrCatalog(typeId, attr);
              const pa = meta.parentAttr(typeId, attr);
              const parentId = pa && typeof value[pa.key] === 'number' ? (value[pa.key] as number) : null;
              // Lista que depende de otra (modelo → marca): primero se elige la marca y solo salen los de esa marca.
              const waiting = !!pa && parentId === null;
              const opts = meta.attrOptions(typeId, attr, value, typeof v === 'number' ? v : null);
              const mayAdd = !!cat && (cat.parentCatalogId ? QUICK_ADD_PERMS.some((p) => can(p)) : can('catalogs.manage'));
              control = (
                <div className="row gap-sm">
                  <Select disabled={disabled || (waiting && v === undefined)} value={v === undefined ? '' : String(v)} onChange={(e) => set(attr.key, e.target.value ? Number(e.target.value) : undefined)}>
                    <option value="">{waiting ? t('fields.pick_first', { name: meta.label(pa!.label) }) : '—'}</option>
                    {opts.map((o) => <option key={o.id} value={o.id}>{meta.name(o.id)}</option>)}
                  </Select>
                  {mayAdd && !disabled && (
                    <button type="button" className="icon-btn" disabled={waiting} title={waiting ? t('fields.pick_first', { name: meta.label(pa!.label) }) : t('fields.add_value')}
                      onClick={() => setAdding({ attr, catalog: cat!, parent: parentId ? meta.item(parentId) ?? null : null })}><Plus size={18} /></button>
                  )}
                </div>
              );
              break;
            }
            case 'multiselect': {
              // Cada fila es un valor elegido, con su propio selector; así se puede repetir el mismo valor más de una
              // vez (p. ej. dos discos duros del mismo tamaño). La última fila siempre queda vacía, lista para agregar
              // uno más; al elegir algo ahí se suma a la lista y aparece una fila vacía nueva debajo.
              const cat = meta.attrCatalog(typeId, attr);
              const cur = Array.isArray(v) ? (v as number[]) : [];
              const mayAdd = !!cat && (cat.parentCatalogId ? QUICK_ADD_PERMS.some((p) => can(p)) : can('catalogs.manage'));
              const entries: (number | null)[] = [...cur, null];
              const updateEntry = (idx: number, newId: number | null) => {
                const arr = [...cur];
                if (idx < arr.length) { if (newId === null) arr.splice(idx, 1); else arr[idx] = newId; }
                else if (newId !== null) arr.push(newId);
                set(attr.key, arr);
              };
              control = (
                <div className="stack sm">
                  {entries.map((id, idx) => {
                    const isNew = idx === cur.length;
                    const opts = meta.attrOptions(typeId, attr, value, id ?? null);
                    return (
                      <div key={idx} className="row gap-sm">
                        <Select disabled={disabled} value={id === null ? '' : String(id)} onChange={(e) => updateEntry(idx, e.target.value ? Number(e.target.value) : null)}>
                          <option value="">{isNew ? `+ ${t('fields.add_another')}` : '—'}</option>
                          {opts.map((o) => <option key={o.id} value={o.id}>{meta.name(o.id)}</option>)}
                        </Select>
                        {mayAdd && !disabled && (
                          <button type="button" className="icon-btn" title={t('fields.add_value')} onClick={() => setAdding({ attr, catalog: cat!, parent: null, index: idx })}><Plus size={18} /></button>
                        )}
                        {!isNew && !disabled && (
                          <button type="button" className="icon-btn" title={t('common.remove')} onClick={() => updateEntry(idx, null)}><X size={18} /></button>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
              break;
            }
            default: {
              // Con lista de sugerencias (p. ej. modelos de la marca elegida): se puede elegir de la lista o escribir otro.
              const options = meta.suggestions(typeId, cfg, value);
              control = (
                <>
                  <Input disabled={disabled} value={typeof v === 'string' ? v : v === undefined ? '' : String(v)} onChange={(e) => set(attr.key, e.target.value)}
                    list={options.length ? `${listId}-${attr.key}` : undefined} autoComplete="off" />
                  {options.length > 0 && <datalist id={`${listId}-${attr.key}`}>{options.map((o) => <option key={o} value={o} />)}</datalist>}
                </>
              );
            }
          }
          return <Field key={attr.key} label={label} required={required}>{control}</Field>;
        })}
      </div>
      {adding && (
        <QuickAddItem attr={adding.attr} catalog={adding.catalog} parent={adding.parent} onClose={() => setAdding(null)}
          onCreated={(id) => {
            if (adding.index === undefined) { set(adding.attr.key, id); return; }
            // Viene de una fila de "varios valores": lo pone en esa fila (la agrega si era la fila vacía del final).
            const cur = Array.isArray(value[adding.attr.key]) ? [...(value[adding.attr.key] as number[])] : [];
            if (adding.index < cur.length) cur[adding.index] = id; else cur.push(id);
            set(adding.attr.key, cur);
          }}
        />
      )}
    </>
  );
}

/** Convierte specs a un "parche" que también borra los valores que el usuario dejó vacíos. */
export function specsPatch(typeId: number, current: Specs, meta: ReturnType<typeof useMeta>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const { attr } of meta.typeAttrs(typeId)) out[attr.key] = current[attr.key] ?? null;
  return out;
}

/** Estado de un equipo/lote/pedido: valor de catálogo con su color. */
export function StatusBadge({ id, keyName }: { id: number | null | undefined; keyName?: string }) {
  const meta = useMeta();
  const it = meta.item(id);
  if (!it) return keyName ? <Badge>{keyName}</Badge> : null;
  return <Badge color={it.color}>{meta.label(it.name)}</Badge>;
}

/** Nota: "grado cosmético / funcional" en una sola línea: A / B. */
export function Grades({ cosmeticId, functionalId }: { cosmeticId: number | null | undefined; functionalId: number | null | undefined }) {
  const meta = useMeta();
  if (!cosmeticId && !functionalId) return <span className="muted">—</span>;
  const one = (id: number | null | undefined) => {
    const it = meta.item(id);
    return it ? <Badge color={it.color} title={meta.label(it.name)}>{it.code ?? meta.label(it.name)}</Badge> : <span className="muted">–</span>;
  };
  return <span className="row gap-sm" style={{ display: 'inline-flex' }}>{one(cosmeticId)}<span className="muted">/</span>{one(functionalId)}</span>;
}
