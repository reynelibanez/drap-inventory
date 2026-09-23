import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Badge, Button, Card, Checkbox, Empty, Field, Input, Modal, PageHeader, Spinner, Textarea, useConfirm, useErr, useToast } from '../../components/ui';
import { RolePermissions, RoleSalesScope } from '../../components/PermissionMatrix';
import { DataGrid, type GridColumn } from '../../components/grid/DataGrid';

export interface Role { id: number; name: string; description: string | null; isActive: boolean; permissions: string[]; members: number }
export const useRoles = () => useQuery({ queryKey: ['roles'], queryFn: () => api.get<{ items: Role[] }>('/roles') });

export default function RolesPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const err = useErr();
  const toast = useToast();
  const [modal, setModal] = useState<{ role?: Role } | null>(null);
  const roles = useRoles();
  const manage = can('roles.manage');
  const columns: GridColumn<Role>[] = [
    { key: 'name', title: t('common.name'), width: 200, render: (r) => <><strong>{r.name}</strong>{!r.isActive && <> <Badge>{t('common.inactive')}</Badge></>}</> },
    { key: 'description', title: t('common.description'), width: 300 },
    { key: 'permissions', title: t('roles.functions'), type: 'number', width: 110, value: (r) => r.permissions.length },
    { key: 'members', title: t('roles.users'), type: 'number', width: 110 },
    { key: 'isActive', title: t('common.active'), type: 'boolean', hidden: true },
    ...(manage ? [{ key: '_actions', title: '', actions: true as const, render: (r: Role) => <>
      <button className="icon-btn" title={t('common.edit')} onClick={() => setModal({ role: r })}><Pencil size={16} /></button>
      <button className="icon-btn" title={t('common.delete')} onClick={() => del(r)}><Trash2 size={16} /></button></> }] : []),
  ];

  async function del(r: Role) {
    if (!(await confirm({ title: t('roles.delete_title', { name: r.name }), message: r.members ? t('roles.delete_msg_members', { count: r.members }) : t('roles.delete_msg'), danger: true, confirmLabel: t('common.delete') }))) return;
    try { await api.del(`/roles/${r.id}`); void qc.invalidateQueries({ queryKey: ['roles'] }); toast.success(t('common.deleted')); } catch (e) { toast.error(err(e)); }
  }
  return (
    <>
      <PageHeader title={t('roles.title')} subtitle={t('roles.subtitle')} actions={manage && <Button variant="primary" icon={<Plus size={16} />} onClick={() => setModal({})}>{t('roles.new')}</Button>} />
      <DataGrid id="roles" rows={roles.data?.items ?? []} loading={roles.isLoading} columns={columns} rowId={(r) => r.id} exportName={t('roles.title')} emptyTitle={t('roles.empty')}
        rowClass={(r) => (r.isActive ? undefined : 'row-inactive')} />
      {modal && <RoleModal role={modal.role} onClose={() => setModal(null)} />}
    </>
  );
}

function RoleModal({ role, onClose }: { role?: Role; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const err = useErr();
  const toast = useToast();
  const [name, setName] = useState(role?.name ?? '');
  const [desc, setDesc] = useState(role?.description ?? '');
  const [perms, setPerms] = useState<string[]>(role?.permissions ?? []);
  const [active, setActive] = useState(role?.isActive ?? true);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      const body = { name: name.trim(), description: desc.trim() || null, permissions: perms, isActive: active };
      if (role) await api.put(`/roles/${role.id}`, body); else await api.post('/roles', body);
      void qc.invalidateQueries({ queryKey: ['roles'] });
      toast.success(t('common.saved')); onClose();
    } catch (e) { toast.error(err(e)); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} size="lg" title={role ? t('roles.edit') : t('roles.new')}
      footer={<><Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} disabled={name.trim().length < 2} onClick={save}>{t('common.save')}</Button></>}>
      <div className="stack">
        <div className="grid grid-2">
          <Field label={t('common.name')} required><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
          <Field label={t('common.description')}><Textarea value={desc} onChange={(e) => setDesc(e.target.value)} style={{ minHeight: 40 }} /></Field>
        </div>
        {role && <Checkbox checked={active} onChange={setActive} label={t('common.active')} />}
        <RoleSalesScope value={perms} onChange={setPerms} />
        <div>
          <div className="section-title">{t('roles.functions')} ({perms.length})</div>
          <p className="muted" style={{ marginBottom: 8 }}>{t('roles.functions_hint')}</p>
          <RolePermissions value={perms} onChange={setPerms} />
        </div>
      </div>
    </Modal>
  );
}
