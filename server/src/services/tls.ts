import { createPrivateKey, generateKeyPairSync, randomBytes, sign as cryptoSign, X509Certificate, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { ROOT_DIR } from '../config.js';

const DIR = join(ROOT_DIR, 'data', 'tls');
const CA_CERT_FILE = join(DIR, 'ca-cert.pem');
const CA_KEY_FILE = join(DIR, 'ca-key.pem');
const CERT_FILE = join(DIR, 'cert.pem');
const KEY_FILE = join(DIR, 'key.pem');

const CA_NAME = 'DRAP Inventory (esta PC)';

// ---------------------------------------------------------------------------
// Codificador DER mínimo (sin dependencias externas) para armar certificados
// X.509 v3: una autoridad local (CA) y, firmado por ella, el certificado del
// servidor. Solo lo necesario: SEQUENCE, INTEGER, OID, BIT STRING, OCTET
// STRING, BOOLEAN, NULL, UTF8String y los tags [n] de contexto.
// ---------------------------------------------------------------------------
function derLen(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  const bytes: number[] = [];
  let n = len;
  while (n > 0) { bytes.unshift(n & 0xff); n = Math.floor(n / 256); }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, value: Buffer): Buffer => Buffer.concat([Buffer.from([tag]), derLen(value.length), value]);
const seq = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]): Buffer => tlv(0x31, Buffer.concat(parts));
const int = (bytes: Buffer): Buffer => tlv(0x02, bytes[0] & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
const bool = (v: boolean): Buffer => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const nul = (): Buffer => Buffer.from([0x05, 0x00]);
const octet = (data: Buffer): Buffer => tlv(0x04, data);
const bitString = (data: Buffer, unusedBits = 0): Buffer => tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), data]));
const utf8Str = (s: string): Buffer => tlv(0x0c, Buffer.from(s, 'utf8'));
const explicitTag = (n: number, inner: Buffer): Buffer => tlv(0xa0 | n, inner);
const contextPrimitive = (n: number, value: Buffer): Buffer => tlv(0x80 | n, value);

function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  const bytes: number[] = [parts[0] * 40 + parts[1]];
  for (const p of parts.slice(2)) {
    if (p < 0x80) { bytes.push(p); continue; }
    const chunk: number[] = [p & 0x7f];
    let v = p >> 7;
    while (v > 0) { chunk.unshift((v & 0x7f) | 0x80); v >>= 7; }
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function pad2(n: number): string { return String(n).padStart(2, '0'); }
/** UTCTime (AAMMDDhhmmssZ): válido hasta 2049, de sobra para estos certificados. */
function derUtcTime(d: Date): Buffer {
  const s = pad2(d.getUTCFullYear() % 100) + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate())
    + pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()) + pad2(d.getUTCSeconds()) + 'Z';
  return tlv(0x17, Buffer.from(s, 'ascii'));
}

const RSA_SHA256_OID = '1.2.840.113549.1.1.11';
const CN_OID = '2.5.4.3';
const algSha256Rsa = () => seq(oid(RSA_SHA256_OID), nul());
const nameCN = (cn: string) => seq(set(seq(oid(CN_OID), utf8Str(cn))));

function extension(extnOid: string, critical: boolean, valueDer: Buffer): Buffer {
  const parts = [oid(extnOid)];
  if (critical) parts.push(bool(true));
  parts.push(octet(valueDer));
  return seq(...parts);
}
const dnsName = (name: string): Buffer => contextPrimitive(2, Buffer.from(name, 'ascii'));   // GeneralName ::= dNSName [2]
const ipv4Name = (ip: string): Buffer => contextPrimitive(7, Buffer.from(ip.split('.').map(Number))); // iPAddress [7]
const IPV6_LOOPBACK = contextPrimitive(7, Buffer.concat([Buffer.alloc(15, 0), Buffer.from([1])]));

function toPem(der: Buffer, label: string): string {
  return `-----BEGIN ${label}-----\n${(der.toString('base64').match(/.{1,64}/g) ?? []).join('\n')}\n-----END ${label}-----\n`;
}

/** Arma el TBSCertificate (la parte firmada) común a la CA y al certificado del servidor. */
function buildTbs(opts: {
  subjectCN: string; issuerCN: string; publicKeySpki: Buffer; notBefore: Date; notAfter: Date; extensions: Buffer;
}): Buffer {
  return seq(
    explicitTag(0, int(Buffer.from([2]))),                   // version: v3
    int(randomBytes(16)),                                    // serialNumber (aleatorio, siempre positivo por `int`)
    algSha256Rsa(),
    nameCN(opts.issuerCN),
    seq(derUtcTime(opts.notBefore), derUtcTime(opts.notAfter)),
    nameCN(opts.subjectCN),
    opts.publicKeySpki,
    opts.extensions,
  );
}

/** Autoridad local (CA) autofirmada: firma el certificado del servidor para que, una vez que un
 * dispositivo la marca como confiable, deje de mostrar avisos de "conexión no privada". */
function buildCa(notBefore: Date, notAfter: Date): { key: KeyObject; cert: Buffer; pem: { key: string; cert: string } } {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 }) as { publicKey: KeyObject; privateKey: KeyObject };
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const extensions = explicitTag(3, seq(
    extension('2.5.29.19', true, seq(bool(true), int(Buffer.from([0])))),   // basicConstraints: cA=true, pathLen=0
    extension('2.5.29.15', true, bitString(Buffer.from([0x06]), 1)),        // keyUsage: keyCertSign + cRLSign
  ));
  const tbs = buildTbs({ subjectCN: CA_NAME, issuerCN: CA_NAME, publicKeySpki: spki, notBefore, notAfter, extensions });
  const signature = cryptoSign('sha256', tbs, privateKey);
  const certDer = seq(tbs, algSha256Rsa(), bitString(signature, 0));
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  return { key: privateKey, cert: certDer, pem: { key: keyPem, cert: toPem(certDer, 'CERTIFICATE') } };
}

