import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Zap } from 'lucide-react';
import { api } from '../lib/api';
import { useMeta, type Specs } from '../lib/meta';
import { Button, Checkbox, Field, Input, Select, Textarea, useErr, useToast } from './ui';
import { CatalogSelect, SpecFields, TypeSelect, specsPatch } from './fields';
import type { UnitData } from './UnitForm';

/** Datos con los que arranca el formulario de un equipo nuevo. */
export interface Draft {
  lotId: number | null; typeId: number | null; serial: string; specs: Specs;
  cosmeticGradeId: number | null; functionalGradeId: number | null; notes: string;
}
export const emptyDraft = (lotId: number | null): Draft => ({ lotId, typeId: null, serial: '', specs: {}, cosmeticGradeId: null, functionalGradeId: null, notes: '' });

/** "Repetir el último" (sin serie ni grados) o "Clonar" (sin serie; conserva grados y notas). */
export function draftFromUnit(u: UnitData, opts: { keepGrades: boolean; lotId?: number | null }): Draft {
  return {
    lotId: opts.lotId ?? u.lotId, typeId: u.equipmentTypeId, serial: '', specs: { ...(u.specs ?? {}) },
    cosmeticGradeId: opts.keepGrades ? u.cosmeticGradeId : null, functionalGradeId: opts.keepGrades ? u.functionalGradeId : null, notes: u.notes ?? '',
  };
}

interface LotOption { id: number; code: string; supplierName: string | null; requiresTesting: boolean }

/**
 * Formulario para registrar equipos nuevos en un lote. Pide el lote, el tipo y todos los datos; el equipo se crea al guardar
 * (como borrador en testeo) o al terminar el testeo (con sus grados). Para tipos sin serie se puede crear varios a la vez.
 */
