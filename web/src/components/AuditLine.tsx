import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useMeta } from '../lib/meta';

export const auditKey = (action: string) => `audit.actions.${action.replace(/\./g, '_')}`;

/** Texto legible de un evento del historial (acción + datos relevantes). */
export function useAuditText() {
  const { t } = useTranslation();
  const meta = useMeta();
  return (action: string, data: Record<string, any> | null | undefined): string => {
    const label = t(auditKey(action), { defaultValue: action });
    const d = data ?? {};
    const bits: string[] = [];
    const nm = (id: unknown) => (typeof id === 'number' ? meta.name(id) : '');
    if (action === 'asset.status_changed') bits.push(`${nm(d.from)} → ${nm(d.to)}`);
    else if (action === 'asset.updated') bits.push(Object.keys(d).map((k) => t(`assets.field.${k}`, { defaultValue: k })).join(', '));
    else if (action === 'unit.status_changed') { bits.push(`${nm(d.from)} → ${nm(d.to)}`); if (d.note) bits.push(String(d.note)); }
    else if (action === 'unit.tested') bits.push(`${meta.item(d.cosmeticGradeId)?.code ?? ''} / ${meta.item(d.functionalGradeId)?.code ?? ''}`);
    else if (action === 'lot.status_changed') bits.push(`${d.from ?? ''} → ${d.to ?? ''}`.replace(/(\w+)/g, (w) => t(`audit.lot_status.${w}`, { defaultValue: w })));
    else if (action === 'lot.counted') bits.push(`${d.from ?? '–'} → ${d.to ?? '–'}`);
    else if (action === 'unit.reserved' || action === 'unit.sold') bits.push(String(d.orderCode ?? ''));
    else if (action === 'unit.released') bits.push(t(`audit.release_reason.${d.reason}`, { defaultValue: String(d.reason ?? '') }));
    else {
      for (const k of ['code', 'lotCode', 'name', 'username', 'orderCode']) if (typeof d[k] === 'string' && d[k]) bits.push(d[k]);
    }
    const extra = bits.filter(Boolean).join(' · ');
    return extra ? `${label} — ${extra}` : label;
  };
}

/** Enlace a la entidad afectada, si existe una pantalla para ella. */
export function EntityLink({ entity, id, label }: { entity: string; id: number | null; label?: string }) {
  const { t } = useTranslation();
  const map: Record<string, string> = { unit: '/units/', lot: '/lots/', order: '/orders/', asset: '/assets/' };
  const text = label ?? `${t(`audit.entities.${entity}`, { defaultValue: entity })}${id ? ` #${id}` : ''}`;
  if (id && map[entity]) return <Link to={`${map[entity]}${id}`}>{text}</Link>;
  return <span>{text}</span>;
}
