import {
  createCipheriv, createECDH, createPrivateKey, createPublicKey, generateKeyPairSync, hkdfSync, randomBytes, sign, verify,
  type KeyObject,
} from 'node:crypto';
import { withGlobal } from '../db.js';

/**
 * Web Push sin dependencias externas (solo `node:crypto`):
 *  - Cifrado del mensaje: RFC 8291 (aes128gcm).
 *  - Identificación del servidor: VAPID, RFC 8292 (JWT ES256).
 * Así el sistema no necesita instalar paquetes nuevos al actualizarse.
 */

const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url');
const fromB64u = (s: string) => Buffer.from(s, 'base64url');

// ---------------------------------------------------------------------------
// Claves VAPID
// ---------------------------------------------------------------------------

export interface VapidKeys { publicKey: string; privateKey: string }   // ambas en base64url (pública: 65 bytes sin comprimir; privada: 32 bytes)

export function generateVapidKeys(): VapidKeys {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const priv = privateKey.export({ format: 'jwk' }) as { d: string };
  const pub = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  return { privateKey: priv.d, publicKey: b64u(Buffer.concat([Buffer.from([4]), fromB64u(pub.x), fromB64u(pub.y)])) };
}

function privateKeyObject(keys: VapidKeys): KeyObject {
  const pub = fromB64u(keys.publicKey);
  return createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) } });
}

let cachedKeys: VapidKeys | null = null;

/** Claves del servidor: variables de entorno (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY) o, si no hay, las de la base (se crean solas). */
export async function getVapidKeys(): Promise<VapidKeys> {
  if (cachedKeys) return cachedKeys;
  const envPub = process.env.VAPID_PUBLIC_KEY?.trim(), envPriv = process.env.VAPID_PRIVATE_KEY?.trim();
  if (envPub && envPriv) return (cachedKeys = { publicKey: envPub, privateKey: envPriv });
  cachedKeys = await withGlobal(async (db) => {
    // Bloqueo para que dos procesos que arrancan a la vez no generen claves distintas.
    await db.query('SELECT pg_advisory_xact_lock(7301)');
    const rows = await db.rows<{ key: string; value: string }>(`SELECT key, value FROM app_secrets WHERE key IN ('vapid_public', 'vapid_private')`);
    const pub = rows.find((r) => r.key === 'vapid_public')?.value, priv = rows.find((r) => r.key === 'vapid_private')?.value;
    if (pub && priv) return { publicKey: pub, privateKey: priv };
    const k = generateVapidKeys();
    await db.query(`INSERT INTO app_secrets (key, value) VALUES ('vapid_public', $1), ('vapid_private', $2)`, [k.publicKey, k.privateKey]);
    return k;
  });
  return cachedKeys;
}

/** Solo para pruebas. */
export function resetVapidCache() { cachedKeys = null; }

/** Contacto que ven los servicios push (obligatorio en VAPID). Configurable con VAPID_SUBJECT. */
const vapidSubject = () => process.env.VAPID_SUBJECT?.trim() || 'mailto:admin@example.com';

/** Cabecera Authorization de VAPID para un servicio push (el JWT dura 12 h y se reutiliza por servicio). */
const jwtCache = new Map<string, { jwt: string; exp: number }>();
export function vapidAuthorization(endpoint: string, keys: VapidKeys, now = Date.now()): string {
  const aud = new URL(endpoint).origin;
  const cacheKey = `${aud}|${keys.publicKey}`;
  const hit = jwtCache.get(cacheKey);
  let jwt: string;
  if (hit && hit.exp - now > 3600_000) jwt = hit.jwt;
  else {
    const exp = Math.floor(now / 1000) + 12 * 3600;
    const head = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
    const body = b64u(Buffer.from(JSON.stringify({ aud, exp, sub: vapidSubject() })));
    const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key: privateKeyObject(keys), dsaEncoding: 'ieee-p1363' });
    jwt = `${head}.${body}.${b64u(sig)}`;
    jwtCache.set(cacheKey, { jwt, exp: exp * 1000 });
  }
  return `vapid t=${jwt}, k=${keys.publicKey}`;
}

