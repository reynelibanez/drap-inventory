import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db.js';
import { MODEL_DATA } from '../src/seed/modelData.js';
import { ensureModelCatalogs } from '../src/services/modelDefaults.js';
import { login, makeCompany, startApi, stopApi, type Api } from './helpers.js';

describe('catálogos de modelos por tipo de equipo', () => {
  let api: Api; let token: string; let companyId: number; let meta: any;
  const cat = (key: string) => meta.catalogs.find((c: any) => c.key === key);
  const reload = async () => { meta = (await api.call('GET', '/api/meta', token)).body; };

  beforeAll(async () => {
    api = await startApi();
    const co = await makeCompany('Modelos SA', 'admin_models');
    companyId = co.id;
    token = (await login(api, 'admin_models', 'password123', companyId)).token;
    await reload();
  });
  afterAll(() => stopApi(api));

  it('cada tipo de equipo tiene su catálogo de modelos, dependiente del de marcas', () => {
    const brand = cat('brand');
    for (const t of meta.equipmentTypes) {
      const c = cat(`model_${t.key}`);
      expect(c, `catálogo de ${t.key}`).toBeTruthy();
      expect(c.parentCatalogId).toBe(brand.id);
    }
  });

  it('cada marca trae como máximo 10 modelos, ordenados, y cada modelo pertenece a su marca', () => {
    const brand = cat('brand');
    for (const [type, byBrand] of Object.entries(MODEL_DATA)) {
      const c = cat(`model_${type}`);
      let total = 0;
      for (const [brandName, models] of Object.entries(byBrand)) {
        expect(models.length, `${type}/${brandName}`).toBeLessThanOrEqual(10);
        const b = brand.items.find((i: any) => i.name.es.toLowerCase() === brandName.toLowerCase());
        expect(b, `la marca ${brandName} (${type}) debe existir en el catálogo de marcas`).toBeTruthy();
        const got = c.items.filter((i: any) => i.parentItemId === b.id).sort((x: any, y: any) => x.sortOrder - y.sortOrder).map((i: any) => i.name.es);
        expect(got).toEqual(models);
        total += got.length;
      }
      expect(c.items.length).toBe(total);
    }
    expect(cat('model_laptop').items.length).toBeGreaterThan(100);
  });

  it('el atributo "Modelo" es una lista desplegable: cada tipo usa el catálogo de sus modelos', () => {
    const modelAttr = meta.attributes.find((a: any) => a.key === 'model');
    expect(modelAttr.dataType).toBe('select');
    expect(modelAttr.catalogId).toBe(cat('model').id);
    expect(cat('model').parentCatalogId).toBe(cat('brand').id);
    for (const key of ['laptop', 'desktop', 'monitor', 'hard_drive', 'generic']) {
      const t = meta.equipmentTypes.find((x: any) => x.key === key);
      const ta = t.attributes.find((x: any) => x.attributeId === modelAttr.id);
      expect(ta.catalogId, key).toBe(cat(`model_${key}`).id);
      expect(ta.suggestCatalogId, key).toBeNull();
    }
    const mem = meta.equipmentTypes.find((x: any) => x.key === 'memory');
    expect(mem.attributes.every((x: any) => x.suggestCatalogId == null)).toBe(true);
  });

  it('un valor nuevo debe apuntar a una marca del catálogo padre', async () => {
    const models = cat('model_laptop'); const brands = cat('brand');
    const dell = brands.items.find((i: any) => i.name.es === 'Dell');
    const ok = await api.call('POST', `/api/catalogs/${models.id}/items`, token, { name: { es: 'Latitude 9999', en: 'Latitude 9999' }, parentItemId: dell.id });
    expect(ok.status).toBe(200);
    // un valor que no es de un catálogo de marcas no sirve como padre
    const ram = cat('ram_size').items[0];
    const bad = await api.call('POST', `/api/catalogs/${models.id}/items`, token, { name: { es: 'X', en: 'X' }, parentItemId: ram.id });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_parent_item');
    // un catálogo sin padre no acepta valores con padre
    const plain = cat('customer_type');
    const bad2 = await api.call('POST', `/api/catalogs/${plain.id}/items`, token, { name: { es: 'Y', en: 'Y' }, parentItemId: dell.id });
    expect(bad2.status).toBe(400);
    // se puede cambiar la marca de un modelo y quitarla
    const hp = brands.items.find((i: any) => i.name.es === 'HP');
    expect((await api.call('PATCH', `/api/catalog-items/${ok.body.id}`, token, { parentItemId: hp.id })).status).toBe(200);
    expect((await api.call('PATCH', `/api/catalog-items/${ok.body.id}`, token, { parentItemId: null })).status).toBe(200);
    await reload();
    expect(cat('model_laptop').items.find((i: any) => i.id === ok.body.id).parentItemId).toBeNull();
  });

  it('no se borra una marca que tiene modelos, ni un catálogo del que otro depende', async () => {
    const dell = cat('brand').items.find((i: any) => i.name.es === 'Dell');
    const del = await api.call('DELETE', `/api/catalog-items/${dell.id}`, token);
    expect(del.status).toBe(409);
    expect(del.body.error.code).toBe('item_has_children');
    const delCat = await api.call('DELETE', `/api/catalogs/${cat('brand').id}`, token);
    expect(delCat.status).toBe(409);
  });

  it('un catálogo nuevo puede depender de otro, sin círculos ni cambios que dejen valores huérfanos', async () => {
    const brand = cat('brand');
    const made = await api.call('POST', '/api/catalogs', token, { key: 'model_extra', name: { es: 'Modelos extra', en: 'Extra models' }, parentCatalogId: brand.id });
    expect(made.status).toBe(200);
    const self = await api.call('PATCH', `/api/catalogs/${made.body.id}`, token, { parentCatalogId: made.body.id });
    expect(self.status).toBe(400);
    const loop = await api.call('PATCH', `/api/catalogs/${brand.id}`, token, { parentCatalogId: made.body.id });
    expect(loop.status).toBe(400);
    const dell = brand.items.find((i: any) => i.name.es === 'Dell');
    await api.call('POST', `/api/catalogs/${made.body.id}/items`, token, { name: { es: 'Z1', en: 'Z1' }, parentItemId: dell.id });
    const change = await api.call('PATCH', `/api/catalogs/${made.body.id}`, token, { parentCatalogId: null });
    expect(change.status).toBe(409);
    expect(change.body.error.code).toBe('catalog_parent_in_use');
  });

  it('la lista de sugerencias solo aplica a atributos de texto y la lista propia del tipo, a los de lista', async () => {
    await reload();
    const t = meta.equipmentTypes.find((x: any) => x.key === 'monitor');
    const modelCat = cat('model_monitor');
    const send = (tt: any, mapper: (a: any) => any) => api.call('PUT', `/api/equipment-types/${tt.id}`, token, {
      name: tt.name, icon: tt.icon, tracksSerial: tt.tracksSerial, isActive: true,
      attributes: tt.attributes.map((a: any) => mapper({ attributeId: a.attributeId, inLotLine: a.inLotLine, requiredOnLot: a.requiredOnLot, requiredOnTest: a.requiredOnTest, isActive: a.isActive })),
    });
    const brandAttr = meta.attributes.find((a: any) => a.key === 'brand');
    const modelAttr = meta.attributes.find((a: any) => a.key === 'model');
    // sugerencias en un atributo de lista: no
    const bad = await send(t, (a) => (a.attributeId === brandAttr.id ? { ...a, suggestCatalogId: modelCat.id } : a));
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_suggest_catalog');
    // lista propia en un atributo de texto: no
    const textAttr = await api.call('POST', '/api/attributes', token, { key: 'nota_corta', label: { es: 'Nota corta', en: 'Short note' }, dataType: 'text' });
    expect(textAttr.status).toBe(200);
    const withText = { ...t, attributes: [...t.attributes, { attributeId: textAttr.body.id, inLotLine: false, requiredOnLot: false, requiredOnTest: false, isActive: true }] };
    const bad2 = await send(withText, (a) => (a.attributeId === textAttr.body.id ? { ...a, catalogId: modelCat.id } : a));
    expect(bad2.status).toBe(400);
    expect(bad2.body.error.code).toBe('invalid_catalog');
    // texto con sugerencias: sí
    const ok = await send(withText, (a) => (a.attributeId === textAttr.body.id ? { ...a, suggestCatalogId: modelCat.id } : a));
    expect(ok.status).toBe(200);
    await reload();
    expect(meta.equipmentTypes.find((x: any) => x.key === 'monitor').attributes.find((a: any) => a.attributeId === textAttr.body.id).suggestCatalogId).toBe(modelCat.id);
    // Un cliente antiguo que no envía el campo no borra la lista del tipo
    const t2 = meta.equipmentTypes.find((x: any) => x.key === 'laptop');
    const before = t2.attributes.find((a: any) => a.attributeId === modelAttr.id).catalogId;
    expect(before).toBe(cat('model_laptop').id);
    expect((await send(t2, (a) => a)).status).toBe(200);
    await reload();
    expect(meta.equipmentTypes.find((x: any) => x.key === 'laptop').attributes.find((a: any) => a.attributeId === modelAttr.id).catalogId).toBe(before);
    // Quitarla deja la lista general de modelos
    expect((await send(t2, (a) => (a.attributeId === modelAttr.id ? { ...a, catalogId: null } : a))).status).toBe(200);
    await reload();
    expect(meta.equipmentTypes.find((x: any) => x.key === 'laptop').attributes.find((a: any) => a.attributeId === modelAttr.id).catalogId).toBeNull();
    expect((await send(t2, (a) => (a.attributeId === modelAttr.id ? { ...a, catalogId: before } : a))).status).toBe(200);
    await reload();
  });

  it('un tipo de equipo nuevo recibe su propio catálogo de modelos', async () => {
    const modelAttr = meta.attributes.find((a: any) => a.key === 'model');
    const r = await api.call('POST', '/api/equipment-types', token, {
      key: 'tablet', name: { es: 'Tableta', en: 'Tablet' }, tracksSerial: true, attributes: [{ attributeId: modelAttr.id }],
    });
    expect(r.status).toBe(200);
    await reload();
    const c = cat('model_tablet');
    expect(c.name.es).toBe('Modelos de Tableta');
    const t = meta.equipmentTypes.find((x: any) => x.key === 'tablet');
    expect(t.attributes[0].catalogId).toBe(c.id);
  });

  it('la carga inicial se aplica una sola vez: lo que la empresa borra no se recrea al reiniciar', async () => {
    const generic = cat('model_generic');
    // desvincula y borra el catálogo de modelos genéricos
    const t = meta.equipmentTypes.find((x: any) => x.key === 'generic');
    const modelAttr = meta.attributes.find((a: any) => a.key === 'model');
    await api.call('PUT', `/api/equipment-types/${t.id}`, token, {
      name: t.name, icon: t.icon, tracksSerial: t.tracksSerial, isActive: true,
      attributes: t.attributes.map((a: any) => ({ attributeId: a.attributeId, inLotLine: a.inLotLine, requiredOnLot: a.requiredOnLot, requiredOnTest: a.requiredOnTest, isActive: a.isActive, suggestCatalogId: a.suggestCatalogId, catalogId: a.attributeId === modelAttr.id ? null : a.catalogId })),
    });
    expect((await api.call('DELETE', `/api/catalogs/${generic.id}`, token)).status).toBe(200);
    await withTenant(companyId, (db) => ensureModelCatalogs(db, companyId));
    await reload();
    expect(cat('model_generic')).toBeUndefined();
  });

  /** Deja la empresa como estaba antes de esta versión: modelo de texto, sin catálogos de modelos ni marcas de "ya cargado". */
  const backToText = () => withTenant(companyId, async (db) => {
    await db.query(`UPDATE equipment_type_attributes SET suggest_catalog_id = NULL, catalog_id = NULL`);
    await db.query(`UPDATE attribute_definitions SET data_type = 'text', catalog_id = NULL WHERE key = 'model'`);
    await db.query(`DELETE FROM catalog_items WHERE catalog_id IN (SELECT id FROM catalogs WHERE key = 'model' OR key LIKE 'model\\_%')`);
    await db.query(`DELETE FROM catalogs WHERE key = 'model' OR key LIKE 'model\\_%'`);
    await db.query(`UPDATE companies SET settings = settings #- '{_seeded,models}' #- '{_seeded,modelSelect}' WHERE id = $1`, [companyId]);
  });

  it('una empresa anterior a esta versión recibe los catálogos al arrancar', async () => {
    await backToText();
    await withTenant(companyId, async (db) => {
      await ensureModelCatalogs(db, companyId);
      await ensureModelCatalogs(db, companyId); // repetir no duplica
    });
    await reload();
    expect(cat('model_laptop').items.length).toBeGreaterThan(100);
    expect(meta.attributes.find((a: any) => a.key === 'model').dataType).toBe('select');
    const before = cat('model_laptop').items.length;
    await withTenant(companyId, (db) => ensureModelCatalogs(db, companyId));
    await reload();
    expect(cat('model_laptop').items.length).toBe(before);
  });

  it('al convertir, el modelo escrito a mano en equipos, activos y reglas pasa a ser el de la lista, bajo su marca', async () => {
    await backToText();
    await reload();
    const dell = cat('brand').items.find((i: any) => i.name.es === 'Dell').id;
    const hp = cat('brand').items.find((i: any) => i.name.es === 'HP').id;
    const laptop = meta.equipmentTypes.find((t: any) => t.key === 'laptop').id;
    const lot = await api.call('POST', '/api/lots', token, { lines: [] });
    await api.call('POST', `/api/lots/${lot.body.id}/transition`, token, { action: 'start_testing' });
    const mk = async (brand: number, model: string, sn: string) => {
      const r = await api.call('POST', `/api/lots/${lot.body.id}/units`, token, { equipmentTypeId: laptop, specs: { brand, model }, serialNumber: sn });
      expect(r.status).toBe(200);
      return r.body.id as number;
    };
    const u1 = await mk(dell, 'Modelo Viejo 1', 'CNV-1');
    const u2 = await mk(dell, '  modelo   viejo 1 ', 'CNV-2');   // el mismo, escrito distinto
    const u3 = await mk(hp, 'Modelo Viejo 1', 'CNV-3');           // otra marca: otro modelo
    const asset = await api.call('POST', '/api/assets', token, { equipmentTypeId: laptop, specs: { brand: dell, model: 'Modelo Viejo 1' } });
    expect(asset.status).toBe(200);
    const rule = await api.call('PUT', '/api/price-rules', token, { rules: [{ name: 'Viejo', match: { specs: { model: 'Modelo Viejo 1' } }, method: 'fixed', value: 100 }] });
    expect(rule.status).toBe(200);

    await withTenant(companyId, (db) => ensureModelCatalogs(db, companyId));
    await reload();
    const items = cat('model_laptop').items.filter((i: any) => i.name.es === 'Modelo Viejo 1');
    expect(items.map((i: any) => i.parentItemId).sort()).toEqual([dell, hp].sort());
    const dellItem = items.find((i: any) => i.parentItemId === dell).id;
    const hpItem = items.find((i: any) => i.parentItemId === hp).id;
    const model = async (id: number) => (await api.call('GET', `/api/units/${id}`, token)).body.specs.model;
    expect(await model(u1)).toBe(dellItem);
    expect(await model(u2)).toBe(dellItem);
    expect(await model(u3)).toBe(hpItem);
    expect((await api.call('GET', `/api/assets/${asset.body.items[0].id}`, token)).body.specs.model).toBe(dellItem);
    const rules = (await api.call('GET', '/api/price-rules', token)).body.rules;
    expect(rules[0].match.specs.model).toBe(dellItem);
  });

  it('el modelo se elige de la lista de su marca: texto libre y modelos de otra marca se rechazan', async () => {
    await reload();
    const dell = cat('brand').items.find((i: any) => i.name.es === 'Dell').id;
    const hp = cat('brand').items.find((i: any) => i.name.es === 'HP').id;
    const laptop = meta.equipmentTypes.find((t: any) => t.key === 'laptop').id;
    const dellModel = cat('model_laptop').items.find((i: any) => i.parentItemId === dell).id;
    const lot = await api.call('POST', '/api/lots', token, { lines: [] });
    await api.call('POST', `/api/lots/${lot.body.id}/transition`, token, { action: 'start_testing' });
    const add = (specs: any, sn: string) => api.call('POST', `/api/lots/${lot.body.id}/units`, token, { equipmentTypeId: laptop, specs, serialNumber: sn });
    expect((await add({ brand: dell, model: dellModel }, 'SEL-1')).status).toBe(200);
    expect((await add({ brand: dell, model: 'texto libre' }, 'SEL-2')).status).toBe(400);
    const wrong = await add({ brand: hp, model: dellModel }, 'SEL-3');
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('catalog_parent_mismatch');
  });

  it('alta rápida de un modelo: bajo su marca, sin duplicar y con permiso de quien registra equipos', async () => {
    await reload();
    const modelCat = cat('model_laptop');
    const dell = cat('brand').items.find((i: any) => i.name.es === 'Dell').id;
    const hp = cat('brand').items.find((i: any) => i.name.es === 'HP').id;
    const q = (name: string, parentItemId: number | null, t = token, id = modelCat.id) => api.call('POST', `/api/catalogs/${id}/quick-item`, t, { name, parentItemId });
    const a = await q('Zeta Book 900', dell);
    expect(a.status).toBe(200);
    expect(a.body.existed).toBe(false);
    const again = await q('  zeta   book 900 ', dell);
    expect(again.body).toEqual({ id: a.body.id, existed: true });
    const other = await q('Zeta Book 900', hp);
    expect(other.body.id).not.toBe(a.body.id);
    expect((await q('X', cat('ram_size').items[0].id)).status).toBe(400);   // el padre debe ser una marca
    // un catálogo que no es una lista de propiedades exige administrar catálogos
    const roleRes = await api.call('POST', '/api/roles', token, { name: 'Solo testeo', permissions: ['units.test', 'units.view'] });
    expect(roleRes.status).toBe(200);
    const usr = await api.call('POST', '/api/team/members', token, { username: 'tester_q', fullName: 'Tester Q', password: 'password123', roleIds: [roleRes.body.id] });
    expect(usr.status).toBe(200);
    const tTok = (await login(api, 'tester_q', 'password123', companyId)).token;
    expect((await q('Zeta Book 901', dell, tTok)).status).toBe(200);
    expect((await q('Otra', null, tTok, cat('customer_type').id)).status).toBe(403);
    expect((await q('Otra', null, tTok, cat('ram_size').id)).status).toBe(403);   // las listas que no dependen de otra, solo quien administra catálogos
    expect((await q('Sin marca', null, tTok)).status).toBe(400);                   // un modelo siempre va bajo una marca
  });
});
