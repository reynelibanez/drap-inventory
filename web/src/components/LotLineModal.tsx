import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { useMeta, type Specs } from '../lib/meta';
import { Button, Field, Input, Modal, Textarea, useErr, useToast } from './ui';
import { SpecFields, TypeSelect } from './fields';

export interface LineLike { id?: number; equipmentTypeId: number; specs: Specs; expectedQty?: number; countedQty?: number | null; notes: string | null; tested?: number }

/** Alta o edición de una línea de lote; también sirve para registrar un ítem inesperado durante el conteo. */
export function LotLineModal({ lotId, line, unexpected, onClose, onSaved }: {
  lotId: number; line: LineLike | null; unexpected?: boolean; onClose: () => void; onSaved: () => void;
}) {
  const { t } = useTranslation();
  const meta = useMeta();
  const err = useErr();
  const toast = useToast();
  const [typeId, setTypeId] = useState<number | null>(line?.equipmentTypeId ?? null);
  const [specs, setSpecs] = useState<Specs>(line?.specs ?? {});
  const [qty, setQty] = useState<string>(String(unexpected ? line?.countedQty ?? 1 : line?.expectedQty ?? 1));
  const [notes, setNotes] = useState(line?.notes ?? '');
  const [busy, setBusy] = useState(false);
  const locked = !!line?.tested; // con equipos ya testeados no se cambia el tipo

  async function save() {
    if (!typeId) return;
    setBusy(true);
    try {
      const n = Math.max(0, Math.floor(Number(qty) || 0));
      if (unexpected) await api.post(`/lots/${lotId}/unexpected-lines`, { equipmentTypeId: typeId, specs, countedQty: Math.max(1, n), notes: notes || null });
      else if (line?.id) await api.put(`/lots/${lotId}/lines/${line.id}`, { equipmentTypeId: typeId, specs, expectedQty: n, notes: notes || null });
      else await api.post(`/lots/${lotId}/lines`, { equipmentTypeId: typeId, specs, expectedQty: n, notes: notes || null });
      toast.success(t('common.saved'));
      onSaved(); onClose();
    } catch (e) { toast.error(err(e)); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} size="lg"
      title={unexpected ? t('lots.unexpected_title') : line?.id ? t('lots.edit_line') : t('lots.add_line')}
      footer={<><Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} disabled={!typeId} onClick={save}>{t('common.save')}</Button></>}>
      <div className="stack">
        {unexpected && <div className="alert alert-info">{t('lots.unexpected_hint')}</div>}
        <div className="grid grid-2">
          <Field label={t('common.type')} required><TypeSelect value={typeId} onChange={(v) => { setTypeId(v); setSpecs({}); }} disabled={locked} /></Field>
          <Field label={unexpected ? t('lots.counted_qty') : t('lots.expected_qty')} required>
            <Input type="number" min={unexpected ? 1 : 0} value={qty} onChange={(e) => setQty(e.target.value)} />
          </Field>
        </div>
        {typeId && <SpecFields typeId={typeId} mode="lot" value={specs} onChange={setSpecs} />}
        <Field label={t('common.notes')}><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        {typeId && meta.type(typeId)?.attributes.length === 0 && <p className="muted">{t('fields.no_attributes')}</p>}
      </div>
    </Modal>
  );
}
