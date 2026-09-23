import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Pencil, Plus } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Button, Checkbox, Field, Input, Modal, PageHeader, Select, Textarea, useErr, useToast } from '../../components/ui';
import { useAllRows } from '../../lib/useAllRows';
import { DataGrid, type Filter, type GridColumn } from '../../components/grid/DataGrid';
import { CatalogSelect } from '../../components/fields';

export interface FieldDef { key: string; label: string; kind?: 'text' | 'textarea' | 'catalog' | 'member'; catalog?: string; required?: boolean; type?: string }
export interface CrudConfig {
  path: string; queryKey: string; title: string; subtitle: string; newLabel: string; editLabel: string; emptyLabel: string;
  viewPerm: string; managePerm: string; fields: FieldDef[]; columns: GridColumn<any>[];
}

const ACTIVE_ONLY: Record<string, Filter> = { isActive: { op: 'is', a: 'true' } };

/** Listado + alta/edición para catálogos de personas y empresas (proveedores, clientes, vendedores). */
export function CrudPage({ cfg }: { cfg: CrudConfig }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [modal, setModal] = useState<{ row: any | null } | null>(null);
  const manage = can(cfg.managePerm);
  const list = useAllRows<any>([cfg.queryKey], cfg.path, { active: 'all' });
  const columns: GridColumn<any>[] = [
    ...cfg.columns,
    { key: 'isActive', title: t('common.active'), type: 'boolean', width: 90, hidden: true },
    ...(manage ? [{ key: '_actions', title: '', actions: true as const, render: (r: any) => <button className="icon-btn" title={t('common.edit')} onClick={() => setModal({ row: r })}><Pencil size={16} /></button> }] : []),
  ];

  return (
    <>
      <PageHeader title={cfg.title} subtitle={cfg.subtitle} actions={manage && <Button variant="primary" icon={<Plus size={16} />} onClick={() => setModal({ row: null })}>{cfg.newLabel}</Button>} />
      <DataGrid id={cfg.queryKey} rows={list.data ?? []} loading={list.isLoading} columns={columns} rowId={(r) => r.id} exportName={cfg.title}
        initialFilters={ACTIVE_ONLY} rowClass={(r) => (r.isActive ? undefined : 'row-inactive')} emptyTitle={cfg.emptyLabel}
        onRowClick={manage ? (r) => setModal({ row: r }) : undefined} />
      {modal && <CrudModal cfg={cfg} row={modal.row} onClose={() => setModal(null)} onSaved={() => { void qc.invalidateQueries({ queryKey: [cfg.queryKey] }); }} />}
    </>
  );
}

function CrudModal({ cfg, row, onClose, onSaved }: { cfg: CrudConfig; row: any | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const err = useErr();
  const toast = useToast();
  const [v, setV] = useState<Record<string, any>>(() => Object.fromEntries(cfg.fields.map((f) => [f.key, row?.[f.key] ?? (f.kind === 'catalog' || f.kind === 'member' ? null : '')])));
  const [active, setActive] = useState(row?.isActive ?? true);
  const [busy, setBusy] = useState(false);
  const members = useQuery({ queryKey: ['members'], queryFn: () => api.get<{ items: { id: number; fullName: string }[] }>('/team/members'), enabled: can('users.view') && cfg.fields.some((f) => f.kind === 'member') });
  const missing = cfg.fields.some((f) => f.required && !String(v[f.key] ?? '').trim());

  async function save() {
    setBusy(true);
    try {
      const body: Record<string, any> = {};
      for (const f of cfg.fields) body[f.key] = f.kind === 'catalog' || f.kind === 'member' ? v[f.key] ?? null : String(v[f.key] ?? '').trim() || null;
      if (row) await api.put(`${cfg.path}/${row.id}`, { ...body, isActive: active }); else await api.post(cfg.path, body);
      toast.success(t('common.saved')); onSaved(); onClose();
    } catch (e) { toast.error(err(e)); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title={row ? cfg.editLabel : cfg.newLabel}
      footer={<><Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} disabled={missing} onClick={save}>{t('common.save')}</Button></>}>
      <div className="stack">
        <div className="form-grid">
          {cfg.fields.filter((f) => f.kind !== 'textarea').map((f, i) => (
            <Field key={f.key} label={f.label} required={f.required}>
              {f.kind === 'catalog' ? <CatalogSelect catalog={f.catalog!} value={v[f.key]} onChange={(x) => setV({ ...v, [f.key]: x })} />
                : f.kind === 'member' ? (
                  <Select value={v[f.key] ?? ''} onChange={(e) => setV({ ...v, [f.key]: e.target.value ? Number(e.target.value) : null })} disabled={!members.data}>
                    <option value="">—</option>{members.data?.items.map((m) => <option key={m.id} value={m.id}>{m.fullName}</option>)}
                  </Select>
                ) : <Input type={f.type} value={v[f.key] ?? ''} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} autoFocus={i === 0} />}
            </Field>
          ))}
        </div>
        {cfg.fields.filter((f) => f.kind === 'textarea').map((f) => (
          <Field key={f.key} label={f.label}><Textarea value={v[f.key] ?? ''} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} /></Field>
        ))}
        {row && <Checkbox checked={active} onChange={setActive} label={t('common.active')} />}
      </div>
    </Modal>
  );
}
