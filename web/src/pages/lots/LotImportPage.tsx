import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, FileUp, Upload, XCircle } from 'lucide-react';
import { api } from '../../lib/api';
import { useMeta, type Specs } from '../../lib/meta';
import { Button, Card, Checkbox, Field, Input, PageHeader, Select, useErr, useToast } from '../../components/ui';
import { SpecChips, TypeSelect } from '../../components/fields';

interface ImportMapping {
  serialCol: number | null;
  referenceCol: number | null;
  notesCol: number | null;
  extraCols: number[];
  attrs: Record<string, number | null>;
}

interface InspectResult { headers: string[]; rowCount: number; sample: string[][] }
interface ImportRowResult { rowIndex: number; ok: boolean; unitCode?: string; serial?: string | null; specs?: Specs; notes?: string | null; reason?: string }
interface NewCatalogItem { attrKey: string; value: string }
interface ImportOutcome { lotId: number; lotCode: string; created: number; skipped: number; results: ImportRowResult[]; newCatalogItems: NewCatalogItem[]; preview: boolean }

/** A, B, C … Z, AA, AB … (para identificar columnas como en una hoja de cálculo). */
function colLetter(i: number): string {
  let s = '';
  let n = i;
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

const normHeader = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const SYNONYMS: [string, string[]][] = [
  ['serial', ['serial', 'sn', 's n', 'no serie', 'nserie', 'numero de serie']],
  ['brand', ['make', 'marca', 'brand', 'fabricante']],
  ['model', ['model', 'modelo']],
  ['cpu', ['cpu', 'processor', 'procesador']],
  ['ram', ['ram', 'memoria']],
  ['storage', ['ssd', 'hdd', 'disco', 'storage', 'almacenamiento']],
  ['screen_size', ['size', 'pantalla', 'screen', 'tamano']],
  ['os', ['o s', 'os', 'so', 'sistema operativo', 'sistema']],
  ['battery_condition', ['battery', 'bateria', 'estado bateria', 'estado de bateria']],
  ['touch_screen', ['touch', 'tactil']],
  ['notes', ['notes', 'notas', 'observaciones', 'comentarios']],
];
const EXCLUDED_HEADERS = ['status', 'estado', 'p s', 'ps'];

/** Primera columna = referencia (así lo pidió Arianne); el resto se adivina por el nombre del encabezado. Todo se puede corregir a mano. */
function suggestMapping(headers: string[], typeAttrKeys: Set<string>): ImportMapping {
  const mapping: ImportMapping = { serialCol: null, referenceCol: headers.length ? 0 : null, notesCol: null, extraCols: [], attrs: {} };
  const used = new Set<number>([0]);
  for (let i = 1; i < headers.length; i++) {
    const h = normHeader(headers[i]);
    if (!h) continue;
    if (EXCLUDED_HEADERS.includes(h)) continue;
    const hit = SYNONYMS.find(([, syns]) => syns.some((s) => h === s || h.includes(s)));
    if (!hit) { mapping.extraCols.push(i); used.add(i); continue; }
    const [role] = hit;
    if (role === 'serial') { mapping.serialCol = i; used.add(i); continue; }
    if (role === 'notes') { mapping.notesCol = i; used.add(i); continue; }
    if (role === 'cpu') {
      if (typeAttrKeys.has('processor')) mapping.attrs.processor = i;
      if (typeAttrKeys.has('generation')) mapping.attrs.generation = i;
      used.add(i);
      continue;
    }
    if (role === 'storage') {
      if (typeAttrKeys.has('storage_type')) mapping.attrs.storage_type = i;
      if (typeAttrKeys.has('storage_size')) mapping.attrs.storage_size = i;
      used.add(i);
      continue;
    }
    if (typeAttrKeys.has(role)) { mapping.attrs[role] = i; used.add(i); } else { mapping.extraCols.push(i); used.add(i); }
  }
  return mapping;
}

export default function LotImportPage() {
  const { t } = useTranslation();
  const meta = useMeta();
  const nav = useNavigate();
  const err = useErr();
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);

  const [typeId, setTypeId] = useState<number | null>(null);
  const [fileName, setFileName] = useState('');
  const [csv, setCsv] = useState('');
  const [lotReference, setLotReference] = useState('');
  const [verifyOnTest, setVerifyOnTest] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [inspected, setInspected] = useState<InspectResult | null>(null);
  const [mapping, setMapping] = useState<ImportMapping | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const [committing, setCommitting] = useState(false);

  const attrRows = useMemo(() => (typeId ? meta.typeAttrs(typeId) : []), [meta, typeId]);
  const typeAttrKeys = useMemo(() => new Set(attrRows.map((r) => r.attr.key)), [attrRows]);

  function reset() {
    setInspected(null); setMapping(null); setOutcome(null);
  }

  async function onFile(f: File) {
    reset();
    setFileName(f.name);
    if (!lotReference) setLotReference(f.name.replace(/\.csv$/i, ''));
    const text = await f.text();
    setCsv(text);
  }

  async function analyze() {
    if (!typeId || !csv) return;
    setInspecting(true);
    try {
      const r = await api.post<InspectResult>('/imports/inspect', { csv });
      setInspected(r);
      setMapping(suggestMapping(r.headers, typeAttrKeys));
    } catch (e) { toast.error(err(e)); } finally { setInspecting(false); }
  }

  const effectiveVerify = verifyOnTest && mapping?.serialCol !== null && mapping?.serialCol !== undefined;

  const usedCols = useMemo(() => {
    if (!mapping) return new Set<number>();
    const s = new Set<number>();
    if (mapping.serialCol !== null) s.add(mapping.serialCol);
    if (mapping.referenceCol !== null) s.add(mapping.referenceCol);
    if (mapping.notesCol !== null) s.add(mapping.notesCol);
    for (const v of Object.values(mapping.attrs)) if (v !== null && v !== undefined) s.add(v);
    return s;
  }, [mapping]);

  function setSpecial(field: 'serialCol' | 'referenceCol' | 'notesCol', v: number | null) {
    setMapping((m) => (m ? { ...m, [field]: v } : m));
  }
  function setAttrCol(key: string, v: number | null) {
    setMapping((m) => (m ? { ...m, attrs: { ...m.attrs, [key]: v } } : m));
  }
  function toggleExtra(col: number, on: boolean) {
    setMapping((m) => (m ? { ...m, extraCols: on ? [...m.extraCols, col] : m.extraCols.filter((c) => c !== col) } : m));
  }

  function colOption(i: number) { return `${colLetter(i)} — ${inspected!.headers[i] || t('lots.import.col_n', { n: i + 1 })}`; }

  async function runPreview() {
    if (!typeId || !mapping || !inspected) return;
    setPreviewing(true);
    setOutcome(null);
    try {
      const r = await api.post<ImportOutcome>('/imports/preview', { equipmentTypeId: typeId, csv, mapping, lotReference: lotReference || null, verifyOnTest: effectiveVerify });
      setOutcome(r);
    } catch (e) { toast.error(err(e)); } finally { setPreviewing(false); }
  }

  async function commit() {
    if (!typeId || !mapping) return;
    setCommitting(true);
    try {
      const r = await api.post<ImportOutcome>('/imports/commit', { equipmentTypeId: typeId, csv, mapping, lotReference: lotReference || null, verifyOnTest: effectiveVerify });
      toast.success(t('lots.import.done', { n: r.created }));
      nav(`/lots/${r.lotId}`);
    } catch (e) { toast.error(err(e)); } finally { setCommitting(false); }
  }

  const specialCols: { key: 'serialCol' | 'referenceCol' | 'notesCol'; label: string }[] = [
    { key: 'referenceCol', label: t('lots.import.col_reference') },
    { key: 'serialCol', label: t('lots.import.col_serial') },
    { key: 'notesCol', label: t('lots.import.col_notes') },
  ];

  return (
    <>
      <PageHeader title={t('lots.import.title')} subtitle={t('lots.import.subtitle')} />
      <div className="stack">
        <Card title={t('lots.import.step1')}>
          <div className="form-grid">
            <Field label={t('common.type')} hint={t('lots.import.type_hint')}>
              <TypeSelect value={typeId} onChange={(v) => { setTypeId(v); reset(); }} />
            </Field>
            <Field label={t('lots.import.file')}>
              <input ref={fileInput} type="file" accept=".csv,text/csv" className="input"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); }} />
            </Field>
            <Field label={t('lots.reference')} hint={t('lots.import.lot_reference_hint')}>
              <Input value={lotReference} onChange={(e) => setLotReference(e.target.value)} />
            </Field>
          </div>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Button variant="primary" icon={<FileUp size={16} />} disabled={!typeId || !csv} loading={inspecting} onClick={analyze}>
              {t('lots.import.analyze')}
            </Button>
          </div>
        </Card>

        {inspected && mapping && typeId && (
          <Card title={t('lots.import.step2')} className="">
            <p className="muted" style={{ marginTop: 0 }}>{t('lots.import.rows_found', { n: inspected.rowCount, file: fileName })}</p>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>{t('lots.import.field')}</th><th>{t('lots.import.column')}</th></tr></thead>
                <tbody>
                  {specialCols.map((sc) => (
                    <tr key={sc.key}>
                      <td>{sc.label}</td>
                      <td>
                        <Select value={mapping[sc.key] ?? ''} onChange={(e) => setSpecial(sc.key, e.target.value === '' ? null : Number(e.target.value))}>
                          <option value="">{t('lots.import.not_imported')}</option>
                          {inspected.headers.map((_, i) => <option key={i} value={i}>{colOption(i)}</option>)}
                        </Select>
                      </td>
                    </tr>
                  ))}
                  {attrRows.map(({ attr }) => (
                    <tr key={attr.key}>
                      <td>{meta.label(attr.label)}</td>
                      <td>
                        <Select value={mapping.attrs[attr.key] ?? ''} onChange={(e) => setAttrCol(attr.key, e.target.value === '' ? null : Number(e.target.value))}>
                          <option value="">{t('lots.import.not_imported')}</option>
                          {inspected.headers.map((_, i) => <option key={i} value={i}>{colOption(i)}</option>)}
                        </Select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ marginTop: 12 }}>
              <Checkbox checked={verifyOnTest} disabled={mapping.serialCol === null}
                onChange={(v) => setVerifyOnTest(mapping.serialCol === null ? false : v)}
                label={t('lots.import.verify_on_test')} />
              <div className="field-hint">
                {mapping.serialCol === null ? t('lots.import.verify_on_test_needs_serial') : t('lots.import.verify_on_test_hint')}
              </div>
            </div>

            {inspected.headers.some((_, i) => !usedCols.has(i)) && (
              <>
                <h4>{t('lots.import.extra_cols')}</h4>
                <p className="muted" style={{ marginTop: 0 }}>{t('lots.import.extra_cols_hint')}</p>
                <div className="stack" style={{ gap: 4 }}>
                  {inspected.headers.map((h, i) => {
                    if (usedCols.has(i)) return null;
                    return (
                      <label key={i} className="checkbox">
                        <input type="checkbox" checked={mapping.extraCols.includes(i)} onChange={(e) => toggleExtra(i, e.target.checked)} />
                        <span>{colLetter(i)} — {h || t('lots.import.col_n', { n: i + 1 })}</span>
                      </label>
                    );
                  })}
                </div>
              </>
            )}

            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
              <Button variant="primary" loading={previewing} onClick={runPreview}>{t('lots.import.preview_action')}</Button>
            </div>
          </Card>
        )}

        {outcome && (
          <Card title={t('lots.import.step3')}>
            <p>
              {t('lots.import.summary', { created: outcome.created, skipped: outcome.skipped, total: outcome.results.length })}
            </p>
            {effectiveVerify && <div className="alert alert-info" style={{ marginBottom: 12 }}>{t('lots.import.verify_on_test_summary')}</div>}
            {outcome.newCatalogItems.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <strong>{t('lots.import.new_values', { n: outcome.newCatalogItems.length })}</strong>
                <div className="spec-chips" style={{ marginTop: 6 }}>
                  {outcome.newCatalogItems.map((n, i) => (
                    <span key={i} className="chip">{meta.attrByKey(n.attrKey) ? meta.label(meta.attrByKey(n.attrKey)!.label) : n.attrKey}: {n.value}</span>
                  ))}
                </div>
              </div>
            )}
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>#</th><th>{t('lots.import.result')}</th><th>{t('units.serial')}</th><th>{t('common.notes')}</th></tr></thead>
                <tbody>
                  {outcome.results.map((r) => (
                    <tr key={r.rowIndex}>
                      <td>{r.rowIndex + 2}</td>
                      <td>
                        {r.ok ? (
                          <span className="row gap-sm" style={{ display: 'inline-flex' }}>
                            <CheckCircle2 size={16} color="var(--good, #16a34a)" />
                            <strong className="mono">{r.unitCode}</strong>
                            {typeId && r.specs && <SpecChips typeId={typeId} specs={r.specs} all />}
                          </span>
                        ) : (
                          <span className="row gap-sm" style={{ display: 'inline-flex' }}>
                            <XCircle size={16} color="var(--bad, #dc2626)" />
                            {t(`errors.${r.reason}`, { defaultValue: r.reason, code: (r as any).code })}
                          </span>
                        )}
                      </td>
                      <td className="mono">{r.serial ?? '—'}</td>
                      <td className="sub">{r.notes ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
              <Button variant="ghost" onClick={runPreview} loading={previewing}>{t('lots.import.preview_again')}</Button>
              <Button variant="primary" icon={<Upload size={16} />} loading={committing} disabled={outcome.created === 0} onClick={commit}>
                {t('lots.import.commit_action')}
              </Button>
            </div>
          </Card>
        )}
      </div>
    </>
  );
}
