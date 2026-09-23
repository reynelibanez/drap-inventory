import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from './api';
import { useAuth } from './auth';
import { trText, type I18nText } from './i18n';
import { localModels, onLocalModels, type LocalModel } from './offline/models';

export interface CatalogItem {
  id: number; catalogId: number; code: string | null; name: I18nText; description: I18nText | null; color: string | null;
  sortOrder: number; systemKey: string | null; meta: Record<string, any>; isActive: boolean;
  /** Valor del catálogo del que depende (p. ej. la marca de un modelo). */
  parentItemId: number | null;
}
export interface Catalog { id: number; key: string; name: I18nText; description: I18nText | null; isSystem: boolean; isActive: boolean; sortOrder: number;
  /** Catálogo del que depende (modelos → marcas). */
  parentCatalogId: number | null; items: CatalogItem[] }
export interface Attribute { id: number; key: string; label: I18nText; dataType: 'text' | 'number' | 'boolean' | 'date' | 'select' | 'multiselect'; catalogId: number | null; unit: string | null; isSystem: boolean; isActive: boolean }
export interface TypeAttr { id: number; equipmentTypeId: number; attributeId: number; sortOrder: number; inLotLine: boolean; requiredOnLot: boolean; requiredOnTest: boolean; isActive: boolean;
  /** Atributo de texto con lista de sugerencias: catálogo del que salen. */
  suggestCatalogId: number | null;
  /** Atributo de lista: catálogo propio de este tipo de equipo (p. ej. los modelos de laptop); si no hay, el del atributo. */
  catalogId: number | null }
export interface EquipmentType { id: number; key: string; name: I18nText; icon: string | null; tracksSerial: boolean; isSystem: boolean; isActive: boolean; sortOrder: number; attributes: TypeAttr[] }
export interface Settings {
  unitCodeFormat: string; lotCodeFormat: string; orderCodeFormat: string; reservationDays: number | null; autoPlaceOnTest?: boolean;
  placement: { sameModel: number; sameBrand: number; sameType: number; sameGrade: number; preferredArea: number; emptySlot: number; fillStarted: number };
}
export interface MetaData {
  company: { id: number; name: string; defaultLanguage: string; currency: string; timezone: string };
  settings: Settings; catalogs: Catalog[]; attributes: Attribute[]; equipmentTypes: EquipmentType[];
}
export type Specs = Record<string, any>;

export class MetaIndex {
  private items = new Map<number, CatalogItem>();
  private catalogs = new Map<string, Catalog>();
  private types = new Map<number, EquipmentType>();
  private attrs = new Map<number, Attribute>();
  private attrKeys = new Map<string, Attribute>();

  readonly data: MetaData;
  private catalogsById = new Map<number, Catalog>();

  /** `pending`: valores agregados sin conexión que el servidor todavía no tiene (aparecen en su lista con id provisional). */
  constructor(data: MetaData, readonly lang: string, pending: LocalModel[] = []) {
    if (pending.length) {
      data = {
        ...data,
        catalogs: data.catalogs.map((c) => {
          const mine = pending.filter((m) => m.catalogId === c.id && !c.items.some((i) => i.id === m.id));
          if (!mine.length) return c;
          const base = c.items.reduce((a, i) => Math.max(a, i.sortOrder), 0);
          return {
            ...c,
            items: [...c.items, ...mine.map((m, n): CatalogItem => ({
              id: m.id, catalogId: c.id, code: null, name: { es: m.name, en: m.name }, description: null, color: null, sortOrder: base + n + 1,
              systemKey: null, meta: {}, isActive: true, parentItemId: m.parentItemId,
            }))],
          };
        }),
      };
    }
    this.data = data;
    for (const c of data.catalogs) { this.catalogs.set(c.key, c); this.catalogsById.set(c.id, c); for (const i of c.items) this.items.set(i.id, i); }
    for (const t of data.equipmentTypes) this.types.set(t.id, t);
    for (const a of data.attributes) { this.attrs.set(a.id, a); this.attrKeys.set(a.key, a); }
  }
  label = (v: I18nText | null | undefined) => trText(v, this.lang);
  private byLang = new Map<string, MetaIndex>();
  /** Los mismos catálogos escritos en otro idioma (para los documentos, que salen en el idioma de la empresa). */
  inLang(lang: string): MetaIndex {
    if (lang === this.lang) return this;
    let m = this.byLang.get(lang);
    if (!m) { m = new MetaIndex(this.data, lang); this.byLang.set(lang, m); }
    return m;
  }
  item = (id: number | null | undefined) => (id ? this.items.get(id) : undefined);
  /** Nombre de un valor de catálogo en el idioma actual. */
  name = (id: number | null | undefined) => (id ? this.label(this.items.get(id)?.name) : '');
  /** "A — Como nuevo" */
  nameWithCode = (id: number | null | undefined) => {
    const it = this.item(id);
    if (!it) return '';
    return it.code ? `${it.code} — ${this.label(it.name)}` : this.label(it.name);
  };
  catalog = (key: string) => this.catalogs.get(key);
  catalogOptions = (key: string, includeInactive = false, keepId?: number | null) =>
    (this.catalogs.get(key)?.items ?? []).filter((i) => i.isActive || includeInactive || i.id === keepId);
  sysId = (catalogKey: string, systemKey: string) => this.catalogs.get(catalogKey)?.items.find((i) => i.systemKey === systemKey)?.id;
  sysKey = (id: number | null | undefined) => (id ? this.items.get(id)?.systemKey ?? null : null);
  color = (id: number | null | undefined) => (id ? this.items.get(id)?.color ?? null : null);

