import { createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db.js';
import { flushPendingPushes } from '../src/services/notifications.js';
import { releaseExpiredReservations } from '../src/services/sweeper.js';
import {
  encryptPayload, generateVapidKeys, getVapidKeys, isAllowedPushEndpoint, setPushTransport, vapidAuthorization, verifyVapidJwt,
} from '../src/services/webpush.js';
import { login, makeCompany, metaHelper, startApi, stopApi, type Api } from './helpers.js';

const b64u = (b: Buffer) => b.toString('base64url');
const fromB64u = (s: string) => Buffer.from(s, 'base64url');

/** Lado receptor de RFC 8291 (lo que hace el navegador): descifra el cuerpo de un mensaje push. */
function decryptPush(body: Buffer, ua: { ecdh: ReturnType<typeof createECDH>; auth: Buffer }): string {
  const salt = body.subarray(0, 16);
  const idLen = body[20];
  const asPublic = body.subarray(21, 21 + idLen);
  const data = body.subarray(21 + idLen);
  const uaPublic = ua.ecdh.getPublicKey();
  const shared = ua.ecdh.computeSecret(asPublic);
  const ikm = Buffer.from(hkdfSync('sha256', shared, ua.auth, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
  let end = plain.length;
  while (end > 0 && plain[end - 1] === 0) end--;
  expect(plain[end - 1]).toBe(2);   // marca de último registro
  return plain.subarray(0, end - 1).toString();
}

/** Un "navegador" de mentira: claves de suscripción reales y un punto de destino falso. */
function fakeDevice(name: string) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    ecdh, auth,
    endpoint: `https://fcm.googleapis.com/fcm/send/${name}-${b64u(randomBytes(8))}`,
    keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) },
  };
}

