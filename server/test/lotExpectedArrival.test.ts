import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, makeCompany, startApi, stopApi, type Api } from './helpers.js';

// Fecha de posible entrada: campo informativo para un lote que todavía no llegó físicamente (p. ej. uno recién
// comprado a un proveedor). Opcional al crear, editable después, y se puede volver a dejar en blanco.

let api: Api;
let tok: string;

beforeAll(async () => {
  api = await startApi();
  await makeCompany('Refurb Entrada Esperada', 'adminEntrada');
  tok = (await login(api, 'adminEntrada')).token;
});
afterAll(() => stopApi(api));

describe('fecha de posible entrada de un lote', () => {
  it('se puede indicar al crear el lote y se ve en el detalle y en el listado', async () => {
    const r = await api.call('POST', '/api/lots', tok, { expectedArrivalDate: '2026-12-24', reference: 'Prueba entrada' });
    expect(r.status).toBe(200);

    const detail = await api.call('GET', `/api/lots/${r.body.id}`, tok);
    expect(detail.body.expectedArrivalDate?.slice(0, 10)).toBe('2026-12-24');

    const list = await api.call('GET', '/api/lots?pageSize=200', tok);
    const row = list.body.items.find((l: any) => l.id === r.body.id);
    expect(row.expectedArrivalDate?.slice(0, 10)).toBe('2026-12-24');
  });

  it('es opcional: si no se indica, queda en blanco', async () => {
    const r = await api.call('POST', '/api/lots', tok, { reference: 'Prueba sin entrada' });
    const detail = await api.call('GET', `/api/lots/${r.body.id}`, tok);
    expect(detail.body.expectedArrivalDate).toBeNull();
  });

  it('se puede cambiar y volver a dejar en blanco desde la edición del lote', async () => {
    const r = await api.call('POST', '/api/lots', tok, { reference: 'Prueba editar entrada' });

    const upd = await api.call('PATCH', `/api/lots/${r.body.id}`, tok, { expectedArrivalDate: '2027-01-15' });
    expect(upd.status).toBe(200);
    let detail = await api.call('GET', `/api/lots/${r.body.id}`, tok);
    expect(detail.body.expectedArrivalDate?.slice(0, 10)).toBe('2027-01-15');

    // Se edita otro campo sin tocar la fecha: debe quedar como estaba (no se borra por no mandarla).
    await api.call('PATCH', `/api/lots/${r.body.id}`, tok, { reference: 'Prueba editar entrada 2' });
    detail = await api.call('GET', `/api/lots/${r.body.id}`, tok);
    expect(detail.body.expectedArrivalDate?.slice(0, 10)).toBe('2027-01-15');

    // Se manda explícitamente en null: ahora sí se borra.
    await api.call('PATCH', `/api/lots/${r.body.id}`, tok, { expectedArrivalDate: null });
    detail = await api.call('GET', `/api/lots/${r.body.id}`, tok);
    expect(detail.body.expectedArrivalDate).toBeNull();
  });
});