  type = (id: number | null | undefined) => (id ? this.types.get(id) : undefined);
  typeName = (id: number | null | undefined) => this.label(this.type(id)?.name);
  typeList = (includeInactive = false) => this.data.equipmentTypes.filter((t) => t.isActive || includeInactive);
  attr = (id: number) => this.attrs.get(id);
  attrByKey = (key: string) => this.attrKeys.get(key);

  /** Atributos configurados de un tipo, ya resueltos y ordenados. */
  typeAttrs(typeId: number | null | undefined, opts: { lotLine?: boolean } = {}) {
    const t = this.type(typeId);
    if (!t) return [];
    return t.attributes
      .filter((ta) => ta.isActive && (!opts.lotLine || ta.inLotLine))
      .map((ta) => ({ cfg: ta, attr: this.attrs.get(ta.attributeId)! }))
      .filter((x) => x.attr && x.attr.isActive)
      .sort((a, b) => a.cfg.sortOrder - b.cfg.sortOrder);
  }

  /** Catálogo por id. */
  catalogById = (id: number | null | undefined) => (id ? this.catalogsById.get(id) : undefined);

  /** Id del catálogo que usa un atributo de lista en este tipo de equipo: el propio del tipo (p. ej. modelos de laptop) o el del atributo. */
  attrCatalogId(typeId: number | null | undefined, attr: Attribute): number | null {
    const cfg = this.type(typeId)?.attributes.find((a) => a.attributeId === attr.id);
    return cfg?.catalogId ?? attr.catalogId;
  }
  attrCatalog = (typeId: number | null | undefined, attr: Attribute) => this.catalogById(this.attrCatalogId(typeId, attr));

  /** Todos los catálogos que un atributo de lista puede usar según el tipo de equipo (para filtros y columnas que abarcan varios tipos). */
  attrCatalogs(attr: Attribute): Catalog[] {
    const ids = new Set<number>();
    if (attr.catalogId) ids.add(attr.catalogId);
    for (const t of this.data.equipmentTypes) for (const ta of t.attributes) if (ta.attributeId === attr.id && ta.catalogId) ids.add(ta.catalogId);
    return [...ids].map((id) => this.catalogsById.get(id)).filter((c): c is Catalog => !!c);
  }

  /**
   * Todos los valores que puede tener un atributo de lista en cualquier tipo de equipo (para filtros, columnas y reglas), sin repetir.
   * Si dos valores se llaman igual bajo marcas distintas (dos modelos "X1"), se distinguen con su marca.
   */
  attrChoices(attr: Attribute, includeInactive = false, keep: number[] = []): { id: number; label: string }[] {
    const items = this.attrCatalogs(attr).flatMap((c) => c.items).filter((i) => includeInactive || i.isActive || keep.includes(i.id));
    const count = new Map<string, number>();
    for (const i of items) { const n = this.label(i.name).toLowerCase(); count.set(n, (count.get(n) ?? 0) + 1); }
    return items.map((i) => {
      const n = this.label(i.name);
      const dup = (count.get(n.toLowerCase()) ?? 0) > 1 && i.parentItemId;
      return { id: i.id, label: dup ? `${n} (${this.name(i.parentItemId)})` : n };
    });
  }

  /** Atributo de lista del tipo del que depende éste (el modelo depende de la marca), si el tipo lo tiene. */
  parentAttr(typeId: number | null | undefined, attr: Attribute): Attribute | undefined {
    const cat = this.attrCatalog(typeId, attr);
    if (!cat?.parentCatalogId) return undefined;
    return this.typeAttrs(typeId).find((x) => x.attr.id !== attr.id && x.attr.dataType === 'select' && this.attrCatalogId(typeId, x.attr) === cat.parentCatalogId)?.attr;
  }

