import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, FileUp, Upload, XCircle } from 'lucide-react';
import { api } from '../../lib/api';
import { useMeta, type Specs } from '../../lib/meta';
import { Button, Card, PageHeader, useErr, useToast } from '../../components/ui';
import { SpecChips } from '../../components/fields';

interface InspectLot { lote: string; reference: string | null; rowCount: number }
interface InspectResult { headers: string[]; rowCount: number; lots: InspectLot[]; sample: string[][] }
interface TechRowResult {
  rowIndex: number; ok: boolean; unitCode?: string; serial?: string | null; specs?: Specs; notes?: string | null;
  reason?: string; lotCode?: string; equipmentTypeKey?: string;
}
interface NewCatalogItem { attrKey: string; value: string }
interface TechLotOutcome { lotId: number; lotCode: string; lote: string; reference: string | null; created: number; skipped: number }
interface TechOutcome {
  lots: TechLotOutcome[]; created: number; skipped: number; results: TechRowResult[]; newCatalogItems: NewCatalogItem[];
  gradeWarnings: number; preview: boolean;
}

export default function LotImportTechPage() {
  const { t } = useTranslation();
  const meta = useMeta();
  const nav = useNavigate();
  const err = useErr();
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);

  const [fileName, setFileName] = useState('');
  const [csv, setCsv] = useState('');
  const [inspecting, setInspecting] = useState(false);
  const [inspected, setInspected] = useState<InspectResult | null>(null);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [outcome, setOutcome] = useState<TechOutcome | null>(null);
  const [committing, setCommitting] = useState(false);

  const typeIdByKey = useMemo(() => new Map(meta.data.equipmentTypes.map((t) => [t.key, t.id])), [meta]);
  const typeLabel = (key: string | undefined) => (key ? meta.typeName(typeIdByKey.get(key)) : '');

  async function onFile(f: File) {
    setInspected(null); setOutcome(null); setInspectError(null);
    setFileName(f.name);
    const text = await f.text();
    setCsv(text);
  }

  async function analyze() {
    if (!csv) return;
    setInspecting(true);
    setInspectError(null);
    try {
      const r = await api.post<InspectResult>('/imports/tech/inspect', { csv });
      setInspected(r);
    } catch (e) {
      setInspectError(err(e));
    } finally { setInspecting(false); }
  }

  async function runPreview() {
    if (!csv || !inspected) return;
    setPreviewing(true);
    setOutcome(null);
    try {
      const r = await api.post<TechOutcome>('/imports/tech/preview', { csv });
      setOutcome(r);
    } catch (e) { toast.error(err(e)); } finally { setPreviewing(false); }
  }

  async function commit() {
    if (!csv) return;
    setCommitting(true);
    try {
      const r = await api.post<TechOutcome>('/imports/tech/commit', { csv });
      toast.success(t('lots.importTech.done', { n: r.created, lots: r.lots.length }));
      nav('/lots');
    } catch (e) { toast.error(err(e)); } finally { setCommitting(false); }
  }

  return (
    <>
      <PageHeader title={t('lots.importTech.title')} subtitle={t('lots.importTech.subtitle')} />
      <div className="stack">
        <Card title={t('lots.importTech.step1')}>
          <p className="muted" style={{ marginTop: 0 }}>{t('lots.importTech.step1_hint')}</p>
          <div className="row" style={{ alignItems: 'center', gap: 12 }}>
            <input ref={fileInput} type="file" accept=".csv,text/csv" className="input"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); }} />
            <Button variant="primary" icon={<FileUp size={16} />} disabled={!csv} loading={inspecting} onClick={analyze}>
              {t('lots.import.analyze')}
            </Button>
          </div>
          {inspectError && (
            <p className="row gap-sm" style={{ color: 'var(--bad, #dc2626)', marginTop: 12 }}>
              <XCircle size={16} /> {inspectError}
            </p>
          )}
        </Card>

        {inspected && (
          <Card title={t('lots.importTech.step2')}>
            <p className="muted" style={{ marginTop: 0 }}>{t('lots.import.rows_found', { n: inspected.rowCount, file: fileName })}</p>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>{t('lots.importTech.lote')}</th><th>{t('lots.reference')}</th><th>{t('lots.importTech.row_count')}</th></tr></thead>
                <tbody>
                  {inspected.lots.map((l) => (
                    <tr key={l.lote}><td className="mono">{l.lote}</td><td>{l.reference ?? '—'}</td><td>{l.rowCount}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
              <Button variant="primary" loading={previewing} onClick={runPreview}>{t('lots.import.preview_action')}</Button>
            </div>
          </Card>
        )}

        {outcome && (
          <Card title={t('lots.import.step3')}>
            <p>{t('lots.import.summary', { created: outcome.created, skipped: outcome.skipped, total: outcome.results.length })}</p>
            <p className="muted">{t('lots.importTech.lots_summary', { n: outcome.lots.length })}</p>
            {outcome.gradeWarnings > 0 && (
              <p className="row gap-sm" style={{ color: 'var(--warn, #d97706)' }}>
                <AlertTriangle size={16} /> {t('lots.importTech.grade_warnings', { n: outcome.gradeWarnings })}
              </p>
            )}
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
                <thead><tr><th>#</th><th>{t('lots.importTech.lote')}</th><th>{t('common.type')}</th><th>{t('lots.import.result')}</th><th>{t('units.serial')}</th><th>{t('common.notes')}</th></tr></thead>
                <tbody>
                  {outcome.results.map((r) => {
                    const typeId = r.equipmentTypeKey ? typeIdByKey.get(r.equipmentTypeKey) : undefined;
                    return (
                      <tr key={r.rowIndex}>
                        <td>{r.rowIndex + 2}</td>
                        <td className="mono">{r.lotCode ?? '—'}</td>
                        <td>{typeLabel(r.equipmentTypeKey)}</td>
                        <td>
                          {r.ok ? (
                            <span className="row gap-sm" style={{ display: 'inline-flex' }}>
                              <CheckCircle2 size={16} color="var(--good, #16a34a)" />
                              <strong className="mono">{r.unitCode}</strong>
                              {typeId != null && r.specs && <SpecChips typeId={typeId} specs={r.specs} all />}
                            </span>
                          ) : (
                            <span className="row gap-sm" style={{ display: 'inline-flex' }}>
                              <XCircle size={16} color="var(--bad, #dc2626)" />
                              {t(`errors.${r.reason}`, { defaultValue: r.reason })}
                            </span>
                          )}
                        </td>
                        <td className="mono">{r.serial ?? '—'}</td>
                        <td className="sub">{r.notes ?? '—'}</td>
                      </tr>
                    );
                  })}
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
