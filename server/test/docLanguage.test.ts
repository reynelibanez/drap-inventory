import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, makeCompany, startApi, stopApi, type Api } from './helpers.js';

describe('los documentos salen en el idioma de la empresa, no en el del usuario', () => {
  let api: Api; let token: string;
  const def = { mode: 'detail', columns: [{ field: 'code' }, { field: 'status' }], filters: [], sort: [] };
  const labels = async (lang: string) => {
    const r = await api.call('POST', `/api/reports/preview?lang=${lang}`, token, { dataset: 'units', definition: def });
    expect(r.status).toBe(200);
    return (r.body.columns as { label: string }[]).map((c) => c.label);
  };

  beforeAll(async () => {
    api = await startApi();
    const co = await makeCompany('Idioma SA', 'admin_lang', 'es');
    token = (await login(api, 'admin_lang', 'password123', co.id)).token;
  });
  afterAll(() => stopApi(api));

  it('los reportes salen en español si la empresa es española, aunque el usuario pida inglés', async () => {
    const es = await labels('es');
    expect(await labels('en')).toEqual(es);
  });

  it('al cambiar el idioma de la empresa, los reportes cambian con ella', async () => {
    const es = await labels('es');
    expect((await api.call('PATCH', '/api/company', token, { defaultLanguage: 'en' })).status).toBe(200);
    const en = await labels('es');   // el usuario sigue pidiendo español
    expect(en).not.toEqual(es);
    expect(await labels('en')).toEqual(en);
  });

  it('la lista de empaque y las etiquetas se generan aunque se pida otro idioma', async () => {
    const lot = await api.call('POST', '/api/lots', token, { lines: [] });
    expect(lot.status).toBe(200);
    const meta = (await api.call('GET', '/api/meta', token)).body;
    const laptop = meta.equipmentTypes.find((t: any) => t.key === 'laptop').id;
    await api.call('POST', `/api/lots/${lot.body.id}/transition`, token, { action: 'start_testing' });
    const u = await api.call('POST', `/api/lots/${lot.body.id}/units`, token, { equipmentTypeId: laptop, specs: {}, serialNumber: 'DOC-1' });
    expect(u.status).toBe(200);
    const labelsPdf = await api.call('GET', `/api/units/labels.pdf?ids=${u.body.id}&lang=es`, token);
    expect(labelsPdf.status).toBe(200);
  });
});