/** Solo para pruebas: verifica un JWT VAPID con la clave pública. */
export function verifyVapidJwt(jwt: string, publicKey: string): { aud: string; exp: number; sub: string } | null {
  const [h, p, s] = jwt.split('.');
  if (!h || !p || !s) return null;
  const pub = fromB64u(publicKey);
  const key = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) } });
  const ok = verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, fromB64u(s));
  return ok ? JSON.parse(fromB64u(p).toString()) : null;
}

// ---------------------------------------------------------------------------
// Cifrado del mensaje (RFC 8291, aes128gcm)
// ---------------------------------------------------------------------------

export interface PushKeys { p256dh: string; auth: string }

/**
 * Cifra `plaintext` para un suscriptor. Devuelve el cuerpo completo de la petición HTTP
 * (cabecera de contenido + datos cifrados). `opts` permite fijar la sal y la clave efímera (pruebas).
 */
export function encryptPayload(keys: PushKeys, plaintext: Buffer, opts: { salt?: Buffer; ephemeralPrivate?: Buffer } = {}): Buffer {
  const uaPublic = fromB64u(keys.p256dh);
  const authSecret = fromB64u(keys.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('p256dh inválida');
  if (authSecret.length !== 16) throw new Error('auth inválida');

  const ecdh = createECDH('prime256v1');
  if (opts.ephemeralPrivate) ecdh.setPrivateKey(opts.ephemeralPrivate); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const salt = opts.salt ?? randomBytes(16);
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // Un solo registro: los datos + 0x02 (marca del último registro).
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, encrypted]);
}

// ---------------------------------------------------------------------------
// Validación del destino (evita que alguien registre una URL cualquiera y use el servidor para llamarla)
// ---------------------------------------------------------------------------

const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,                 // Chrome, Edge, Android, Samsung (FCM)
  /(^|\.)push\.services\.mozilla\.com$/,  // Firefox
  /(^|\.)push\.apple\.com$/,              // Safari / iPhone / iPad
  /(^|\.)notify\.windows\.com$/,          // Edge / Windows
];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  let u: URL;
  try { u = new URL(endpoint); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
  const host = u.hostname.toLowerCase();
  if (PUSH_HOSTS.some((re) => re.test(host))) return true;
  const extra = (process.env.PUSH_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return extra.some((h) => host === h || host.endsWith('.' + h));
}

// ---------------------------------------------------------------------------
// Envío
// ---------------------------------------------------------------------------

export interface PushMessage {
  title: string;
  body?: string;
  url?: string;
  tag?: string;
  event?: string;
  id?: number;
}

export type PushResult = 'sent' | 'gone' | 'failed';

/** Transporte HTTP (se reemplaza en las pruebas). */
export type PushFetch = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: Buffer; signal?: AbortSignal }) => Promise<{ status: number }>;
let transport: PushFetch = (url, init) => fetch(url, { ...init, body: new Uint8Array(init.body) });
export function setPushTransport(fn: PushFetch | null) {
  transport = fn ?? ((url, init) => fetch(url, { ...init, body: new Uint8Array(init.body) }));
}

export async function sendPush(sub: { endpoint: string } & PushKeys, msg: PushMessage, opts: { ttl?: number; urgency?: 'very-low' | 'low' | 'normal' | 'high' } = {}): Promise<PushResult> {
  if (!isAllowedPushEndpoint(sub.endpoint)) return 'gone';
  const keys = await getVapidKeys();
  let body: Buffer;
  try {
    body = encryptPayload(sub, Buffer.from(JSON.stringify(msg)));
  } catch {
    return 'gone';   // claves del dispositivo dañadas: no sirve reintentar
  }
  try {
    const res = await transport(sub.endpoint, {
      method: 'POST',
      headers: {
        Authorization: vapidAuthorization(sub.endpoint, keys),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(body.length),
        TTL: String(opts.ttl ?? 86400),
        Urgency: opts.urgency ?? 'normal',
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status >= 200 && res.status < 300) return 'sent';
    if (res.status === 404 || res.status === 410) return 'gone';   // el usuario quitó el permiso o desinstaló
    return 'failed';
  } catch {
    return 'failed';
  }
}
