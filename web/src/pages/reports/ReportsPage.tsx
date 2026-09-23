import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChartColumn, Copy, Pencil, Plus, Table2, Trash2, Users, Lock, Layers } from 'lucide-react';
import { api } from '../../lib/api';
import { Badge, Button, Empty, PageHeader, SearchInput, Spinner, useConfirm, useErr, useToast } from '../../components/ui';
import { useLang, useReportText, useReportsMeta, type ReportItem } from './reportTypes';

/** Lista de reportes: estándar del sistema, compartidos con la empresa y los privados del usuario. */
export default function ReportsPage() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const qc = useQueryClient();
  const lang = useLang();
  const confirm = useConfirm();
  const err = useErr();
  const toast = useToast();
  const txt = useReportText();
  const meta = useReportsMeta();
  const [q, setQ] = useState('');
  const list = useQuery({ queryKey: ['reports'], queryFn: () => api.get<ReportItem[]>('/reports') });
  const canCreate = meta.data?.canCreate ?? false;

  const dup = useMutation({
    mutationFn: (r: ReportItem) => api.post<{ id: number }>(`/reports/${r.id}/duplicate?lang=${lang}`),
    onSuccess: (res) => { void qc.invalidateQueries({ queryKey: ['reports'] }); toast.success(t('reports.duplicated')); nav(`/reports/${res.id}/edit`); },
    onError: (e) => toast.error(err(e)),
  });

  async function remove(r: ReportItem) {
    if (!(await confirm({ title: t('reports.delete_title', { name: txt.name(r) }), message: t('reports.delete_msg'), danger: true, confirmLabel: t('common.delete') }))) return;
    try { await api.del(`/reports/${r.id}`); void qc.invalidateQueries({ queryKey: ['reports'] }); toast.success(t('common.deleted')); } catch (e) { toast.error(err(e)); }
  }

  const groups = useMemo(() => {
    const nq = q.trim().toLowerCase();
    const items = (list.data ?? []).filter((r) => !nq || `${txt.name(r)} ${txt.desc(r)} ${t(`reports.ds.${r.dataset}`, { defaultValue: r.dataset })}`.toLowerCase().includes(nq));
    return [
      { id: 'mine', title: t('reports.g_mine'), hint: t('reports.g_mine_hint'), icon: <Lock size={15} />, items: items.filter((r) => r.visibility === 'private') },
      { id: 'company', title: t('reports.g_company'), hint: t('reports.g_company_hint'), icon: <Users size={15} />, items: items.filter((r) => r.visibility === 'company' && !r.systemKey) },
      { id: 'system', title: t('reports.g_system'), hint: t('reports.g_system_hint'), icon: <Layers size={15} />, items: items.filter((r) => !!r.systemKey) },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.data, q, lang]);

  return (
    <>
      <PageHeader title={t('reports.title')} subtitle={t('reports.subtitle')}
        actions={canCreate && <Button variant="primary" icon={<Plus size={16} />} onClick={() => nav('/reports/new')}>{t('reports.new')}</Button>} />
      <div className="row" style={{ marginBottom: 12 }}><SearchInput value={q} onChange={setQ} placeholder={t('reports.search')} /></div>
      {list.isLoading ? <Spinner /> : (list.data ?? []).length === 0 ? <Empty title={t('reports.empty')} hint={t('reports.empty_hint')} /> : (
        <div className="stack" style={{ gap: 22 }}>
          {groups.filter((g) => g.items.length > 0 || (g.id === 'mine' && canCreate && !q)).map((g) => (
            <section key={g.id}>
              <div className="rp-group"><span className="rp-group-title">{g.icon}{g.title}<Badge>{g.items.length}</Badge></span><span className="muted">{g.hint}</span></div>
              {g.items.length === 0 ? <p className="muted">{t('reports.none_mine')}</p> : (
                <div className="rp-cards">
                  {g.items.map((r) => (
                    <div key={r.id} className="card rp-card">
                      <button type="button" className="rp-open" onClick={() => nav(`/reports/${r.id}`)}>
                        <span className="rp-ico">{r.mode === 'summary' ? <ChartColumn size={20} /> : <Table2 size={20} />}</span>
                        <span className="rp-main">
                          <strong>{txt.name(r)}</strong>
                          {txt.desc(r) && <span className="muted rp-desc">{txt.desc(r)}</span>}
                          <span className="rp-tags">
                            <Badge tone="info">{t(`reports.ds.${r.dataset}`, { defaultValue: r.dataset })}</Badge>
                            <Badge>{r.mode === 'summary' ? t('reports.mode_summary_short') : t('reports.mode_detail_short')}</Badge>
                            {r.visibility === 'company' && !r.systemKey && r.ownerName && <Badge title={t('reports.created_by')}>{r.ownerName}</Badge>}
                          </span>
                        </span>
                      </button>
                      <div className="rp-actions">
                        {canCreate && <button className="icon-btn" title={r.systemKey ? t('reports.customize') : t('reports.duplicate')} onClick={() => dup.mutate(r)}><Copy size={16} /></button>}
                        {r.canEdit && <button className="icon-btn" title={t('common.edit')} onClick={() => nav(`/reports/${r.id}/edit`)}><Pencil size={16} /></button>}
                        {r.canEdit && <button className="icon-btn" title={t('common.delete')} onClick={() => void remove(r)}><Trash2 size={16} /></button>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          ))}
          {groups.every((g) => g.items.length === 0) && <Empty title={t('grid.no_results')} />}
        </div>
      )}
    </>
  );
}
