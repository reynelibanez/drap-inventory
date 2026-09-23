import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import { z, type ZodType } from 'zod';
import { Db, withGlobal, withTenant } from './db.js';
import { badRequest, conflict, forbidden, paymentRequired, unauthorized } from './errors.js';
import { isBillingBlocked } from './services/billing.js';

/** Contenido del token de acceso. `sid` identifica la sesión (fila de refresh_tokens); los tokens emitidos
 *  antes de que existiera este campo no lo tienen y se dejan pasar igual hasta que se renueven. */
export interface TokenPayload { sub: number; cid: number | null; sid?: number }

declare module '@fastify/jwt' {
  interface FastifyJWT { payload: TokenPayload; user: TokenPayload }
}

export interface Ctx {
  req: FastifyRequest;
  reply: FastifyReply;
  db: Db;
  userId: number;
  companyId: number;
  membershipId: number;
  techNumber: number;
  isCompanyAdmin: boolean;
  isPlatformAdmin: boolean;
  can(permission: string): boolean;
  /** Lanza 403 si falta el permiso. */
  need(...permissions: string[]): void;
  audit(action: string, entity: string, entityId: number | null, data?: Record<string, unknown>): Promise<void>;
  /** Valida y devuelve el cuerpo de la petición. */
  body<T extends ZodType>(schema: T): z.infer<T>;
  query<T extends ZodType>(schema: T): z.infer<T>;
  params<T extends ZodType>(schema: T): z.infer<T>;
}

// ---- permisos efectivos (roles + excepciones por usuario), con caché corta ----

interface Access {
  isAdmin: boolean; techNumber: number; membershipId: number; perms: Set<string>; expires: number;
  isPlatformAdmin: boolean;
  billing: { status: string; trialEndsAt: string | null };
}
const accessCache = new Map<string, Access>();
const CACHE_MS = 5_000;

/** Llamar tras cambiar roles/permisos/membresías/suscripción para que apliquen de inmediato. */
export function invalidateAccessCache() { accessCache.clear(); }

// ---- validez de la sesión (un solo dispositivo a la vez), con caché corta ----

const sessionCache = new Map<number, { valid: boolean; expires: number }>();
const SESSION_CACHE_MS = 5_000;

/** Llamar al cerrar una sesión (login en otro dispositivo, logout) para que el corte sea inmediato. */
export function invalidateSessionCache(sid?: number) {
  if (sid == null) sessionCache.clear(); else sessionCache.delete(sid);
}

/**
 * Solo puede haber una sesión abierta por usuario: al iniciar sesión en otro dispositivo, las demás se revocan
 * (ver /api/auth/login). Si el token de esta petición pertenece a una sesión ya revocada, se corta acá.
 * `sid` puede faltar en tokens emitidos antes de este cambio: se dejan pasar hasta que se renueven solos.
 */
async function assertSessionValid(sid: number | undefined): Promise<void> {
  if (sid == null) return;
  const hit = sessionCache.get(sid);
  if (hit && hit.expires > Date.now()) {
    if (!hit.valid) throw unauthorized('session_revoked');
    return;
  }
  const row = await withGlobal((db) => db.opt('SELECT 1 FROM refresh_tokens WHERE id = $1 AND revoked_at IS NULL', [sid]));
  const valid = !!row;
  sessionCache.set(sid, { valid, expires: Date.now() + SESSION_CACHE_MS });
  if (!valid) throw unauthorized('session_revoked');
}

