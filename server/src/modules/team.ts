import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { hashPassword, passwordProblem } from '../auth/password.js';
import { invalidateAccessCache, route, zId, zIdParam, zI18n } from '../http.js';
import { assertUserLimit } from '../services/billing.js';
import type { Db } from '../db.js';

const overrideSchema = z.object({ permission: z.string().min(3).max(80), effect: z.enum(['allow', 'deny']) });

async function setAccess(db: Db, companyId: number, membershipId: number, roleIds: number[], overrides: z.infer<typeof overrideSchema>[]) {
  await db.query('DELETE FROM membership_roles WHERE membership_id = $1', [membershipId]);
  if (roleIds.length) {
    const r = await db.query(
      `INSERT INTO membership_roles (company_id, membership_id, role_id)
       SELECT $1, $2, id FROM roles WHERE company_id = $1 AND id = ANY($3::bigint[])`, [companyId, membershipId, roleIds]);
    if (r.rowCount !== new Set(roleIds).size) throw badRequest('invalid_role');
  }
  await db.query('DELETE FROM membership_permissions WHERE membership_id = $1', [membershipId]);
  if (overrides.length) {
    const r = await db.query(
      `INSERT INTO membership_permissions (company_id, membership_id, permission_id, effect)
       SELECT $1, $2, p.id, o.effect
         FROM jsonb_to_recordset($3::jsonb) AS o(permission text, effect text)
         JOIN permissions p ON p.key = o.permission`, [companyId, membershipId, JSON.stringify(overrides)]);
    if (r.rowCount !== overrides.length) throw badRequest('invalid_permission');
  }
  invalidateAccessCache();
}

/** ¿El usuario pertenece también a otras empresas? Si sí, esta empresa no puede tocar sus datos globales. */
async function isExclusiveMember(db: Db, companyId: number, userId: number) {
  const r = await db.one<{ n: number }>('SELECT count(*)::int AS n FROM memberships WHERE user_id = $1 AND company_id <> $2', [userId, companyId]);
  return r.n === 0;
}

/**
 * El administrador principal (el que se crea al instalar) es único y solo él puede cambiar sus propios datos:
 * nadie más lo edita, le cambia la contraseña, lo desactiva ni le quita el rol de administrador.
 */
async function assertNotOwner(db: Db, targetUserId: number, callerUserId: number) {
  const t = await db.opt<{ is_platform_admin: boolean }>('SELECT is_platform_admin FROM users WHERE id = $1', [targetUserId]);
  if (t?.is_platform_admin && targetUserId !== callerUserId) throw forbidden('owner_protected');
}

