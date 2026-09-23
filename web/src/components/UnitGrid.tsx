import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Pin } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { useMeta, type MetaIndex, type Specs } from '../lib/meta';
import { Grades, SpecChips, StatusBadge, TypeLabel } from './fields';
import { ItemBadge } from './ui';
import { PendingMark } from './PendingMark';
import type { GridColumn, Raw } from './grid/DataGrid';
import { useCatalogOpts, useTypeOpts } from './grid/helpers';

export interface UnitRow {
  id: number; code: string; serialNumber: string | null; specs: Specs; lotId: number; lotCode: string; equipmentTypeId: number; statusId: number; statusKey: string;
  cosmeticGradeId: number | null; functionalGradeId: number | null; slotId: number | null; slotCode: string | null; orderId: number | null; orderCode: string | null;
  lotLineId?: number | null; testerNumber?: number | null; createdAt?: string;
  /** Costo del equipo y precio de lista (vienen vacíos si el usuario no tiene permiso para verlos). */
  cost?: number | null; costSource?: 'plan' | 'manual' | null; listPrice?: number | null; priceSource?: 'rule' | 'manual' | null;
  /** Guardado en este dispositivo y aún sin enviar al servidor. */
  pendingSync?: boolean;
}

const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Una columna (oculta por defecto) por cada propiedad configurada en el sistema, filtrable según su tipo de dato. */
export function specColumns<T>(meta: MetaIndex, specsOf: (row: T) => Specs | null | undefined): GridColumn<T>[] {
  const cols: GridColumn<T>[] = [];
  for (const a of meta.data.attributes) {
    if (!a.isActive) continue;
    const key = `attr:${a.key}`;
    const title = `${meta.label(a.label)}${a.unit ? ` (${a.unit})` : ''}`;
    const raw = (u: T): unknown => specsOf(u)?.[a.key];
    const base = { key, title, hidden: true, width: 140 };
    switch (a.dataType) {
      case 'number': cols.push({ ...base, type: 'number', value: (u) => (raw(u) === undefined || raw(u) === '' ? null : Number(raw(u))) }); break;
      case 'boolean': cols.push({ ...base, type: 'boolean', value: (u) => (raw(u) === undefined || raw(u) === null ? null : Boolean(raw(u))) }); break;
      case 'date': cols.push({ ...base, type: 'date', value: (u) => (raw(u) as Raw) ?? null }); break;
      case 'select': {
        const options = meta.attrChoices(a, true).map((i) => ({ value: String(i.id), label: i.label }));
        cols.push({ ...base, type: 'select', options, value: (u) => (raw(u) ? String(raw(u)) : null) }); break;
      }
      case 'multiselect': {
        const options = meta.attrChoices(a, true).map((i) => ({ value: String(i.id), label: i.label }));
        cols.push({ ...base, type: 'multi', options, value: (u) => (Array.isArray(raw(u)) ? (raw(u) as number[]).map(String) : []) }); break;
      }
      default: cols.push({ ...base, type: 'text', value: (u) => (raw(u) === undefined || raw(u) === null ? null : String(raw(u))) });
    }
  }
  return cols;
}

/**
 * Columnas estándar del grid de equipos (con TODAS las propiedades del tipo como columnas ocultas
 * que se pueden activar y filtrar según su tipo de dato).
 */
