import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { useMeta } from '../lib/meta';
import { Eye, UserRound } from 'lucide-react';
import { Badge, Button, Checkbox, Spinner } from './ui';

interface Perm { key: string; module: string; name: Record<string, string> }
export type Effect = 'allow' | 'deny';

/** Función que decide si se ven las ventas de todos o solo las propias: tiene su propio control destacado (no va en la lista general). */
export const SALES_SCOPE = 'sales.view_all';

export function usePermissions() {
  return useQuery({ queryKey: ['permissions'], queryFn: () => api.get<{ items: Perm[] }>('/permissions'), staleTime: 5 * 60_000 });
}

function useGroups() {
  const q = usePermissions();
  const groups = useMemo(() => {
    const m = new Map<string, Perm[]>();
    for (const p of q.data?.items ?? []) if (p.key !== SALES_SCOPE) (m.get(p.module) ?? m.set(p.module, []).get(p.module)!).push(p);
    return [...m.entries()];
  }, [q.data]);
  return { groups, loading: q.isLoading };
}

/** Lista de funciones del sistema agrupadas por módulo, con casilla para marcarlas (se usa en Roles). */
export function RolePermissions({ value, onChange, disabled }: { value: string[]; onChange: (v: string[]) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  const meta = useMeta();
  const { groups, loading } = useGroups();
  if (loading) return <Spinner />;
  const set = new Set(value);
  const toggleMany = (keys: string[], on: boolean) => { const n = new Set(set); for (const k of keys) { if (on) n.add(k); else n.delete(k); } onChange([...n]); };
  return (
    <div>
      {groups.map(([mod, perms]) => {
        const keys = perms.map((p) => p.key);
        const all = keys.every((k) => set.has(k));
        return (
          <div key={mod} className="perm-module">
            <header>
              <span>{t(`permModules.${mod}`, { defaultValue: mod })}</span>
              {!disabled && <Button size="sm" variant="ghost" onClick={() => toggleMany(keys, !all)}>{all ? t('permissions.none') : t('permissions.all')}</Button>}
            </header>
            {perms.map((p) => (
              <div key={p.key} className="perm-row"><Checkbox disabled={disabled} checked={set.has(p.key)} onChange={(c) => toggleMany([p.key], c)} label={meta.label(p.name)} /></div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Excepciones por usuario: cada función puede heredarse de los roles, permitirse aunque
 * los roles no la den, o denegarse aunque los roles la den.
 */
export function UserOverrides({ overrides, onChange, rolePermissions, disabled }: {
  overrides: Record<string, Effect>; onChange: (v: Record<string, Effect>) => void; rolePermissions: Set<string>; disabled?: boolean;
}) {
  const { t } = useTranslation();
  const meta = useMeta();
  const { groups, loading } = useGroups();
  if (loading) return <Spinner />;
  const setOne = (key: string, v: Effect | null) => { const n = { ...overrides }; if (v) n[key] = v; else delete n[key]; onChange(n); };
  return (
    <div>
      {groups.map(([mod, perms]) => (
        <div key={mod} className="perm-module">
          <header><span>{t(`permModules.${mod}`, { defaultValue: mod })}</span></header>
          {perms.map((p) => {
            const cur = overrides[p.key] ?? null;
            const byRole = rolePermissions.has(p.key);
            const effective = cur === 'allow' ? true : cur === 'deny' ? false : byRole;
            return (
              <div key={p.key} className="perm-row">
                <span className="row gap-sm"><Badge tone={effective ? 'good' : 'neutral'}>{effective ? t('permissions.yes') : t('permissions.no')}</Badge>{meta.label(p.name)}</span>
                <span className="tri">
                  <button type="button" disabled={disabled} className={cur === null ? 'on-inherit' : ''} onClick={() => setOne(p.key, null)}>{byRole ? t('permissions.inherit_yes') : t('permissions.inherit_no')}</button>
                  <button type="button" disabled={disabled} className={cur === 'allow' ? 'on-allow' : ''} onClick={() => setOne(p.key, 'allow')}>{t('common.allow')}</button>
                  <button type="button" disabled={disabled} className={cur === 'deny' ? 'on-deny' : ''} onClick={() => setOne(p.key, 'deny')}>{t('common.deny')}</button>
                </span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Rol: ¿ve solo sus ventas o las de todos? (función sales.view_all). */
export function RoleSalesScope({ value, onChange, disabled }: { value: string[]; onChange: (v: string[]) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  const all = value.includes(SALES_SCOPE);
  const set = (on: boolean) => onChange(on ? [...new Set([...value, SALES_SCOPE])] : value.filter((k) => k !== SALES_SCOPE));
  const opts = [
    { on: false, icon: UserRound, title: t('roles.scope_own'), hint: t('roles.scope_own_hint') },
    { on: true, icon: Eye, title: t('roles.scope_all'), hint: t('roles.scope_all_hint') },
  ];
  return (
    <div className="scope-box">
      <div className="section-title">{t('roles.scope_title')}</div>
      <p className="muted">{t('roles.scope_hint')}</p>
      <div className="scope-opts">
        {opts.map((o) => (
          <button key={String(o.on)} type="button" disabled={disabled} className={`scope-opt ${all === o.on ? 'on' : ''}`} aria-pressed={all === o.on} onClick={() => set(o.on)}>
            <strong className="row gap-sm"><o.icon size={16} />{o.title}</strong>
            <span className="muted">{o.hint}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Usuario: hereda del rol o lo fuerza (permitir = ve todo, denegar = solo lo suyo). */
export function UserSalesScope({ overrides, onChange, rolePermissions, disabled }: {
  overrides: Record<string, Effect>; onChange: (v: Record<string, Effect>) => void; rolePermissions: Set<string>; disabled?: boolean;
}) {
  const { t } = useTranslation();
  const cur = overrides[SALES_SCOPE] ?? null;
  const byRole = rolePermissions.has(SALES_SCOPE);
  const setOne = (v: Effect | null) => { const n = { ...overrides }; if (v) n[SALES_SCOPE] = v; else delete n[SALES_SCOPE]; onChange(n); };
  const effective = cur === 'allow' ? true : cur === 'deny' ? false : byRole;
  return (
    <div className="scope-box">
      <div className="row spread wrap">
        <div className="section-title" style={{ margin: 0 }}>{t('users.scope_title')}</div>
        <Badge tone={effective ? 'good' : 'warn'}>{effective ? t('roles.scope_all') : t('roles.scope_own')}</Badge>
      </div>
      <p className="muted">{t('users.scope_hint')}</p>
      <span className="tri">
        <button type="button" disabled={disabled} className={cur === null ? 'on-inherit' : ''} onClick={() => setOne(null)}>{byRole ? t('users.scope_role_all') : t('users.scope_role_own')}</button>
        <button type="button" disabled={disabled} className={cur === 'deny' ? 'on-deny' : ''} onClick={() => setOne('deny')}>{t('users.scope_force_own')}</button>
        <button type="button" disabled={disabled} className={cur === 'allow' ? 'on-allow' : ''} onClick={() => setOne('allow')}>{t('users.scope_force_all')}</button>
      </span>
    </div>
  );
}
