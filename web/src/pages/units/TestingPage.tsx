import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Copy, History, ListChecks, Pencil, Plus, Printer, ScanLine, Trash2 } from 'lucide-react';
import { api, ApiError, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useMeta } from '../../lib/meta';
import { Badge, Button, Card, Checkbox, Empty, Field, Input, Modal, PageHeader, Progress, Select, Spinner, Tabs, Textarea, useConfirm, useErr, useToast } from '../../components/ui';
import { DataGrid, type GridColumn } from '../../components/grid/DataGrid';
import { useUnitColumns, type UnitRow } from '../../components/UnitGrid';
import { useAllRows } from '../../lib/useAllRows';
import { CatalogSelect, Grades, SpecChips, StatusBadge, TypeLabel } from '../../components/fields';
import { UnitForm, type UnitData } from '../../components/UnitForm';
import { NewUnitForm, draftFromUnit, emptyDraft, type Draft } from '../../components/NewUnitForm';
import { PlaceUnitsModal } from '../../components/PlaceUnitsModal';
import { BottomSheet } from '../../components/mobile/BottomSheet';
import { useIsMobile } from '../../lib/useIsMobile';
import { PrintLabelsModal } from '../../components/PrintLabelsModal';
import { useLabelCtx, useLabelTemplates } from '../../lib/useLabels';
import { getAutoPrint, printUnitLabels, setAutoPrint } from '../../lib/printUnits';

interface LotRow { id: number; code: string; statusKey: string; supplierName: string | null; units: number; counted: number; inTesting: number; requiresTesting: boolean }
interface LotDetail { id: number; code: string; statusKey: string; lines: { id: number; lineNo: number }[]; summary: { counted: number; units: number; unlinkedUnits: number; unitsByStatus: { statusId: number; n: number }[] } }
type View = 'all' | 'testing' | 'done';
type Panel = { kind: 'draft'; seed: Draft; nonce: number; title: string } | { kind: 'unit'; id: number } | null;