export function useUnitColumns(omit: string[] = []): GridColumn<UnitRow>[] {
  const { t } = useTranslation();
  const meta = useMeta();
  const typeOpts = useTypeOpts();
  const statusOpts = useCatalogOpts('unit_status');
  const cosOpts = useCatalogOpts('cosmetic_grade', true);
  const funOpts = useCatalogOpts('functional_grade', true);
  const { can } = useAuth();
  const canCost = can('costs.view');
  const canPrice = can('sales.price') || can('prices.manage');
  const omitKey = omit.join('|');

  return useMemo(() => {
    const all: GridColumn<UnitRow>[] = [
      { key: 'code', title: t('common.code'), width: 140, value: (u) => u.code, render: (u) => <><Link to={`/units/${u.id}`} className="mono" onClick={(e) => e.stopPropagation()}><strong>{u.code}</strong></Link>{u.pendingSync && <PendingMark />}{u.serialNumber && <div className="sub">S/N {u.serialNumber}</div>}</> },
      { key: 'serialNumber', title: t('units.serial'), hidden: true, width: 140 },
      { key: 'type', title: t('common.type'), type: 'select', options: typeOpts, width: 140, value: (u) => String(u.equipmentTypeId), render: (u) => <TypeLabel typeId={u.equipmentTypeId} /> },
      { key: 'description', title: t('units.description'), width: 260, mobile: 'wide', value: (u) => meta.describe(u.equipmentTypeId, u.specs).join(' · '), render: (u) => <SpecChips typeId={u.equipmentTypeId} specs={u.specs} /> },
      { key: 'cosmetic', title: t('units.cosmetic'), type: 'select', options: cosOpts, width: 125, value: (u) => (u.cosmeticGradeId ? String(u.cosmeticGradeId) : null), render: (u) => <ItemBadge id={u.cosmeticGradeId} code /> },
      { key: 'functional', title: t('units.functional'), type: 'select', options: funOpts, width: 125, value: (u) => (u.functionalGradeId ? String(u.functionalGradeId) : null), render: (u) => <ItemBadge id={u.functionalGradeId} code /> },
      { key: 'status', title: t('common.status'), type: 'select', options: statusOpts, width: 150, value: (u) => String(u.statusId), render: (u) => <><StatusBadge id={u.statusId} />{u.orderCode && <div className="sub"><Link to={`/orders/${u.orderId}`} onClick={(e) => e.stopPropagation()}>{u.orderCode}</Link></div>}</> },
      { key: 'location', title: t('units.location'), width: 160, value: (u) => u.slotCode },
      { key: 'lot', title: t('units.lot'), type: 'select', width: 130, value: (u) => u.lotCode, render: (u) => <Link to={`/lots/${u.lotId}`} className="mono" onClick={(e) => e.stopPropagation()}>{u.lotCode}</Link> },
      { key: 'order', title: t('units.order'), hidden: true, width: 130, value: (u) => u.orderCode },
      ...(canCost ? [{
        key: 'cost', title: t('pricing.col_cost'), type: 'money' as const, hidden: true, width: 120, value: (u: UnitRow) => u.cost ?? null,
        render: (u: UnitRow) => (u.cost === null || u.cost === undefined ? <span className="muted">—</span> : <span className="row gap-sm" style={{ display: 'inline-flex', justifyContent: 'flex-end' }}>{u.costSource === 'manual' && <Pin size={11} aria-label={t('pricing.manual')} />}{fmt(u.cost)}</span>),
      }] : []),
      ...(canPrice ? [{
        key: 'listPrice', title: t('pricing.col_list_price'), type: 'money' as const, width: 120, value: (u: UnitRow) => u.listPrice ?? null,
        render: (u: UnitRow) => (u.listPrice === null || u.listPrice === undefined ? <span className="muted">—</span> : <span className="row gap-sm" style={{ display: 'inline-flex', justifyContent: 'flex-end' }}>{u.priceSource === 'manual' && <Pin size={11} aria-label={t('pricing.manual')} />}{fmt(u.listPrice)}</span>),
      }] : []),
      ...(canCost && canPrice ? [{
        key: 'margin', title: t('pricing.col_margin'), type: 'number' as const, hidden: true, width: 110,
        value: (u: UnitRow) => (u.cost === null || u.cost === undefined || !u.listPrice ? null : Math.round(((u.listPrice - u.cost) / u.listPrice) * 1000) / 10),
        render: (u: UnitRow) => (u.cost === null || u.cost === undefined || !u.listPrice ? <span className="muted">—</span> : <span className={u.listPrice < u.cost ? 'diff-neg' : undefined}>{(Math.round(((u.listPrice - u.cost) / u.listPrice) * 1000) / 10).toFixed(1)}%</span>),
      }] : []),
      { key: 'tester', title: t('testing.col_tech'), type: 'number', hidden: true, width: 100, value: (u) => u.testerNumber ?? null },
      { key: 'createdAt', title: t('common.created'), type: 'datetime', hidden: true, width: 160 },
    ];
    const cols = all.filter((c) => !omit.includes(c.key));

    cols.push(...specColumns<UnitRow>(meta, (u) => u.specs));
    return cols;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, meta, typeOpts, statusOpts, cosOpts, funOpts, omitKey, canCost, canPrice]);
}

export { Grades };
