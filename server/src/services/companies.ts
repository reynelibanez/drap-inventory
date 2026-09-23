import type { Db } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { hashPassword, passwordProblem } from '../auth/password.js';
import { seedCompanyDefaults } from '../seed/defaults.js';

export const slugify = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'empresa';

export interface NewCompany {
  name: string;
  slug?: string;
  legalName?: string | null;
  taxId?: string | null;
  defaultLanguage: 'es' | 'en';
  currency: string;
  timezone: string;
  admin: { existingUserId: number } | { username: string; fullName: string; email?: string | null; password: string; mustChangePassword?: boolean };
}

/**
 * Crea una empresa completa: registro, catálogos y roles iniciales, y su primer administrador.
 * Debe correr dentro de una transacción sin empresa activa (withGlobal).
 */
export async function createCompanyWithAdmin(db: Db, b: NewCompany): Promise<{ id: number; slug: string; adminUserId: number }> {
  const slug = b.slug ?? slugify(b.name);
  if (await db.opt('SELECT 1 FROM companies WHERE lower(slug) = $1', [slug])) throw conflict('company_slug_taken');

  let adminUserId: number;
  if ('existingUserId' in b.admin) {
    const u = await db.opt('SELECT id FROM users WHERE id = $1 AND is_active', [b.admin.existingUserId]);
    if (!u) throw notFound('user_not_found');
    adminUserId = b.admin.existingUserId;
  } else {
    const problem = passwordProblem(b.admin.password);
    if (problem) throw badRequest(problem);
    if (await db.opt('SELECT 1 FROM users WHERE lower(username) = lower($1)', [b.admin.username])) throw conflict('username_taken');
    const u = await db.one<{ id: number }>(
      `INSERT INTO users (username, email, full_name, password_hash, must_change_password) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [b.admin.username, b.admin.email ?? null, b.admin.fullName, await hashPassword(b.admin.password), b.admin.mustChangePassword ?? true]);
    adminUserId = u.id;
  }

  const company = await db.one<{ id: number }>(
    `INSERT INTO companies (slug, name, legal_name, tax_id, default_language, currency, timezone, plan_id, trial_ends_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, (SELECT id FROM subscription_plans WHERE key = 'free'), now() + interval '30 days')
     RETURNING id`,
    [slug, b.name, b.legalName ?? null, b.taxId ?? null, b.defaultLanguage, b.currency, b.timezone]);

  // A partir de aquí la transacción trabaja "dentro" de la empresa nueva para poder sembrar sus datos.
  await db.query("SELECT set_config('app.company_id', $1, true)", [String(company.id)]);
  await seedCompanyDefaults(db, company.id);
  await addMember(db, company.id, adminUserId, true);
  await db.query(
    `INSERT INTO audit_log (company_id, user_id, action, entity, entity_id, data) VALUES ($1,$2,'company.created','company',$1,$3)`,
    [company.id, adminUserId, JSON.stringify({ name: b.name })]);
  return { id: company.id, slug, adminUserId };
}

/** Agrega un usuario a la empresa activa de la transacción (con el rol "Administrador" si es admin). */
export async function addMember(db: Db, companyId: number, userId: number, admin: boolean): Promise<number> {
  const { value: tech } = await db.one<{ value: number }>("SELECT next_seq('tech_number') AS value");
  const m = await db.one<{ id: number }>(
    `INSERT INTO memberships (company_id, user_id, tech_number, is_company_admin) VALUES ($1,$2,$3,$4) RETURNING id`,
    [companyId, userId, tech, admin]);
  if (admin) {
    await db.query(
      `INSERT INTO membership_roles (company_id, membership_id, role_id)
       SELECT $1, $2, id FROM roles WHERE company_id = $1 AND name = 'Administrador'`, [companyId, m.id]);
  }
  return m.id;
}