/** Certificado del servidor, firmado por la CA local (no autofirmado). */
function buildServerCert(caKey: KeyObject, cn: string, sanDnsNames: string[], sanIps: string[], notBefore: Date, notAfter: Date) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 }) as { publicKey: KeyObject; privateKey: KeyObject };
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

  const sanEntries = [...sanDnsNames.map(dnsName), ipv4Name('127.0.0.1'), IPV6_LOOPBACK, ...sanIps.map(ipv4Name)];
  const extKeyUsageOids = seq(oid('1.3.6.1.5.5.7.3.1'), oid('1.3.6.1.5.5.7.3.2')); // serverAuth, clientAuth
  const extensions = explicitTag(3, seq(
    extension('2.5.29.19', true, seq()),                                    // basicConstraints: cA=false
    extension('2.5.29.15', true, bitString(Buffer.from([0xa0]), 5)),        // keyUsage: digitalSignature + keyEncipherment
    extension('2.5.29.37', false, extKeyUsageOids),                         // extKeyUsage
    extension('2.5.29.17', false, seq(...sanEntries)),                      // subjectAltName
  ));
  const tbs = buildTbs({ subjectCN: cn, issuerCN: CA_NAME, publicKeySpki: spki, notBefore, notAfter, extensions });
  const signature = cryptoSign('sha256', tbs, caKey);
  const certDer = seq(tbs, algSha256Rsa(), bitString(signature, 0));
  return { cert: toPem(certDer, 'CERTIFICATE'), key: privateKeyPem };
}

/** Direcciones IPv4 de la red local de esta PC (para el certificado, y para mostrarlas al usuario). */
export function localIps(): string[] {
  const out: string[] = [];
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const it of ifaces ?? []) if (it.family === 'IPv4' && !it.internal) out.push(it.address);
  }
  return out;
}

function certExpiringOrMissingSans(certPem: string, ips: string[]): boolean {
  try {
    const cert = new X509Certificate(certPem);
    if (new Date(cert.validTo).getTime() < Date.now() + 30 * 86_400_000) return true;
    const san = cert.subjectAltName ?? '';
    return !ips.every((ip) => san.includes(`IP Address:${ip}`));
  } catch {
    return true;
  }
}

function loadExistingCa(): { key: KeyObject; certPem: string } | null {
  if (!existsSync(CA_CERT_FILE) || !existsSync(CA_KEY_FILE)) return null;
  try {
    const certPem = readFileSync(CA_CERT_FILE, 'utf8');
    const keyPem = readFileSync(CA_KEY_FILE, 'utf8');
    if (new Date(new X509Certificate(certPem).validTo).getTime() < Date.now()) return null;
    return { key: createPrivateKey(keyPem), certPem };
  } catch {
    return null;
  }
}

/**
 * Certificados para servir la app por HTTPS desde esta PC: una autoridad local (CA, se genera solo
 * una vez y no cambia) y, firmado por ella, el certificado del servidor (se renueva solo si está por
 * vencer o cambió la IP de la red local). El navegador exige HTTPS (o "localhost") para notificaciones
 * push, y para que Chrome permita **instalar la app** además exige que el certificado sea de confianza
 * — no basta con un autofirmado normal. Por eso el certificado del servidor no se autofirma: lo firma
 * esta CA local, y la CA se puede marcar como confiable una vez en cada dispositivo (se descarga sin
 * avisos desde `/ca.crt`, incluso por HTTP normal) — desde ahí, ya no hay más avisos y la instalación
 * de la app queda disponible. Sin depender de ningún paquete externo ni de OpenSSL.
 */
export async function ensureTlsCert(): Promise<{ key: string; cert: string; caCert: string; ips: string[] }> {
  const ips = localIps();
  mkdirSync(DIR, { recursive: true });

  let ca = loadExistingCa();
  if (!ca) {
    // Se genera una sola vez: si cambiara después, los dispositivos que ya confiaron en la anterior
    // tendrían que volver a confiar en la nueva. Validez larga para que eso no haga falta.
    const built = buildCa(new Date(), new Date(Date.now() + 20 * 365 * 86_400_000));
    writeFileSync(CA_CERT_FILE, built.pem.cert, { mode: 0o600 });
    writeFileSync(CA_KEY_FILE, built.pem.key, { mode: 0o600 });
    ca = { key: built.key, certPem: built.pem.cert };
  }

  if (existsSync(CERT_FILE) && existsSync(KEY_FILE)) {
    const cert = readFileSync(CERT_FILE, 'utf8');
    if (!certExpiringOrMissingSans(cert, ips)) return { key: readFileSync(KEY_FILE, 'utf8'), cert, caCert: ca.certPem, ips };
  }

  const host = hostname();
  const notBefore = new Date();
  const notAfter = new Date(Date.now() + 10 * 365 * 86_400_000);
  const { cert, key } = buildServerCert(ca.key, host, ['localhost', host], ips, notBefore, notAfter);
  writeFileSync(CERT_FILE, cert, { mode: 0o600 });
  writeFileSync(KEY_FILE, key, { mode: 0o600 });
  return { key, cert, caCert: ca.certPem, ips };
}
