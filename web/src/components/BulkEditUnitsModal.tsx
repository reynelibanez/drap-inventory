import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { useMeta, type Specs } from '../lib/meta';
import { Button, Checkbox, Modal, Textarea, useErr, useToast } from './ui';
import { CatalogSelect, SpecFields } from './fields';
import type { UnitRow } from './UnitGrid';

/**
 * Cambiar los mismos datos en varios equipos a la vez: se eligen (con casillas) los campos a cambiar y su valor
 * nuevo, y se aplica igual a todos los equipos seleccionados. Los campos técnicos (marca, modelo, RAM…) solo se
 * pueden cambiar si todos los seleccionados son del mismo tipo de equipo; el grado cosmético, el funcional y las
 * notas siempre están disponibles, sea cual sea el tipo.
 */
export function BulkEditUnitsModal({ units, onClose, onDone }: { units: UnitRow[]; onClose: () => void; onDone?: () => void }) {
  const { t } = useTranslation();
  const meta = useMeta();
  const err = useErr();
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);

  const typeIds = useMemo(() => [...new Set(units.map((u) => u.equipmentTypeId))], [units]);
  const typeId = typeIds.length === 1 ? typeIds[0] : null;
  const attrRows = typeId ? meta.typeAttrs(typeId) : [];

  const [enabledSpecKeys, setEnabledSpecKeys] = useState<Set<string>>(new Set());
  const [specs, setSpecs] = useState<Specs>({});
  function toggleSpecKey(key: string, on: boolean) {
    setEnabledSpecKeys((s) => { const n = new Set(s); if (on) n.add(key); else n.delete(key); return n; });
    if (!on) setSpecs((v) => { if (!(key in v)) return v; const n = { ...v }; delete n[key]; return n; });
  }

  const [editCosmetic, setEditCosmetic] = useState(false);
  const [cosmeticGradeId, setCosmeticGradeId] = useState<number | null>(null);
  const [editFunctional, setEditFunctional] = useState(false);
  const [functionalGradeId, setFunctionalGradeId] = useState<number | null>(null);
  const [editNotes, setEditNotes] = useState(false);
  const [notes, setNotes] = useState('');

  const nothingChosen = enabledSpecKeys.size === 0 && !editCosmetic && !editFunctional && !editNotes;

  async function save() {
    setBusy(true);
    try {
      const body: Record<string, unknown> = { unitIds: units.map((u) => u.id) };
      if (enabledSpecKeys.size > 0) {
        const patch: Record<string, unknown> = {};
        for (const key of enabledSpecKeys) patch[key] = specs[key] ?? null;
        body.specs = patch;
      }
      if (editCosmetic) body.cosmeticGradeId = cosmeticGradeId;
      if (editFunctional) body.functionalGradeId = functionalGradeId;
      if (editNotes) body.notes = notes.trim() || null;
      const r = await api.post<{ count: number }>('/units/bulk-edit', body);
      toast.success(t('units.bulk_edit_saved', { count: r.count }));
      for (const k of ['units', 'unit', 'dashboard']) void qc.invalidateQueries({ queryKey: [k] });
      onDone?.();
      onClose();
    } catch (e) { toast.error(err(e)); } finally { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} size="lg" title={t('units.bulk_edit_title', { count: units.length })}
      footer={<>
        <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" loading={busy} disabled={nothingChosen} onClick={save}>{t('common.apply')}</Button>
      </>}>
      <div className="stack">
        <p className="field-hint" style={{ marginTop: 0 }}>{t('units.bulk_edit_hint')}</p>
        <p className="field-hint">{t('units.bulk_edit_sold_hint')}</p>
        {typeId === null && <p className="row gap-sm" style={{ color: 'var(--warn, #d97706)' }}>{t('units.bulk_edit_mixed_types')}</p>}

        <div className="stack" style={{ gap: 10 }}>
          <div>
            <Checkbox checked={editCosmetic} onChange={setEditCosmetic} label={t('units.cosmetic')} />
            {editCosmetic && <CatalogSelect catalog="cosmetic_grade" withCode value={cosmeticGradeId} onChange={setCosmeticGradeId} empty={t('units.bulk_edit_clear')} />}
          </div>
          <div>
            <Checkbox checked={editFunctional} onChange={setEditFunctional} label={t('units.functional')} />
            {editFunctional && <CatalogSelect catalog="functional_grade" withCode value={functionalGradeId} onChange={setFunctionalGradeId} empty={t('units.bulk_edit_clear')} />}
          </div>
          <div>
            <Checkbox checked={editNotes} onChange={setEditNotes} label={t('common.notes')} />
            {editNotes && <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t('units.bulk_edit_notes_placeholder')} />}
          </div>
        </div>

        {typeId !== null && attrRows.length > 0 && (
          <>
            <h4 style={{ marginBottom: 4 }}>{t('units.bulk_edit_fields', { type: meta.typeName(typeId) })}</h4>
            <div className="row wrap gap-sm">
              {attrRows.map(({ attr }) => (
                <Checkbox key={attr.key} checked={enabledSpecKeys.has(attr.key)} onChange={(c) => toggleSpecKey(attr.key, c)} label={meta.label(attr.label)} />
              ))}
            </div>
            {enabledSpecKeys.size > 0 && (
              <SpecFields typeId={typeId} value={specs} onChange={setSpecs} mode="unit" optional only={(key) => enabledSpecKeys.has(key)} />
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
