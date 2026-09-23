import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { KeyRound, Lock, Pencil, Plus } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useFmt } from '../../lib/useFmt';
import { Badge, Button, Card, Checkbox, Empty, Field, Input, Modal, PageHeader, Spinner, Tabs, useErr, useToast } from '../../components/ui';
import { UserOverrides, UserSalesScope, type Effect } from '../../components/PermissionMatrix';
import { useRoles } from './RolesPage';
import { DataGrid, type GridColumn } from '../../components/grid/DataGrid';

interface Member {
  id: number; userId: number; username: string; email: string | null; fullName: string; lastLoginAt: string | null; techNumber: number; isCompanyAdmin: boolean; isActive: boolean;
  roles: { id: number; name: string }[]; overrides: number; isOwner: boolean;
}
interface MemberDetail { id: number; userId: number; username: string; email: string | null; fullName: string; techNumber: number; isCompanyAdmin: boolean; isActive: boolean; roleIds: number[]; overrides: { permission: string; effect: Effect }[]; isOwner: boolean }

export default function UsersPage() {
  const { t } = useTranslation();
  const { can, user: me } = useAuth();
  const f = useFmt();
  const [modal, setModal] = useState<{ id?: number } | null>(null);
  const q = useQuery({ queryKey: ['members'], queryFn: () => api.get<{ items: Member[] }>('/team/members') });
  const roleList = useRoles();
  const manage = can('users.manage');
  const columns: GridColumn<Member>[] = [
    { key: 'fullName', title: t('common.name'), width: 220, render: (m) => <><strong>{m.fullName}</strong><div className="sub">{m.username}{m.email ? ` · ${m.email}` : ''}</div></> },
    { key: 'username', title: t('users.username'), hidden: true }, { key: 'email', title: t('common.email'), hidden: true },
    { key: 'techNumber', title: t('users.tech_number'), type: 'number', width: 110, render: (m) => <span className="mono">{m.techNumber}</span> },
    {
      key: 'roles', title: t('users.roles'), type: 'multi', width: 260,
      value: (m) => [...(m.isOwner ? ['__owner'] : m.isCompanyAdmin ? ['__admin'] : []), ...m.roles.map((r) => String(r.id))],
      options: [{ value: '__owner', label: t('users.owner') }, { value: '__admin', label: t('users.admin') }, ...(roleList.data?.items ?? []).map((r) => ({ value: String(r.id), label: r.name }))],
      render: (m) => (
        <span className="tag-list">
          {m.isOwner && <Badge tone="warn"><Lock size={12} /> {t('users.owner')}</Badge>}
          {m.isCompanyAdmin && !m.isOwner && <Badge tone="info">{t('users.admin')}</Badge>}
          {m.roles.map((r) => <span key={r.id} className="chip">{r.name}</span>)}
          {m.overrides > 0 && <Badge tone="warn">{t('users.overrides', { count: m.overrides })}</Badge>}
        </span>
      ),
    },
    { key: 'lastLoginAt', title: t('users.last_login'), type: 'datetime', width: 170 },
    { key: 'isActive', title: t('common.status'), type: 'boolean', width: 110, render: (m) => (m.isActive ? <Badge tone="good">{t('common.active')}</Badge> : <Badge>{t('common.inactive')}</Badge>) },
    ...(manage ? [{
      key: '_actions', title: '', actions: true as const,
      render: (m: Member) => (m.isOwner && m.userId !== me?.id
        ? <span className="icon-btn" title={t('users.owner_locked')} style={{ opacity: 0.5, cursor: 'not-allowed' }}><Lock size={16} /></span>
        : <button className="icon-btn" title={t('common.edit')} onClick={() => setModal({ id: m.id })}><Pencil size={16} /></button>),
    }] : []),
  ];
  return (
    <>
      <PageHeader title={t('users.title')} subtitle={t('users.subtitle')} actions={manage && <Button variant="primary" icon={<Plus size={16} />} onClick={() => setModal({})}>{t('users.new')}</Button>} />
      <DataGrid id="users" rows={q.data?.items ?? []} loading={q.isLoading} columns={columns} rowId={(m) => m.id} exportName={t('users.title')} emptyTitle={t('common.empty')}
        rowClass={(m) => (m.isActive ? undefined : 'row-inactive')} />
      {modal && <UserModal id={modal.id} onClose={() => setModal(null)} />}
    </>
  );
}

function UserModal({ id, onClose }: { id?: number; onClose: () => void }) {
  const detail = useQuery({ queryKey: ['member', id], queryFn: () => api.get<MemberDetail>(`/team/members/${id}`), enabled: !!id, staleTime: 0 });
  if (id && !detail.data) return <Modal open onClose={onClose} title="…"><Spinner /></Modal>;
  return <UserForm member={detail.data} onClose={onClose} />;
}