async function loadAccess(db: Db, companyId: number, userId: number): Promise<Access> {
  const key = `${companyId}:${userId}`;
  const hit = accessCache.get(key);
  if (hit && hit.expires > Date.now()) return hit;

  const m = await db.opt<{
    id: number; tech_number: number; is_company_admin: boolean; is_active: boolean; user_active: boolean; company_active: boolean;
    is_platform_admin: boolean; subscription_status: string; trial_ends_at: string | null;
  }>(
    `SELECT m.id, m.tech_number, m.is_company_admin, m.is_active,
            u.is_active AS user_active, u.is_platform_admin, c.is_active AS company_active,
            c.subscription_status, c.trial_ends_at
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       JOIN companies c ON c.id = m.company_id
      WHERE m.company_id = $1 AND m.user_id = $2`,
    [companyId, userId],
  );
  if (!m || !m.is_active || !m.user_active || !m.company_active) throw forbidden('no_company_access');

  const rows = await db.rows<{ key: string; effect: string }>(
    `SELECT p.key, 'role' AS effect
       FROM membership_roles mr
       JOIN roles r ON r.id = mr.role_id AND r.is_active
       JOIN role_permissions rp ON rp.role_id = r.id
       JOIN permissions p ON p.id = rp.permission_id
      WHERE mr.membership_id = $1
     UNION ALL
     SELECT p.key, mp.effect
       FROM membership_permissions mp
       JOIN permissions p ON p.id = mp.permission_id
      WHERE mp.membership_id = $1`,
    [m.id],
  );
  const perms = new Set<string>();
  for (const r of rows) if (r.effect === 'role' || r.effect === 'allow') perms.add(r.key);
  for (const r of rows) if (r.effect === 'deny') perms.delete(r.key);

  const access: Access = {
    isAdmin: m.is_company_admin, techNumber: m.tech_number, membershipId: m.id, perms, expires: Date.now() + CACHE_MS,
    isPlatformAdmin: m.is_platform_admin,
    billing: { status: m.subscription_status, trialEndsAt: m.trial_ends_at },
  };
  accessCache.set(key, access);
  return access;
}

function issues(err: z.ZodError) {
  return err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

function parse<T extends ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) throw badRequest('validation', { issues: issues(r.error) });
  return r.data;
}

/**
 * Ruta con empresa activa: autentica, resuelve permisos, abre una transacción
 * limitada a la empresa (RLS) y ejecuta el manejador. Si algo falla, todo se revierte.
 *
 * `permission`: una función requerida, varias (basta una) o null (solo estar dentro de la empresa).
 *
 * `opts.skipBillingGate`: deja pasar aunque la suscripción de la empresa esté vencida/bloqueada
 * (solo para las rutas de facturación: si no, nadie podría pagar para desbloquearse). El admin de
 * plataforma también pasa siempre, para poder entrar a dar soporte a una empresa bloqueada.
 */
