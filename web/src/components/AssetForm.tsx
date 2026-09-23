import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { useMeta, type Specs } from '../lib/meta';
import { Button, Field, Input, Textarea, useErr, useToast } from './ui';
import { CatalogSelect, SpecFields, TypeSelect, specsPatch } from './fields';

/** Activo de la empresa: herramienta o equipo propio (no se vende). */
export interface AssetData {
  id: number; code: string; name: string | null; equipmentTypeId: number; serialNumber: string | null; specs: Specs; notes: string | null;
  statusId: number; statusKey: string | null; assignedTo: string | null; location: string | null; acquiredAt: string | null;
  createdAt: string; updatedAt: string; createdByName: string | null;
}

/**
 * Formulario de un activo. Sin `asset` registra uno nuevo (con la opción de registrar varios iguales);
 * con `asset` edita el existente. Usa los mismos tipos de equipo y atributos que el inventario.
 */
export function AssetForm({ asset, onSaved, onCancel }: { asset?: AssetData; onSaved: (items: AssetData[]) => void; onCancel?: () => void }) {
  const { t } = useTranslation();
  const meta = useMeta();
  const err = useErr();
  const toast = useToast();
  const [typeId, setTypeId] = useState<number | null>(asset?.equipmentTypeId ?? null);
  const [name, setName] = useState(asset?.name ?? '');
  const [serial, setSerial] = useState(asset?.serialNumber ?? '');
  const [specs, setSpecs] = useState<Specs>(asset?.specs ?? {});
  const [statusId, setStatusId] = useState<number | null>(asset?.statusId ?? meta.sysId('asset_status', 'in_use') ?? null);
  const [assignedTo, setAssignedTo] = useState(asset?.assignedTo ?? '');
  const [location, setLocation] = useState(asset?.location ?? '');
  const [acquiredAt, setAcquiredAt] = useState(asset?.acquiredAt ?? '');
  const [notes, setNotes] = useState(asset?.notes ?? '');
  const [quantity, setQuantity] = useState('1');
  const [busy, setBusy] = useState(false);
  const typeChanged = !!asset && typeId !== asset.equipmentTypeId;
  const qty = Math.max(1, Math.min(200, Math.floor(Number(quantity)) || 1));

  function changeType(v: number | null) {
    setTypeId(v);
    setSpecs({});   // los atributos dependen del tipo
  }

  async function save() {
    if (!typeId) { toast.error(t('assets.type_required')); return; }
    setBusy(true);
    try {
      const common = {
        name: name.trim() || null, serialNumber: serial.trim() || null, assignedTo: assignedTo.trim() || null, location: location.trim() || null,
        acquiredAt: acquiredAt || null, notes: notes.trim() || null,
      };
      if (asset) {
        const a = await api.patch<AssetData>(`/assets/${asset.id}`, {
          ...common, equipmentTypeId: typeId, specs: specsPatch(typeId, specs, meta), ...(statusId ? { statusId } : {}),
        });
        toast.success(t('common.saved'));
        onSaved([a]);
      } else {
        const r = await api.post<{ items: AssetData[] }>('/assets', { ...common, equipmentTypeId: typeId, specs, statusId, quantity: qty });
        toast.success(r.items.length === 1 ? t('assets.created_one', { code: r.items[0].code }) : t('assets.created_many', { count: r.items.length, first: r.items[0].code, last: r.items[r.items.length - 1].code }));
        onSaved(r.items);
      }
    } catch (e) { toast.error(err(e)); } finally { setBusy(false); }
  }

  return (
    <div className="stack">
      <div className="form-grid">
        <Field label={t('common.type')} required hint={typeChanged ? t('assets.type_change_hint') : undefined}>
          <TypeSelect value={typeId} onChange={changeType} />
        </Field>
        <Field label={t('assets.name')} hint={t('assets.name_hint')}><Input value={name} maxLength={150} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label={t('common.status')}><CatalogSelect catalog="asset_status" value={statusId} onChange={setStatusId} /></Field>
        <Field label={t('assets.serial')} hint={t('assets.serial_hint')}><Input value={serial} onChange={(e) => setSerial(e.target.value)} autoComplete="off" spellCheck={false} /></Field>
        <Field label={t('assets.assigned_to')} hint={t('assets.assigned_to_hint')}><Input value={assignedTo} maxLength={150} onChange={(e) => setAssignedTo(e.target.value)} /></Field>
        <Field label={t('assets.location')} hint={t('assets.location_hint')}><Input value={location} maxLength={150} onChange={(e) => setLocation(e.target.value)} /></Field>
        <Field label={t('assets.acquired_at')}><Input type="date" value={acquiredAt} onChange={(e) => setAcquiredAt(e.target.value)} /></Field>
        {!asset && (
          <Field label={t('assets.quantity')} hint={serial.trim() ? t('assets.quantity_serial') : t('assets.quantity_hint')}>
            <Input type="number" min={1} max={200} value={quantity} disabled={!!serial.trim()} onChange={(e) => setQuantity(e.target.value)} style={{ width: 120 }} />
          </Field>
        )}
      </div>
      {typeId && <SpecFields key={typeId} typeId={typeId} mode="unit" value={specs} onChange={setSpecs} optional />}
      <Field label={t('common.notes')}><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        {onCancel && <Button variant="ghost" onClick={onCancel}>{t('common.cancel')}</Button>}
        <Button variant="primary" loading={busy} disabled={!typeId} onClick={save}>
          {asset ? t('common.save') : qty > 1 && !serial.trim() ? t('assets.register_many', { count: qty }) : t('assets.register')}
        </Button>
      </div>
    </div>
  );
}
