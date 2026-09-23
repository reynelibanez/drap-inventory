import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, makeCompany, startApi, stopApi, type Api } from './helpers.js';

let api: Api;
let companyId: number;

/** Saca el valor de la cookie `rt` (sesión) de un `set-cookie` de la respuesta de login/refresh. */
function cookieOf(headers: any): string {
  const raw = headers['set-cookie'];
  const list: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const rt = list.find((c) => c.startsWith('rt='));
  if (!rt) throw new Error('sin cookie rt en la respuesta');
  return rt.split(';')[0];
}

beforeAll(async () => {
  api = await startApi();
  const c = await makeCompany('Auth Test Co', 'adminAuth');
  companyId = c.id;
});
afterAll(() => stopApi(api));

describe('un solo dispositivo a la vez', () => {
  it('iniciar sesión en un segundo dispositivo cierra el primero de inmediato', async () => {
    const first = await api.call('POST', '/api/auth/login', null, { username: 'adminAuth', password: 'password123' });
    expect(first.status).toBe(200);
    const tokenA = first.body.accessToken as string;
    const cookieA = cookieOf(first.headers);

    // El primer token sigue funcionando hasta que entre otro dispositivo.
    const before = await api.call('GET', '/api/meta', tokenA);
    expect(before.status).toBe(200);

    const second = await api.call('POST', '/api/auth/login', null, { username: 'adminAuth', password: 'password123' });
    expect(second.status).toBe(200);
    const tokenB = second.body.accessToken as string;
    const cookieB = cookieOf(second.headers);
    expect(cookieB).not.toBe(cookieA);

    // El token del primer dispositivo queda cortado en la próxima petición (sin esperar a que venza).
    const after = await api.call('GET', '/api/meta', tokenA);
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('session_revoked');

    // Su cookie de renovación también quedó revocada.
    const refreshA = await api.call('POST', '/api/auth/refresh', null, undefined, { cookie: cookieA });
    expect(refreshA.status).toBe(401);

    // El segundo dispositivo sigue con su sesión intacta.
    const stillB = await api.call('GET', '/api/meta', tokenB);
    expect(stillB.status).toBe(200);
    const refreshB = await api.call('POST', '/api/auth/refresh', null, undefined, { cookie: cookieB });
    expect(refreshB.status).toBe(200);
  });

  it('cambiar la contraseña no cierra la sesión que la cambió', async () => {
    const first = await api.call('POST', '/api/auth/login', null, { username: 'adminAuth', password: 'password123' });
    const token = first.body.accessToken as string;
    const cookie = cookieOf(first.headers); // el navegador la manda sola junto al token; acá hay que pasarla a mano

    const changed = await api.call('POST', '/api/auth/change-password', token, { current: 'password123', next: 'otraClave456' }, { cookie });
    expect(changed.status).toBe(200);
    // La sesión que hizo el cambio sigue viva (no se revoca a sí misma).
    expect((await api.call('GET', '/api/meta', token)).status).toBe(200);

    // Vuelve a dejar la contraseña como estaba para no afectar otros tests.
    const revert = await api.call('POST', '/api/auth/change-password', token, { current: 'otraClave456', next: 'password123' }, { cookie });
    expect(revert.status).toBe(200);
  });
});

describe('desbloquear tras el bloqueo por inactividad', () => {
  it('confirma la contraseña sin cerrar la sesión', async () => {
    const { token } = await login(api, 'adminAuth');
    const bad = await api.call('POST', '/api/auth/unlock', token, { password: 'incorrecta' });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('invalid_credentials');

    const ok = await api.call('POST', '/api/auth/unlock', token, { password: 'password123' });
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);

    // Ni el intento fallido ni el correcto tocan la sesión: el mismo token sigue sirviendo.
    expect((await api.call('GET', '/api/meta', token)).status).toBe(200);
  });
});

describe('bloqueo por inactividad configurable por empresa', () => {
  it('guarda y valida inactivityLockMinutes en los ajustes de la empresa', async () => {
    const { token } = await login(api, 'adminAuth', 'password123', companyId);

    const start = await api.call('GET', '/api/company', token);
    expect(start.body.settings.inactivityLockMinutes).toBeNull();

    const tooLow = await api.call('PATCH', '/api/company', token, { settings: { inactivityLockMinutes: 0 } });
    expect(tooLow.status).toBe(400);
    const tooHigh = await api.call('PATCH', '/api/company', token, { settings: { inactivityLockMinutes: 481 } });
    expect(tooHigh.status).toBe(400);

    const set = await api.call('PATCH', '/api/company', token, { settings: { inactivityLockMinutes: 15 } });
    expect(set.status).toBe(200);
    const after = await api.call('GET', '/api/company', token);
    expect(after.body.settings.inactivityLockMinutes).toBe(15);

    // Vuelve a null (desactivado) también debe aceptarse.
    const off = await api.call('PATCH', '/api/company', token, { settings: { inactivityLockMinutes: null } });
    expect(off.status).toBe(200);
    const final = await api.call('GET', '/api/company', token);
    expect(final.body.settings.inactivityLockMinutes).toBeNull();
  });
});