export function route<T>(permission: string | string[] | null, fn: (c: Ctx) => Promise<T>, opts: { skipBillingGate?: boolean } = {}): RouteHandlerMethod {
  return async function (req, reply) {
    let payload: TokenPayload;
    try {
      await req.jwtVerify();
      payload = req.user;
    } catch {
      throw unauthorized();
    }
    await assertSessionValid(payload.sid);
    if (!payload.cid) throw unauthorized('company_not_selected');
    const companyId = payload.cid;

    return withTenant(companyId, async (db) => {
      const access = await loadAccess(db, companyId, payload.sub);
      if (!opts.skipBillingGate && !access.isPlatformAdmin
          && isBillingBlocked({ subscriptionStatus: access.billing.status as any, trialEndsAt: access.billing.trialEndsAt })) {
        throw paymentRequired('subscription_expired', { trialEndsAt: access.billing.trialEndsAt });
      }
      const can = (p: string) => access.isAdmin || access.perms.has(p);
      const need = (...ps: string[]) => { if (!ps.some(can)) throw forbidden('missing_permission', { permission: ps.join('|') }); };
      if (permission) need(...(Array.isArray(permission) ? permission : [permission]));

      const ctx: Ctx = {
        req, reply, db,
        userId: payload.sub,
        companyId,
        membershipId: access.membershipId,
        techNumber: access.techNumber,
        isCompanyAdmin: access.isAdmin,
        isPlatformAdmin: access.isPlatformAdmin,
        can, need,
        audit: async (action, entity, entityId, data = {}) => {
          await db.query(
            'INSERT INTO audit_log (company_id, user_id, action, entity, entity_id, data, ip) VALUES ($1,$2,$3,$4,$5,$6,$7)',
            [companyId, payload.sub, action, entity, entityId, JSON.stringify(data), req.ip],
          );
        },
        body: (schema) => parse(schema, req.body ?? {}),
        query: (schema) => parse(schema, req.query ?? {}),
        params: (schema) => parse(schema, req.params ?? {}),
      };
      // Envío repetido de una acción hecha sin conexión: se responde lo ya guardado, sin ejecutarla otra vez.
      const idemKey = req.method === 'GET' ? null : idempotencyKey(req);
      if (!idemKey) return fn(ctx);
      const path = req.url.split('?')[0];
      // Serializa dos envíos simultáneos con la misma llave (p. ej. reintento mientras el primero sigue en curso).
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`idem:${companyId}:${payload.sub}:${idemKey}`]);
      const done = await db.opt<{ method: string; path: string; status: number; response: unknown }>(
        'SELECT method, path, status, response FROM idempotency_keys WHERE company_id = $1 AND user_id = $2 AND key = $3',
        [companyId, payload.sub, idemKey]);
      if (done) {
        if (done.method !== req.method || done.path !== path) throw conflict('idempotency_key_reused');
        reply.header('Idempotent-Replayed', 'true');
        reply.code(done.status);
        return done.response;
      }
      const result = await fn(ctx);
      await db.query(
        `INSERT INTO idempotency_keys (company_id, user_id, key, method, path, status, response) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [companyId, payload.sub, idemKey, req.method, path, reply.statusCode, JSON.stringify(result ?? null)]);
      // Limpieza ocasional de llaves viejas (ya no se van a reintentar).
      if (Math.random() < 0.02) await db.query(`DELETE FROM idempotency_keys WHERE created_at < now() - interval '30 days'`);
      return result;
    });
  };
}

function idempotencyKey(req: FastifyRequest): string | null {
  const v = req.headers['idempotency-key'];
  const k = (Array.isArray(v) ? v[0] : v)?.trim();
  return k && k.length >= 8 && k.length <= 100 ? k : null;
}

export interface GlobalCtx {
  req: FastifyRequest;
  reply: FastifyReply;
  db: Db;
  userId: number;
  isPlatformAdmin: boolean;
  companyId: number | null;
  body<T extends ZodType>(schema: T): z.infer<T>;
  params<T extends ZodType>(schema: T): z.infer<T>;
}

/** Ruta autenticada sin empresa (perfil, lista de empresas, cambio de empresa). */
export function userRoute<T>(fn: (c: GlobalCtx) => Promise<T>, opts: { platformAdmin?: boolean } = {}): RouteHandlerMethod {
  return async function (req, reply) {
    try { await req.jwtVerify(); } catch { throw unauthorized(); }
    const payload = req.user;
    await assertSessionValid(payload.sid);
    return withGlobal(async (db) => {
      const u = await db.opt<{ is_active: boolean; is_platform_admin: boolean }>('SELECT is_active, is_platform_admin FROM users WHERE id = $1', [payload.sub]);
      if (!u || !u.is_active) throw unauthorized();
      if (opts.platformAdmin && !u.is_platform_admin) throw forbidden('platform_admin_only');
      return fn({
        req, reply, db, userId: payload.sub, isPlatformAdmin: u.is_platform_admin, companyId: payload.cid,
        body: (schema) => parse(schema, req.body ?? {}),
        params: (schema) => parse(schema, req.params ?? {}),
      });
    });
  };
}

export { parse };

// ---- validaciones comunes ----
export const zId = z.coerce.number().int().positive();
export const zIdParam = z.object({ id: zId });
export const zI18n = z.partialRecord(z.enum(['es', 'en']), z.string().trim().min(1).max(200)).refine((o) => Object.keys(o).length > 0, 'i18n_required');
export const zOptText = (max = 500) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));
export const zPage = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(5000).default(50),
  q: z.string().trim().max(100).optional(),
});