export async function teamRoutes(app: FastifyInstance) {
  // ---------- Catálogo de permisos ----------
  app.get('/api/permissions', route(['roles.view', 'users.view'], async (c) => {
    const items = await c.db.rows('SELECT key, module, name, sort_order AS "sortOrder" FROM permissions ORDER BY sort_order');
    return { items };
  }));

  // ---------- Roles ----------
  app.get('/api/roles', route(['roles.view', 'users.view'], async (c) => {
    const roles = await c.db.rows(
      `SELECT r.id, r.name, r.description, r.is_active AS "isActive",
              COALESCE((SELECT array_agg(p.key ORDER BY p.sort_order) FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = r.id), '{}') AS permissions,
              (SELECT count(*) FROM membership_roles mr WHERE mr.role_id = r.id)::int AS members
         FROM roles r ORDER BY r.name`);
    return { items: roles };
  }));

  const roleSchema = z.object({
    name: z.string().trim().min(2).max(60),
    description: z.string().trim().max(300).nullish(),
    permissions: z.array(z.string()).max(200),
    isActive: z.boolean().optional(),
  });

  async function saveRolePerms(c: { db: Db; companyId: number }, roleId: number, keys: string[]) {
    await c.db.query('DELETE FROM role_permissions WHERE role_id = $1', [roleId]);
    const uniq = [...new Set(keys)];
    const r = await c.db.query(
      `INSERT INTO role_permissions (company_id, role_id, permission_id)
       SELECT $1, $2, id FROM permissions WHERE key = ANY($3::text[])`, [c.companyId, roleId, uniq]);
    if (r.rowCount !== uniq.length) throw badRequest('invalid_permission');
    invalidateAccessCache();
  }

  app.post('/api/roles', route('roles.manage', async (c) => {
    const b = c.body(roleSchema);
    const r = await c.db.one<{ id: number }>('INSERT INTO roles (company_id, name, description) VALUES ($1,$2,$3) RETURNING id', [c.companyId, b.name, b.description ?? null]);
    await saveRolePerms(c, r.id, b.permissions);
    await c.audit('role.created', 'role', r.id, { name: b.name });
    return { id: r.id };
  }));

  app.put('/api/roles/:id', route('roles.manage', async (c) => {
    const { id } = c.params(zIdParam);
    const b = c.body(roleSchema);
    const r = await c.db.query('UPDATE roles SET name = $2, description = $3, is_active = COALESCE($4, is_active) WHERE id = $1', [id, b.name, b.description ?? null, b.isActive ?? null]);
    if (!r.rowCount) throw notFound();
    await saveRolePerms(c, id, b.permissions);
    await c.audit('role.updated', 'role', id, { name: b.name, permissions: b.permissions.length });
    return { ok: true };
  }));

  app.delete('/api/roles/:id', route('roles.manage', async (c) => {
    const { id } = c.params(zIdParam);
    const r = await c.db.query('DELETE FROM roles WHERE id = $1', [id]);
    if (!r.rowCount) throw notFound();
    invalidateAccessCache();
    await c.audit('role.deleted', 'role', id);
    return { ok: true };
  }));

  // ---------- Usuarios de la empresa ----------
  app.get('/api/team/members', route('users.view', async (c) => {
    const items = await c.db.rows(
      `SELECT m.id, m.user_id AS "userId", u.username, u.email, u.full_name AS "fullName", u.last_login_at AS "lastLoginAt",
              m.tech_number AS "techNumber", m.is_company_admin AS "isCompanyAdmin", m.is_active AS "isActive",
              u.is_platform_admin AS "isOwner",
              COALESCE((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name) ORDER BY r.name)
                          FROM membership_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.membership_id = m.id), '[]') AS roles,
              (SELECT count(*) FROM membership_permissions mp WHERE mp.membership_id = m.id)::int AS "overrides"
         FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.company_id = $1 ORDER BY u.full_name`, [c.companyId]);
    return { items };
  }));

  app.get('/api/team/members/:id', route('users.view', async (c) => {
    const { id } = c.params(zIdParam);
    const m = await c.db.opt<any>(
      `SELECT m.id, m.user_id AS "userId", u.username, u.email, u.full_name AS "fullName", m.tech_number AS "techNumber",
              m.is_company_admin AS "isCompanyAdmin", m.is_active AS "isActive", u.is_platform_admin AS "isOwner"
         FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.company_id = $1 AND m.id = $2`, [c.companyId, id]);
    if (!m) throw notFound();
    const roleIds = (await c.db.rows<{ role_id: number }>('SELECT role_id FROM membership_roles WHERE membership_id = $1', [id])).map((r) => r.role_id);
    const overrides = await c.db.rows(
      `SELECT p.key AS permission, mp.effect FROM membership_permissions mp JOIN permissions p ON p.id = mp.permission_id WHERE mp.membership_id = $1 ORDER BY p.sort_order`, [id]);
    return { ...m, roleIds, overrides };
  }));

  app.post('/api/team/members', route('users.manage', async (c) => {
    const b = c.body(z.object({
      username: z.string().trim().min(3).max(60).regex(/^[a-zA-Z0-9._-]+$/),
      fullName: z.string().trim().min(2).max(120),
      email: z.string().trim().email().nullish(),
      password: z.string().min(1).max(200).optional(),
      isCompanyAdmin: z.boolean().default(false),
      roleIds: z.array(zId).default([]),
      overrides: z.array(overrideSchema).default([]),
    }));
    await assertUserLimit(c.db, c.companyId);
    let userId: number;
    let created = false;
    const existing = await c.db.opt<{ id: number; is_platform_admin: boolean }>('SELECT id, is_platform_admin FROM users WHERE lower(username) = lower($1)', [b.username]);
    if (existing) {
      if (existing.is_platform_admin) throw forbidden('owner_protected');
      // El usuario ya existe (p. ej. trabaja en otra empresa): solo se le da acceso a esta.
      userId = existing.id;
      if (await c.db.opt('SELECT 1 FROM memberships WHERE company_id = $1 AND user_id = $2', [c.companyId, userId])) throw conflict('already_member');
    } else {
      if (!b.password) throw badRequest('password_required');
      const problem = passwordProblem(b.password);
      if (problem) throw badRequest(problem);
      const u = await c.db.one<{ id: number }>(
        `INSERT INTO users (username, email, full_name, password_hash, must_change_password) VALUES ($1,$2,$3,$4,true) RETURNING id`,
        [b.username, b.email ?? null, b.fullName, await hashPassword(b.password)]);
      userId = u.id;
      created = true;
    }
    const { value: tech } = await c.db.one<{ value: number }>("SELECT next_seq('tech_number') AS value");
    const m = await c.db.one<{ id: number }>(
      `INSERT INTO memberships (company_id, user_id, tech_number, is_company_admin) VALUES ($1,$2,$3,$4) RETURNING id`,
      [c.companyId, userId, tech, b.isCompanyAdmin]);
    await setAccess(c.db, c.companyId, m.id, b.roleIds, b.overrides);
    await c.audit('member.added', 'membership', m.id, { username: b.username, createdUser: created });
    return { id: m.id, techNumber: tech, createdUser: created };
  }));

  app.put('/api/team/members/:id', route('users.manage', async (c) => {
    const { id } = c.params(zIdParam);
    const b = c.body(z.object({
      isActive: z.boolean().optional(),
      isCompanyAdmin: z.boolean().optional(),
      roleIds: z.array(zId),
      overrides: z.array(overrideSchema),
      fullName: z.string().trim().min(2).max(120).optional(),
      email: z.string().trim().email().nullable().optional(),
    }));
    const m = await c.db.opt<{ user_id: number; is_company_admin: boolean }>('SELECT user_id, is_company_admin FROM memberships WHERE company_id = $1 AND id = $2', [c.companyId, id]);
    if (!m) throw notFound();
    await assertNotOwner(c.db, m.user_id, c.userId);
    // Nadie puede quitarse a sí mismo el acceso o el rol de administrador (evita quedarse fuera).
    if (m.user_id === c.userId && (b.isActive === false || b.isCompanyAdmin === false)) throw badRequest('cannot_demote_self');
    await c.db.query(
      'UPDATE memberships SET is_active = COALESCE($2, is_active), is_company_admin = COALESCE($3, is_company_admin) WHERE id = $1',
      [id, b.isActive ?? null, b.isCompanyAdmin ?? null]);
    if ((b.fullName !== undefined || b.email !== undefined)) {
      if (!(await isExclusiveMember(c.db, c.companyId, m.user_id))) throw conflict('user_in_other_companies');
      await c.db.query('UPDATE users SET full_name = COALESCE($2, full_name), email = CASE WHEN $3::boolean THEN $4 ELSE email END WHERE id = $1',
        [m.user_id, b.fullName ?? null, b.email !== undefined, b.email ?? null]);
    }
    await setAccess(c.db, c.companyId, id, b.roleIds, b.overrides);
    await c.audit('member.updated', 'membership', id, { roles: b.roleIds.length, overrides: b.overrides.length, isActive: b.isActive });
    return { ok: true };
  }));

  app.post('/api/team/members/:id/reset-password', route('users.manage', async (c) => {
    const { id } = c.params(zIdParam);
    const { password } = c.body(z.object({ password: z.string().min(1).max(200) }));
    const problem = passwordProblem(password);
    if (problem) throw badRequest(problem);
    const m = await c.db.opt<{ user_id: number }>('SELECT user_id FROM memberships WHERE company_id = $1 AND id = $2', [c.companyId, id]);
    if (!m) throw notFound();
    await assertNotOwner(c.db, m.user_id, c.userId);
    // Una empresa no puede tomar el control de la cuenta de alguien que también trabaja en otra.
    if (!(await isExclusiveMember(c.db, c.companyId, m.user_id))) throw conflict('user_in_other_companies');
    await c.db.query('UPDATE users SET password_hash = $2, must_change_password = true WHERE id = $1', [m.user_id, await hashPassword(password)]);
    await c.db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [m.user_id]);
    await c.audit('member.password_reset', 'membership', id);
    return { ok: true };
  }));
}

export { zI18n };
