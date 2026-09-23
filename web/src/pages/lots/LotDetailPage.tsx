import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ArrowLeft, Boxes, Check, Coins, FileOutput, FlaskConical, Pencil, PackagePlus, Plus, Printer, Tag, Trash2 } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useMeta, type Specs } from '../../lib/meta';
import { useFmt } from '../../lib/useFmt';
import { useDoc } from '../../lib/docLang';
import { Badge, Button, Card, Checkbox, Empty, Field, Input, PageHeader, Spinner, Stepper, Tabs, Textarea, useConfirm, useErr, useToast, Select } from '../../components/ui';
import { useIsMobile } from '../../lib/useIsMobile';
import { Grades, SpecChips, StatusBadge, TypeLabel } from '../../components/fields';
import { LotLineModal, type LineLike } from '../../components/LotLineModal';
import { PrintLabelsModal } from '../../components/PrintLabelsModal';
import { DataGrid } from '../../components/grid/DataGrid';
import { useUnitColumns, type UnitRow } from '../../components/UnitGrid';
import { fetchAll, useAllRows } from '../../lib/useAllRows';
import { ExportMenu, type ExportOption } from '../../components/ExportMenu';
import { PendingMark } from '../../components/PendingMark';
import { printLabels } from '../../lib/printLabels';
import { templateForLot } from '../../lib/labels';
import { lotToLabel } from '../../lib/lotLabels';
import { useLabelCtx, useLabelTemplates } from '../../lib/useLabels';
import LotCostsTab from './LotCostsTab';
import { BulkCostModal, BulkPriceModal } from '../../components/PricingModals';

interface Line {
  id: number; lineNo: number; equipmentTypeId: number; specs: Specs; expectedQty: number; countedQty: number | null; isUnexpected: boolean;
  notes: string | null; tested: number; inTesting: number; difference: number | null;
  /** Costo por equipo que dio el reparto del lote (solo con permiso de ver costos). */
  unitCost?: number | null;
}
interface Lot {
  id: number; code: string; statusId: number; statusKey: string; supplierId: number | null; supplierName: string | null; purchaseDate: string;
  reference: string | null; currency: string; totalCost: number | null; notes: string | null; requiresTesting: boolean; createdAt: string; lines: Line[];
  /** Solo con permiso de ver costos. */
  canSeeCosts?: boolean; extrasTotal?: number; landedCost?: number; costAppliedAt?: string | null;
  offLines: { equipmentTypeId: number; specs: Specs; tested: number; inTesting: number }[];
  summary: { expected: number; counted: number; missing: number; surplus: number; uncountedLines: number; units: number; unlinkedUnits: number };
  /** Sin equipos ni conteos: todavía se puede eliminar. */
  deletable?: boolean;
  pendingSync?: boolean;
}
const FLOW = ['open', 'counting', 'counted', 'testing', 'closed'] as const;
const ACTIONS: Record<string, { action: string; primary?: boolean }[]> = {
  open: [{ action: 'start_count', primary: true }],
  counting: [{ action: 'finish_count', primary: true }, { action: 'start_testing' }],
  counted: [{ action: 'start_testing', primary: true }, { action: 'reopen_count' }],
  testing: [{ action: 'close', primary: true }, { action: 'reopen_count' }],
  closed: [{ action: 'reopen', primary: true }],
};

