import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { withGlobal, withTenant } from '../db.js';
import { badRequest, forbidden, unauthorized } from '../errors.js';
import { hashPassword, hashToken, newOpaqueToken, passwordProblem, verifyPassword } from '../auth/password.js';
import { invalidateSessionCache, userRoute, zId } from '../http.js';
import { getSettings } from '../settings.js';
import { billingSummary, getCompanyBilling } from '../services/billing.js';

const COOKIE = 'rt';
const cookiePath = '/api/auth';

// Hash falso para igualar el tiempo de respuesta cuando el usuario no existe.
const DUMMY_HASH = await hashPassword('dummy-password-for-timing');

interface CompanyRow { id: number; name: string; slug: string; default_language: string; currency: string; is_company_admin: boolean; tech_number: number }

async function listCompanies(db: import('../db.js').Db, userId: number) {
  const rows = await db.rows<CompanyRow>(
    `SELECT c.id, c.name, c.slug, c.default_language, c.currency, m.is_company_admin, m.tech_number
       FROM memberships m JOIN companies c ON c.id = m.company_id
      WHERE m.user_id = $1 AND m.is_active AND c.is_active
      ORDER BY c.name`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id, name: r.name, slug: r.slug, defaultLanguage: r.default_language, currency: r.currency,
    isCompanyAdmin: r.is_company_admin, techNumber: r.tech_number,
  }));
}

async function effectivePermissions(companyId: number, userId: number) {
  return withTenant(companyId, async (db) => {
    const m = await db.opt<{ id: number; is_company_admin: boolean }>(
      'SELECT id, is_company_admin FROM memberships WHERE company_id = $1 AND user_id = $2 AND is_active', [companyId, userId]);
    if (!m) return null;
    const rows = await db.rows<{ key: string; effect: string }>(
      `SELECT p.key, 'role' AS effect FROM membership_roles mr
         JOIN roles r ON r.id = mr.role_id AND r.is_active
         JOIN role_permissions rp ON rp.role_id = r.id JOIN permissions p ON p.id = rp.permission_id
        WHERE mr.membership_id = $1
       UNION ALL
       SELECT p.key, mp.effect FROM membership_permissions mp JOIN permissions p ON p.id = mp.permission_id
        WHERE mp.membership_id = $1`, [m.id]);
    const set = new Set<string>();
    for (const r of rows) if (r.effect !== 'deny') set.add(r.key);
    for (const r of rows) if (r.effect === 'deny') set.delete(r.key);
    const roles = await db.rows<{ id: number; name: string }>(
      'SELECT r.id, r.name FROM membership_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.membership_id = $1 ORDER BY r.name', [m.id]);
    const settings = await getSettings(db, companyId);
    const cb = await getCompanyBilling(db, companyId);
    return {
      isCompanyAdmin: m.is_company_admin, permissions: [...set].sort(), roles,
      settings: { reservationDays: settings.reservationDays, unitCodeFormat: settings.unitCodeFormat, inactivityLockMinutes: settings.inactivityLockMinutes },
      billing: cb ? billingSummary(cb) : null,
    };
  });
}

