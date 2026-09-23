import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowLeft, ArrowUp, ChevronDown, GripVertical, Plus, Save, Sigma, Trash2, X } from 'lucide-react';
import { api } from '../../lib/api';
import { Alert } from '../../components/Alert';
import { Popover } from '../../components/grid/Popover';
import { Badge, Button, Card, Empty, Field, Input, PageHeader, Select, Spinner, Textarea, useConfirm, useDebounced, useErr, useToast } from '../../components/ui';
import { ResultGrid } from './ResultGrid';
import {
  AGGS_FOR, useLang, useReportsMeta,
  type Agg, type FType, type MetaDataset, type MetaField, type ReportDef, type ReportFull, type ReportsMeta, type RunResult,
} from './reportTypes';

/* ------------------------------------------------------------------ estado del diseñador */

let seq = 1;
const uid = () => seq++;

interface DCol { uid: number; field: string; label: string; agg: Agg | '' }
interface DFilter { uid: number; field: string; op: string; a: string; b: string; list: string[] }
interface DSort { colUid: number; dir: 'asc' | 'desc' }
interface State {
  name: string; description: string; visibility: 'private' | 'company'; dataset: string;
  mode: 'detail' | 'summary'; cols: DCol[]; filters: DFilter[]; sort: DSort[]; limit: string;
}

const NO_VALUE_OPS = ['empty', 'notEmpty', 'thisMonth', 'thisYear'];
const isNum = (t: FType) => t === 'number' || t === 'money';
const isDate = (t: FType) => t === 'date' || t === 'datetime';
const defaultOp = (type: FType) => (type === 'text' ? 'contains' : type === 'select' ? 'in' : type === 'boolean' ? 'is' : isDate(type) ? 'lastDays' : 'eq');
const defaultAgg = (type: FType): Agg | '' => (isNum(type) ? 'sum' : '');
const newFilter = (f: MetaField): DFilter => ({ uid: uid(), field: f.key, op: defaultOp(f.type), a: f.type === 'boolean' ? 'true' : '', b: '', list: [] });

function firstCols(ds: MetaDataset | undefined): DCol[] {
  const pick = ds?.key === 'units' ? ['code', 'type', 'status'] : (ds?.fields ?? []).slice(0, 3).map((f) => f.key);
  return pick.filter((k) => ds?.fields.some((f) => f.key === k)).map((field) => ({ uid: uid(), field, label: '', agg: '' as const }));
}

function blank(meta: ReportsMeta): State {
  const ds = meta.datasets.find((d) => d.key === 'units') ?? meta.datasets[0];
  return { name: '', description: '', visibility: 'private', dataset: ds?.key ?? '', mode: 'detail', cols: firstCols(ds), filters: [], sort: [], limit: '' };
}

function fromReport(r: ReportFull): State {
  const cols = r.definition.columns.map((c) => ({ uid: uid(), field: c.field, label: c.label ?? '', agg: (c.agg ?? '') as Agg | '' }));
  return {
    name: r.name, description: r.description ?? '', visibility: r.visibility, dataset: r.dataset, mode: r.definition.mode, cols,
    filters: r.definition.filters.map((f) => ({ uid: uid(), field: f.field, op: f.op, a: f.a ?? '', b: f.b ?? '', list: f.list ?? [] })),
    sort: r.definition.sort.filter((s) => cols[s.col]).map((s) => ({ colUid: cols[s.col]!.uid, dir: s.dir })),
    limit: r.definition.limit ? String(r.definition.limit) : '',
  };
}

/** Un filtro a medias (sin valor) no se envía: se ignora hasta completarlo. */
function filterComplete(f: DFilter, type: FType): boolean {
  if (NO_VALUE_OPS.includes(f.op)) return true;
  if (type === 'select') return f.list.length > 0;
  if (type === 'boolean') return f.a === 'true' || f.a === 'false';
  if (f.op === 'between') return !!(f.a.trim() || f.b.trim());
  return !!f.a.trim();
}