export default function LotDetailPage() {
  const { t } = useTranslation();
  const id = Number(useParams().id);
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as 'lines' | 'units' | 'costs' | 'info' | null) ?? 'lines';
  const { can } = useAuth();
  const meta = useMeta();
  const f = useFmt();
  const { t: dt, meta: dmeta, fmt: dfmt } = useDoc();   // el documento sale en el idioma de la empresa
  const qc = useQueryClient();
  const nav = useNavigate();
  const err = useErr();
  const toast = useToast();
  const confirm = useConfirm();
  const mobile = useIsMobile();
  const [counts, setCounts] = useState<Record<number, string>>({});
  const [modal, setModal] = useState<{ line: LineLike | null; unexpected?: boolean } | null>(null);
  const [sellingComplete, setSellingComplete] = useState(false);
  const [printingDoc, setPrintingDoc] = useState(false);
  const tpls = useLabelTemplates();
  const docCtx = useLabelCtx();

  const q = useQuery({ queryKey: ['lot', id], queryFn: () => api.get<Lot>(`/lots/${id}`) });
  const lot = q.data;
  const setLot = (l: Lot) => { qc.setQueryData(['lot', id], l); void qc.invalidateQueries({ queryKey: ['lots'] }); };
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['lot', id] }); void qc.invalidateQueries({ queryKey: ['lots'] }); };

  async function sellComplete() {
    if (!lot) return;
    if (!(await confirm({ title: t('lots.sell_complete_title'), message: t('lots.sell_complete_msg'), confirmLabel: t('lots.sell_complete_action') }))) return;
    setSellingComplete(true);
    try {
      const r = await api.post<{ units: { id: number; code: string }[] }>(`/lots/${id}/sell-complete`, {});
      refresh();
      nav('/orders/quick', { state: { codes: r.units.map((u) => u.code) } });
    } catch (e) { toast.error(err(e)); } finally { setSellingComplete(false); }
  }

  async function printLotDocument() {
    const tpl = templateForLot(tpls.data ?? []);
    if (!tpl) { toast.error(t('lots.doc_no_template')); return; }
    if (!lot) return;
    setPrintingDoc(true);
    try {
      const label = lotToLabel(lot, dmeta, dmeta.name(lot.statusId));
      await printLabels({ template: tpl, units: [label], ctx: docCtx });
    } catch (e) { toast.error(err(e)); } finally { setPrintingDoc(false); }
  }

  useEffect(() => { setCounts({}); }, [id]);

  const closed = lot?.statusKey === 'closed';
  const canCount = can('lots.count') && !closed;
  const dirty = Object.keys(counts).length > 0;

  const saveCounts = useMutation({
    mutationFn: () => api.put<Lot>(`/lots/${id}/counts`, {
      counts: Object.entries(counts).map(([lineId, v]) => ({ lineId: Number(lineId), countedQty: v.trim() === '' ? null : Math.max(0, Math.floor(Number(v))) })),
    }),
    onSuccess: (l) => { setLot(l); setCounts({}); toast.success(t('lots.counts_saved')); },
    onError: (e) => toast.error(err(e)),
  });

  async function transition(action: string) {
    if (action === 'close' && !(await confirm({ title: t('lots.confirm_close_title'), message: t('lots.confirm_close_msg'), confirmLabel: t('lots.action.close') }))) return;
    if (dirty && (action === 'finish_count' || action === 'start_testing')) {
      try { await saveCounts.mutateAsync(); } catch { return; }
    }
    const run = async (force: boolean) => {
      const l = await api.post<Lot>(`/lots/${id}/transition`, { action, force });
      setLot(l);
      toast.success(t('lots.status_updated'));
    };
    try { await run(false); } catch (e) {
      if (e instanceof ApiError && e.code === 'lines_not_counted') {
        if (await confirm({ title: t('lots.confirm_finish_title'), message: t('lots.confirm_finish_msg', { pending: e.params.pending }), confirmLabel: t('lots.finish_anyway') })) {
          try { await run(true); } catch (e2) { toast.error(err(e2)); }
        }
      } else toast.error(err(e));
    }
  }

  const delLine = async (l: Line) => {
    if (!(await confirm({ title: t('lots.delete_line_title'), danger: true, confirmLabel: t('common.delete') }))) return;
    try { await api.del(`/lots/${id}/lines/${l.id}`); refresh(); } catch (e) { toast.error(err(e)); }
  };
  const delLot = async () => {
    const msg = lot && lot.summary.units > 0
      ? t('lots.delete_lot_msg_units', { code: lot.code, count: lot.summary.units })
      : t('lots.delete_lot_msg');
    if (!(await confirm({ title: t('lots.delete_lot_title'), message: msg, danger: true, confirmLabel: t('common.delete') }))) return;
    try { await api.del(`/lots/${id}`); await qc.invalidateQueries({ queryKey: ['lots'] }); toast.success(t('common.deleted')); nav('/lots'); } catch (e) { toast.error(err(e)); }
  };

  const fillExpected = () => {
    if (!lot) return;
    const next = { ...counts };
    for (const l of lot.lines) if (l.countedQty === null && next[l.id] === undefined) next[l.id] = String(l.expectedQty);
    setCounts(next);
  };

  const idx = lot ? FLOW.indexOf(lot.statusKey as (typeof FLOW)[number]) : 0;

  if (q.isLoading) return <Spinner />;
  if (!lot) return <Empty title={t('errors.lot_not_found')} />;

  // ---- Reportes exportables del lote
  const lotOptions: ExportOption[] = [
    {
      id: 'report', label: t('lots.rep.report'), hint: t('lots.rep.report_hint'), filename: `Lote_${lot.code}`,
      build: () => {
        const lines = lot.lines;
        const sum = (fn: (l: Line) => number) => lines.reduce((a, l) => a + fn(l), 0);
        return {
          title: `${dt('lots.rep.report')} ${lot.code}`, sheetName: lot.code,
          preamble: [
            { cells: [dt('lots.rep.report'), lot.code], bold: true },
            { cells: [dt('common.status'), dmeta.name(lot.statusId)] },
            { cells: [dt('lots.supplier'), lot.supplierName ?? ''] },
            { cells: [dt('lots.purchase_date'), dfmt.date(lot.purchaseDate)] },
            { cells: [dt('lots.reference'), lot.reference ?? ''] },
            { cells: [dt('lots.expected'), lot.summary.expected] },
            { cells: [dt('lots.counted'), lot.summary.counted] },
            { cells: [dt('lots.missing'), lot.summary.missing] },
            { cells: [dt('lots.surplus'), lot.summary.surplus] },
            { cells: [dt('lots.tab_units'), lot.summary.units] },
          ],
          header: ['#', dt('common.type'), dt('lots.description'), dt('lots.expected'), dt('lots.counted'), dt('lots.difference'), dt('lots.tested'), dt('lots.in_testing_col')],
          types: ['number', 'text', 'text', 'number', 'number', 'number', 'number', 'number'],
          rows: [
            ...lines.map((l) => [l.lineNo, dmeta.typeName(l.equipmentTypeId), dmeta.describe(l.equipmentTypeId, l.specs, false).join(' · ') + (l.isUnexpected ? ` (${dt('lots.unexpected')})` : ''),
              l.expectedQty, l.countedQty, l.difference, l.tested, l.inTesting] as (string | number | null)[]),
            ...(lot.offLines ?? []).map((g) => ['', dmeta.typeName(g.equipmentTypeId), `${dmeta.describe(g.equipmentTypeId, g.specs, false).join(' · ')} (${dt('lots.off_lines')})`, null, null, null, g.tested, g.inTesting] as (string | number | null)[]),
          ],
          totals: ['', dt('common.total_label'), '', sum((l) => l.expectedQty), sum((l) => l.countedQty ?? 0), '', sum((l) => l.tested) + (lot.offLines ?? []).reduce((a, g) => a + g.tested, 0), sum((l) => l.inTesting) + (lot.offLines ?? []).reduce((a, g) => a + g.inTesting, 0)],
        };
      },
    },
    {
      id: 'units', label: t('lots.rep.units'), hint: t('lots.rep.units_hint'), filename: `Equipos_${lot.code}`,
      build: async () => {
        const units = await fetchAll<UnitRow>('/units', { lotId: id });
        return {
          title: `${dt('lots.rep.units')} ${lot.code}`, sheetName: lot.code, landscape: true,
          preamble: [{ cells: [dt('lots.rep.units'), lot.code], bold: true }, { cells: [dt('lots.tab_units'), units.length] }],
          header: [dt('common.code'), dt('units.serial'), dt('common.type'), dt('units.description'), dt('units.cosmetic'), dt('units.functional'), dt('common.status'), dt('units.location'), dt('units.order')],
          types: ['text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text'],
          rows: units.map((u) => [u.code, u.serialNumber ?? '', dmeta.typeName(u.equipmentTypeId), dmeta.describe(u.equipmentTypeId, u.specs, false).join(' · '),
            dmeta.item(u.cosmeticGradeId)?.code ?? '', dmeta.item(u.functionalGradeId)?.code ?? '', dmeta.name(u.statusId), u.slotCode ?? '', u.orderCode ?? '']),
        };
      },
    },
  ];

  return (
    <>
      <PageHeader
        back={<Link to="/lots" className="row gap-sm muted" style={{ marginBottom: 6 }}><ArrowLeft size={14} />{t('lots.title')}</Link>}
        title={<span className="row"><span className="mono">{lot.code}</span><StatusBadge id={lot.statusId} />{lot.pendingSync && <PendingMark label />}</span>}
        subtitle={[lot.supplierName, f.date(lot.purchaseDate), lot.reference].filter(Boolean).join(' · ')}
        actions={<>
          <ExportMenu options={lotOptions} />
          <Button variant="ghost" icon={<FileOutput size={16} />} loading={printingDoc} onClick={() => void printLotDocument()}>{t('lots.print_doc')}</Button>
          {can('units.test') && (lot.statusKey === 'counted' || lot.statusKey === 'testing') && (
            <Button icon={<FlaskConical size={16} />} onClick={() => nav(`/testing?lot=${id}`)}>{t('lots.go_testing')}</Button>
          )}
          {can('units.test') && !lot.requiresTesting && (lot.statusKey === 'counted' || lot.statusKey === 'testing') && (
            <Button icon={<Boxes size={16} />} loading={sellingComplete} onClick={() => void sellComplete()}>{t('lots.sell_complete')}</Button>
          )}
          {can('lots.close') && ACTIONS[lot.statusKey]?.map((a) => (
            <Button key={a.action} variant={a.primary ? 'primary' : 'secondary'} onClick={() => transition(a.action)}>{t(`lots.action.${a.action}`)}</Button>
          ))}
        </>}
      />

      <div className="step-flow" style={{ marginBottom: 16 }}>
        {FLOW.map((k, i) => <span key={k} className={`step ${i < idx ? 'done' : i === idx ? 'current' : ''}`}>{meta.name(meta.sysId('lot_status', k))}</span>)}
      </div>

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <div className="card kpi"><span className="kpi-value">{f.int(lot.summary.expected)}</span><span className="kpi-label">{t('lots.expected')}</span></div>
        <div className="card kpi"><span className="kpi-value">{f.int(lot.summary.counted)}</span><span className="kpi-label">{t('lots.counted')}{lot.summary.uncountedLines > 0 && ` · ${t('lots.uncounted_lines', { n: lot.summary.uncountedLines })}`}</span></div>
        <div className="card kpi"><span className="kpi-value" style={{ color: lot.summary.missing ? 'var(--danger)' : undefined }}>{f.int(lot.summary.missing)}</span><span className="kpi-label">{t('lots.missing')}</span></div>
        <div className="card kpi"><span className="kpi-value" style={{ color: lot.summary.surplus ? 'var(--info)' : undefined }}>{f.int(lot.summary.surplus)}</span><span className="kpi-label">{t('lots.surplus')}</span></div>
      </div>

      <Tabs value={tab} onChange={(v) => setSp(v === 'lines' ? {} : { tab: v })}
        tabs={[{ id: 'lines', label: t('lots.tab_lines'), count: lot.lines.length }, { id: 'units', label: t('lots.tab_units'), count: lot.summary.units },
        ...(can('costs.view') ? [{ id: 'costs' as const, label: t('costs.tab') }] : []), { id: 'info', label: t('lots.tab_info') }]} />

      {tab === 'lines' && (
        <Card padded={false}
          title={t('lots.lines_and_count')}
          actions={<>
            {canCount && lot.lines.some((l) => l.countedQty === null) && <Button size="sm" variant="ghost" onClick={fillExpected}>{t('lots.fill_expected')}</Button>}
            {canCount && <Button size="sm" icon={<PackagePlus size={14} />} onClick={() => setModal({ line: null, unexpected: true })}>{t('lots.add_unexpected')}</Button>}
            {can('lots.edit') && !closed && <Button size="sm" icon={<Plus size={14} />} onClick={() => setModal({ line: null })}>{t('lots.add_line')}</Button>}
          </>}>
          {lot.lines.length === 0 ? <Empty title={t('lots.no_lines')} hint={t('lots.no_lines_hint')} /> : mobile ? (
            <LinesMobile lot={lot} counts={counts} setCounts={setCounts} canCount={canCount} canEdit={can('lots.edit') && !closed}
              onEdit={(l) => setModal({ line: l })} onDelete={delLine} onUnits={() => setSp({ tab: 'units' })} />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr>
                  <th>#</th><th>{t('common.type')}</th><th>{t('lots.description')}</th>
                  <th className="num">{t('lots.expected')}</th><th className="num">{t('lots.counted')}</th><th className="num">{t('lots.difference')}</th>
                  <th className="num">{t('lots.tested')}</th>{lot.canSeeCosts && <th className="num">{t('costs.col_unit')}</th>}<th />
                </tr></thead>
                <tbody>
                  {lot.lines.map((l, i) => {
                    const cur = counts[l.id] ?? (l.countedQty === null ? '' : String(l.countedQty));
                    const num = cur.trim() === '' ? null : Number(cur);
                    const diff = num === null ? null : num - l.expectedQty;
                    return (
                      <tr key={l.id}>
                        <td className="muted">{l.lineNo}</td>
                        <td><TypeLabel typeId={l.equipmentTypeId} />{l.isUnexpected && <div><Badge tone="warn">{t('lots.unexpected')}</Badge></div>}</td>
                        <td><SpecChips typeId={l.equipmentTypeId} specs={l.specs} />{l.notes && <div className="sub">{l.notes}</div>}</td>
                        <td className="num">{l.expectedQty}</td>
                        <td className="num">
                          {canCount ? (
                            <span className="row gap-sm" style={{ justifyContent: 'flex-end' }}>
                              <input className="input count-input" type="number" min={l.tested} inputMode="numeric" data-count-idx={i} value={cur}
                                placeholder={String(l.expectedQty)}
                                onChange={(e) => setCounts((c) => ({ ...c, [l.id]: e.target.value }))}
                                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (document.querySelector(`[data-count-idx="${i + 1}"]`) as HTMLInputElement | null)?.focus(); } }} />
                              <button className="icon-btn" title={t('lots.same_as_expected')} onClick={() => setCounts((c) => ({ ...c, [l.id]: String(l.expectedQty) }))}><Check size={16} /></button>
                            </span>
                          ) : (l.countedQty ?? <span className="muted">—</span>)}
                        </td>
                        <td className="num">{diff === null ? <span className="muted">—</span> : diff === 0 ? <span className="diff-zero">✓</span> : <span className={diff > 0 ? 'diff-pos' : 'diff-neg'}>{diff > 0 ? `+${diff}` : diff}</span>}</td>
                        <td className="num">{l.tested}{l.inTesting > 0 && <div className="sub">{t('lots.in_testing', { n: l.inTesting })}</div>}</td>
                        {lot.canSeeCosts && <td className="num">{l.unitCost === null || l.unitCost === undefined ? <span className="muted">—</span> : f.money(l.unitCost, lot.currency)}</td>}
                        <td className="cell-actions">
                          {can('lots.edit') && !closed && !l.isUnexpected && <button className="icon-btn" title={t('common.edit')} onClick={() => setModal({ line: l })}><Pencil size={16} /></button>}
                          {can('lots.edit') && !closed && l.tested === 0 && <button className="icon-btn" title={t('common.delete')} onClick={() => delLine(l)}><Trash2 size={16} /></button>}
                        </td>
                      </tr>
                    );
                  })}
                  {(lot.offLines ?? []).map((g, gi) => (
                    <tr key={`off-${gi}`} className="clickable" onClick={() => setSp({ tab: 'units' })}>
                      <td className="muted">—</td>
                      <td><TypeLabel typeId={g.equipmentTypeId} /><div><Badge tone="warn" title={t('lots.off_lines_hint')}>{t('lots.off_lines')}</Badge></div></td>
                      <td><SpecChips typeId={g.equipmentTypeId} specs={g.specs} /></td>
                      <td className="num muted">—</td><td className="num muted">—</td><td className="num muted">—</td>
                      <td className="num"><strong>{g.tested}</strong>{g.inTesting > 0 && <div className="sub">{t('lots.in_testing', { n: g.inTesting })}</div>}</td>
                      {lot.canSeeCosts && <td className="num muted">—</td>}
                      <td className="cell-actions"><Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setSp({ tab: 'units' }); }}>{t('lots.view_units')}</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {dirty && (
            <div className="sticky-actions">
              <span className="muted grow">{t('lots.unsaved_counts', { n: Object.keys(counts).length })}</span>
              <Button variant="ghost" onClick={() => setCounts({})}>{t('common.cancel')}</Button>
              <Button variant="primary" loading={saveCounts.isPending} onClick={() => saveCounts.mutate()}>{t('lots.save_counts')}</Button>
            </div>
          )}
        </Card>
      )}

      {tab === 'lines' && lot.summary.unlinkedUnits > 0 && (
        <div className="alert alert-warn" style={{ marginTop: 12 }}><AlertTriangle size={18} /><span>{t('lots.unlinked_units', { n: lot.summary.unlinkedUnits })}</span></div>
      )}

      {tab === 'units' && <LotUnits lotId={id} />}
      {tab === 'costs' && can('costs.view') && <LotCostsTab lotId={id} />}
      {tab === 'info' && <LotInfo lot={lot} onSaved={refresh} onDelete={can('lots.delete') && lot.deletable ? delLot : undefined} />}

      {modal && <LotLineModal lotId={id} line={modal.line} unexpected={modal.unexpected} onClose={() => setModal(null)} onSaved={refresh} />}
    </>
  );
}

