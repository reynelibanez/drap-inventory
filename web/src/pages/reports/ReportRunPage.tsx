import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Copy, Pencil, RefreshCw } from 'lucide-react';
import { api } from '../../lib/api';
import { Alert } from '../../components/Alert';
import { Badge, Button, Empty, PageHeader, Spinner, useErr, useToast } from '../../components/ui';
import { ResultGrid } from './ResultGrid';
import { useLang, useReportText, useReportsMeta, type ReportFull, type RunResult } from './reportTypes';

/** Ejecuta un reporte guardado y muestra el resultado en el grid (filtrable, reordenable y exportable). */
export default function ReportRunPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const lang = useLang();
  const err = useErr();
  const toast = useToast();
  const txt = useReportText();
  const meta = useReportsMeta();
  const rid = Number(id);

  const info = useQuery({ queryKey: ['report', rid], queryFn: () => api.get<ReportFull>(`/reports/${rid}`) });
  const run = useQuery({
    queryKey: ['report-run', rid, lang], enabled: info.isSuccess,
    queryFn: () => api.post<RunResult & { report: ReportFull }>(`/reports/${rid}/run?lang=${lang}`), refetchOnWindowFocus: false,
  });
  const dup = useMutation({
    mutationFn: () => api.post<{ id: number }>(`/reports/${rid}/duplicate?lang=${lang}`),
    onSuccess: (res) => { void qc.invalidateQueries({ queryKey: ['reports'] }); toast.success(t('reports.duplicated')); nav(`/reports/${res.id}/edit`); },
    onError: (e) => toast.error(err(e)),
  });

  if (info.isLoading) return <Spinner />;
  if (info.isError || !info.data) return <Empty title={t('errors.report_not_found')} action={<Link to="/reports">{t('reports.back')}</Link>} />;
  const r = info.data;
  const name = txt.name(r);
  return (
    <>
      <PageHeader
        back={<Link to="/reports" className="row gap-sm muted" style={{ marginBottom: 6 }}><ArrowLeft size={15} />{t('reports.back')}</Link>}
        title={name} subtitle={txt.desc(r) || undefined}
        actions={<>
          <Button variant="ghost" icon={<RefreshCw size={15} />} loading={run.isFetching} onClick={() => void run.refetch()}>{t('reports.refresh')}</Button>
          {meta.data?.canCreate && <Button variant="secondary" icon={<Copy size={15} />} loading={dup.isPending} onClick={() => dup.mutate()}>{r.systemKey ? t('reports.customize') : t('reports.duplicate')}</Button>}
          {r.canEdit && <Button variant="primary" icon={<Pencil size={15} />} onClick={() => nav(`/reports/${rid}/edit`)}>{t('common.edit')}</Button>}
        </>} />
      <div className="row" style={{ gap: 6, marginBottom: 10 }}>
        <Badge tone="info">{t(`reports.ds.${r.dataset}`, { defaultValue: r.dataset })}</Badge>
        <Badge>{r.definition.mode === 'summary' ? t('reports.mode_summary_short') : t('reports.mode_detail_short')}</Badge>
        <Badge>{r.systemKey ? t('reports.g_system') : r.visibility === 'company' ? t('reports.visibility_company') : t('reports.visibility_private')}</Badge>
      </div>
      {run.isError && <Alert kind="bad">{err(run.error)}</Alert>}
      {run.data?.truncated && <Alert kind="warn">{t('reports.truncated', { count: run.data.limit })}</Alert>}
      <ResultGrid id={`report-${rid}`} result={run.data} title={name} loading={run.isLoading} emptyTitle={t('reports.no_rows')} />
    </>
  );
}
