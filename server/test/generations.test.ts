import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db.js';
import { processorGenerationValues } from '../src/seed/processorData.js';
import { seedProcessorGenerations } from '../src/services/generationDefaults.js';
import { login, makeCompany, startApi, stopApi, type Api } from './helpers.js';

describe('generación del procesador: número de modelo sin repetir la familia', () => {
  let api: Api; let token: string; let companyId: number; let meta: any;
  const cat = (key: string) => meta.catalogs.find((c: any) => c.key === key);
  const reload = async () => { meta = (await api.call('GET', '/api/meta', token)).body; };

  beforeAll(async () => {
    api = await startApi();
    const co = await makeCompany('Generaciones SA', 'admin_gen');
    companyId = co.id;
    token = (await login(api, 'admin_gen', 'password123', companyId)).token;
    await reload();
  });
  afterAll(() => stopApi(api));

  it('al instalar se cargan todos los números, cada uno ligado a su procesador', () => {
    const gen = cat('processor_generation');
    const cpu = cat('processor');
    expect(gen.parentCatalogId).toBe(cpu.id);
    const expected = processorGenerationValues().filter((v) => cpu.items.some((i: any) => i.name.es === v.family));
    expect(expected.length).toBeGreaterThan(700);
    expect(gen.items.length).toBe(expected.length);
    const i5 = cpu.items.find((i: any) => i.name.es === 'Intel Core i5').id;
    const item = gen.items.find((i: any) => i.name.es === '6300U');
    expect(item?.parentItemId).toBe(i5);
    expect(gen.items.some((i: any) => /^i[3579]-/i.test(i.name.es))).toBe(false);   // ya no repite la familia (i5-, i7-…)
    expect(gen.items.some((i: any) => /gen$/i.test(i.name.es))).toBe(false);   // ya no hay "6.ª gen"
    // sin repetir dentro de cada procesador
    const keys = gen.items.map((i: any) => `${i.parentItemId}|${i.name.es}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('en el equipo solo vale un número del procesador elegido', async () => {
    const cpu = cat('processor'); const gen = cat('processor_generation');
    const id = (name: string) => cpu.items.find((i: any) => i.name.es === name).id;
    const laptop = meta.equipmentTypes.find((t: any) => t.key === 'laptop').id;
    const lot = await api.call('POST', '/api/lots', token, { lines: [] });
    await api.call('POST', `/api/lots/${lot.body.id}/transition`, token, { action: 'start_testing' });
    const add = (specs: any, sn: string) => api.call('POST', `/api/lots/${lot.body.id}/units`, token, { equipmentTypeId: laptop, specs, serialNumber: sn });
    const g = (name: string) => gen.items.find((i: any) => i.name.es === name).id;
    expect((await add({ processor: id('Intel Core i5'), generation: g('6300U') }, 'GEN-1')).status).toBe(200);
    const bad = await add({ processor: id('Intel Core i5'), generation: g('8650U') }, 'GEN-2');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('catalog_parent_mismatch');
  });

  it('una empresa que venía con "6.ª gen" recibe los números y los valores viejos quedan ocultos, sin repetir', async () => {
    const before = cat('processor_generation').items.length;
    await withTenant(companyId, async (db) => {
      const genCat = (await db.one<{ id: number }>(`SELECT id FROM catalogs WHERE key = 'processor_generation'`)).id;
      await db.query(`INSERT INTO catalog_items (company_id, catalog_id, code, name, sort_order) VALUES ($1, $2, '6', '{"es":"6.ª gen","en":"6th gen"}', 0)`, [companyId, genCat]);
      await seedProcessorGenerations(db, companyId);
      await seedProcessorGenerations(db, companyId);   // repetir no duplica
    });
    await reload();
    const items = cat('processor_generation').items;
    expect(items.length).toBe(before + 1);
    expect(items.find((i: any) => i.name.es === '6.ª gen').isActive).toBe(false);
  });
});