/** Líneas del lote en el teléfono: una tarjeta por línea con selector de cantidad contada (− / +) en vez de una tabla. */
function LinesMobile({ lot, counts, setCounts, canCount, canEdit, onEdit, onDelete, onUnits }: {
  lot: Lot; counts: Record<number, string>; setCounts: (fn: (c: Record<number, string>) => Record<number, string>) => void; canCount: boolean; canEdit: boolean;
  onEdit: (l: Line) => void; onDelete: (l: Line) => void; onUnits: () => void;
}) {
  const { t } = useTranslation();
  const f = useFmt();
  return (
    <ul className="ml-lines">
      {lot.lines.map((l) => {
        const cur = counts[l.id] ?? (l.countedQty === null ? '' : String(l.countedQty));
        const num = cur.trim() === '' ? null : Number(cur);
        const diff = num === null ? null : num - l.expectedQty;
        const changed = counts[l.id] !== undefined;
        return (
          <li key={l.id} className={`ml-line ${changed ? 'changed' : ''}`}>
            <div className="ml-head">
              <span className="muted ml-no">#{l.lineNo}</span>
              <span className="grow"><TypeLabel typeId={l.equipmentTypeId} /></span>
              {l.isUnexpected && <Badge tone="warn">{t('lots.unexpected')}</Badge>}
            </div>
            <SpecChips typeId={l.equipmentTypeId} specs={l.specs} />
            {l.notes && <div className="sub">{l.notes}</div>}
            <div className="ml-stats">
              <div><span className="ml-k">{t('lots.expected')}</span><strong>{l.expectedQty}</strong></div>
              <div><span className="ml-k">{t('lots.difference')}</span>
                {diff === null ? <span className="muted">—</span> : diff === 0 ? <span className="diff-zero">✓</span> : <span className={diff > 0 ? 'diff-pos' : 'diff-neg'}>{diff > 0 ? `+${diff}` : diff}</span>}</div>
              <div><span className="ml-k">{t('lots.tested')}</span><strong>{l.tested}</strong>{l.inTesting > 0 && <span className="sub"> · {t('lots.in_testing', { n: l.inTesting })}</span>}</div>
            </div>
            {lot.canSeeCosts && l.unitCost !== null && l.unitCost !== undefined && <div className="sub">{t('costs.col_unit')}: <strong>{f.money(l.unitCost, lot.currency)}</strong></div>}
            {canCount ? (
              <div className="ml-count">
                <span className="ml-k">{t('lots.counted')}</span>
                <Stepper value={num === null ? '' : Math.max(0, Math.floor(num))} start={l.expectedQty} min={l.tested} placeholder={String(l.expectedQty)} label={t('lots.counted')}
                  onChange={(v) => setCounts((c) => ({ ...c, [l.id]: String(v) }))} />
                <Button size="sm" variant={num === l.expectedQty ? 'primary' : 'secondary'} icon={<Check size={16} />} onClick={() => setCounts((c) => ({ ...c, [l.id]: String(l.expectedQty) }))}>{t('lots.same_as_expected')}</Button>
              </div>
            ) : (
              <div className="ml-count"><span className="ml-k">{t('lots.counted')}</span><strong>{l.countedQty ?? '—'}</strong></div>
            )}
            {canEdit && (!l.isUnexpected || l.tested === 0) && (
              <div className="ml-actions">
                {!l.isUnexpected && <Button size="sm" variant="ghost" icon={<Pencil size={15} />} onClick={() => onEdit(l)}>{t('common.edit')}</Button>}
                {l.tested === 0 && <Button size="sm" variant="ghost" icon={<Trash2 size={15} />} onClick={() => onDelete(l)}>{t('common.delete')}</Button>}
              </div>
            )}
          </li>
        );
      })}
      {(lot.offLines ?? []).map((g, gi) => (
        <li key={`off-${gi}`} className="ml-line" onClick={onUnits}>
          <div className="ml-head"><span className="grow"><TypeLabel typeId={g.equipmentTypeId} /></span><Badge tone="warn" title={t('lots.off_lines_hint')}>{t('lots.off_lines')}</Badge></div>
          <SpecChips typeId={g.equipmentTypeId} specs={g.specs} />
          <div className="ml-stats"><div><span className="ml-k">{t('lots.tested')}</span><strong>{g.tested}</strong>{g.inTesting > 0 && <span className="sub"> · {t('lots.in_testing', { n: g.inTesting })}</span>}</div></div>
          <div className="ml-actions"><Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); onUnits(); }}>{t('lots.view_units')}</Button></div>
        </li>
      ))}
    </ul>
  );
}