function UserForm({ member, onClose }: { member?: MemberDetail; onClose: () => void }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const qc = useQueryClient();
  const err = useErr();
  const toast = useToast();
  const roles = useRoles();
  const [tab, setTab] = useState<'basic' | 'perms'>('basic');
  const [username, setUsername] = useState(member?.username ?? '');
  const [fullName, setFullName] = useState(member?.fullName ?? '');
  const [email, setEmail] = useState(member?.email ?? '');
  const [password, setPassword] = useState('');
  const [admin, setAdmin] = useState(member?.isCompanyAdmin ?? false);
  const [active, setActive] = useState(member?.isActive ?? true);
  const [roleIds, setRoleIds] = useState<number[]>(member?.roleIds ?? []);
  const [ov, setOv] = useState<Record<string, Effect>>(() => Object.fromEntries((member?.overrides ?? []).map((o) => [o.permission, o.effect])));
  const [busy, setBusy] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const self = member?.userId === user?.id;

  const rolePerms = useMemo(() => {
    const s = new Set<string>();
    for (const r of roles.data?.items ?? []) if (r.isActive && roleIds.includes(r.id)) for (const p of r.permissions) s.add(p);
    return s;
  }, [roles.data, roleIds]);

  async function save() {
    setBusy(true);
    try {
      const overrides = Object.entries(ov).map(([permission, effect]) => ({ permission, effect }));
      if (member) {
        // Nombre y correo solo se envían si cambiaron (si el usuario trabaja en otras empresas, no se pueden tocar desde aquí).
        const personal: Record<string, unknown> = {};
        if (fullName.trim() !== member.fullName) personal.fullName = fullName.trim();
        if ((email.trim() || null) !== member.email) personal.email = email.trim() || null;
        await api.put(`/team/members/${member.id}`, { isActive: active, isCompanyAdmin: admin, roleIds, overrides, ...personal });
      } else {
        const r = await api.post<{ createdUser: boolean; techNumber: number }>('/team/members', {
          username: username.trim(), fullName: fullName.trim(), email: email.trim() || null, password: password || undefined, isCompanyAdmin: admin, roleIds, overrides,
        });
        toast.success(t('users.created', { n: r.techNumber }));
      }
      void qc.invalidateQueries({ queryKey: ['members'] }); void qc.invalidateQueries({ queryKey: ['member'] }); void qc.invalidateQueries({ queryKey: ['roles'] });
      if (member) toast.success(t('common.saved'));
      onClose();
    } catch (e) { toast.error(err(e)); } finally { setBusy(false); }
  }

  return (
    <>
      <Modal open onClose={onClose} size="xl" title={member ? t('users.edit', { name: member.fullName }) : t('users.new')}
        footer={<>
          {member && <Button variant="ghost" icon={<KeyRound size={14} />} onClick={() => setResetOpen(true)} style={{ marginRight: 'auto' }}>{t('users.reset_password')}</Button>}
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={busy} disabled={!fullName.trim() || (!member && (!username.trim()))} onClick={save}>{t('common.save')}</Button>
        </>}>
        <Tabs value={tab} onChange={setTab} tabs={[{ id: 'basic', label: t('users.tab_basic') }, { id: 'perms', label: t('users.tab_perms'), count: Object.keys(ov).length }]} />
        {tab === 'basic' ? (
          <div className="stack">
            <div className="form-grid">
              <Field label={t('users.username')} required><Input value={username} disabled={!!member} onChange={(e) => setUsername(e.target.value)} autoFocus={!member} autoComplete="off" /></Field>
              <Field label={t('users.full_name')} required><Input value={fullName} onChange={(e) => setFullName(e.target.value)} /></Field>
              <Field label={t('common.email')}><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
              {!member && <Field label={t('auth.password')} hint={t('users.password_hint')}><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" /></Field>}
            </div>
            <div className="row wrap">
              <Checkbox checked={admin} disabled={self} onChange={setAdmin} label={t('users.is_admin')} />
              {member && <Checkbox checked={active} disabled={self} onChange={setActive} label={t('common.active')} />}
            </div>
            {member?.isOwner && <div className="alert alert-info"><Lock size={14} /> {t('users.owner_locked')}</div>}
            {admin && <div className="alert alert-info">{t('users.admin_hint')}</div>}
            <div>
              <div className="section-title">{t('users.roles')}</div>
              <p className="muted" style={{ marginBottom: 8 }}>{t('users.roles_hint')}</p>
              {roles.isLoading ? <Spinner /> : (
                <div className="row wrap">
                  {roles.data?.items.filter((r) => r.isActive || roleIds.includes(r.id)).map((r) => (
                    <Checkbox key={r.id} checked={roleIds.includes(r.id)} onChange={(c) => setRoleIds((ids) => (c ? [...ids, r.id] : ids.filter((x) => x !== r.id)))} label={<>{r.name} <span className="muted">({r.permissions.length})</span></>} />
                  ))}
                </div>
              )}
            </div>
            {member && <p className="muted">{t('users.tech_hint', { n: member.techNumber })}</p>}
          </div>
        ) : (
          <div className="stack">
            <p className="muted">{t('users.perms_hint')}</p>
            <UserSalesScope overrides={ov} onChange={setOv} rolePermissions={rolePerms} disabled={admin} />
            <UserOverrides overrides={ov} onChange={setOv} rolePermissions={rolePerms} disabled={admin} />
            {admin && <div className="alert alert-info">{t('users.admin_hint')}</div>}
          </div>
        )}
      </Modal>
      {resetOpen && member && <ResetPassword id={member.id} onClose={() => setResetOpen(false)} />}
    </>
  );
}

function ResetPassword({ id, onClose }: { id: number; onClose: () => void }) {
  const { t } = useTranslation();
  const err = useErr();
  const toast = useToast();
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try { await api.post(`/team/members/${id}/reset-password`, { password: pw }); toast.success(t('users.password_reset_done')); onClose(); }
    catch (e) { toast.error(err(e)); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} size="sm" title={t('users.reset_password')}
      footer={<><Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} disabled={pw.length < 8} onClick={go}>{t('common.save')}</Button></>}>
      <Field label={t('auth.new_password')} hint={t('users.reset_hint')}><Input type="text" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus autoComplete="off" /></Field>
    </Modal>
  );
}
