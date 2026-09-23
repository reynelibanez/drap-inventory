import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool, withGlobal } from '../src/db.js';
import { syncPermissions } from '../src/permissions.js';
import { createCompanyWithAdmin } from '../src/services/companies.js';

export interface Api {
  app: FastifyInstance;
  call(method: string, url: string, token: string | null, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any; raw: Buffer; headers: any }>;
}

export async function startApi(): Promise<Api> {
  const app = await buildApp({ logger: false });
  await withGlobal((db) => syncPermissions(db));
  await app.ready();
  return {
    app,
    async call(method, url, token, body, headers) {
      const res = await app.inject({
        method: method as any, url,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(headers ?? {}) },
        payload: body as any,
      });
      let parsed: any = null;
      try { parsed = res.body ? JSON.parse(res.body) : null; } catch { /* binario */ }
      return { status: res.statusCode, body: parsed, raw: res.rawPayload, headers: res.headers };
    },
  };
}

export async function stopApi(api: Api) {
  await api.app.close();
  await pool.end();
}

export async function makeCompany(name: string, username: string, lang: 'es' | 'en' = 'es') {
  return withGlobal((db) => createCompanyWithAdmin(db, {
    name, defaultLanguage: lang, currency: 'USD', timezone: 'America/New_York',
    admin: { username, fullName: `Admin ${name}`, password: 'password123', mustChangePassword: false },
  }));
}

export async function login(api: Api, username: string, password = 'password123', companyId?: number) {
  const r = await api.call('POST', '/api/auth/login', null, { username, password });
  if (r.status !== 200) throw new Error(`login failed ${r.status} ${JSON.stringify(r.body)}`);
  let token: string = r.body.accessToken;
  if (companyId && r.body.activeCompanyId !== companyId) {
    const s = await api.call('POST', '/api/auth/select-company', token, { companyId });
    if (s.status !== 200) throw new Error('select-company failed ' + JSON.stringify(s.body));
    token = s.body.accessToken;
  }
  return { token, session: r.body };
}

/** Resuelve ids de catálogo por nombre en español, para armar peticiones legibles. */
export function metaHelper(meta: any) {
  return {
    item(catalogKey: string, nameEs: string): number {
      const cat = meta.catalogs.find((c: any) => c.key === catalogKey);
      const it = cat?.items.find((i: any) => i.name.es === nameEs || i.code === nameEs);
      if (!it) throw new Error(`No existe ${catalogKey}/${nameEs}`);
      return it.id;
    },
    sys(catalogKey: string, systemKey: string): number {
      const cat = meta.catalogs.find((c: any) => c.key === catalogKey);
      return cat.items.find((i: any) => i.systemKey === systemKey).id;
    },
    type(key: string): number {
      return meta.equipmentTypes.find((t: any) => t.key === key).id;
    },
    /** Id del modelo (lista desplegable ligada a la marca); hay que prepararlo antes con `ensureModels`. */
    model(typeKey: string, brandEs: string, nameEs: string): number {
      const brand = meta.catalogs.find((c: any) => c.key === 'brand').items.find((i: any) => i.name.es === brandEs)?.id;
      for (const c of meta.catalogs) {
        if (c.key !== `model_${typeKey}` && c.key !== 'model') continue;
        const it = c.items.find((i: any) => i.parentItemId === brand && i.name.es.toLowerCase() === nameEs.toLowerCase());
        if (it) return it.id;
      }
      throw new Error(`Modelo sin preparar: ${typeKey}/${brandEs}/${nameEs}`);
    },
    /** Crea (si faltan) los modelos [tipo, marca, modelo] y los agrega al `meta` en memoria. */
    async ensureModels(api: Api, token: string, list: [string, string, string][]): Promise<void> {
      for (const [t, b, n] of list) {
        const cat = meta.catalogs.find((c: any) => c.key === `model_${t}`) ?? meta.catalogs.find((c: any) => c.key === 'model');
        const brand = meta.catalogs.find((c: any) => c.key === 'brand').items.find((i: any) => i.name.es === b)?.id;
        if (!brand) throw new Error(`No existe la marca ${b}`);
        if (cat.items.some((i: any) => i.parentItemId === brand && i.name.es.toLowerCase() === n.toLowerCase())) continue;
        const r = await api.call('POST', `/api/catalogs/${cat.id}/quick-item`, token, { name: n, parentItemId: brand });
        if (r.status !== 200 && r.status !== 201) throw new Error(`quick-item ${r.status} ${JSON.stringify(r.body)}`);
        cat.items.push({ id: r.body.id, parentItemId: brand, name: { es: n, en: n } });
      }
    },
  };
}
