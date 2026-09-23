import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, makeCompany, metaHelper, startApi, stopApi, type Api } from './helpers.js';

let api: Api;
let tokA: string;
let m: ReturnType<typeof metaHelper>;

beforeAll(async () => {
  api = await startApi();
  const A = await makeCompany('Refurb Masivo', 'adminBulk');
  tokA = (await login(api, 'adminBulk')).token;
  const meta = await api.call('GET', '/api/meta', tokA);
  m = metaHelper(meta.body);
  await m.ensureModels(api, tokA, [['monitor', 'LG', '24MK430H']]);
  void A;
});
afterAll(() => stopApi(api));

/** Lleva un lote recién creado hasta el estado "counted" (conteo completo, listo para testear). */
async function countAndFinish(lotId: number, lineId: number, qty: number) {
  await api.call('PUT', `/api/lots/${lotId}/counts`, tokA, { counts: [{ lineId, countedQty: qty }] });
  const r = await api.call('POST', `/api/lots/${lotId}/transition`, tokA, { action: 'finish_count' });
  expect(r.status).toBe(200);
  expect(r.body.statusKey).toBe('counted');
}

describe('lote sin testeo individual: registro masivo y venta completa', () => {
  it('marca el lote como que no requiere testeo al crearlo', async () => {
    const r = await api.call('POST', '/api/lots', tokA, {
      requiresTesting: false,
      lines: [{ equipmentTypeId: m.type('monitor'), specs: { brand: m.item('brand', 'LG'), model: m.model('monitor', 'LG', '24MK430H') }, expectedQty: 5 }],
    });
    expect(r.status).toBe(200);
    const det = await api.call('GET', `/api/lots/${r.body.id}`, tokA);
    expect(det.body.requiresTesting).toBe(false);
  });

  it('rechaza saltar el testeo en un lote que sí lo requiere', async () => {
    const r = await api.call('POST', '/api/lots', tokA, {
      lines: [{ equipmentTypeId: m.type('monitor'), specs: { brand: m.item('brand', 'LG'), model: m.model('monitor', 'LG', '24MK430H') }, expectedQty: 2 }],
    });
    const lotId = r.body.id, lineId = (await api.call('GET', `/api/lots/${lotId}`, tokA)).body.lines[0].id;
    await countAndFinish(lotId, lineId, 2);
    const bad = await api.call('POST', `/api/lots/${lotId}/units`, tokA, { equipmentTypeId: m.type('monitor'), skipTest: true });
    expect(bad.status).toBe(409);
    expect(bad.body.error.code).toBe('lot_requires_testing');
    const sell = await api.call('POST', `/api/lots/${lotId}/sell-complete`, tokA, {});
    expect(sell.status).toBe(409);
    expect(sell.body.error.code).toBe('lot_requires_testing');
  });

  it('combina registro individual, masivo y venta del resto del lote', async () => {
    const r = await api.call('POST', '/api/lots', tokA, {
      requiresTesting: false,
      lines: [{ equipmentTypeId: m.type('monitor'), specs: { brand: m.item('brand', 'LG'), model: m.model('monitor', 'LG', '24MK430H') }, expectedQty: 6 }],
    });
    const lotId = r.body.id;
    const lineId = (await api.call('GET', `/api/lots/${lotId}`, tokA)).body.lines[0].id;
    await countAndFinish(lotId, lineId, 6);

    // Un monitor entrado en detalle, pasa por testeo normal (no se salta nada si no se pide).
    const single = await api.call('POST', `/api/lots/${lotId}/units`, tokA, { equipmentTypeId: m.type('monitor'), lotLineId: lineId, serialNumber: 'MON-0001' });
    expect(single.status).toBe(200);
    expect(single.body.statusKey).toBe('testing');

    // Registro masivo: 2 monitores idénticos sin serie, directo a disponible (se salta el testeo porque el lote no lo exige).
    const batch = await api.call('POST', `/api/lots/${lotId}/units/batch`, tokA, { equipmentTypeId: m.type('monitor'), lotLineId: lineId, quantity: 2, skipTest: true });
    expect(batch.status).toBe(200);
    expect(batch.body.units).toHaveLength(2);
    for (const u of batch.body.units) {
      const det = await api.call('GET', `/api/units/${u.id}`, tokA);
      expect(det.body.statusKey).toBe('available');
      expect(det.body.serialNumber).toBeNull();
    }

    // Vender el lote completo: genera los que faltan (6 - 1 - 2 = 3), todos disponibles.
    const sell = await api.call('POST', `/api/lots/${lotId}/sell-complete`, tokA, {});
    expect(sell.status).toBe(200);
    expect(sell.body.units).toHaveLength(3);
    for (const u of sell.body.units) {
      const det = await api.call('GET', `/api/units/${u.id}`, tokA);
      expect(det.body.statusKey).toBe('available');
    }

    // Ya no queda nada por generar.
    const again = await api.call('POST', `/api/lots/${lotId}/sell-complete`, tokA, {});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('nothing_to_sell');

    const all = await api.call('GET', `/api/units${`?lotId=${lotId}&pageSize=20`}`, tokA);
    expect(all.body.total).toBe(6);
  });

  it('registro masivo normal (con testeo) para cualquier tipo de equipo, sin serie compartida', async () => {
    const r = await api.call('POST', '/api/lots', tokA, {
      lines: [{ equipmentTypeId: m.type('monitor'), specs: { brand: m.item('brand', 'LG'), model: m.model('monitor', 'LG', '24MK430H') }, expectedQty: 4 }],
    });
    const lotId = r.body.id, lineId = (await api.call('GET', `/api/lots/${lotId}`, tokA)).body.lines[0].id;
    await countAndFinish(lotId, lineId, 4);
    const batch = await api.call('POST', `/api/lots/${lotId}/units/batch`, tokA, { equipmentTypeId: m.type('monitor'), lotLineId: lineId, quantity: 4 });
    expect(batch.status).toBe(200);
    expect(batch.body.units).toHaveLength(4);
    const det = await api.call('GET', `/api/lots/${lotId}`, tokA);
    expect(det.body.statusKey).toBe('testing');
    for (const u of batch.body.units) {
      const ud = await api.call('GET', `/api/units/${u.id}`, tokA);
      expect(ud.body.statusKey).toBe('testing');
      expect(ud.body.serialNumber).toBeNull();
    }
  });

  it('se puede activar/desactivar requiresTesting con PATCH', async () => {
    const r = await api.call('POST', '/api/lots', tokA, { lines: [] });
    const lotId = r.body.id;
    expect((await api.call('GET', `/api/lots/${lotId}`, tokA)).body.requiresTesting).toBe(true);
    const patch = await api.call('PATCH', `/api/lots/${lotId}`, tokA, { requiresTesting: false });
    expect(patch.status).toBe(200);
    expect((await api.call('GET', `/api/lots/${lotId}`, tokA)).body.requiresTesting).toBe(false);
  });
});

describe('plantillas de documento por lote, con íconos', () => {
  it('crea una plantilla kind=lot con un elemento icon', async () => {
    const r = await api.call('POST', '/api/label-templates', tokA, {
      kind: 'lot', name: 'Reporte de lote', widthMm: 210, heightMm: 297,
      layout: { elements: [{ id: 'i1', type: 'icon', icon: 'PackageCheck', x: 5, y: 5, w: 10, h: 10 }] },
    });
    expect(r.status).toBe(200);
    expect(r.body.kind).toBe('lot');
    expect(r.body.layout.elements[0].icon).toBe('PackageCheck');
  });

  it('rechaza un ícono fuera de la lista permitida', async () => {
    const r = await api.call('POST', '/api/label-templates', tokA, {
      kind: 'lot', name: 'Malo', widthMm: 100, heightMm: 100,
      layout: { elements: [{ id: 'i1', type: 'icon', icon: 'NoExiste', x: 0, y: 0, w: 5, h: 5 }] },
    });
    expect(r.status).toBe(400);
  });
});