function toDef(s: State, fields: Map<string, MetaField>): ReportDef {
  const cols = s.cols.filter((c) => c.field === '*' || fields.has(c.field));
  const uids = cols.map((c) => c.uid);
  const limit = Number(s.limit);
  return {
    mode: s.mode,
    columns: cols.map((c) => ({ field: c.field, ...(c.label.trim() ? { label: c.label.trim() } : {}), ...(s.mode === 'summary' && c.agg ? { agg: c.agg } : {}) })),
    filters: s.filters.filter((f) => fields.has(f.field) && filterComplete(f, fields.get(f.field)!.type)).map((f) => {
      const type = fields.get(f.field)!.type;
      return {
        field: f.field, op: f.op,
        ...(type === 'select' ? { list: f.list } : NO_VALUE_OPS.includes(f.op) ? {} : { a: f.a.trim(), ...(f.op === 'between' ? { b: f.b.trim() } : {}) }),
      };
    }),
    sort: s.sort.map((x) => ({ col: uids.indexOf(x.colUid), dir: x.dir })).filter((x) => x.col >= 0),
    ...(Number.isInteger(limit) && limit > 0 ? { limit: Math.min(limit, 50000) } : {}),
  };
}

/* ------------------------------------------------------------------ página */

export default function ReportDesignerPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const meta = useReportsMeta();
  const info = useQuery({ queryKey: ['report', Number(id)], queryFn: () => api.get<ReportFull>(`/reports/${id}`), enabled: !!id });
  if (meta.isLoading || (id && info.isLoading)) return <Spinner />;
  if (!meta.data) return <Empty title={t('errors.internal')} />;
  if (id && !info.data) return <Empty title={t('errors.report_not_found')} action={<Link to="/reports">{t('reports.back')}</Link>} />;
  if (id && info.data && !info.data.canEdit) return <Empty title={t('errors.report_edit_forbidden')} action={<Link to={`/reports/${id}`}>{t('reports.back')}</Link>} />;
  if (!id && !meta.data.canCreate) return <Empty title={t('errors.missing_permission')} />;
  return <Designer key={id ?? 'new'} meta={meta.data} report={info.data} />;
}