  /** Al cambiar la marca (o lo que sea el padre), quita el valor de las listas que dependen de ella si era de otra marca. Devuelve `specs` (sin cambios si no hace falta). */
  dropStaleChildren(typeId: number | null | undefined, specs: Specs, changedKey: string): Specs {
    let out = specs;
    for (const { attr } of this.typeAttrs(typeId)) {
      const chosen = out[attr.key];
      if (attr.dataType !== 'select' || typeof chosen !== 'number' || this.parentAttr(typeId, attr)?.key !== changedKey) continue;
      const parentId = this.item(chosen)?.parentItemId;
      if (parentId && parentId !== out[changedKey]) { out = { ...out }; delete out[attr.key]; }
    }
    return out;
  }

  /**
   * Opciones de un atributo de lista para un equipo. Si depende de otra lista (modelo → marca) solo salen las de la marca elegida
   * (más las que no pertenecen a ninguna marca). `keepId` conserva el valor ya guardado aunque esté inactivo.
   */
  attrOptions(typeId: number | null | undefined, attr: Attribute, specs: Specs | null | undefined, keepId?: number | null): CatalogItem[] {
    const cat = this.attrCatalog(typeId, attr);
    if (!cat) return [];
    const pa = this.parentAttr(typeId, attr);
    const chosen = pa ? specs?.[pa.key] : undefined;
    return cat.items.filter((i) => {
      if (i.id === keepId) return true;
      if (!i.isActive) return false;
      if (!pa) return true;
      return typeof chosen === 'number' && (i.parentItemId === null || i.parentItemId === chosen);
    });
  }

  /**
   * Sugerencias para un atributo de texto con lista (atributos propios de la empresa): los valores del catálogo, y si ese catálogo
   * depende de otro (modelos → marcas) y el equipo ya tiene la marca elegida, solo los de esa marca. Sin repetir.
   */
  suggestions(typeId: number | null | undefined, cfg: TypeAttr, specs: Specs | null | undefined): string[] {
    const cat = this.catalogById(cfg.suggestCatalogId);
    if (!cat) return [];
    let parentId: number | null = null;
    if (cat.parentCatalogId) {
      const parentAttr = this.typeAttrs(typeId).find((x) => x.attr.dataType === 'select' && this.attrCatalogId(typeId, x.attr) === cat.parentCatalogId)?.attr;
      const chosen = parentAttr ? specs?.[parentAttr.key] : undefined;
      if (typeof chosen === 'number') parentId = chosen;
    }
    const seen = new Set<string>();
    const out: string[] = [];
    for (const it of cat.items) {
      if (!it.isActive) continue;
      if (parentId && it.parentItemId && it.parentItemId !== parentId) continue;
      const name = this.label(it.name);
      if (name && !seen.has(name.toLowerCase())) { seen.add(name.toLowerCase()); out.push(name); }
    }
    return out;
  }

  /** Texto corto legible de las especificaciones: ["Dell", "Latitude 7490", "16 GB"]. */
  describe(typeId: number | null | undefined, specs: Specs | null | undefined, lineOnly = true): string[] {
    const out: string[] = [];
    for (const { attr, cfg } of this.typeAttrs(typeId)) {
      if (lineOnly && !cfg.inLotLine) continue;
      const v = specs?.[attr.key];
      if (v === undefined || v === null || v === '') continue;
      out.push(this.specValue(attr, v, true));
    }
    return out;
  }

  specValue(attr: Attribute, v: any, withLabelForBool = false): string {
    switch (attr.dataType) {
      case 'select': return this.name(Number(v));
      case 'multiselect': return (v as number[]).map((id) => this.name(id)).join(', ');
      case 'boolean': return withLabelForBool ? `${this.label(attr.label)}: ${v ? '✓' : '✗'}` : v ? '✓' : '✗';
      case 'number': return `${v}${attr.unit ? ' ' + attr.unit : ''}`;
      default: return String(v);
    }
  }
}

const MetaCtx = createContext<MetaIndex | null>(null);

export function MetaProvider({ children }: { children: ReactNode }) {
  const { company, status } = useAuth();
  const { i18n } = useTranslation();
  const q = useQuery({
    queryKey: ['meta', company?.id],
    queryFn: () => api.get<MetaData>('/meta'),
    enabled: status === 'authed' && !!company,
    staleTime: 30_000,   // corto: los tipos y propiedades nuevos aparecen enseguida en todas las pantallas
  });
  const extra = useSyncExternalStore(onLocalModels, localModels, localModels);
  const idx = useMemo(() => (q.data ? new MetaIndex(q.data, i18n.language, extra) : null), [q.data, i18n.language, extra]);
  if (!idx) return q.isError ? <div className="center-screen">⚠</div> : <div className="center-screen"><div className="spinner" /></div>;
  return <MetaCtx.Provider value={idx}>{children}</MetaCtx.Provider>;
}

export function useMeta(): MetaIndex {
  const v = useContext(MetaCtx);
  if (!v) throw new Error('useMeta fuera de MetaProvider');
  return v;
}

/** Vuelve a pedir catálogos/tipos tras editarlos. */
export function useReloadMeta() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['meta'] });
}