export async function authRoutes(app: FastifyInstance) {
  const sign = (userId: number, companyId: number | null, sid?: number) =>
    app.jwt.sign({ sub: userId, cid: companyId, sid }, { expiresIn: `${config.accessTokenMinutes}m` });

  function setRefreshCookie(reply: FastifyReply, token: string) {
    reply.setCookie(COOKIE, token, {
      httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: cookiePath,
      maxAge: config.refreshTokenDays * 24 * 3600,
    });
  }

  async function session(userId: number, companyId: number | null, sid?: number) {
    return withGlobal(async (db) => {
      const u = await db.one<any>(
        'SELECT id, username, email, full_name, language, is_platform_admin, must_change_password FROM users WHERE id = $1', [userId]);
      const companies = await listCompanies(db, userId);
      let active = companyId && companies.some((c) => c.id === companyId) ? companyId : null;
      if (!active && companies.length === 1) active = companies[0].id;
      const access = active ? await effectivePermissions(active, userId) : null;
      return {
        accessToken: sign(userId, active, sid),
        user: {
          id: u.id, username: u.username, email: u.email, fullName: u.full_name, language: u.language,
          isPlatformAdmin: u.is_platform_admin, mustChangePassword: u.must_change_password,
        },
        companies,
        activeCompanyId: active,
        access,
      };
    });
  }

  /** Crea la fila de sesión (una por dispositivo) y devuelve su id -sirve de "sid" en el token de acceso- y el token de la cookie. */
  async function newRefresh(userId: number, companyId: number | null, req: { headers: any; ip: string }): Promise<{ id: number; token: string }> {
    const { token, hash } = newOpaqueToken();
    const row = await withGlobal((db) => db.one<{ id: number }>(
      `INSERT INTO refresh_tokens (user_id, company_id, token_hash, expires_at, user_agent, ip)
       VALUES ($1,$2,$3, now() + make_interval(days => $4), $5, $6) RETURNING id`,
      [userId, companyId, hash, config.refreshTokenDays, String(req.headers['user-agent'] ?? '').slice(0, 300), req.ip]));
    return { id: row.id, token };
  }

  // ---- Iniciar sesión ----
  app.post('/api/auth/login', { config: { rateLimit: { max: process.env.NODE_ENV === 'test' ? 10_000 : 12, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { username, password } = z.object({ username: z.string().trim().min(1).max(100), password: z.string().min(1).max(200) }).parse(req.body);
    const user = await withGlobal((db) => db.opt<any>(
      'SELECT id, password_hash, is_active FROM users WHERE lower(username) = lower($1) OR lower(email) = lower($1)', [username]));
    const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok || !user.is_active) throw unauthorized('invalid_credentials');

    await withGlobal((db) => db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]));
    // Un solo dispositivo a la vez: cualquier otra sesión abierta de este usuario se cierra ahora mismo
    // (no cuando se le venza el token de acceso).
    const revoked = await withGlobal((db) => db.rows<{ id: number }>(
      `UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL RETURNING id`, [user.id]));
    for (const r of revoked) invalidateSessionCache(r.id);
    const { id: sid, token } = await newRefresh(user.id, null, req);
    setRefreshCookie(reply, token);
    const s = await session(user.id, null, sid);
    if (s.activeCompanyId) await withGlobal((db) => db.query('UPDATE refresh_tokens SET company_id = $2 WHERE id = $1', [sid, s.activeCompanyId]));
    return s;
  });

  // ---- Renovar sesión (al abrir la app o al vencer el token de acceso) ----
  app.post('/api/auth/refresh', async (req, reply) => {
    const raw = req.cookies[COOKIE];
    if (!raw) throw unauthorized('no_session');
    const row = await withGlobal((db) => db.opt<{ id: number; user_id: number; company_id: number | null }>(
      `SELECT id, user_id, company_id FROM refresh_tokens
        WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`, [hashToken(raw)]));
    if (!row) { reply.clearCookie(COOKIE, { path: cookiePath }); throw unauthorized('no_session'); }
    const active = await withGlobal((db) => db.opt('SELECT 1 FROM users WHERE id = $1 AND is_active', [row.user_id]));
    if (!active) throw unauthorized('no_session');
    // Renovación deslizante: mientras se use, la sesión sigue viva.
    await withGlobal((db) => db.query(
      'UPDATE refresh_tokens SET expires_at = now() + make_interval(days => $2) WHERE id = $1', [row.id, config.refreshTokenDays]));
    return session(row.user_id, row.company_id, row.id);
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const raw = req.cookies[COOKIE];
    if (raw) await withGlobal((db) => db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1', [hashToken(raw)]));
    reply.clearCookie(COOKIE, { path: cookiePath });
    return { ok: true };
  });

  // ---- Cambiar de empresa sin volver a iniciar sesión ----
  app.post('/api/auth/select-company', userRoute(async (c) => {
    const { companyId } = c.body(z.object({ companyId: zId }));
    const m = await c.db.opt(
      `SELECT 1 FROM memberships m JOIN companies co ON co.id = m.company_id
        WHERE m.user_id = $1 AND m.company_id = $2 AND m.is_active AND co.is_active`, [c.userId, companyId]);
    if (!m) throw forbidden('no_company_access');
    const raw = c.req.cookies[COOKIE];
    if (raw) await c.db.query('UPDATE refresh_tokens SET company_id = $2 WHERE token_hash = $1', [hashToken(raw), companyId]);
    return session(c.userId, companyId, c.req.user.sid);
  }));

  // ---- Desbloquear tras el bloqueo por inactividad: confirma la contraseña sin cerrar la sesión ----
  app.post('/api/auth/unlock', { config: { rateLimit: { max: process.env.NODE_ENV === 'test' ? 10_000 : 12, timeWindow: '1 minute' } } },
    userRoute(async (c) => {
      const { password } = c.body(z.object({ password: z.string().min(1).max(200) }));
      const u = await c.db.one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [c.userId]);
      if (!(await verifyPassword(password, u.password_hash))) throw unauthorized('invalid_credentials');
      return { ok: true };
    }));

  // ---- Perfil ----
  app.patch('/api/auth/profile', userRoute(async (c) => {
    const b = c.body(z.object({
      fullName: z.string().trim().min(1).max(120).optional(),
      email: z.string().trim().email().max(200).nullable().optional(),
      language: z.enum(['es', 'en']).nullable().optional(),
    }));
    await c.db.query(
      `UPDATE users SET full_name = COALESCE($2, full_name),
                        email = CASE WHEN $3::boolean THEN $4 ELSE email END,
                        language = CASE WHEN $5::boolean THEN $6 ELSE language END
        WHERE id = $1`,
      [c.userId, b.fullName ?? null, b.email !== undefined, b.email ?? null, b.language !== undefined, b.language ?? null]);
    return { ok: true };
  }));

  app.post('/api/auth/change-password', userRoute(async (c) => {
    const { current, next } = c.body(z.object({ current: z.string().min(1), next: z.string().min(1).max(200) }));
    const problem = passwordProblem(next);
    if (problem) throw badRequest(problem);
    const u = await c.db.one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [c.userId]);
    if (!(await verifyPassword(current, u.password_hash))) throw badRequest('wrong_current_password');
    await c.db.query('UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1', [c.userId, await hashPassword(next)]);
    // Cierra las demás sesiones abiertas (conserva la actual).
    const raw = c.req.cookies[COOKIE];
    const revoked = await c.db.rows<{ id: number }>(
      'UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND token_hash <> $2 AND revoked_at IS NULL RETURNING id',
      [c.userId, raw ? hashToken(raw) : '']);
    for (const r of revoked) invalidateSessionCache(r.id);
    return { ok: true };
  }));
}