describe('Web Push: cifrado y VAPID', () => {
  it('reproduce el ejemplo oficial de RFC 8291 (apéndice A)', () => {
    const out = encryptPayload(
      { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
      Buffer.from('When I grow up, I want to be a watermelon'),
      { salt: fromB64u('DGv6ra1nlYgDCS1FRnbzlw'), ephemeralPrivate: fromB64u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw') },
    );
    expect(b64u(out)).toBe('DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
  });

  it('un mensaje cifrado lo descifra el dispositivo (ida y vuelta)', () => {
    const dev = fakeDevice('rt');
    const msg = JSON.stringify({ title: 'Hola ñandú', body: 'Órden #1 ✓' });
    const body = encryptPayload(dev.keys, Buffer.from(msg));
    expect(decryptPush(body, dev)).toBe(msg);
    // Dos cifrados del mismo texto no se parecen (sal y clave efímera nuevas).
    expect(encryptPayload(dev.keys, Buffer.from(msg)).equals(body)).toBe(false);
  });

  it('rechaza claves de dispositivo dañadas', () => {
    expect(() => encryptPayload({ p256dh: 'abc', auth: 'def' }, Buffer.from('x'))).toThrow();
  });

  it('la cabecera VAPID lleva un JWT ES256 válido para el servicio push', () => {
    const keys = generateVapidKeys();
    expect(fromB64u(keys.publicKey)).toHaveLength(65);
    const h = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys);
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(h)!;
    expect(m[2]).toBe(keys.publicKey);
    const claims = verifyVapidJwt(m[1], keys.publicKey)!;
    expect(claims.aud).toBe('https://fcm.googleapis.com');
    expect(claims.exp * 1000).toBeGreaterThan(Date.now() + 11 * 3600_000);
    expect(claims.sub).toMatch(/^mailto:|^https:/);
    // Con otra clave no valida.
    expect(verifyVapidJwt(m[1], generateVapidKeys().publicKey)).toBeNull();
  });

  it('solo acepta destinos de servicios push conocidos, por https', () => {
    expect(isAllowedPushEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
    expect(isAllowedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/abc')).toBe(true);
    expect(isAllowedPushEndpoint('https://web.push.apple.com/abc')).toBe(true);
    expect(isAllowedPushEndpoint('https://wns2-par02p.notify.windows.com/w/?token=abc')).toBe(true);
    expect(isAllowedPushEndpoint('http://fcm.googleapis.com/fcm/send/abc')).toBe(false);
    expect(isAllowedPushEndpoint('https://localhost/x')).toBe(false);
    expect(isAllowedPushEndpoint('https://169.254.169.254/latest')).toBe(false);
    expect(isAllowedPushEndpoint('https://fcm.googleapis.com.evil.com/x')).toBe(false);
    expect(isAllowedPushEndpoint('https://evil.com/fcm.googleapis.com')).toBe(false);
    expect(isAllowedPushEndpoint('https://user:pw@fcm.googleapis.com/x')).toBe(false);
    expect(isAllowedPushEndpoint('https://fcm.googleapis.com:8443/x')).toBe(false);
    expect(isAllowedPushEndpoint('no es una url')).toBe(false);
  });
});

describe('notificaciones y push de una empresa', () => {
  let api: Api;
  let co: { id: number };
  let tokAdmin: string, tokTec: string, tokAlm: string, tokVen: string;
  let m: ReturnType<typeof metaHelper>;
  const sent: { endpoint: string; headers: Record<string, string>; body: Buffer }[] = [];
  let status = 201;
  const tec = fakeDevice('tec');
  const tecPhone = fakeDevice('tecphone');
  const admin = fakeDevice('admin');

  const inbox = async (tok: string, q = '') => (await api.call('GET', `/api/notifications${q}`, tok)).body;
  const plain = (s: (typeof sent)[number], dev: ReturnType<typeof fakeDevice>) => JSON.parse(decryptPush(s.body, dev));

  beforeAll(async () => {
    api = await startApi();
    setPushTransport(async (endpoint, init) => { sent.push({ endpoint, headers: init.headers, body: init.body }); return { status }; });
    co = await makeCompany('Push Co', 'padmin');
    tokAdmin = (await login(api, 'padmin')).token;
    m = metaHelper((await api.call('GET', '/api/meta', tokAdmin)).body);
    const roles = (await api.call('GET', '/api/roles', tokAdmin)).body.items;
    const mk = async (username: string, role: string) => {
      const r = await api.call('POST', '/api/team/members', tokAdmin, { username, fullName: username, password: 'password123', roleIds: [roles.find((x: any) => x.name === role).id] });
      expect(r.status).toBe(200);
      return (await login(api, username)).token;
    };
    tokTec = await mk('ptec', 'Técnico');
    tokAlm = await mk('palm', 'Almacén');
    tokVen = await mk('pven', 'Ventas');
  });
  afterAll(async () => { setPushTransport(null); await stopApi(api); });

  it('entrega la clave pública VAPID (siempre la misma) a cualquier usuario', async () => {
    const a = await api.call('GET', '/api/push/config', tokTec);
    expect(a.status).toBe(200);
    expect(fromB64u(a.body.publicKey)).toHaveLength(65);
    expect((await api.call('GET', '/api/push/config', tokAlm)).body.publicKey).toBe(a.body.publicKey);
    expect((await getVapidKeys()).publicKey).toBe(a.body.publicKey);
    expect((await api.call('GET', '/api/push/config', null)).status).toBe(401);
  });

  it('registra dispositivos y rechaza destinos o claves inválidas', async () => {
    const bad = await api.call('POST', '/api/push/subscribe', tokTec, { endpoint: 'http://localhost:9999/x', keys: tec.keys });
    expect(bad.body.error.code).toBe('push_endpoint_invalid');
    const ssrf = await api.call('POST', '/api/push/subscribe', tokTec, { endpoint: 'https://internal.example.local/x', keys: tec.keys });
    expect(ssrf.body.error.code).toBe('push_endpoint_invalid');
    const keys = await api.call('POST', '/api/push/subscribe', tokTec, { endpoint: tec.endpoint, keys: { p256dh: 'A'.repeat(90), auth: 'B'.repeat(22) } });
    expect(keys.body.error.code).toBe('push_keys_invalid');

    expect((await api.call('POST', '/api/push/subscribe', tokTec, { endpoint: tec.endpoint, keys: tec.keys, userAgent: 'Chrome test' })).status).toBe(200);
    expect((await api.call('POST', '/api/push/subscribe', tokTec, { endpoint: tecPhone.endpoint, keys: tecPhone.keys })).status).toBe(200);
    // Registrar dos veces el mismo dispositivo no lo duplica.
    expect((await api.call('POST', '/api/push/subscribe', tokTec, { endpoint: tec.endpoint, keys: tec.keys })).status).toBe(200);
    const list = await api.call('GET', '/api/push/subscriptions', tokTec);
    expect(list.body.items).toHaveLength(2);
    // Cada quien ve solo los suyos.
    expect((await api.call('GET', '/api/push/subscriptions', tokAlm)).body.items).toHaveLength(0);
    expect((await api.call('POST', '/api/push/subscribe', tokAdmin, { endpoint: admin.endpoint, keys: admin.keys })).status).toBe(200);
  });

  it('terminar el conteo avisa a quien puede cerrar/avanzar el lote, no a quien lo hizo ni a quien no aplica', async () => {
    const lot = await api.call('POST', '/api/lots', tokAdmin, { lines: [{ equipmentTypeId: m.type('generic'), specs: { description: 'Teclado' }, expectedQty: 2 }] });
    const detail = await api.call('GET', `/api/lots/${lot.body.id}`, tokAdmin);
    await api.call('PUT', `/api/lots/${lot.body.id}/counts`, tokAdmin, { counts: [{ lineId: detail.body.lines[0].id, countedQty: 2 }] });
    const done = await api.call('POST', `/api/lots/${lot.body.id}/transition`, tokAdmin, { action: 'finish_count' });
    expect(done.status).toBe(200);

    const alm = await inbox(tokAlm);
    expect(alm.items).toHaveLength(1);
    expect(alm.items[0]).toMatchObject({ event: 'lot_counted', url: `/lots/${lot.body.id}` });
    expect(alm.items[0].title).toContain(lot.body.code);
    expect(alm.unreadCount).toBe(1);
    expect((await inbox(tokAdmin)).items).toHaveLength(0);   // quien lo hizo no se avisa a sí mismo
    expect((await inbox(tokTec)).items).toHaveLength(0);     // el técnico no cierra lotes
    expect((await inbox(tokVen)).items).toHaveLength(0);

    // Pasar a testeo avisa a los técnicos.
    const t = await api.call('POST', `/api/lots/${lot.body.id}/transition`, tokAdmin, { action: 'start_testing' });
    expect(t.status).toBe(200);
    const tec1 = await inbox(tokTec);
    expect(tec1.items.map((i: any) => i.event)).toEqual(['lot_testing']);
    expect(tec1.items[0].url).toBe(`/testing?lot=${lot.body.id}`);
  });

  it('el despachador cifra y envía el aviso a todos los dispositivos del destinatario', async () => {
    sent.length = 0;
    const n = await flushPendingPushes();
    expect(n).toBeGreaterThanOrEqual(2);
    const toTec = sent.filter((s) => s.endpoint === tec.endpoint || s.endpoint === tecPhone.endpoint);
    expect(toTec).toHaveLength(2);   // celular y PC
    const pc = toTec.find((s) => s.endpoint === tec.endpoint)!;
    const payload = plain(pc, tec);
    expect(payload).toMatchObject({ event: 'lot_testing', url: expect.stringMatching(/^\/testing\?lot=/) });
    expect(payload.title).toMatch(/listo para testear/);
    // Cabeceras exigidas por el servicio push.
    expect(pc.headers['Content-Encoding']).toBe('aes128gcm');
    expect(Number(pc.headers.TTL)).toBeGreaterThan(0);
    const auth = /^vapid t=([^,]+), k=(.+)$/.exec(pc.headers.Authorization)!;
    const vapid = await getVapidKeys();
    expect(auth[2]).toBe(vapid.publicKey);
    expect(verifyVapidJwt(auth[1], vapid.publicKey)?.aud).toBe('https://fcm.googleapis.com');
    // El de "Almacén" no tiene dispositivos: queda como omitido, sin error.
    const st = await withTenant(co.id, (db) => db.rows("SELECT push_state, count(*)::int AS n FROM notifications GROUP BY 1 ORDER BY 1"));
    expect(st.find((r: any) => r.push_state === 'pending')).toBeUndefined();
    // Un segundo despacho no repite nada.
    sent.length = 0;
    expect(await flushPendingPushes()).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('bandeja: leer una, leer todas, borrar, y solo ve las suyas', async () => {
    const inb = await inbox(tokTec);
    const id = inb.items[0].id;
    expect((await api.call('POST', '/api/notifications/read', tokAlm, { ids: [id] })).body.updated).toBe(0);   // no es suya
    expect((await api.call('GET', '/api/notifications/unread-count', tokTec)).body.count).toBe(1);
    expect((await api.call('POST', '/api/notifications/read', tokTec, { ids: [id] })).body.updated).toBe(1);
    expect((await api.call('GET', '/api/notifications/unread-count', tokTec)).body.count).toBe(0);
    expect((await inbox(tokTec, '?unread=true')).items).toHaveLength(0);
    expect((await inbox(tokTec, '?unread=false')).items).toHaveLength(1);
    expect((await api.call('POST', '/api/notifications/read', tokTec, {})).body.error.code).toBe('nothing_selected');
    expect((await api.call('DELETE', `/api/notifications/${id}`, tokAlm)).status).toBe(404);
    expect((await api.call('DELETE', `/api/notifications/${id}`, tokTec)).status).toBe(200);
    expect((await inbox(tokTec)).items).toHaveLength(0);
  });

  it('preferencias: solo aparecen los avisos que la persona puede recibir y se respetan', async () => {
    const tecPrefs = (await api.call('GET', '/api/notifications/prefs', tokTec)).body.events.map((e: any) => e.key);
    expect(tecPrefs).toEqual(['lot_testing']);
    const venPrefs = (await api.call('GET', '/api/notifications/prefs', tokVen)).body.events.map((e: any) => e.key);
    expect(venPrefs).toEqual(expect.arrayContaining(['order_created', 'order_completed', 'order_cancelled', 'order_expiring', 'order_expired']));
    expect(venPrefs).not.toContain('lot_testing');
    const adminPrefs = (await api.call('GET', '/api/notifications/prefs', tokAdmin)).body.events;
    expect(adminPrefs).toHaveLength(7);

    const bad = await api.call('PUT', '/api/notifications/prefs', tokTec, { prefs: [{ event: 'order_created', inApp: false, push: false }] });
    expect(bad.body.error.code).toBe('invalid_event');
    const bogus = await api.call('PUT', '/api/notifications/prefs', tokTec, { prefs: [{ event: 'no_existe', inApp: false, push: false }] });
    expect(bogus.status).toBe(400);

    // El técnico apaga el push pero deja la bandeja.
    await api.call('PUT', '/api/notifications/prefs', tokTec, { prefs: [{ event: 'lot_testing', inApp: true, push: false }] });
    const lot = await api.call('POST', '/api/lots', tokAdmin, { lines: [] });
    await api.call('POST', `/api/lots/${lot.body.id}/transition`, tokAdmin, { action: 'start_testing' });
    sent.length = 0;
    await flushPendingPushes();
    expect(sent.filter((s) => s.endpoint === tec.endpoint)).toHaveLength(0);
    expect((await inbox(tokTec)).items).toHaveLength(1);

    // Apaga también la bandeja: el siguiente aviso no le llega por ningún lado.
    await api.call('PUT', '/api/notifications/prefs', tokTec, { prefs: [{ event: 'lot_testing', inApp: false, push: false }] });
    const lot2 = await api.call('POST', '/api/lots', tokAdmin, { lines: [] });
    await api.call('POST', `/api/lots/${lot2.body.id}/transition`, tokAdmin, { action: 'start_testing' });
    expect((await inbox(tokTec)).items).toHaveLength(1);
    // Solo push (bandeja apagada): no aparece en la bandeja pero sí se envía.
    await api.call('PUT', '/api/notifications/prefs', tokTec, { prefs: [{ event: 'lot_testing', inApp: false, push: true }] });
    const lot3 = await api.call('POST', '/api/lots', tokAdmin, { lines: [] });
    await api.call('POST', `/api/lots/${lot3.body.id}/transition`, tokAdmin, { action: 'start_testing' });
    sent.length = 0;
    await flushPendingPushes();
    expect(sent.filter((s) => s.endpoint === tec.endpoint)).toHaveLength(1);
    expect((await inbox(tokTec)).items).toHaveLength(1);
    // Volver a lo normal borra la preferencia guardada.
    await api.call('PUT', '/api/notifications/prefs', tokTec, { prefs: [{ event: 'lot_testing', inApp: true, push: true }] });
    expect(await withTenant(co.id, (db) => db.rows('SELECT 1 FROM notification_prefs'))).toHaveLength(0);
  });

  it('pedidos: aviso al crear, completar, cancelar, y a quien lo creó aunque no tenga el permiso', async () => {
    const cu = await api.call('POST', '/api/customers', tokVen, { name: 'Cliente Push' });
    const stock = await api.call('POST', '/api/orders', tokVen, { customerId: cu.body.id, lines: [{ equipmentTypeId: m.type('generic'), quantity: 1 }] });
    expect(stock.status).toBe(200);
    // Nuevo pedido: lo recibe quien completa ventas (admin), no quien lo creó.
    const adm = await inbox(tokAdmin);
    const created = adm.items.find((i: any) => i.event === 'order_created');
    expect(created.title).toContain(stock.body.code);
    expect(created.body).toContain('Cliente Push');
    expect((await inbox(tokVen)).items.filter((i: any) => i.event === 'order_created')).toHaveLength(0);

    // El admin lo cancela: se entera quien lo creó.
    const cancel = await api.call('POST', `/api/orders/${stock.body.id}/cancel`, tokAdmin);
    expect(cancel.status).toBe(200);
    expect((await inbox(tokVen)).items.map((i: any) => i.event)).toContain('order_cancelled');
    expect((await inbox(tokAdmin)).items.filter((i: any) => i.event === 'order_cancelled')).toHaveLength(0);
  });

  it('reservas: avisa una sola vez que van a vencer y otra al vencer; cambiar la fecha rearma el aviso', async () => {
    const cu = await api.call('POST', '/api/customers', tokVen, { name: 'Cliente Reserva' });
    const soon = new Date(Date.now() + 5 * 3600_000).toISOString();
    const o = await api.call('POST', '/api/orders', tokVen, { customerId: cu.body.id, reservedUntil: soon, lines: [{ equipmentTypeId: m.type('generic'), quantity: 1 }] });
    const far = await api.call('POST', '/api/orders', tokVen, { customerId: cu.body.id, reservedUntil: new Date(Date.now() + 72 * 3600_000).toISOString(), lines: [] });
    const count = async (tok: string, event: string) => (await inbox(tok)).items.filter((i: any) => i.event === event).length;

    await releaseExpiredReservations({ error: () => undefined } as any);
    expect(await count(tokVen, 'order_expiring')).toBe(1);   // quien creó el pedido
    expect(await count(tokAdmin, 'order_expiring')).toBe(1);  // y quien administra
    expect((await inbox(tokVen)).items.find((i: any) => i.event === 'order_expiring').title).toContain(o.body.code);
    expect((await inbox(tokVen)).items.some((i: any) => i.title.includes(far.body.code))).toBe(false);

    await releaseExpiredReservations({ error: () => undefined } as any);
    expect(await count(tokVen, 'order_expiring')).toBe(1);   // no se repite

    // Si se cambia la fecha (a una que aún queda dentro de la ventana), vuelve a avisar.
    await api.call('PATCH', `/api/orders/${o.body.id}`, tokVen, { reservedUntil: new Date(Date.now() + 6 * 3600_000).toISOString() });
    await releaseExpiredReservations({ error: () => undefined } as any);
    expect(await count(tokVen, 'order_expiring')).toBe(2);

    // Vence de verdad.
    await withTenant(co.id, (db) => db.query(`UPDATE sales_orders SET reserved_until = now() - interval '1 minute' WHERE id = $1`, [o.body.id]));
    expect(await releaseExpiredReservations({ error: () => undefined } as any)).toBe(1);
    expect(await count(tokVen, 'order_expired')).toBe(1);
    expect(await count(tokAdmin, 'order_expired')).toBe(1);
  });

  it('un dispositivo que ya no existe (410) se elimina solo; un error temporal no', async () => {
    status = 410;
    // Provoca un aviso para el admin (que tiene un dispositivo).
    const lot = await api.call('POST', '/api/lots', tokAlm, { lines: [] });
    await api.call('POST', `/api/lots/${lot.body.id}/transition`, tokAlm, { action: 'start_count' });
    await api.call('POST', `/api/lots/${lot.body.id}/transition`, tokAlm, { action: 'finish_count', force: true });
    await flushPendingPushes();
    expect((await api.call('GET', '/api/push/subscriptions', tokAdmin)).body.items).toHaveLength(0);

    status = 500;
    const res = await api.call('POST', '/api/push/test', tokTec);
    expect(res.body).toMatchObject({ devices: 2, sent: 0, failed: 2 });
    expect((await api.call('GET', '/api/push/subscriptions', tokTec)).body.items).toHaveLength(2);
    status = 201;
  });

  it('aviso de prueba: llega a todos los dispositivos, en el idioma de la persona', async () => {
    sent.length = 0;
    const res = await api.call('POST', '/api/push/test', tokTec);
    expect(res.body).toMatchObject({ devices: 2, sent: 2, failed: 0 });
    expect(plain(sent.find((s) => s.endpoint === tec.endpoint)!, tec)).toMatchObject({ title: 'Notificación de prueba', url: '/notifications' });
    expect((await api.call('POST', '/api/push/test', null)).status).toBe(401);
    // Sin dispositivos no hay error: solo cero.
    expect((await api.call('POST', '/api/push/test', tokVen)).body).toEqual({ devices: 0, sent: 0, failed: 0 });
  });

  it('quitar un dispositivo: por endpoint (este navegador) o por id (desde otro)', async () => {
    const un = await api.call('POST', '/api/push/unsubscribe', tokTec, { endpoint: tec.endpoint });
    expect(un.status).toBe(200);
    const left = (await api.call('GET', '/api/push/subscriptions', tokTec)).body.items;
    expect(left).toHaveLength(1);
    expect((await api.call('DELETE', `/api/push/subscriptions/${left[0].id}`, tokAlm)).status).toBe(404);   // ajeno
    expect((await api.call('DELETE', `/api/push/subscriptions/${left[0].id}`, tokTec)).status).toBe(200);
    expect((await api.call('GET', '/api/push/subscriptions', tokTec)).body.items).toHaveLength(0);
  });

  it('el mismo navegador pasa al usuario que inició sesión y las empresas no se ven entre sí', async () => {
    const shared = fakeDevice('shared');
    await api.call('POST', '/api/push/subscribe', tokTec, { endpoint: shared.endpoint, keys: shared.keys });
    await api.call('POST', '/api/push/subscribe', tokAlm, { endpoint: shared.endpoint, keys: shared.keys });
    expect((await api.call('GET', '/api/push/subscriptions', tokTec)).body.items).toHaveLength(0);
    expect((await api.call('GET', '/api/push/subscriptions', tokAlm)).body.items).toHaveLength(1);

    const other = await makeCompany('Otra Co', 'oadmin');
    const tokO = (await login(api, 'oadmin', 'password123', other.id)).token;
    expect((await inbox(tokO)).items).toHaveLength(0);
    expect(await withTenant(other.id, (db) => db.rows('SELECT 1 FROM notifications'))).toHaveLength(0);
  });
});