export default function TestingPage() {
  const { t } = useTranslation();
  const meta = useMeta();
  const { can, company } = useAuth();
  const err = useErr();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [sp, setSp] = useSearchParams();
  const lotId = Number(sp.get('lot')) || null;
  const [panel, setPanel] = useState<Panel>(null);
  const [placeIds, setPlaceIds] = useState<number[] | null>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [bulk, setBulk] = useState(false);
  const [autoPrint, setAutoPrintState] = useState(getAutoPrint);
  const [printIds, setPrintIds] = useState<number[] | null>(null);
  const labelTpls = useLabelTemplates();
  const labelCtx = useLabelCtx();
  const [mineOnly, setMineOnly] = useState(false);
  const [view, setView] = useState<View>('all');
  const [serialLookup, setSerialLookup] = useState('');
  const mobile = useIsMobile();

  const lots = useQuery({
    queryKey: ['lots', 'testable'],
    queryFn: () => api.get<{ items: LotRow[] }>('/lots?openOnly=1&pageSize=100'),
    select: (d) => d.items.filter((l) => l.statusKey === 'counted' || l.statusKey === 'testing'),
  });
  const lot = useQuery({ queryKey: ['lot', lotId], queryFn: () => api.get<LotDetail>(`/lots/${lotId}`), enabled: !!lotId });

  // Todos los equipos del lote (coincidan o no con sus líneas); el grid filtra, ordena y pagina en el navegador.
  const list = useAllRows<UnitData>(['units', 'testing-list', lotId], '/units', { lotId, sort: 'newest' }, !!lotId);
  const allItems = list.data ?? [];
  const items = useMemo(() => allItems.filter((u) => (view === 'all' || (view === 'testing') === (u.statusKey === 'testing')) && (!mineOnly || u.testerNumber === company?.techNumber)), [allItems, view, mineOnly, company?.techNumber]);
  const activeId = panel?.kind === 'unit' ? panel.id : null;
  const active = useQuery({ queryKey: ['unit', activeId], queryFn: () => api.get<UnitData>(`/units/${activeId}`), enabled: !!activeId });

  const testingCount = lot.data?.summary.unitsByStatus.find((s) => meta.sysKey(s.statusId) === 'testing')?.n ?? 0;
  const totalCount = lot.data?.summary.units ?? 0;
  const lineNo = (id: number | null) => lot.data?.lines.find((l) => l.id === id)?.lineNo;
  const testable = lots.data ?? [];
  const defaultLot = lotId && testable.some((l) => l.id === lotId) ? lotId : null;

  useEffect(() => { setChecked(new Set()); }, [lotId]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['units'] }); void qc.invalidateQueries({ queryKey: ['unit'] }); void qc.invalidateQueries({ queryKey: ['lot'] });
    void qc.invalidateQueries({ queryKey: ['lots'] }); void qc.invalidateQueries({ queryKey: ['dashboard'] });
  };

  const openDraft = (seed: Draft, title: string) => {
    setPanel({ kind: 'draft', seed, nonce: Date.now(), title });
    setTimeout(() => document.getElementById('test-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 30);
  };
  const lotForClone = (u: UnitData) => (testable.some((l) => l.id === u.lotId) ? u.lotId : defaultLot);

  const newBlank = () => openDraft(emptyDraft(defaultLot), t('testing.new_title'));
  const clone = (u: UnitData) => openDraft(draftFromUnit(u, { keepGrades: true, lotId: lotForClone(u) }), t('testing.clone_title', { code: u.code }));
  async function repeatLast() {
    try {
      let last: UnitData | undefined;
      try {
        last = (await api.get<{ items: UnitData[] }>(`/units${qs({ testerNumber: company?.techNumber, sort: 'newest', pageSize: 1 })}`)).items[0];
      } catch (e) {
        // Sin conexión: se usa el último equipo de este técnico que ya está en pantalla.
        last = allItems.find((u) => u.testerNumber === company?.techNumber);
        if (!last && !(e instanceof ApiError && e.status === 0)) throw e;
      }
      if (!last) { toast.info(t('testing.no_previous')); return; }
      openDraft(draftFromUnit(last, { keepGrades: false, lotId: lotForClone(last) }), t('testing.repeat_title', { code: last.code }));
    } catch (e) { toast.error(err(e)); }
  }

  /** Elimina un borrador en testeo o un equipo ya testeado que sigue disponible (no reservado, vendido ni no vendible). */
  async function discard(u: { id: number; code: string; statusKey: string }) {
    const draft = u.statusKey === 'testing';
    if (!draft && u.statusKey !== 'available') return;
    if (!(await confirm(draft
      ? { title: t('testing.delete_title', { code: u.code }), message: t('testing.delete_msg'), danger: true, confirmLabel: t('testing.delete_draft') }
      : { title: t('units.delete_title', { code: u.code }), message: t('units.delete_msg'), danger: true, confirmLabel: t('common.delete') }))) return;
    try {
      await api.del(`/units/${u.id}`);
      toast.success(draft ? t('testing.deleted', { code: u.code }) : t('units.deleted'));
      setPanel((p) => (p?.kind === 'unit' && p.id === u.id ? null : p));
      setChecked((s) => { const n = new Set(s); n.delete(u.id); return n; });
      refresh();
    } catch (e) { toast.error(err(e)); }
  }

  /** ¿Se puede abrir este equipo para editarlo aquí? En testeo → formulario de testeo; ya testeado → editar datos; vendido → no. */
  const canOpen = (u: { statusKey: string }) => (u.statusKey === 'testing' ? can('units.test') : u.statusKey !== 'sold' && can('units.edit'));
  const canDelete = (u: { statusKey: string }) => (u.statusKey === 'testing' ? can('units.test') : u.statusKey === 'available' && can('units.edit'));
  const openUnit = (u: { id: number; statusKey: string }) => {
    if (!canOpen(u)) return;
    setPanel({ kind: 'unit', id: u.id });
    setTimeout(() => document.getElementById('test-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 30);
  };

  /**
   * Busca por número de serie dentro del lote elegido. Si el equipo ya existe (por ejemplo, viene de una
   * importación con verificación) lo abre con todos sus datos ya cargados, para revisar si coinciden con el
   * equipo físico. Si no existe, abre un registro nuevo con esa serie ya puesta.
   */
  function findBySerial() {
    const serial = serialLookup.trim();
    if (!serial || !lotId) return;
    const match = allItems.find((u) => u.serialNumber && u.serialNumber.toLowerCase() === serial.toLowerCase());
    if (match) {
      if (!canOpen(match)) { toast.error(t('testing.serial_no_access', { code: match.code })); return; }
      openUnit(match);
    } else {
      openDraft({ ...emptyDraft(defaultLot), serial }, t('testing.new_title'));
      toast.info(t('testing.serial_not_found', { serial }));
    }
    setSerialLookup('');
  }

  /** Al terminar el testeo imprime la etiqueta asociada al tipo de cada equipo (si está activado). */
  const autoPrintUnits = (ids: number[]) => {
    const tpls = (labelTpls.data ?? []).filter((x) => x.isActive);
    if (!autoPrint || !tpls.length || !ids.length) return;
    if (ids.some((id) => id < 0) || !navigator.onLine) { toast.info(t('sync.labels_later')); return; }   // aún sin código definitivo / sin conexión
    printUnitLabels(ids, tpls, labelCtx).catch((e: unknown) => toast.error(err(e)));
  };

  /** Avisa dónde quedó cada equipo (ubicación automática). Los que no tienen espacio se ofrecen para ubicar a mano. */
  const placementFeedback = (units: { id: number; code: string; slotId: number | null; autoPlaced?: { slotCode: string } | null; pendingSync?: boolean }[]) => {
    units = units.filter((u) => !u.pendingSync);   // los guardados sin conexión se ubican solos al sincronizar
    const placed = units.filter((u) => u.autoPlaced);
    if (placed.length === 1) toast.info(t('testing.auto_placed', { code: placed[0].code, slot: placed[0].autoPlaced!.slotCode }));
    else if (placed.length > 1) toast.info(t('place.done', { count: placed.length }));
    const pending = units.filter((u) => !u.slotId);
    if (pending.length) {
      if (units.length === 1) toast.error(t('testing.not_placed', { code: pending[0].code }));
      if (can('locations.assign')) setPlaceIds(pending.map((u) => u.id));
    }
  };

  const onCreated = (units: UnitData[], finished: boolean, unitLotId: number) => {
    refresh();
    if (unitLotId !== lotId) setSp({ lot: String(unitLotId) });
    if (finished) {
      autoPrintUnits(units.map((u) => u.id));
      setPanel(null);
      placementFeedback(units);
    } else setPanel(units.length === 1 ? { kind: 'unit', id: units[0].id } : null);
  };
  const onFinished = (u: UnitData) => {
    refresh();
    autoPrintUnits([u.id]);
    setPanel(null);
    placementFeedback([u]);
  };

  const testingIds = new Set(allItems.filter((u) => u.statusKey === 'testing').map((u) => u.id));
  const bulkIds = [...checked].filter((id) => testingIds.has(id));
  const gridCols = useUnitColumns(['lot']);
  const columns: GridColumn<UnitData & UnitRow>[] = useMemo(() => [
    ...gridCols.slice(0, 4) as GridColumn<UnitData & UnitRow>[],
    { key: 'line', title: t('testing.col_line'), type: 'number', width: 100, value: (u) => (u.lotLineId ? lineNo(u.lotLineId) ?? null : null), render: (u) => (u.lotLineId ? <span className="muted">#{lineNo(u.lotLineId)}</span> : <Badge tone="warn" title={t('testing.no_line_hint')}>{t('testing.no_line')}</Badge>) },
    ...gridCols.slice(4) as GridColumn<UnitData & UnitRow>[],
    { key: 'testedAt', title: t('testing.tested_at'), type: 'datetime', hidden: true, width: 160 },
    {
      key: '_actions', title: '', actions: true as const, width: 170,
      render: (u) => (
        <>
          {canOpen(u) && <Button size="sm" variant="ghost" icon={<Pencil size={14} />} title={t('testing.edit')} aria-label={t('testing.edit')} onClick={() => openUnit(u)} />}
          <Button size="sm" variant="ghost" icon={<Copy size={14} />} title={`${t('testing.clone')}: ${t('testing.clone_hint')}`} aria-label={t('testing.clone')} onClick={() => clone(u)} />
          <Button size="sm" variant="ghost" icon={<Printer size={14} />} title={t('labels.print.title')} aria-label={t('labels.print.title')} onClick={() => setPrintIds([u.id])} />
          {canDelete(u) && <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} title={u.statusKey === 'testing' ? t('testing.delete_draft') : t('testing.delete_available')} aria-label={t('common.delete')} onClick={() => void discard(u)} />}
        </>
      ),
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [gridCols, t, lot.data, testable]);

  // Contenido del panel de un equipo ya registrado (igual en escritorio y en teléfono).
  const unitBody = active.isLoading ? <Spinner /> : active.data && active.data.statusKey === 'testing' ? (
    <UnitForm key={active.data.id} unit={active.data} mode="test" onSaved={() => refresh()} onFinished={onFinished} />
  ) : active.data && active.data.statusKey !== 'sold' ? (
    <UnitForm key={active.data.id + active.data.statusKey} unit={active.data} mode="edit" onSaved={() => { refresh(); setPanel(null); }} />
  ) : active.data ? <Empty icon={<CheckCircle2 size={32} />} title={t('testing.sold_locked')} />
  : <Empty icon={<CheckCircle2 size={32} />} title={t('testing.select_unit')} hint={t('testing.select_unit_hint')} />;

  if (lots.isLoading) return <Spinner />;

  return (
    <>
      <PageHeader title={t('testing.title')} subtitle={t('testing.subtitle')}
        actions={<>
          <Button variant="primary" icon={<Plus size={16} />} disabled={!testable.length} onClick={newBlank}>{t('testing.new_unit')}</Button>
          <Button icon={<History size={16} />} disabled={!testable.length} onClick={() => void repeatLast()}>{t('testing.repeat_last')}</Button>
          <span title={t('labels.auto.hint')}><Checkbox checked={autoPrint} onChange={(v) => { setAutoPrintState(v); setAutoPrint(v); }} label={t('labels.auto.toggle')} /></span>
        </>} />
      <Card>
        <div className="row wrap">
          <Field label={t('testing.lot')} className="grow">
            <Select value={lotId ?? ''} onChange={(e) => { setSp(e.target.value ? { lot: e.target.value } : {}); setPanel((p) => (p?.kind === 'unit' ? null : p)); }}>
              <option value="">{t('testing.pick_lot')}</option>
              {testable.map((l) => <option key={l.id} value={l.id}>{l.code}{l.supplierName ? ` — ${l.supplierName}` : ''} ({l.units}/{l.counted})</option>)}
            </Select>
          </Field>
          {lot.data && (
            <div style={{ minWidth: 220 }}>
              <div className="sub">{t('testing.progress', { units: lot.data.summary.units, counted: lot.data.summary.counted })}</div>
              <Progress value={lot.data.summary.units} max={Math.max(lot.data.summary.counted, 1)} tone="good" />
            </div>
          )}
          {lotId && <Link to={`/lots/${lotId}`}>{t('testing.open_lot')}</Link>}
        </div>
        {testable.length === 0 && <div className="alert alert-info" style={{ marginTop: 12 }}>{t('testing.no_lots')}</div>}
        {lotId && (
          <div className="row wrap" style={{ marginTop: 12 }}>
            <Field label={t('testing.search_serial')} hint={t('testing.search_serial_hint')} className="grow">
              <div className="row gap-sm">
                <Input className="big-input" value={serialLookup} autoComplete="off" spellCheck={false}
                  placeholder={t('testing.serial_hint')}
                  onChange={(e) => setSerialLookup(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); findBySerial(); } }} />
                <Button icon={<ScanLine size={16} />} disabled={!serialLookup.trim()} onClick={findBySerial}>{t('testing.search_serial_action')}</Button>
              </div>
            </Field>
          </div>
        )}
      </Card>

      {panel && (mobile ? (
        // En el teléfono, registrar o completar un equipo abre una hoja a pantalla casi completa (más cómodo que un formulario en la página).
        <BottomSheet open full onClose={() => setPanel(null)}
          title={panel.kind === 'draft' ? panel.title : active.data ? <span className="mono">{active.data.code}</span> : t('testing.unit_data')}>
          {panel.kind === 'draft' ? (
            <NewUnitForm key={panel.nonce} seed={panel.seed} lots={testable} onCancel={() => setPanel(null)} onCreated={onCreated} />
          ) : (
            <div className="stack">
              {active.data && (
                <div className="row wrap gap-sm">
                  {active.data.statusKey === 'testing' ? <Badge tone="warn">{t('testing.in_testing_badge')}</Badge> : <StatusBadge id={active.data.statusId} />}
                  <span className="grow" />
                  <Button size="sm" icon={<Copy size={14} />} onClick={() => clone(active.data!)}>{t('testing.clone')}</Button>
                  {canDelete(active.data) && <Button size="sm" variant="danger" icon={<Trash2 size={14} />} aria-label={t('common.delete')} onClick={() => void discard(active.data!)} />}
                </div>
              )}
              {unitBody}
            </div>
          )}
        </BottomSheet>
      ) : (
        <div id="test-panel" style={{ marginTop: 16, scrollMarginTop: 12 }}>
          {panel.kind === 'draft' ? (
            <Card title={panel.title}>
              <NewUnitForm key={panel.nonce} seed={panel.seed} lots={testable} onCancel={() => setPanel(null)} onCreated={onCreated} />
            </Card>
          ) : (
            <Card title={active.data ? <span className="row"><span className="mono">{active.data.code}</span>{active.data.statusKey === 'testing' ? <Badge tone="warn">{t('testing.in_testing_badge')}</Badge> : <StatusBadge id={active.data.statusId} />}</span> : t('testing.unit_data')}
              actions={active.data && <>
                <Button size="sm" icon={<Copy size={14} />} onClick={() => clone(active.data!)}>{t('testing.clone')}</Button>
                {canDelete(active.data) && <Button size="sm" variant="danger" icon={<Trash2 size={14} />} onClick={() => void discard(active.data!)}>{active.data.statusKey === 'testing' ? t('testing.delete_draft') : t('common.delete')}</Button>}
                <Button size="sm" variant="ghost" onClick={() => setPanel(null)}>{t('common.close')}</Button>
              </>}>
              {unitBody}
            </Card>
          )}
        </div>
      ))}

      {lotId && lot.data && (
        <Card className="test-list" padded={false} title={t('testing.lot_units', { count: totalCount })}
          actions={<>
            <label className="checkbox"><input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} /><span>{t('testing.only_mine')}</span></label>
            {bulkIds.length > 0 && <Button size="sm" icon={<ListChecks size={14} />} onClick={() => setBulk(true)}>{t('testing.finish_selected', { count: bulkIds.length })}</Button>}
          </>}>
          <div className="list-toolbar">
            <Tabs<View> value={view} onChange={setView} tabs={[
              { id: 'all', label: t('testing.view_all'), count: totalCount },
              { id: 'testing', label: t('testing.view_testing'), count: testingCount },
              { id: 'done', label: t('testing.view_done'), count: totalCount - testingCount },
            ]} />
          </div>
          {lot.data.summary.unlinkedUnits > 0 && <div className="alert alert-info" style={{ margin: '0 16px 12px' }}>{t('testing.unlinked_note', { n: lot.data.summary.unlinkedUnits })}</div>}
          <DataGrid<UnitData & UnitRow> id="testing-units" bare rows={items as (UnitData & UnitRow)[]} loading={list.isLoading} columns={columns} rowId={(u) => u.id}
            selectable selected={checked} onSelectedChange={setChecked} exportName={`${t('testing.title')} ${lot.data.code}`}
            rowClass={(u) => (u.id === activeId ? 'selected' : undefined)} emptyTitle={t('testing.none_units')}
            onRowClick={openUnit} />
        </Card>
      )}

      {bulk && <BulkFinishModal ids={bulkIds} units={allItems} onClose={() => setBulk(false)}
        onDone={(results) => { setChecked(new Set()); refresh(); autoPrintUnits(results.map((r) => r.id)); placementFeedback(results); }} />}
      {printIds && <PrintLabelsModal unitIds={printIds} onClose={() => setPrintIds(null)} />}
      {placeIds && <PlaceUnitsModal unitIds={placeIds} onClose={() => setPlaceIds(null)} />}
    </>
  );
}

/** Termina el testeo de varios equipos a la vez con los mismos grados (útil para memorias, cables, genéricos). */
function BulkFinishModal({ ids, units, onClose, onDone }: { ids: number[]; units: UnitData[]; onClose: () => void; onDone: (results: { id: number; code: string; slotId: number | null; autoPlaced?: { slotCode: string } | null; pendingSync?: boolean }[]) => void }) {
  const { t } = useTranslation();
  const [cos, setCos] = useState<number | null>(null);
  const [fun, setFun] = useState<number | null>(null);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<{ code: string; msg: string }[]>([]);
  const err = useErr();

  async function run() {
    setBusy(true); setFailed([]);
    const ok: { id: number; code: string; slotId: number | null; autoPlaced?: { slotCode: string } | null; pendingSync?: boolean }[] = []; const bad: { code: string; msg: string }[] = [];
    for (const id of ids) {
      const u = units.find((x) => x.id === id);
      try {
        const r = await api.post<UnitData>(`/units/${id}/finish-test`, { cosmeticGradeId: cos, functionalGradeId: fun, notes: notes.trim() || undefined });
        ok.push({ id, code: r.code, slotId: r.slotId, autoPlaced: r.autoPlaced, pendingSync: (r as any).pendingSync });
      } catch (e) { bad.push({ code: u?.code ?? String(id), msg: err(e) }); }
    }
    setBusy(false);
    if (bad.length) { setFailed(bad); if (ok.length) onDone(ok); return; }
    onDone(ok); onClose();
  }
  return (
    <Modal open onClose={onClose} title={t('testing.bulk_title', { count: ids.length })}
      footer={<><Button variant="ghost" onClick={onClose}>{t('common.close')}</Button><Button variant="primary" loading={busy} disabled={!cos || !fun} onClick={run}>{t('testing.bulk_apply')}</Button></>}>
      <div className="stack">
        <p className="muted">{t('testing.bulk_hint')}</p>
        <div className="grid grid-2">
          <Field label={t('unitForm.cosmetic')} required><CatalogSelect catalog="cosmetic_grade" withCode value={cos} onChange={setCos} /></Field>
          <Field label={t('unitForm.functional')} required><CatalogSelect catalog="functional_grade" withCode value={fun} onChange={setFun} /></Field>
        </div>
        <Field label={t('common.notes')}><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        {failed.length > 0 && (
          <div className="alert alert-bad"><div className="stack sm">
            <strong>{t('testing.bulk_failed', { count: failed.length })}</strong>
            {failed.map((f) => <div key={f.code}><span className="mono">{f.code}</span>: {f.msg}</div>)}
          </div></div>
        )}
      </div>
    </Modal>
  );
}