function LotUnits({ lotId }: { lotId: number }) {
  const { t } = useTranslation();
  const nav = useNavigate();
  const q = useAllRows<UnitRow>(['units', { lotId }], '/units', { lotId, sort: 'code' });
  const columns = useUnitColumns(['lot']);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [print, setPrint] = useState(false);
  const { can } = useAuth();
  const [priceFor, setPriceFor] = useState<number[] | null>(null);
  const [costFor, setCostFor] = useState<number[] | null>(null);
  return (
    <>
      <DataGrid id="lot-units" rows={q.data ?? []} loading={q.isLoading} columns={columns} rowId={(u) => u.id} onRowClick={(u) => nav(`/units/${u.id}`)}
        selectable selected={sel} onSelectedChange={setSel} exportName={t('lots.tab_units')} emptyTitle={t('lots.no_units')}
        toolbar={<>
          <Button size="sm" icon={<Printer size={14} />} disabled={!sel.size} onClick={() => setPrint(true)}>{t('lots.print_labels', { n: sel.size })}</Button>
          {can('prices.manage') && <Button size="sm" icon={<Tag size={14} />} disabled={!sel.size} onClick={() => setPriceFor([...sel])}>{t('pricing.set_price')}</Button>}
          {can('costs.manage') && <Button size="sm" icon={<Coins size={14} />} disabled={!sel.size} onClick={() => setCostFor([...sel])}>{t('pricing.set_cost')}</Button>}
        </>} />
      {print && <PrintLabelsModal unitIds={[...sel]} onClose={() => setPrint(false)} />}
      {priceFor && <BulkPriceModal unitIds={priceFor} canCost={can('costs.view')} onClose={() => setPriceFor(null)} onDone={() => setSel(new Set())} />}
      {costFor && <BulkCostModal unitIds={costFor} onClose={() => setCostFor(null)} onDone={() => setSel(new Set())} />}
    </>
  );
}