function Designer({ meta, report }: { meta: ReportsMeta; report?: ReportFull }) {
  const { t } = useTranslation();
  const nav = useNavigate();
  const qc = useQueryClient();
  const lang = useLang();
  const confirm = useConfirm();
  const err = useErr();
  const toast = useToast();
  const [s, setS] = useState<State>(() => (report ? fromReport(report) : blank(meta)));
  const patch = (p: Partial<State>) => setS((x) => ({ ...x, ...p }));

  const ds = meta.datasets.find((d) => d.key === s.dataset);
  const fields = useMemo(() => new Map((ds?.fields ?? []).map((f) => [f.key, f])), [ds]);
  const countLabel = t('reports.d_count_rows');
  const fieldLabel = (key: string) => (key === '*' ? countLabel : fields.get(key)?.label ?? key);
  const colTitle = (c: DCol) => c.label.trim() || (c.field === '*' ? countLabel : c.agg ? `${t(`reports.d_agg.${c.agg}`)} ${fieldLabel(c.field)}` : fieldLabel(c.field));

  // ---------- columnas
  function addCol(f: MetaField) {
    patch({ cols: [...s.cols, { uid: uid(), field: f.key, label: '', agg: s.mode === 'summary' ? defaultAgg(f.type) : '' }] });
  }
  const addCount = () => patch({ cols: [...s.cols, { uid: uid(), field: '*', label: '', agg: 'count' }] });
  const moveCol = (from: number, to: number) => {
    if (from === to || to < 0 || to >= s.cols.length) return;
    const next = [...s.cols];
    const [it] = next.splice(from, 1);
    next.splice(to, 0, it!);
    patch({ cols: next });
  };
  const setCol = (u: number, p: Partial<DCol>) => patch({ cols: s.cols.map((c) => (c.uid === u ? { ...c, ...p } : c)) });
  const removeCol = (u: number) => patch({ cols: s.cols.filter((c) => c.uid !== u), sort: s.sort.filter((x) => x.colUid !== u) });

  function setMode(mode: 'detail' | 'summary') {
    if (mode === s.mode) return;
    if (mode === 'summary') {
      const cols = s.cols.map((c) => ({ ...c, agg: c.agg || defaultAgg(fields.get(c.field)?.type ?? 'text') }));
      if (!cols.some((c) => c.agg)) cols.push({ uid: uid(), field: '*', label: '', agg: 'count' });
      patch({ mode, cols });
    } else {
      const cols = s.cols.filter((c) => c.field !== '*').map((c) => ({ ...c, agg: '' as const }));
      patch({ mode, cols, sort: s.sort.filter((x) => cols.some((c) => c.uid === x.colUid)) });
    }
  }

  async function changeDataset(key: string) {
    if (key === s.dataset) return;
    if (s.cols.length || s.filters.length) {
      if (!(await confirm({ title: t('reports.d_change_title'), message: t('reports.d_change_msg'), confirmLabel: t('reports.d_change_ok') }))) return;
    }
    const next = meta.datasets.find((d) => d.key === key);
    setS((x) => ({ ...x, dataset: key, mode: 'detail', cols: firstCols(next), filters: [], sort: [] }));
  }

  // ---------- validez y vista previa
  const unknownCols = s.cols.filter((c) => c.field !== '*' && !fields.has(c.field));
  const unknownFilters = s.filters.filter((f) => !fields.has(f.field));
  const aggCount = s.cols.filter((c) => c.agg).length;
  const problem = !ds ? 'no_access' : s.cols.length === 0 ? 'need_cols' : s.mode === 'summary' && aggCount === 0 ? 'need_agg' : unknownCols.length || unknownFilters.length ? 'unavailable' : null;
  const def = useMemo(() => (ds ? toDef(s, fields) : null), [s, fields, ds]);
  const previewKey = useDebounced(JSON.stringify({ d: s.dataset, def, lang }), 600);
  const preview = useQuery({
    queryKey: ['report-preview', previewKey], enabled: !problem && !!def, retry: false, placeholderData: keepPreviousData, refetchOnWindowFocus: false,
    queryFn: () => { const p = JSON.parse(previewKey) as { d: string; def: ReportDef }; return api.post<RunResult>(`/reports/preview?lang=${lang}`, { dataset: p.d, definition: p.def }); },
  });

  const save = useMutation({
    mutationFn: () => {
      const body = { name: s.name.trim(), description: s.description.trim() || null, dataset: s.dataset, visibility: s.visibility, definition: def };
      return report ? api.put<{ ok: true }>(`/reports/${report.id}?lang=${lang}`, body) : api.post<{ id: number }>(`/reports?lang=${lang}`, body);
    },
    onSuccess: (res: any) => {
      const id = report?.id ?? res.id;
      void qc.invalidateQueries({ queryKey: ['reports'] });
      void qc.invalidateQueries({ queryKey: ['report', id] });
      void qc.invalidateQueries({ queryKey: ['report-run', id] });
      toast.success(t('reports.d_saved'));
      nav(`/reports/${id}`);
    },
    onError: (e) => toast.error(err(e)),
  });
  const canSave = s.name.trim().length > 0 && !problem;

  return (
    <>
      <PageHeader
        back={<Link to={report ? `/reports/${report.id}` : '/reports'} className="row gap-sm muted" style={{ marginBottom: 6 }}><ArrowLeft size={15} />{t('reports.back')}</Link>}
        title={report ? t('reports.d_edit') : t('reports.d_new')} subtitle={t('reports.d_subtitle')}
        actions={<>
          <Button variant="ghost" onClick={() => nav(report ? `/reports/${report.id}` : '/reports')}>{t('common.cancel')}</Button>
          <Button variant="primary" icon={<Save size={15} />} loading={save.isPending} disabled={!canSave} onClick={() => save.mutate()}>{t('common.save')}</Button>
        </>} />

      {!ds && <Alert kind="bad">{t('reports.d_no_access')}</Alert>}

      <div className="stack" style={{ gap: 14 }}>
        {/* ---------------- datos generales */}
        <Card title={t('reports.d_general')}>
          <div className="grid grid-2">
            <Field label={t('common.name')} required><Input value={s.name} maxLength={120} onChange={(e) => patch({ name: e.target.value })} placeholder={t('reports.d_name_ph')} autoFocus={!report} /></Field>
            <Field label={t('reports.d_source')} hint={t('reports.d_source_hint')}>
              <Select value={s.dataset} onChange={(e) => void changeDataset(e.target.value)}>
                {!ds && <option value={s.dataset}>{t(`reports.ds.${s.dataset}`, { defaultValue: s.dataset })}</option>}
                {meta.datasets.map((d) => <option key={d.key} value={d.key}>{t(`reports.ds.${d.key}`, { defaultValue: d.label })}</option>)}
              </Select>
            </Field>
            <Field label={t('common.description')}><Textarea value={s.description} maxLength={500} onChange={(e) => patch({ description: e.target.value })} style={{ minHeight: 44 }} /></Field>
            <Field label={t('reports.d_visibility')}>
              <div className="rp-radios">
                <label className="rp-radio"><input type="radio" name="vis" checked={s.visibility === 'private'} onChange={() => patch({ visibility: 'private' })} />
                  <span><strong>{t('reports.d_vis_private')}</strong><span className="muted">{t('reports.d_vis_private_hint')}</span></span></label>
                <label className={`rp-radio ${meta.canShare ? '' : 'disabled'}`}><input type="radio" name="vis" disabled={!meta.canShare} checked={s.visibility === 'company'} onChange={() => patch({ visibility: 'company' })} />
                  <span><strong>{t('reports.d_vis_company')}</strong><span className="muted">{meta.canShare ? t('reports.d_vis_company_hint') : t('reports.d_vis_company_denied')}</span></span></label>
              </div>
            </Field>
          </div>
        </Card>

        {/* ---------------- columnas */}
        <Card title={t('reports.d_columns')} actions={
          <div className="rp-seg" role="radiogroup" aria-label={t('reports.d_mode')}>
            <button type="button" role="radio" aria-checked={s.mode === 'detail'} className={s.mode === 'detail' ? 'on' : ''} onClick={() => setMode('detail')} title={t('reports.d_mode_detail_hint')}>{t('reports.d_mode_detail')}</button>
            <button type="button" role="radio" aria-checked={s.mode === 'summary'} className={s.mode === 'summary' ? 'on' : ''} onClick={() => setMode('summary')} title={t('reports.d_mode_summary_hint')}>{t('reports.d_mode_summary')}</button>
          </div>}>
          <p className="muted" style={{ marginBottom: 10 }}>{s.mode === 'detail' ? t('reports.d_mode_detail_hint') : t('reports.d_mode_summary_hint')}</p>
          <div className="rp-cols">
            <FieldPicker ds={ds} onAdd={addCol} extra={s.mode === 'summary' ? <Button size="sm" variant="secondary" icon={<Sigma size={14} />} onClick={addCount}>{t('reports.d_count_rows')}</Button> : null} />
            <div>
              <div className="section-title">{t('reports.d_chosen')} ({s.cols.length})</div>
              {s.cols.length === 0 && <p className="muted">{t('reports.d_no_cols')}</p>}
              <ol className="rp-chosen">
                {s.cols.map((c, i) => {
                  const f = fields.get(c.field);
                  const type: FType = c.field === '*' ? 'number' : f?.type ?? 'text';
                  const bad = c.field !== '*' && !f;
                  return (
                    <li key={c.uid} className={`rp-col ${bad ? 'bad' : ''}`} draggable
                      onDragStart={(e) => { e.dataTransfer.setData('text/plain', String(i)); e.dataTransfer.effectAllowed = 'move'; }}
                      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
                      onDrop={(e) => { e.preventDefault(); const from = Number(e.dataTransfer.getData('text/plain')); if (Number.isInteger(from)) moveCol(from, i); }}>
                      <span className="rp-grip" aria-hidden><GripVertical size={16} /></span>
                      <div className="rp-col-body">
                        <div className="rp-col-name">
                          <strong>{fieldLabel(c.field)}</strong>
                          {bad && <Badge tone="bad">{t('reports.d_unavailable')}</Badge>}
                        </div>
                        <div className="rp-col-ctl">
                          {s.mode === 'summary' && c.field !== '*' && (
                            <Select value={c.agg} aria-label={t('reports.d_agg_label')} onChange={(e) => setCol(c.uid, { agg: e.target.value as Agg | '' })}>
                              <option value="">{t('reports.d_group_by')}</option>
                              {AGGS_FOR[type].map((a) => <option key={a} value={a}>{t(`reports.d_agg.${a}`)}</option>)}
                            </Select>
                          )}
                          <Input value={c.label} maxLength={80} aria-label={t('reports.d_col_title')} onChange={(e) => setCol(c.uid, { label: e.target.value })} placeholder={colTitle({ ...c, label: '' })} />
                        </div>
                      </div>
                      <div className="rp-col-btns">
                        <button type="button" className="icon-btn" disabled={i === 0} title={t('reports.d_move_up')} onClick={() => moveCol(i, i - 1)}><ArrowUp size={15} /></button>
                        <button type="button" className="icon-btn" disabled={i === s.cols.length - 1} title={t('reports.d_move_down')} onClick={() => moveCol(i, i + 1)}><ArrowDown size={15} /></button>
                        <button type="button" className="icon-btn" title={t('reports.d_remove')} onClick={() => removeCol(c.uid)}><X size={15} /></button>
                      </div>
                    </li>
                  );
                })}
              </ol>
              {s.cols.length > 1 && <p className="muted" style={{ marginTop: 6 }}>{t('reports.d_drag_hint')}</p>}
            </div>
          </div>
        </Card>

        {/* ---------------- filtros */}
        <Card title={t('reports.d_filters')} actions={ds && <Button size="sm" variant="secondary" icon={<Plus size={14} />} onClick={() => ds.fields[0] && patch({ filters: [...s.filters, newFilter(ds.fields[0])] })}>{t('reports.d_add_filter')}</Button>}>
          <p className="muted" style={{ marginBottom: 8 }}>{t('reports.d_filters_hint')}</p>
          {s.filters.length === 0 && <p className="muted">{t('reports.d_no_filters')}</p>}
          <div className="stack" style={{ gap: 8 }}>
            {s.filters.map((f) => {
              const fd = fields.get(f.field);
              const setF = (p: Partial<DFilter>) => patch({ filters: s.filters.map((x) => (x.uid === f.uid ? { ...x, ...p } : x)) });
              const incomplete = fd ? !filterComplete(f, fd.type) : false;
              return (
                <div key={f.uid} className={`rp-filter ${incomplete || !fd ? 'incomplete' : ''}`}>
                  <Select value={f.field} aria-label={t('reports.d_field')} onChange={(e) => { const nf = fields.get(e.target.value); if (nf) setF({ ...newFilter(nf), uid: f.uid }); }}>
                    {!fd && <option value={f.field}>{f.field}</option>}
                    <GroupedOptions ds={ds} />
                  </Select>
                  {fd && (
                    <>
                      <Select value={f.op} aria-label={t('reports.d_operator')} onChange={(e) => setF({ op: e.target.value })}>
                        {(meta.ops[fd.type] ?? []).map((o) => <option key={o} value={o}>{opLabel(t, fd.type, o)}</option>)}
                      </Select>
                      <FilterValue f={f} field={fd} onChange={setF} />
                    </>
                  )}
                  {(incomplete || !fd) && <span className="rp-inc">{fd ? t('reports.d_filter_incomplete') : t('reports.d_unavailable')}</span>}
                  <button type="button" className="icon-btn" title={t('reports.d_remove')} onClick={() => patch({ filters: s.filters.filter((x) => x.uid !== f.uid) })}><Trash2 size={15} /></button>
                </div>
              );
            })}
          </div>
        </Card>

        {/* ---------------- orden y límite */}
        <Card title={t('reports.d_sort')} actions={<Button size="sm" variant="secondary" icon={<Plus size={14} />} disabled={s.cols.length === 0} onClick={() => {
          const free = s.cols.find((c) => !s.sort.some((x) => x.colUid === c.uid)) ?? s.cols[0];
          if (free) patch({ sort: [...s.sort, { colUid: free.uid, dir: 'asc' }] });
        }}>{t('reports.d_add_sort')}</Button>}>
          {s.sort.length === 0 && <p className="muted">{t('reports.d_no_sort')}</p>}
          <div className="stack" style={{ gap: 8 }}>
            {s.sort.map((x, i) => (
              <div key={i} className="rp-filter">
                <Select value={x.colUid} aria-label={t('reports.d_sort_col')} onChange={(e) => patch({ sort: s.sort.map((y, j) => (j === i ? { ...y, colUid: Number(e.target.value) } : y)) })}>
                  {s.cols.map((c) => <option key={c.uid} value={c.uid}>{colTitle(c)}</option>)}
                </Select>
                <Select value={x.dir} aria-label={t('reports.d_direction')} onChange={(e) => patch({ sort: s.sort.map((y, j) => (j === i ? { ...y, dir: e.target.value as 'asc' | 'desc' } : y)) })}>
                  <option value="asc">{t('reports.d_asc')}</option>
                  <option value="desc">{t('reports.d_desc')}</option>
                </Select>
                <button type="button" className="icon-btn" title={t('reports.d_remove')} onClick={() => patch({ sort: s.sort.filter((_, j) => j !== i) })}><Trash2 size={15} /></button>
              </div>
            ))}
          </div>
          <div style={{ maxWidth: 260, marginTop: 12 }}>
            <Field label={t('reports.d_limit')} hint={t('reports.d_limit_hint')}>
              <Input type="number" min={1} max={50000} value={s.limit} onChange={(e) => patch({ limit: e.target.value })} placeholder="50000" />
            </Field>
          </div>
        </Card>

        {/* ---------------- vista previa */}
        <Card title={t('reports.d_preview')} actions={preview.isFetching ? <span className="muted">{t('reports.d_updating')}</span> : null}>
          {problem && problem !== 'no_access' && <Alert kind="warn">{t(problem === 'unavailable' ? 'reports.d_unavailable_msg' : `reports.d_${problem}`)}</Alert>}
          {!problem && preview.isError && <Alert kind="bad">{err(preview.error)}</Alert>}
          {!problem && !preview.isError && (
            <>
              <p className="muted" style={{ marginBottom: 8 }}>{t('reports.d_preview_hint', { count: preview.data?.limit ?? 200 })}{preview.data?.truncated ? ` ${t('reports.d_preview_more')}` : ''}</p>
              <ResultGrid id="report-preview" result={preview.data} title={s.name || t('reports.d_new')} loading={preview.isLoading} emptyTitle={t('reports.no_rows')} />
            </>
          )}
        </Card>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ piezas */

const GROUP_ORDER = ['unit', 'grades', 'location', 'lot', 'sale', 'price', 'stats', 'attrs'];

function groupFields(ds: MetaDataset | undefined): [string, MetaField[]][] {
  const by = new Map<string, MetaField[]>();
  for (const f of ds?.fields ?? []) (by.get(f.group) ?? by.set(f.group, []).get(f.group)!).push(f);
  return [...by.entries()].sort((a, b) => (GROUP_ORDER.indexOf(a[0]) + 1 || 99) - (GROUP_ORDER.indexOf(b[0]) + 1 || 99));
}

function GroupedOptions({ ds }: { ds: MetaDataset | undefined }) {
  const { t } = useTranslation();
  return <>{groupFields(ds).map(([g, fs]) => <optgroup key={g} label={t(`reportsGroup.${g}`, { defaultValue: g })}>{fs.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</optgroup>)}</>;
}

/** Lista de campos disponibles del conjunto de datos, agrupados y con búsqueda. */
function FieldPicker({ ds, onAdd, extra }: { ds: MetaDataset | undefined; onAdd: (f: MetaField) => void; extra?: React.ReactNode }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const groups = useMemo(() => {
    const nq = q.trim().toLowerCase();
    return groupFields(ds).map(([g, fs]) => [g, fs.filter((f) => !nq || f.label.toLowerCase().includes(nq))] as [string, MetaField[]]).filter(([, fs]) => fs.length);
  }, [ds, q]);
  return (
    <div>
      <div className="row spread" style={{ marginBottom: 6 }}>
        <div className="section-title" style={{ margin: 0 }}>{t('reports.d_available')}</div>
        {extra}
      </div>
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('reports.d_search_fields')} aria-label={t('reports.d_search_fields')} />
      <div className="rp-avail">
        {groups.map(([g, fs]) => (
          <div key={g}>
            <div className="rp-avail-g">{t(`reportsGroup.${g}`, { defaultValue: g })}</div>
            {fs.map((f) => (
              <button key={f.key} type="button" className="rp-avail-f" onClick={() => onAdd(f)} title={t('reports.d_add')}>
                <span>{f.label}</span><span className="rp-type">{t(`reports.type.${f.type}`)}</span><Plus size={14} />
              </button>
            ))}
          </div>
        ))}
        {groups.length === 0 && <p className="muted">{t('grid.no_results')}</p>}
      </div>
    </div>
  );
}

function opLabel(t: (k: string, o?: any) => string, type: FType, op: string): string {
  if (op === 'lastDays' || op === 'thisMonth' || op === 'thisYear') return t(`reports.op.${op}`);
  return t(`grid.${isDate(type) ? 'opd' : 'op'}.${op}`, { defaultValue: t(`grid.op.${op}`) });
}

/** Editor del valor de un filtro; cambia según el tipo de dato y el operador. */
function FilterValue({ f, field, onChange }: { f: DFilter; field: MetaField; onChange: (p: Partial<DFilter>) => void }) {
  const { t } = useTranslation();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const type = field.type;
  if (NO_VALUE_OPS.includes(f.op)) return <span className="muted rp-novalue">—</span>;
  if (type === 'boolean') {
    return <Select value={f.a} aria-label={t('reports.d_value')} onChange={(e) => onChange({ a: e.target.value })}><option value="true">{t('grid.yes')}</option><option value="false">{t('grid.no')}</option></Select>;
  }
  if (type === 'select') {
    const opts = field.options ?? [];
    const label = f.list.length === 0 ? t('reports.d_pick') : f.list.length === 1 ? opts.find((o) => o.value === f.list[0])?.label ?? f.list[0]! : t('grid.n_selected', { count: f.list.length });
    return (
      <>
        <button type="button" className="input rp-pick" onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}><span className="truncate">{label}</span><ChevronDown size={14} /></button>
        {anchor && (
          <Popover anchor={anchor} onClose={() => setAnchor(null)} minWidth={230}>
            <div className="pop-body">
              <div className="row spread pop-links">
                <button type="button" className="link-btn" onClick={() => onChange({ list: opts.map((o) => o.value) })}>{t('grid.select_all')}</button>
                <button type="button" className="link-btn" onClick={() => onChange({ list: [] })}>{t('grid.select_none')}</button>
              </div>
              <ul className="pop-list">
                {opts.map((o) => (
                  <li key={o.value}><label className="checkbox"><input type="checkbox" checked={f.list.includes(o.value)}
                    onChange={() => onChange({ list: f.list.includes(o.value) ? f.list.filter((x) => x !== o.value) : [...f.list, o.value] })} /><span>{o.label || '—'}</span></label></li>
                ))}
                {opts.length === 0 && <li className="muted">{t('grid.no_options')}</li>}
              </ul>
            </div>
          </Popover>
        )}
      </>
    );
  }
  if (f.op === 'lastDays') {
    return <span className="row gap-sm"><Input type="number" min={1} max={3650} value={f.a} aria-label={t('reports.d_value')} onChange={(e) => onChange({ a: e.target.value })} style={{ width: 90 }} /><span className="muted">{t('reports.d_days')}</span></span>;
  }
  const inType = isDate(type) ? 'date' : isNum(type) ? 'number' : 'text';
  if (f.op === 'between') {
    return (
      <span className="row gap-sm">
        <Input type={inType} step="any" value={f.a} aria-label={t('grid.from')} placeholder={t('grid.from')} onChange={(e) => onChange({ a: e.target.value })} />
        <Input type={inType} step="any" value={f.b} aria-label={t('grid.to')} placeholder={t('grid.to')} onChange={(e) => onChange({ b: e.target.value })} />
      </span>
    );
  }
  return <Input type={inType} step="any" value={f.a} aria-label={t('reports.d_value')} onChange={(e) => onChange({ a: e.target.value })} />;
}