export function NewUnitForm({ seed, lots, title, onCancel, onCreated }: {
  seed: Draft; lots: LotOption[]; title?: string; onCancel: () => void;
  onCreated: (units: UnitData[], finished: boolean, lotId: number) => void;
}) {
  const { t } = useTranslation();
  const meta = useMeta();
  const err = useErr();
  const toast = useToast();
  const [lotId, setLotId] = useState<number | null>(seed.lotId);
  const [typeId, setTypeId] = useState<number | null>(seed.typeId);
  const [serial, setSerial] = useState(seed.serial);
  const [specs, setSpecs] = useState<Specs>(seed.specs);
  const [cos, setCos] = useState<number | null>(seed.cosmeticGradeId);
  const [fun, setFun] = useState<number | null>(seed.functionalGradeId);
  const [notes, setNotes] = useState(seed.notes);
  const [qty, setQty] = useState('1');
  const [skipTest, setSkipTest] = useState(false);
  const [busy, setBusy] = useState<'save' | 'finish' | null>(null);
  const type = meta.type(typeId);
  const funItem = meta.item(fun);
  const notSellable = funItem?.meta?.sellable === false;
  const currentLot = lots.find((l) => l.id === lotId);
  /** El lote no requiere testeo individual: se puede registrar directo como disponible, sin grados ni serie. */
  const skippable = !!currentLot && !currentLot.requiresTesting;
  const cleanSpecs = useMemo(() => {
    const valid = new Set(meta.typeAttrs(typeId).map((x) => x.attr.key));
    return Object.fromEntries(Object.entries(specs).filter(([k, v]) => valid.has(k) && v !== undefined && v !== null && v !== ''));
  }, [meta, typeId, specs]);

  const changeType = (v: number | null) => {
    setTypeId(v);
    if (v) { const keep = new Set(meta.typeAttrs(v).map((x) => x.attr.key)); setSpecs((s) => Object.fromEntries(Object.entries(s).filter(([k]) => keep.has(k)))); } else setSpecs({});
  };

  /** Registro directo (lote sin testeo obligatorio): sin serie ni grados, queda disponible de una. */
  async function submitSkipTest() {
    if (!lotId) { toast.error(t('newUnit.lot_required')); return; }
    if (!typeId) { toast.error(t('newUnit.type_required')); return; }
    const n = type?.tracksSerial ? 1 : Math.min(500, Math.max(1, Math.floor(Number(qty) || 1)));
    setBusy('finish');
    try {
      let created: UnitData[];
      if (n === 1) {
        const u = await api.post<UnitData>(`/lots/${lotId}/units`, {
          equipmentTypeId: typeId, serialNumber: serial.trim() || null, specs: cleanSpecs, notes: notes.trim() || null, skipTest: true,
        });
        created = [u];
      } else {
        const r = await api.post<{ units: UnitData[] }>(`/lots/${lotId}/units/batch`, {
          equipmentTypeId: typeId, specs: cleanSpecs, quantity: n, notes: notes.trim() || null, skipTest: true,
        });
        created = r.units;
      }
      toast.success(n === 1 ? t('unitForm.finished', { code: created[0].code }) : t('testing.registered_many', { count: n }));
      onCreated(created, true, lotId);
    } catch (e) { toast.error(err(e)); } finally { setBusy(null); }
  }

  async function submit(finish: boolean) {
    if (!lotId) { toast.error(t('newUnit.lot_required')); return; }
    if (!typeId) { toast.error(t('newUnit.type_required')); return; }
    if (type?.tracksSerial && !serial.trim()) { toast.error(t('newUnit.serial_required')); return; }
    if (finish) {
      if (!cos || !fun) { toast.error(t('unitForm.grades_required')); return; }
      // Se validan los datos obligatorios antes de crear nada, para no dejar equipos a medias.
      for (const { attr, cfg } of meta.typeAttrs(typeId)) {
        if (cfg.requiredOnTest && cleanSpecs[attr.key] === undefined) { toast.error(t('errors.required_attribute', { attribute: meta.label(attr.label) })); return; }
      }
    }
    const n = type?.tracksSerial ? 1 : Math.min(500, Math.max(1, Math.floor(Number(qty) || 1)));
    setBusy(finish ? 'finish' : 'save');
    try {
      let created: UnitData[];
      if (n === 1) {
        let u = await api.post<UnitData>(`/lots/${lotId}/units`, {
          equipmentTypeId: typeId, serialNumber: serial.trim() || null, specs: cleanSpecs, notes: notes.trim() || null,
        });
        if (finish) {
          u = await api.post<UnitData>(`/units/${u.id}/finish-test`, {
            cosmeticGradeId: cos, functionalGradeId: fun, serialNumber: serial.trim() || null,
            specs: specsPatch(typeId, cleanSpecs, meta), notes: notes.trim() || null,
          });
        } else if (cos || fun) {
          // Guardar borrador conserva los grados ya elegidos.
          u = await api.patch<UnitData>(`/units/${u.id}`, { cosmeticGradeId: cos, functionalGradeId: fun });
        }
        created = [u];
      } else {
        // Sin serie (son equipos iguales entre sí): un solo pedido al servidor para las N unidades.
        const r = await api.post<{ units: UnitData[] }>(`/lots/${lotId}/units/batch`, { equipmentTypeId: typeId, specs: cleanSpecs, quantity: n, notes: notes.trim() || null });
        created = r.units;
        if (finish) {
          const done: UnitData[] = [];
          for (const u of created) {
            done.push(await api.post<UnitData>(`/units/${u.id}/finish-test`, { cosmeticGradeId: cos, functionalGradeId: fun, specs: specsPatch(typeId, cleanSpecs, meta), notes: notes.trim() || null }));
          }
          created = done;
        } else if (cos || fun) {
          const done: UnitData[] = [];
          for (const u of created) done.push(await api.patch<UnitData>(`/units/${u.id}`, { cosmeticGradeId: cos, functionalGradeId: fun }));
          created = done;
        }
      }
      toast.success(finish ? (n === 1 ? t('unitForm.finished', { code: created[0].code }) : t('testing.registered_many', { count: n })) : n === 1 ? t('common.saved') : t('testing.registered_many', { count: n }));
      onCreated(created, finish, lotId);
    } catch (e) {
      toast.error(err(e));
    } finally { setBusy(null); }
  }

  return (
    <div className="stack">
      {title && <div className="row spread"><strong>{title}</strong></div>}
      <div className="form-grid">
        <Field label={t('testing.lot')} required>
          <Select value={lotId ?? ''} onChange={(e) => {
            const v = e.target.value ? Number(e.target.value) : null;
            setLotId(v);
            const next = lots.find((l) => l.id === v);
            if (!next || next.requiresTesting) setSkipTest(false);
          }}>
            <option value="">{t('testing.pick_lot')}</option>
            {lots.map((l) => <option key={l.id} value={l.id}>{l.code}{l.supplierName ? ` — ${l.supplierName}` : ''}</option>)}
          </Select>
        </Field>
        <Field label={t('common.type')} required><TypeSelect value={typeId} onChange={changeType} /></Field>
        {typeId && (type?.tracksSerial ? (
          <Field label={t('unitForm.serial')} hint={t('testing.serial_hint')} required>
            <Input className="big-input" value={serial} autoFocus autoComplete="off" spellCheck={false} onChange={(e) => setSerial(e.target.value)} />
          </Field>
        ) : (
          <Field label={t('testing.qty')} hint={t('testing.qty_hint')}><Input type="number" min={1} max={500} value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
        ))}
      </div>
      {skippable && (
        <div>
          <Checkbox checked={skipTest} onChange={setSkipTest} label={t('testing.skip_test')} />
          <div className="field-hint">{t('testing.skip_test_hint')}</div>
        </div>
      )}
      {typeId && !skipTest && <SpecFields typeId={typeId} mode="unit" value={specs} onChange={setSpecs} />}
      {typeId && !skipTest && (
        <>
          <div className="grid grid-2">
            <Field label={t('unitForm.cosmetic')}><CatalogSelect catalog="cosmetic_grade" withCode value={cos} onChange={setCos} /></Field>
            <Field label={t('unitForm.functional')} hint={notSellable ? t('unitForm.not_sellable_hint') : undefined}><CatalogSelect catalog="functional_grade" withCode value={fun} onChange={setFun} /></Field>
          </div>
          <Field label={t('common.notes')}><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        </>
      )}
      {typeId && skipTest && (
        <Field label={t('common.notes')}><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      )}
      <div className="row form-actions" style={{ justifyContent: 'flex-end' }}>
        <Button variant="ghost" onClick={onCancel} disabled={!!busy}>{t('common.cancel')}</Button>
        {skipTest ? (
          <Button variant="primary" icon={<Zap size={16} />} loading={busy === 'finish'} disabled={!!busy} onClick={() => void submitSkipTest()}>{t('testing.skip_test_action')}</Button>
        ) : (
          <>
            <Button loading={busy === 'save'} disabled={!!busy && busy !== 'save'} onClick={() => void submit(false)}>{t('unitForm.save_draft')}</Button>
            <Button variant="primary" icon={<CheckCircle2 size={16} />} loading={busy === 'finish'} disabled={!!busy && busy !== 'finish'} onClick={() => void submit(true)}>{t('unitForm.finish')}</Button>
          </>
        )}
      </div>
    </div>
  );
}