function LotInfo({ lot, onSaved, onDelete }: { lot: Lot; onSaved: () => void; onDelete?: () => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const err = useErr();
  const toast = useToast();
  const suppliers = useQuery({ queryKey: ['suppliers', 'all'], queryFn: () => api.get<{ items: { id: number; name: string }[] }>('/suppliers?all=1'), enabled: can('suppliers.view') });
  const [supplierId, setSupplierId] = useState(lot.supplierId ? String(lot.supplierId) : '');
  const [date, setDate] = useState(lot.purchaseDate.slice(0, 10));
  const [reference, setReference] = useState(lot.reference ?? '');
  const initialCost = lot.totalCost === null || lot.totalCost === undefined ? '' : String(lot.totalCost);
  const [cost, setCost] = useState(initialCost);
  const [notes, setNotes] = useState(lot.notes ?? '');
  const [requiresTesting, setRequiresTesting] = useState(lot.requiresTesting);
  const [busy, setBusy] = useState(false);
  const editable = can('lots.edit') && lot.statusKey !== 'closed';

  async function save() {
    setBusy(true);
    try {
      await api.patch(`/lots/${lot.id}`, {
        supplierId: supplierId ? Number(supplierId) : null, purchaseDate: date, reference: reference || null, notes: notes || null,
        requiresTesting,
        // El costo de la mercancía solo lo cambia quien puede administrar costos.
        ...(can('costs.manage') && cost !== initialCost ? { totalCost: cost === '' ? null : Number(cost) } : {}),
      });
      toast.success(t('common.saved')); onSaved();
    } catch (e) { toast.error(err(e)); } finally { setBusy(false); }
  }
  return (
    <Card title={t('lots.tab_info')}>
      <div className="stack">
        <div className="form-grid">
          {can('suppliers.view') && (
            <Field label={t('lots.supplier')}>
              <Select disabled={!editable} value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                <option value="">—</option>
                {suppliers.data?.items.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </Field>
          )}
          <Field label={t('lots.purchase_date')}><Input disabled={!editable} type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label={t('lots.reference')}><Input disabled={!editable} value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
          {can('costs.view') && <Field label={t('lots.total_cost', { currency: lot.currency })}><Input disabled={!editable || !can('costs.manage')} type="number" min={0} step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} /></Field>}
        </div>
        <Field label={t('common.notes')}><Textarea disabled={!editable} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        <div>
          <Checkbox disabled={!editable} checked={!requiresTesting} onChange={(v) => setRequiresTesting(!v)} label={t('lots.skip_testing')} />
          <div className="field-hint">{t('lots.skip_testing_hint')}</div>
        </div>
        <div className="row spread">
          <div>
            {onDelete
              ? <Button variant="danger" icon={<Trash2 size={16} />} onClick={onDelete}>{t('lots.delete_lot')}</Button>
              : can('lots.delete') && <span className="muted">{t('lots.delete_only_empty')}</span>}
          </div>
          {editable && <Button variant="primary" loading={busy} onClick={save}>{t('common.save')}</Button>}
        </div>
      </div>
    </Card>
  );
}
