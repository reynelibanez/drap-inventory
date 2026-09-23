import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2 } from 'lucide-react';
import { api } from '../lib/api';
import { useMeta, type Specs } from '../lib/meta';
import { Button, Field, Input, Textarea, useErr, useToast } from './ui';
import { CatalogSelect, SpecFields, specsPatch } from './fields';

export interface UnitData {
  id: number; code: string; equipmentTypeId: number; specs: Specs; serialNumber: string | null; notes: string | null;
  cosmeticGradeId: number | null; functionalGradeId: number | null; statusId: number; statusKey: string; lotId: number; lotCode: string;
  lotLineId: number | null; slotId: number | null; slotCode: string | null; testedAt: string | null; orderId: number | null; orderCode: string | null; testerNumber: number;
  /** Solo al terminar el testeo: dónde quedó ubicado automáticamente (null si no había espacio). */
  autoPlaced?: { slotCode: string; moved: boolean } | null;
  /** Costo y precio de lista (vacíos si el usuario no tiene permiso para verlos). */
  cost?: number | null; costSource?: 'plan' | 'manual' | null; listPrice?: number | null; priceSource?: 'rule' | 'manual' | null;
  lotCurrency?: string;
}

/**
 * Formulario de datos de un equipo.
 *  - mode "test": equipo en testeo → guardar borrador o terminar el testeo (exige grados y datos obligatorios).
 *  - mode "edit": corregir datos de un equipo ya testeado.
 */
export function UnitForm({ unit, mode, onSaved, onFinished }: { unit: UnitData; mode: 'test' | 'edit'; onSaved: (u: UnitData) => void; onFinished?: (u: UnitData) => void }) {
  const { t } = useTranslation();
  const meta = useMeta();
  const err = useErr();
  const toast = useToast();
  const type = meta.type(unit.equipmentTypeId);
  const [serial, setSerial] = useState(unit.serialNumber ?? '');
  const [specs, setSpecs] = useState<Specs>(unit.specs ?? {});
  const [cos, setCos] = useState<number | null>(unit.cosmeticGradeId);
  const [fun, setFun] = useState<number | null>(unit.functionalGradeId);
  const [notes, setNotes] = useState(unit.notes ?? '');
  const [busy, setBusy] = useState<'save' | 'finish' | null>(null);
  const funItem = meta.item(fun);
  const notSellable = funItem?.meta?.sellable === false;
  const locked = unit.statusKey === 'sold';

  async function save() {
    setBusy('save');
    try {
      const u = await api.patch<UnitData>(`/units/${unit.id}`, {
        serialNumber: serial.trim() || null, specs: specsPatch(unit.equipmentTypeId, specs, meta), notes: notes.trim() || null,
        cosmeticGradeId: cos, functionalGradeId: fun,
      });
      toast.success(t('common.saved'));
      onSaved(u);
    } catch (e) { toast.error(err(e)); } finally { setBusy(null); }
  }

  async function finish() {
    if (!cos || !fun) { toast.error(t('unitForm.grades_required')); return; }
    setBusy('finish');
    try {
      const u = await api.post<UnitData>(`/units/${unit.id}/finish-test`, {
        cosmeticGradeId: cos, functionalGradeId: fun, serialNumber: serial.trim() || null,
        specs: specsPatch(unit.equipmentTypeId, specs, meta), notes: notes.trim() || null,
      });
      toast.success(t('unitForm.finished', { code: u.code }));
      onFinished?.(u);
    } catch (e) { toast.error(err(e)); } finally { setBusy(null); }
  }

  return (
    <div className="stack">
      <div className="form-grid">
        <Field label={t('unitForm.serial')} required={!!type?.tracksSerial} hint={type?.tracksSerial ? undefined : t('unitForm.serial_optional')}>
          <Input value={serial} onChange={(e) => setSerial(e.target.value)} disabled={locked} autoComplete="off" spellCheck={false} />
        </Field>
      </div>
      <SpecFields typeId={unit.equipmentTypeId} mode="unit" value={specs} onChange={setSpecs} disabled={locked} />
      <div className="grid grid-2">
        <Field label={t('unitForm.cosmetic')} required={mode === 'test'}><CatalogSelect catalog="cosmetic_grade" withCode value={cos} onChange={setCos} disabled={locked} /></Field>
        <Field label={t('unitForm.functional')} required={mode === 'test'} hint={notSellable ? t('unitForm.not_sellable_hint') : undefined}>
          <CatalogSelect catalog="functional_grade" withCode value={fun} onChange={setFun} disabled={locked} />
        </Field>
      </div>
      <Field label={t('common.notes')}><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} disabled={locked} /></Field>
      {!locked && (
        <div className="row form-actions" style={{ justifyContent: 'flex-end' }}>
          {mode === 'test' ? (
            <>
              <Button loading={busy === 'save'} disabled={busy === 'finish'} onClick={save}>{t('unitForm.save_draft')}</Button>
              <Button variant="primary" icon={<CheckCircle2 size={16} />} loading={busy === 'finish'} disabled={busy === 'save'} onClick={finish}>{t('unitForm.finish')}</Button>
            </>
          ) : (
            <Button variant="primary" loading={busy === 'save'} onClick={save}>{t('common.save')}</Button>
          )}
        </div>
      )}
    </div>
  );
}
