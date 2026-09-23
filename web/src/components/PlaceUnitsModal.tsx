import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Sparkles } from 'lucide-react';
import { api } from '../lib/api';
import { Badge, Button, Modal, Select, Spinner, useErr, useToast } from './ui';
import { SpecChips, TypeLabel } from './fields';
import type { Specs } from '../lib/meta';

interface Suggestion { unitId: number; slotId: number | null; slotCode: string | null; score: number; reason: string }
interface SlotOpt { id: number; code: string; capacity: number; occupied: number }
interface UnitLite { id: number; code: string; equipmentTypeId: number; specs: Specs; slotCode: string | null }

/**
 * Ubicación inteligente: propone un espacio para cada equipo (agrupando parecidos) y
 * deja cambiar cualquier propuesta antes de confirmar.
 */
export function PlaceUnitsModal({ unitIds, onClose, onDone }: { unitIds: number[]; onClose: () => void; onDone?: () => void }) {
  const { t } = useTranslation();
  const err = useErr();
  const toast = useToast();
  const qc = useQueryClient();
  const [choice, setChoice] = useState<Record<number, number | null>>({});
  const [editing, setEditing] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const units = useQuery({ queryKey: ['units', 'ids', unitIds], queryFn: () => api.get<{ items: UnitLite[] }>(`/units?ids=${unitIds.join(',')}&pageSize=200`) });
  const sug = useQuery({
    queryKey: ['suggest', unitIds], gcTime: 0, staleTime: 0,
    queryFn: () => api.post<{ items: Suggestion[] }>('/locations/suggest', { unitIds }),
  });
  const slots = useQuery({ queryKey: ['slots', 'free'], staleTime: 0, queryFn: () => api.get<{ items: SlotOpt[] }>('/locations/slots?free=1') });

  useEffect(() => {
    if (sug.data) setChoice(Object.fromEntries(sug.data.items.map((s) => [s.unitId, s.slotId])));
  }, [sug.data]);

  const byId = useMemo(() => new Map(units.data?.items.map((u) => [u.id, u])), [units.data]);
  const reasonOf = useMemo(() => new Map(sug.data?.items.map((s) => [s.unitId, s.reason])), [sug.data]);
  const slotCode = (id: number | null) => (id ? slots.data?.items.find((s) => s.id === id)?.code ?? sug.data?.items.find((s) => s.slotId === id)?.slotCode ?? `#${id}` : null);
  const chosen = Object.entries(choice).filter(([, v]) => v);

  async function confirm() {
    setBusy(true);
    try {
      const r = await api.post<{ warnings?: { unit: string; slot: string }[] }>('/locations/assign', { assignments: chosen.map(([unitId, slotId]) => ({ unitId: Number(unitId), slotId })) });
      toast.success(t('place.done', { count: chosen.length }));
      if (r.warnings?.length) toast.info(t('place.rule_warning', { list: r.warnings.map((w) => `${w.unit} → ${w.slot}`).join(', ') }));
      void qc.invalidateQueries({ queryKey: ['units'] }); void qc.invalidateQueries({ queryKey: ['locations'] }); void qc.invalidateQueries({ queryKey: ['unit'] }); void qc.invalidateQueries({ queryKey: ['dashboard'] });
      onDone?.(); onClose();
    } catch (e) { toast.error(err(e)); } finally { setBusy(false); }
  }

  const loading = units.isLoading || sug.isLoading;
  return (
    <Modal open onClose={onClose} size="lg" title={<span className="row gap-sm"><Sparkles size={18} />{t('place.title')}</span>}
      footer={<>
        <Button variant="ghost" onClick={onClose}>{t('place.skip')}</Button>
        <Button variant="primary" autoFocus loading={busy} disabled={!chosen.length} onClick={confirm}>{t('place.confirm', { count: chosen.length })}</Button>
      </>}>
      {loading ? <Spinner /> : (
        <div className="stack">
          <p className="muted">{t('place.hint')}</p>
          <div className="table-wrap">
            <table className="table m-stack">
              <thead><tr><th>{t('common.code')}</th><th>{t('units.description')}</th><th>{t('place.suggested')}</th><th /></tr></thead>
              <tbody>
                {unitIds.map((id) => {
                  const u = byId.get(id);
                  const reason = reasonOf.get(id);
                  const cur = choice[id] ?? null;
                  return (
                    <tr key={id}>
                      <td className="mono m-primary"><strong>{u?.code}</strong>{u?.slotCode && <div className="sub">{t('place.currently', { slot: u.slotCode })}</div>}</td>
                      <td data-label={t('units.description')}>{u && <><TypeLabel typeId={u.equipmentTypeId} /> <SpecChips typeId={u.equipmentTypeId} specs={u.specs} /></>}</td>
                      <td data-label={t('place.suggested')}>
                        {editing === id ? (
                          <Select value={cur ?? ''} autoFocus onBlur={() => setEditing(null)} onChange={(e) => { setChoice((c) => ({ ...c, [id]: e.target.value ? Number(e.target.value) : null })); setEditing(null); }}>
                            <option value="">{t('place.dont_place')}</option>
                            {slots.data?.items.map((s) => <option key={s.id} value={s.id}>{s.code} ({s.occupied}/{s.capacity})</option>)}
                          </Select>
                        ) : cur ? (
                          <span className="row gap-sm"><strong className="mono">{slotCode(cur)}</strong>{reason && cur === sug.data?.items.find((s) => s.unitId === id)?.slotId && <Badge tone={reason.startsWith('same') || reason === 'partial_group' || reason === 'rule_empty' ? 'good' : 'info'}>{t(`place.reason.${reason}`)}</Badge>}</span>
                        ) : <Badge tone="warn">{reason === 'no_space' ? t('place.reason.no_space') : t('place.dont_place')}</Badge>}
                      </td>
                      <td className="cell-actions"><Button size="sm" variant="ghost" onClick={() => setEditing(id)}>{t('place.change')}</Button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Modal>
  );
}
