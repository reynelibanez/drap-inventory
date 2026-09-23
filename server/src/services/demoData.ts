/**
 * Datos de demostración: llena una empresa con un negocio "en marcha" para probar todas las pantallas sin escribir nada a mano.
 *
 * Todo se crea con la API real (mismas reglas, validaciones y permisos que la pantalla), así que además sirve de prueba de humo:
 * si algo de la aplicación se rompe, la carga de demostración falla y avisa dónde.
 *
 * Qué genera (cantidades aproximadas):
 *  - Equipo: 6 usuarios de demostración (2 vendedores, 2 técnicos, almacén y consulta), 5 proveedores, 10 clientes, 3 vendedores.
 *  - Almacenes: 2 almacenes, 5 áreas y 8 racks con espacios.
 *  - 5 lotes, uno en cada estado: Registrado, En conteo, Contado, En testeo (≈170 equipos) y Cerrado (40 equipos).
 *  - ≈210 equipos variados (laptops, desktops, monitores, discos, memorias, docking) con distintos grados, marcas, modelos,
 *    procesadores, RAM, discos, notas y hasta 3 técnicos; unos pocos siguen "en testeo" y otros quedan "no vendibles".
 *  - Costos por lote (mercancía + fletes/aduana, con reglas de reparto por peso) y reglas de precio de lista (con precios fijados a mano).
 *  - ≈14 pedidos de venta en todos los estados (abiertos, completados, cancelados, con equipos faltantes, con descuentos, envío
 *    y precio total repartido) hechos por distintos vendedores, más 5 ventas rápidas.
 *  - 23 activos de la empresa (herramientas y equipos propios) en todos los estados.
 */
import type { FastifyInstance } from 'fastify';
import { withGlobal, withTenant } from '../db.js';

export interface DemoOptions {
  companyId: number;
  /** Administrador que hace la carga. */
  adminUserId: number;
  log?: (msg: string) => void;
  /** Para repetir exactamente los mismos datos (por defecto: distintos cada vez). */
  seed?: number;
  /** Contraseña de los usuarios de demostración. */
  password?: string;
  /** Se agrega al nombre de usuario de los usuarios de demostración (para evitar choques con usuarios que ya existan). */
  usernameSuffix?: string;
}

export interface DemoSummary {
  lots: number;
  units: number;
  unitsFinished: number;
  unitsAvailable: number;
  orders: number;
  quickSales: number;
  assets: number;
  customers: number;
  suppliers: number;
  sellers: number;
  users: { username: string; fullName: string; role: string; created: boolean }[];
  password: string;
  mainLotCode: string;
}

// ---------------------------------------------------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------------------------------------------------

function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type TypeKey = 'laptop' | 'desktop' | 'monitor' | 'hard_drive' | 'memory' | 'generic';

interface Model {
  type: TypeKey;
  brand: string;
  model?: string;
  cpu?: string; gen?: string; ram?: string; disk?: string; diskType?: string; screen?: string;
  ramType?: string; res?: string; speed?: string; desc?: string;
  /** Cómo empiezan los números de serie de esta marca. */
  serial: string;
}

/** Mezcla de calidades de los equipos de una línea. */
type Bias = 'good' | 'mixed' | 'worn';

interface LinePlan {
  m: Model;
  expected: number;
  /** Cantidad contada (null = todavía sin contar). */
  counted: number | null;
  /** Equipos que se testean y terminan. */
  tested: number;
  /** Equipos registrados que siguen "en testeo" (sin terminar). */
  pending?: number;
  bias?: Bias;
}

const NOTES = [
  'Rayón en la tapa', 'Tecla Esc floja', 'Bisagra con algo de juego', 'Batería con servicio recomendado', 'Sin cargador',
  'Pixel muerto en una esquina', 'Marcas de uso en el teclado', 'Se cambió la pasta térmica', 'Puerto USB flojo', 'Etiqueta original dañada',
  'Bisel con pequeño golpe', 'Ventilador algo ruidoso',
];

const RAM_UP: Record<string, string> = { '4': '8', '8': '16', '16': '32' };
const DISK_UP: Record<string, string> = { '128': '256', '256': '512', '500': '1TB', '512': '1TB' };

const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000);
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

// ---------------------------------------------------------------------------------------------------------------------
// Catálogo de lo que "llega" en los lotes
// ---------------------------------------------------------------------------------------------------------------------

const MAIN_LINES: LinePlan[] = [
  // Laptops
  { m: { type: 'laptop', brand: 'Dell', model: 'Latitude 7490', cpu: 'Intel Core i7', gen: '8650U', ram: '16', disk: '512', diskType: 'SSD NVMe', screen: '14', serial: 'S' }, expected: 12, counted: 12, tested: 12 },
  { m: { type: 'laptop', brand: 'Dell', model: 'Latitude 5490', cpu: 'Intel Core i5', gen: '8350U', ram: '8', disk: '256', diskType: 'SSD SATA', screen: '14', serial: 'S' }, expected: 10, counted: 10, tested: 8, pending: 2 },
  { m: { type: 'laptop', brand: 'HP', model: 'EliteBook 840 G5', cpu: 'Intel Core i5', gen: '8350U', ram: '8', disk: '256', diskType: 'SSD NVMe', screen: '14', serial: '5CG' }, expected: 10, counted: 10, tested: 10 },
  { m: { type: 'laptop', brand: 'HP', model: 'EliteBook 840 G3', cpu: 'Intel Core i5', gen: '6300U', ram: '8', disk: '256', diskType: 'SSD SATA', screen: '14', serial: '5CG' }, expected: 8, counted: 7, tested: 7, bias: 'worn' },
  { m: { type: 'laptop', brand: 'Lenovo', model: 'ThinkPad T480', cpu: 'Intel Core i7', gen: '8650U', ram: '16', disk: '512', diskType: 'SSD NVMe', screen: '14', serial: 'PF' }, expected: 10, counted: 10, tested: 10 },
  { m: { type: 'laptop', brand: 'Lenovo', model: 'ThinkPad T470', cpu: 'Intel Core i5', gen: '7300U', ram: '8', disk: '256', diskType: 'SSD SATA', screen: '14', serial: 'PF' }, expected: 8, counted: 8, tested: 8, bias: 'mixed' },
  { m: { type: 'laptop', brand: 'Apple', model: 'MacBook Air 13" A1466 (2017)', cpu: 'Intel Core i5', ram: '8', disk: '128', diskType: 'SSD SATA', screen: '13.3', serial: 'C02' }, expected: 6, counted: 5, tested: 5, bias: 'good' },
  { m: { type: 'laptop', brand: 'Samsung', model: 'Chromebook 3 XE500C13', cpu: 'Intel Celeron', ram: '4', disk: '128', diskType: 'eMMC', screen: '11.6', serial: 'HW' }, expected: 6, counted: 6, tested: 6, bias: 'worn' },
  // Desktops
  { m: { type: 'desktop', brand: 'Dell', model: 'OptiPlex 7040 SFF', cpu: 'Intel Core i5', gen: '6500', ram: '8', disk: '256', diskType: 'SSD SATA', serial: 'S' }, expected: 10, counted: 10, tested: 10 },
  { m: { type: 'desktop', brand: 'HP', model: 'EliteDesk 800 G3 Mini', cpu: 'Intel Core i5', gen: '7500T', ram: '8', disk: '256', diskType: 'SSD NVMe', serial: 'MXL' }, expected: 8, counted: 8, tested: 8 },
  { m: { type: 'desktop', brand: 'Lenovo', model: 'ThinkCentre M710q', cpu: 'Intel Core i3', gen: '7100T', ram: '4', disk: '128', diskType: 'SSD SATA', serial: 'MJ' }, expected: 6, counted: 6, tested: 6, bias: 'mixed' },
  // Monitores
  { m: { type: 'monitor', brand: 'Dell', model: 'P2419H', screen: '23.8', res: '1920x1080', serial: 'CN0' }, expected: 12, counted: 12, tested: 11, pending: 1 },
  { m: { type: 'monitor', brand: 'Lenovo', model: 'ThinkVision T22i-10', screen: '21.5', res: '1920x1080', serial: 'V9' }, expected: 8, counted: 8, tested: 8 },
  { m: { type: 'monitor', brand: 'LG', model: '27MK430H-B', screen: '27', res: '1920x1080', serial: '901' }, expected: 6, counted: 6, tested: 6, bias: 'good' },
  { m: { type: 'monitor', brand: 'Samsung', model: 'S22F350FH', screen: '22', res: '1920x1080', serial: 'ZZ' }, expected: 6, counted: 5, tested: 5, bias: 'worn' },
  // Componentes
  { m: { type: 'hard_drive', brand: 'Seagate', model: 'Barracuda 2.5" ST500LM030', diskType: 'HDD', disk: '500', serial: 'W' }, expected: 8, counted: 8, tested: 8, bias: 'mixed' },
  { m: { type: 'hard_drive', brand: 'Samsung', model: '860 EVO', diskType: 'SSD SATA', disk: '256', serial: 'S3Y' }, expected: 8, counted: 8, tested: 8, bias: 'good' },
  { m: { type: 'memory', brand: 'Kingston', ram: '8', ramType: 'DDR4', speed: '2666 MHz', serial: 'KS' }, expected: 15, counted: 15, tested: 14, pending: 1, bias: 'good' },
  { m: { type: 'memory', brand: 'Crucial', ram: '4', ramType: 'DDR3L', speed: '1600 MHz', serial: 'CT' }, expected: 10, counted: 12, tested: 12, bias: 'good' },
];

/** Aparece en el conteo algo que no estaba en la factura. */
const DOCKING: Model = { type: 'generic', brand: 'Dell', model: 'WD15', desc: 'Docking station Dell WD15', serial: 'DK' };

const LOT_B_LINES: LinePlan[] = [
  { m: { type: 'laptop', brand: 'Dell', model: 'Latitude 5480', cpu: 'Intel Core i5', gen: '7300U', ram: '8', disk: '256', diskType: 'SSD SATA', screen: '14', serial: 'S' }, expected: 15, counted: 15, tested: 15, bias: 'good' },
  { m: { type: 'laptop', brand: 'HP', model: 'EliteBook 820 G3', cpu: 'Intel Core i5', gen: '6300U', ram: '8', disk: '128', diskType: 'SSD SATA', screen: '12.5', serial: '5CG' }, expected: 10, counted: 10, tested: 10, bias: 'good' },
  { m: { type: 'desktop', brand: 'Dell', model: 'OptiPlex 3020 SFF', cpu: 'Intel Core i3', gen: '4130', ram: '4', disk: '500', diskType: 'HDD', serial: 'S' }, expected: 8, counted: 8, tested: 8, bias: 'good' },
  { m: { type: 'hard_drive', brand: 'Samsung', model: '850 EVO', diskType: 'SSD SATA', disk: '256', serial: 'S21' }, expected: 7, counted: 7, tested: 7, bias: 'good' },
];

const LOT_C_LINES: LinePlan[] = [
  { m: { type: 'laptop', brand: 'Lenovo', model: 'ThinkPad X270', cpu: 'Intel Core i5', gen: '6300U', ram: '8', disk: '256', diskType: 'SSD SATA', screen: '12.5', serial: 'PF' }, expected: 12, counted: 12, tested: 0 },
  { m: { type: 'desktop', brand: 'Dell', model: 'OptiPlex 7010', cpu: 'Intel Core i5', gen: '3470', ram: '8', disk: '500', diskType: 'HDD', serial: 'S' }, expected: 10, counted: 9, tested: 0 },
  { m: { type: 'monitor', brand: 'HP', model: 'EliteDisplay E231', screen: '24', res: '1920x1080', serial: 'CN4' }, expected: 8, counted: 8, tested: 0 },
];

const LOT_D_LINES: LinePlan[] = [
  { m: { type: 'laptop', brand: 'Dell', model: 'Latitude E7470', cpu: 'Intel Core i5', gen: '6300U', ram: '8', disk: '256', diskType: 'SSD SATA', screen: '14', serial: 'S' }, expected: 20, counted: null, tested: 0 },
  { m: { type: 'laptop', brand: 'Apple', model: 'MacBook Pro 13" A1708 (2017)', cpu: 'Intel Core i5', ram: '8', disk: '256', diskType: 'SSD NVMe', screen: '13.3', serial: 'C02' }, expected: 10, counted: null, tested: 0 },
  { m: { type: 'laptop', brand: 'Microsoft', model: 'Surface Pro 5', cpu: 'Intel Core i5', gen: '7300U', ram: '8', disk: '128', diskType: 'SSD NVMe', screen: '12.5', serial: '0F' }, expected: 8, counted: null, tested: 0 },
];

const LOT_E_LINES: LinePlan[] = [
  { m: { type: 'desktop', brand: 'HP', model: 'ProDesk 600 G2 SFF', cpu: 'Intel Core i5', gen: '6500', ram: '8', disk: '500', diskType: 'HDD', serial: 'MXL' }, expected: 15, counted: 15, tested: 0 },
  { m: { type: 'monitor', brand: 'Dell', model: 'E2216H', screen: '22', res: '1920x1080', serial: 'CN0' }, expected: 20, counted: 18, tested: 0 },
  { m: { type: 'memory', brand: 'Kingston', ram: '4', ramType: 'DDR3', speed: '1333 MHz', serial: 'KS' }, expected: 40, counted: null, tested: 0 },
];

/** Modelos que usan pedidos y activos de la demostración además de los de los lotes: [tipo, marca, modelo]. */
const EXTRA_MODELS: [string, string, string][] = [
  ['laptop', 'Dell', 'Latitude 7490'], ['laptop', 'Dell', 'Latitude 5490'], ['laptop', 'Dell', 'Latitude 5480'],
  ['laptop', 'HP', 'EliteBook 840 G5'], ['laptop', 'HP', 'EliteBook 820 G3'],
  ['laptop', 'Lenovo', 'ThinkPad T470'], ['laptop', 'Lenovo', 'ThinkPad T480'],
  ['laptop', 'Toshiba', 'Satellite C55-B'],
  ['desktop', 'Dell', 'OptiPlex 3020 SFF'], ['desktop', 'Dell', 'OptiPlex 7050 SFF'], ['desktop', 'Lenovo', 'ThinkCentre M920s'],
  ['monitor', 'Dell', 'P2419H'], ['monitor', 'LG', '27MK430H-B'],
  ['hard_drive', 'Samsung', '850 EVO'], ['hard_drive', 'Seagate', 'Barracuda ST2000DM008'],
];

// ---------------------------------------------------------------------------------------------------------------------
// Carga principal
// ---------------------------------------------------------------------------------------------------------------------

export async function loadDemoData(app: FastifyInstance, o: DemoOptions): Promise<DemoSummary> {
  const log = o.log ?? (() => {});
  const password = o.password ?? 'Demo2026!';
  const suffix = o.usernameSuffix ?? '';
  const rnd = mulberry32(o.seed ?? Date.now() % 2147483647);
  const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
  const chance = (p: number) => rnd() < p;
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
  const weighted = <T,>(xs: [T, number][]): T => {
    const total = xs.reduce((a, [, w]) => a + w, 0);
    let r = rnd() * total;
    for (const [x, w] of xs) { r -= w; if (r <= 0) return x; }
    return xs[xs.length - 1][0];
  };

  // ----- Acceso a la API (con el token de cada usuario) -----
  const tokens = new Map<number, string>();
  const call = async (userId: number, method: string, url: string, body?: unknown): Promise<any> => {
    let t = tokens.get(userId);
    if (!t) { t = app.jwt.sign({ sub: userId, cid: o.companyId }, { expiresIn: '3h' }); tokens.set(userId, t); }
    const res = await app.inject({ method: method as any, url, headers: { authorization: `Bearer ${t}` }, payload: body as any });
    const data = res.body ? JSON.parse(res.body) : null;
    if (res.statusCode >= 400) throw new Error(`${method} ${url} → ${res.statusCode} ${JSON.stringify(data?.error ?? data)}`);
    return data;
  };
  const admin = (method: string, url: string, body?: unknown) => call(o.adminUserId, method, url, body);

  // ----- Catálogos -----
  const meta = await admin('GET', '/api/meta');
  const item = (cat: string, key: string): number => {
    const it = meta.catalogs.find((c: any) => c.key === cat)?.items.find((i: any) => i.code === key || i.name.es === key || i.name.en === key);
    if (!it) throw new Error(`No existe el valor "${key}" en el catálogo ${cat}`);
    return it.id;
  };
  const sys = (cat: string, key: string): number => meta.catalogs.find((c: any) => c.key === cat).items.find((i: any) => i.systemKey === key).id;
  const type = (key: string): number => {
    const t = meta.equipmentTypes.find((x: any) => x.key === key);
    if (!t) throw new Error(`No existe el tipo de equipo "${key}"`);
    return t.id;
  };

  // ----- Modelos: lista desplegable ligada a la marca (cada tipo de equipo tiene su catálogo; los que falten se agregan) -----
  const models = new Map<string, number>();
  const modelKey = (t: string, b: string, n: string) => `${t}|${b}|${n}`.toLowerCase();
  const ensureModel = async (t: string, b: string, n: string): Promise<void> => {
    const k = modelKey(t, b, n);
    if (models.has(k)) return;
    const cat = meta.catalogs.find((c: any) => c.key === `model_${t}`) ?? meta.catalogs.find((c: any) => c.key === 'model');
    const parent = item('brand', b);
    const found = cat.items.find((i: any) => i.parentItemId === parent && (i.name.es ?? '').toLowerCase() === n.toLowerCase());
    models.set(k, found ? found.id : (await admin('POST', `/api/catalogs/${cat.id}/quick-item`, { name: n, parentItemId: parent })).id);
  };
  const mdl = (t: string, b: string, n: string): number => {
    const id = models.get(modelKey(t, b, n));
    if (id === undefined) throw new Error(`Modelo sin preparar: ${t}/${b}/${n}`);
    return id;
  };
  /** Marca cada modelo que usan las líneas y pedidos de la demostración (los que el catálogo no traiga se crean bajo su marca). */
  for (const l of [...MAIN_LINES, ...LOT_B_LINES, ...LOT_C_LINES, ...LOT_D_LINES, ...LOT_E_LINES]) if (l.m.model) await ensureModel(l.m.type, l.m.brand, l.m.model);
  await ensureModel(DOCKING.type, DOCKING.brand, DOCKING.model!);
  for (const [t, b, n] of EXTRA_MODELS) await ensureModel(t, b, n);

  const summary: DemoSummary = {
    lots: 0, units: 0, unitsFinished: 0, unitsAvailable: 0, orders: 0, quickSales: 0, assets: 0, customers: 0, suppliers: 0, sellers: 0,
    users: [], password, mainLotCode: '',
  };

  // =====================================================================================================================
  // 1. Equipo de trabajo (usuarios de demostración)
  // =====================================================================================================================
  log('Usuarios de demostración...');
  const roles = (await admin('GET', '/api/roles')).items as { id: number; name: string }[];
  const roleId = (name: string) => roles.find((r) => r.name === name)?.id;
  const userIds: Record<string, number> = {};
  const membershipIds: Record<string, number> = {};
  const team: { username: string; fullName: string; role: string; email: string }[] = [
    { username: 'vendedor1', fullName: 'Carla Méndez', role: 'Ventas', email: 'carla.mendez@demo.example' },
    { username: 'vendedor2', fullName: 'Diego Ramírez', role: 'Ventas', email: 'diego.ramirez@demo.example' },
    { username: 'tecnico1', fullName: 'Luis Ortega', role: 'Técnico', email: 'luis.ortega@demo.example' },
    { username: 'tecnico2', fullName: 'Marta Suárez', role: 'Técnico', email: 'marta.suarez@demo.example' },
    { username: 'almacen1', fullName: 'Pedro Gil', role: 'Almacén', email: 'pedro.gil@demo.example' },
    { username: 'consulta1', fullName: 'Ana Torres', role: 'Solo consulta', email: 'ana.torres@demo.example' },
  ];
  for (const base of team) {
    const t = { ...base, username: base.username + suffix };
    const rid = roleId(t.role);
    let membershipId: number; let created = false;
    try {
      const r = await admin('POST', '/api/team/members', { username: t.username, fullName: t.fullName, email: t.email, password, roleIds: rid ? [rid] : [] });
      membershipId = r.id; created = r.createdUser;
    } catch (e: any) {
      // Ya estaba en esta empresa (carga repetida): se reutiliza.
      if (!String(e.message).includes('already_member')) throw e;
      const row = await withGlobal((db) => db.one<{ id: number }>(
        `SELECT m.id FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.company_id = $1 AND lower(u.username) = lower($2)`, [o.companyId, t.username]));
      membershipId = row.id;
    }
    membershipIds[base.username] = membershipId;
    userIds[base.username] = (await withGlobal((db) => db.one<{ user_id: number }>('SELECT user_id FROM memberships WHERE id = $1', [membershipId]))).user_id;
    summary.users.push({ username: t.username, fullName: t.fullName, role: t.role, created });
  }
  const V1 = userIds.vendedor1, V2 = userIds.vendedor2, T1 = userIds.tecnico1, T2 = userIds.tecnico2;

  // =====================================================================================================================
  // 2. Proveedores, clientes y vendedores
  // =====================================================================================================================
  log('Proveedores, clientes y vendedores...');
  const supplierData = [
    { name: 'Tech Liquidators Inc.', country: 'USA', contactName: 'Mark Ellis', email: 'sales@techliquidators.example', phone: '+1 305 555 0142' },
    { name: 'Global IT Remarketing LLC', country: 'USA', contactName: 'Jennifer Cole', email: 'jcole@globalitremarketing.example', phone: '+1 786 555 0177' },
    { name: 'Corporate Surplus Group', country: 'USA', contactName: 'Robert Lang', email: 'rlang@corpsurplus.example', phone: '+1 954 555 0119' },
    { name: 'Sunbelt Electronics Recycling', country: 'USA', contactName: 'Patricia Vega', email: 'pvega@sunbeltrecycling.example', phone: '+1 407 555 0163' },
    { name: 'Euro Refurb GmbH', country: 'Alemania', contactName: 'Klaus Brandt', email: 'k.brandt@eurorefurb.example', phone: '+49 30 5550 1188' },
  ];
  const suppliers: number[] = [];
  for (const s of supplierData) suppliers.push((await admin('POST', '/api/suppliers', s)).id);
  summary.suppliers = suppliers.length;

  const customerData = [
    { name: 'Importadora Caribe SRL', country: 'República Dominicana', type: 'Importador', contactName: 'Luis Peña', email: 'compras@importcaribe.example', phone: '+1 809 555 0101' },
    { name: 'Tienda Digital Panamá', country: 'Panamá', type: 'Minorista', contactName: 'Rosa Batista', email: 'rosa@tiendadigital.example', phone: '+507 555 0102' },
    { name: 'Computec Guatemala SA', country: 'Guatemala', type: 'Distribuidor', contactName: 'Jorge Mansilla', email: 'jmansilla@computec.example', phone: '+502 5555 0103' },
    { name: 'Mega Compu Colombia SAS', country: 'Colombia', type: 'Importador', contactName: 'Andrea Cifuentes', email: 'acifuentes@megacompu.example', phone: '+57 300 555 0104' },
    { name: 'Soluciones IT México', country: 'México', type: 'Distribuidor', contactName: 'Héctor Salinas', email: 'hsalinas@solucionesit.example', phone: '+52 55 5555 0105' },
    { name: 'Andes Tech Perú', country: 'Perú', type: 'Distribuidor', contactName: 'Camila Quispe', email: 'cquispe@andestech.example', phone: '+51 1 555 0106' },
    { name: 'Caribbean PC Depot', country: 'Jamaica', type: 'Minorista', contactName: 'Marcus Reid', email: 'marcus@caribbeanpc.example', phone: '+1 876 555 0107' },
    { name: 'Miami Office Solutions LLC', country: 'USA', type: 'Cliente final', contactName: 'Daniel Ruiz', email: 'druiz@miamioffice.example', phone: '+1 305 555 0108' },
    { name: 'Escuelas del Futuro ONG', country: 'Honduras', type: 'Cliente final', contactName: 'Elena Cruz', email: 'ecruz@escuelasfuturo.example', phone: '+504 5555 0109' },
    { name: 'Digitales del Sur', country: 'Chile', type: 'Minorista', contactName: 'Tomás Rivera', email: 'trivera@digitalesdelsur.example', phone: '+56 9 5555 0110' },
  ];
  const customers: number[] = [];
  for (const c of customerData) {
    const { type: ct, ...rest } = c;
    customers.push((await admin('POST', '/api/customers', { ...rest, customerTypeId: item('customer_type', ct) })).id);
  }
  summary.customers = customers.length;
  const [cCaribe, cPanama, cGuate, cColombia, cMexico, cPeru, cJamaica, cMiami, cEscuelas, cChile] = customers;

  const sellerCarla = (await admin('POST', '/api/sellers', { name: 'Carla Méndez', email: 'carla.mendez@demo.example', phone: '+1 305 555 0201', membershipId: membershipIds.vendedor1 })).id;
  const sellerDiego = (await admin('POST', '/api/sellers', { name: 'Diego Ramírez', email: 'diego.ramirez@demo.example', phone: '+1 305 555 0202', membershipId: membershipIds.vendedor2 })).id;
  const sellerSofia = (await admin('POST', '/api/sellers', { name: 'Sofía Herrera (externa)', email: 'sofia.herrera@demo.example', phone: '+1 786 555 0203' })).id;
  summary.sellers = 3;

  // =====================================================================================================================
  // 3. Ubicaciones
  // =====================================================================================================================
  log('Almacenes, áreas y racks...');
  const rack = (areaId: number, code: string, levels: number, slots: number, capacity: number) =>
    admin('POST', '/api/racks', { areaId, code, layout: { levels: Array.from({ length: levels }, () => ({ slots, capacity })) } });
  const wh = await admin('POST', '/api/warehouses', { code: 'MIA', name: 'Almacén Miami' });
  const areaLap = await admin('POST', '/api/areas', { warehouseId: wh.id, code: 'LAP', name: 'Laptops', preferredTypeIds: [type('laptop')] });
  const areaDsk = await admin('POST', '/api/areas', { warehouseId: wh.id, code: 'ESC', name: 'Escritorio', preferredTypeIds: [type('desktop')] });
  const areaMon = await admin('POST', '/api/areas', { warehouseId: wh.id, code: 'MON', name: 'Monitores', preferredTypeIds: [type('monitor')] });
  const areaCmp = await admin('POST', '/api/areas', { warehouseId: wh.id, code: 'COM', name: 'Componentes', preferredTypeIds: [type('hard_drive'), type('memory'), type('generic')] });
  await rack(areaLap.id, 'R01', 3, 4, 12);
  await rack(areaLap.id, 'R02', 3, 4, 12);
  await rack(areaDsk.id, 'R01', 2, 4, 8);
  await rack(areaMon.id, 'R01', 3, 3, 8);
  await rack(areaMon.id, 'R02', 2, 3, 8);
  await rack(areaCmp.id, 'R01', 2, 4, 20);
  const wh2 = await admin('POST', '/api/warehouses', { code: 'HIA', name: 'Depósito Hialeah' });
  const areaGen = await admin('POST', '/api/areas', { warehouseId: wh2.id, code: 'GEN', name: 'General' });
  await rack(areaGen.id, 'R01', 3, 4, 15);
  await rack(areaGen.id, 'R02', 2, 4, 15);

  // =====================================================================================================================
  // 4. Lotes
  // =====================================================================================================================
  const attrText = (label: string, v: string | undefined) => (v ? { [label]: v } : {});
  /** Lo que describe la línea del lote (solo atributos "de línea": marca, modelo, procesador, RAM...). */
  const lineSpecs = (m: Model): Record<string, unknown> => {
    switch (m.type) {
      case 'laptop':
      case 'desktop':
        return { brand: item('brand', m.brand), model: mdl(m.type, m.brand, m.model!), processor: item('processor', m.cpu!), ...(m.gen ? { generation: item('processor_generation', m.gen) } : {}), ram: item('ram_size', m.ram!), storage_size: item('storage_size', m.disk!) };
      case 'monitor':
        return { brand: item('brand', m.brand), model: mdl(m.type, m.brand, m.model!), screen_size: item('screen_size', m.screen!) };
      case 'hard_drive':
        return { brand: item('brand', m.brand), model: mdl(m.type, m.brand, m.model!), storage_type: item('storage_type', m.diskType!), storage_size: item('storage_size', m.disk!) };
      case 'memory':
        return { brand: item('brand', m.brand), ram: item('ram_size', m.ram!), ram_type: item('ram_type', m.ramType!) };
      case 'generic':
        return { description: m.desc!, brand: item('brand', m.brand), model: mdl(m.type, m.brand, m.model!) };
    }
  };

  const usedSerials = new Set<string>();
  const alnum = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
  const serialFor = (m: Model): string => {
    for (;;) {
      let s = m.serial;
      while (s.length < 9 + (m.serial.length > 2 ? 0 : 1)) s += alnum[Math.floor(rnd() * alnum.length)];
      if (!usedSerials.has(s)) { usedSerials.add(s); return s; }
    }
  };

  /** Los datos que el técnico completa al testear un equipo (con variaciones reales: a veces trae más RAM o un disco distinto). */
  const testSpecs = (m: Model): Record<string, unknown> => {
    const s = lineSpecs(m);
    if (m.type === 'laptop' || m.type === 'desktop') {
      if (chance(0.15) && RAM_UP[m.ram!]) s.ram = item('ram_size', RAM_UP[m.ram!]);
      if (chance(0.15) && DISK_UP[m.disk!]) s.storage_size = item('storage_size', DISK_UP[m.disk!]);
      s.storage_type = item('storage_type', m.diskType!);
      if (m.type === 'laptop') {
        s.screen_size = item('screen_size', m.screen!);
        s.battery_health = m.brand === 'Samsung' ? int(40, 80) : int(55, 98);
        s.has_charger = chance(0.75);
      }
    }
    if (m.type === 'monitor') s.resolution = m.res;
    if (m.type === 'memory') s.memory_speed = m.speed;
    return s;
  };

  const gradesFor = (bias: Bias): { cos: string; fun: string } => {
    const cosW: Record<Bias, [string, number][]> = {
      good: [['A', 60], ['B', 35], ['C', 5]],
      mixed: [['A', 30], ['B', 40], ['C', 25], ['D', 5]],
      worn: [['A', 8], ['B', 30], ['C', 42], ['D', 20]],
    };
    const funW: Record<Bias, [string, number][]> = {
      good: [['A', 92], ['B', 8]],
      mixed: [['A', 78], ['B', 12], ['C', 7], ['F', 3]],
      worn: [['A', 55], ['B', 20], ['C', 15], ['F', 10]],
    };
    return { cos: weighted(cosW[bias]), fun: weighted(funW[bias]) };
  };

  interface CreatedLot { id: number; code: string; lineIds: number[]; }

  /** Crea el lote con sus líneas y lo lleva al estado pedido (conteo incluido). */
  async function createLot(o2: { supplier: number; reference: string; notes: string; days: number; totalCost?: number; lines: LinePlan[]; unexpected?: { m: Model; qty: number } }): Promise<CreatedLot> {
    const lot = await admin('POST', '/api/lots', {
      supplierId: o2.supplier, reference: o2.reference, notes: o2.notes, purchaseDate: isoDate(daysAgo(o2.days)), totalCost: o2.totalCost ?? null,
      lines: o2.lines.map((l) => ({ equipmentTypeId: type(l.m.type), specs: lineSpecs(l.m), expectedQty: l.expected })),
    });
    const detail = await admin('GET', `/api/lots/${lot.id}`);
    summary.lots++;
    return { id: lot.id, code: lot.code, lineIds: detail.lines.map((l: any) => l.id) };
  }

  const counts = (lot: CreatedLot, lines: LinePlan[]) => lines.flatMap((l, i) => (l.counted === null ? [] : [{ lineId: lot.lineIds[i], countedQty: l.counted }]));

  const testers = [o.adminUserId, T1, T2];
  let testerTurn = 0;

  /** Registra y testea los equipos de un lote (rotando entre los técnicos). Devuelve los ids de los que quedaron terminados. */
  async function testUnits(lot: CreatedLot, lines: LinePlan[]): Promise<number[]> {
    const done: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const total = l.tested + (l.pending ?? 0);
      for (let n = 0; n < total; n++) {
        const who = testers[testerTurn++ % testers.length];
        const specs = testSpecs(l.m);
        const u = await call(who, 'POST', `/api/lots/${lot.id}/units`, {
          equipmentTypeId: type(l.m.type), lotLineId: lot.lineIds[i], specs, serialNumber: serialFor(l.m),
          notes: chance(0.1) ? pick(NOTES) : undefined,
        });
        summary.units++;
        if (n >= l.tested) continue;   // los "pendientes" se quedan en testeo
        const g = gradesFor(l.bias ?? 'mixed');
        const notes = chance(0.12) ? pick(NOTES) : undefined;
        const fin = await call(who, 'POST', `/api/units/${u.id}/finish-test`, {
          cosmeticGradeId: item('cosmetic_grade', g.cos), functionalGradeId: item('functional_grade', g.fun), specs,
          ...(notes ? { notes } : {}),
        });
        summary.unitsFinished++;
        done.push(fin.id);
      }
    }
    return done;
  }

  // ---------- Lote A: el principal (en testeo, ≈170 equipos) ----------
  log('Lote principal (≈170 equipos, se registran uno a uno; puede tardar unos segundos)...');
  const lotA = await createLot({ supplier: suppliers[0], reference: 'PO-2026-0388', notes: 'Lote de demostración: laptops, desktops, monitores y componentes de un cliente corporativo.', days: 38, totalCost: 19500, lines: MAIN_LINES });
  summary.mainLotCode = lotA.code;
  await admin('PUT', `/api/lots/${lotA.id}/counts`, { counts: counts(lotA, MAIN_LINES) });
  await admin('POST', `/api/lots/${lotA.id}/unexpected-lines`, { equipmentTypeId: type('generic'), specs: { description: DOCKING.desc, brand: item('brand', 'Dell'), model: mdl('generic', 'Dell', DOCKING.model!) }, countedQty: 4, notes: 'No estaban en la factura' });
  await admin('POST', `/api/lots/${lotA.id}/transition`, { action: 'finish_count' });
  const finishedA = await testUnits(lotA, MAIN_LINES);
  // El docking (línea "no esperada"): se testea contra esa línea.
  const detailA = await admin('GET', `/api/lots/${lotA.id}`);
  const dockLine = detailA.lines.find((l: any) => l.isUnexpected);
  for (let n = 0; n < 4; n++) {
    const who = testers[testerTurn++ % testers.length];
    const specs = { description: DOCKING.desc, brand: item('brand', 'Dell'), model: mdl('generic', 'Dell', DOCKING.model!) };
    const u = await call(who, 'POST', `/api/lots/${lotA.id}/units`, { equipmentTypeId: type('generic'), lotLineId: dockLine?.id ?? null, specs, serialNumber: serialFor(DOCKING) });
    summary.units++;
    const g = gradesFor('good');
    const fin = await call(who, 'POST', `/api/units/${u.id}/finish-test`, { cosmeticGradeId: item('cosmetic_grade', g.cos), functionalGradeId: item('functional_grade', g.fun), specs });
    summary.unitsFinished++;
    finishedA.push(fin.id);
  }
  log(`  Lote ${lotA.code}: ${finishedA.length} equipos testeados`);

  // ---------- Lote B: cerrado ----------
  log('Lote cerrado (40 equipos)...');
  const lotB = await createLot({ supplier: suppliers[1], reference: 'PO-2026-0412', notes: 'Lote ya procesado y cerrado; casi todo vendido.', days: 62, totalCost: 5600, lines: LOT_B_LINES });
  await admin('PUT', `/api/lots/${lotB.id}/counts`, { counts: counts(lotB, LOT_B_LINES) });
  await admin('POST', `/api/lots/${lotB.id}/transition`, { action: 'finish_count' });
  const finishedB = await testUnits(lotB, LOT_B_LINES);
  await admin('POST', `/api/lots/${lotB.id}/transition`, { action: 'close' });
  log(`  Lote ${lotB.code}: ${finishedB.length} equipos, cerrado`);

  // ---------- Lote C: contado, sin testear ----------
  const lotC = await createLot({ supplier: suppliers[2], reference: 'PO-2026-0517', notes: 'Recién contado; falta testear.', days: 9, totalCost: 3900, lines: LOT_C_LINES });
  await admin('PUT', `/api/lots/${lotC.id}/counts`, { counts: counts(lotC, LOT_C_LINES) });
  await admin('POST', `/api/lots/${lotC.id}/unexpected-lines`, { equipmentTypeId: type('generic'), specs: { description: 'Cables de poder sueltos' }, countedQty: 25 });
  await admin('POST', `/api/lots/${lotC.id}/transition`, { action: 'finish_count' });

  // ---------- Lote D: recién registrado ----------
  await createLot({ supplier: suppliers[3], reference: 'PO-2026-0530', notes: 'Compra en camino: todavía no llega.', days: 3, totalCost: 12000, lines: LOT_D_LINES });

  // ---------- Lote E: contando ----------
  const lotE = await createLot({ supplier: suppliers[4], reference: 'PO-2026-0524', notes: 'Se está contando en el muelle.', days: 5, lines: LOT_E_LINES });
  await admin('PUT', `/api/lots/${lotE.id}/counts`, { counts: counts(lotE, LOT_E_LINES) });

  // =====================================================================================================================
  // 5. Costos de los lotes
  // =====================================================================================================================
  log('Costos de los lotes...');
  const brandApple = item('brand', 'Apple');
  await admin('PUT', `/api/lots/${lotA.id}/costs`, {
    totalCost: 19500,
    extras: [
      { label: 'Flete marítimo', amount: 650, distribute: true },
      { label: 'Aduana e impuestos', amount: 480, distribute: true },
      { label: 'Mano de obra de testeo', amount: 300, distribute: true },
      { label: 'Seguro de transporte', amount: 120, distribute: false },
    ],
    plan: {
      base: 'equal', qtyBasis: 'auto', auto: true,
      rules: [
        { id: 'apple', name: 'Apple (más valor)', enabled: true, method: 'weight', value: 4, match: { typeIds: [type('laptop')], specs: { brand: brandApple } } },
        { id: 'laptops', name: 'Laptops', enabled: true, method: 'weight', value: 3, match: { typeIds: [type('laptop')] } },
        { id: 'desktops', name: 'Desktops', enabled: true, method: 'weight', value: 1.5, match: { typeIds: [type('desktop')] } },
        { id: 'monitors', name: 'Monitores', enabled: true, method: 'weight', value: 0.7, match: { typeIds: [type('monitor')] } },
        { id: 'drives', name: 'Discos', enabled: true, method: 'weight', value: 0.35, match: { typeIds: [type('hard_drive')] } },
        { id: 'ram', name: 'Memorias', enabled: true, method: 'weight', value: 0.15, match: { typeIds: [type('memory')] } },
        { id: 'dock', name: 'Docking (regalo del proveedor)', enabled: true, method: 'unit_amount', value: 8, match: { typeIds: [type('generic')] } },
      ],
    },
    apply: true,
  });
  await admin('PUT', `/api/lots/${lotB.id}/costs`, {
    totalCost: 5600,
    extras: [{ label: 'Flete terrestre', amount: 280, distribute: true }, { label: 'Manejo en muelle', amount: 90, distribute: false }],
    plan: {
      base: 'equal', qtyBasis: 'auto', auto: true,
      rules: [
        { id: 'laptops', name: 'Laptops', enabled: true, method: 'weight', value: 3, match: { typeIds: [type('laptop')] } },
        { id: 'desktops', name: 'Desktops', enabled: true, method: 'weight', value: 1.4, match: { typeIds: [type('desktop')] } },
        { id: 'drives', name: 'Discos', enabled: true, method: 'weight', value: 0.4, match: { typeIds: [type('hard_drive')] } },
      ],
    },
    apply: true,
  });

  // =====================================================================================================================
  // 6. Precios de lista
  // =====================================================================================================================
  log('Reglas de precio...');
  const funC = item('functional_grade', 'C');
  await admin('PUT', '/api/price-rules', {
    rules: [
      { name: 'Equipos con fallas (grado C)', enabled: true, match: { functionalGradeIds: [funC] }, method: 'markup_pct', value: 15, rounding: 'unit' },
      { name: 'Apple', enabled: true, match: { typeIds: [type('laptop')], specs: { brand: brandApple } }, method: 'markup_pct', value: 45, rounding: 'x99', minPrice: 199 },
      { name: 'Laptops Core i7', enabled: true, match: { typeIds: [type('laptop')], specs: { processor: item('processor', 'Intel Core i7') } }, method: 'markup_pct', value: 40, rounding: 'five' },
      { name: 'Laptops', enabled: true, match: { typeIds: [type('laptop')] }, method: 'markup_pct', value: 35, rounding: 'x99' },
      { name: 'Desktops', enabled: true, match: { typeIds: [type('desktop')] }, method: 'margin_pct', value: 28, rounding: 'five' },
      { name: 'Monitores', enabled: true, match: { typeIds: [type('monitor')] }, method: 'add_amount', value: 25, rounding: 'unit' },
      { name: 'Discos y memorias', enabled: true, match: { typeIds: [type('hard_drive'), type('memory')] }, method: 'markup_pct', value: 70, rounding: 'x99', minPrice: 9.99 },
      { name: 'Otros equipos', enabled: true, match: { typeIds: [type('generic')] }, method: 'fixed', value: 35, rounding: 'none' },
    ],
  });
  await admin('POST', '/api/prices/recalculate', { scope: 'unsold' });
  // Unos cuantos precios fijados a mano (las reglas no los pisan).
  const sampleIds = async (typeKey: string, n: number) =>
    (await admin('GET', `/api/units?statusKey=available&typeId=${type(typeKey)}&pageSize=${n}&sort=oldest`)).items.map((u: any) => u.id as number);
  const manualLaptops = await sampleIds('laptop', 3);
  if (manualLaptops.length) await admin('POST', '/api/units/prices', { unitIds: manualLaptops, mode: 'set', value: 329 });
  const manualMon = (await sampleIds('monitor', 2));
  if (manualMon.length) await admin('POST', '/api/units/prices', { unitIds: manualMon, mode: 'set', value: 79.99 });
  const manualCost = await sampleIds('desktop', 1);
  if (manualCost.length) await admin('POST', '/api/units/costs', { unitIds: manualCost, mode: 'set', value: 95 });

  // =====================================================================================================================
  // 7. Ubicar lo que no quedó ubicado solo
  // =====================================================================================================================
  log('Ubicación de equipos...');
  const availableIds = (await admin('GET', `/api/units?statusKey=available&placed=no&pageSize=1000`)).items.map((u: any) => u.id as number);
  for (let i = 0; i < availableIds.length; i += 200) {
    const chunk = availableIds.slice(i, i + 200);
    const sug = await admin('POST', '/api/locations/suggest', { unitIds: chunk });
    const assignments = sug.items.filter((s: any) => s.slotId).map((s: any) => ({ unitId: s.unitId, slotId: s.slotId }));
    if (assignments.length) await admin('POST', '/api/locations/assign', { assignments });
  }

  // =====================================================================================================================
  // 8. Pedidos de venta
  // =====================================================================================================================
  log('Pedidos y ventas...');
  const cos = (k: string) => item('cosmetic_grade', k);
  const brand = (k: string) => item('brand', k);

  interface OrderLine { type: TypeKey; specs?: Record<string, unknown>; cosmetic?: string[]; functional?: string[]; qty: number; price?: number; notes?: string }
  interface OrderPlan {
    by: number; customer: number; seller?: number | null; notes?: string; days: number;
    lines: OrderLine[];
    adjustments?: { label: string; kind: 'percent' | 'amount'; value: number }[];
    shipping?: { weight: number; length: number; width: number; height: number }[];
    /** Precio total del pedido repartido entre sus equipos. */
    totalPrice?: number;
    end: 'open' | 'completed' | 'cancelled';
    /** No reservar equipos (pedido recién pedido). */
    noFill?: boolean;
  }

  const createOrder = async (p: OrderPlan) => {
    const order = await call(p.by, 'POST', '/api/orders', {
      customerId: p.customer, sellerId: p.seller ?? null, notes: p.notes,
      lines: p.lines.map((l) => ({
        equipmentTypeId: type(l.type), specs: l.specs ?? {}, quantity: l.qty, unitPrice: l.price ?? null, notes: l.notes,
        cosmeticGradeIds: (l.cosmetic ?? []).map(cos), functionalGradeIds: (l.functional ?? []).map((k) => item('functional_grade', k)),
      })),
    });
    if (!p.noFill) {
      const det = await call(p.by, 'GET', `/api/orders/${order.id}`);
      for (const line of det.lines) await call(p.by, 'POST', `/api/orders/${order.id}/lines/${line.id}/fill`);
    }
    if (p.adjustments) await call(p.by, 'PUT', `/api/orders/${order.id}/adjustments`, { adjustments: p.adjustments });
    if (p.shipping) await call(p.by, 'PUT', `/api/orders/${order.id}/shipping`, { weightUnit: 'lb', dimUnit: 'in', packages: p.shipping });
    if (p.totalPrice) await call(p.by, 'POST', `/api/orders/${order.id}/price-plan/apply`, { target: 'total', amount: p.totalPrice, plan: { base: 'equal', qtyBasis: 'auto', auto: true, rules: [] } });
    if (p.end === 'completed') await call(p.by, 'POST', `/api/orders/${order.id}/complete`);
    if (p.end === 'cancelled') await call(p.by, 'POST', `/api/orders/${order.id}/cancel`);
    summary.orders++;
    return { id: order.id as number, days: p.days, end: p.end };
  };

  const dellModel = (m: string, t = 'laptop') => ({ brand: brand('Dell'), model: mdl(t, 'Dell', m) });
  const pkgs = (n: number, w: number) => Array.from({ length: n }, () => ({ weight: w, length: 24, width: 18, height: 14 }));

  const plans: OrderPlan[] = [
    // --- Cancelados y devueltos al inventario (van primero: sus equipos vuelven a estar disponibles) ---
    { by: V1, customer: cCaribe, seller: sellerCarla, days: 24, end: 'cancelled', notes: 'El cliente no consiguió el financiamiento.', lines: [{ type: 'laptop', specs: dellModel('Latitude 7490'), qty: 3, price: 295 }] },
    { by: o.adminUserId, customer: cGuate, seller: sellerSofia, days: 22, end: 'cancelled', notes: 'Cancelado por cambio de presupuesto.', lines: [{ type: 'monitor', qty: 10 }] },
    // --- Completados ---
    {
      by: V1, customer: cCaribe, seller: sellerCarla, days: 21, end: 'completed', notes: 'Pedido recurrente de Caribe; pagan por transferencia.',
      lines: [{ type: 'laptop', specs: dellModel('Latitude 5490'), qty: 6, price: 265 }, { type: 'laptop', specs: { brand: brand('HP') }, qty: 4 }],
      adjustments: [{ label: 'Descuento por volumen', kind: 'percent', value: -3 }, { label: 'Flete', kind: 'amount', value: 120 }],
      shipping: pkgs(2, 48),
    },
    {
      by: V1, customer: cColombia, seller: sellerCarla, days: 19, end: 'completed',
      lines: [{ type: 'laptop', specs: { brand: brand('Lenovo') }, qty: 10 }, { type: 'monitor', specs: dellModel('P2419H', 'monitor'), qty: 8, price: 95 }],
      adjustments: [{ label: 'Manejo y embalaje', kind: 'amount', value: 75 }],
      shipping: pkgs(3, 55),
    },
    {
      by: V2, customer: cGuate, seller: sellerDiego, days: 17, end: 'completed', notes: 'Se pactó el total del pedido.',
      lines: [{ type: 'desktop', qty: 8 }], totalPrice: 1400, shipping: pkgs(2, 62),
    },
    {
      by: o.adminUserId, customer: cMiami, seller: null, days: 15, end: 'completed', notes: 'Oficina nueva en Brickell.',
      lines: [{ type: 'laptop', specs: { brand: brand('HP'), model: mdl('laptop', 'HP', 'EliteBook 840 G5') }, qty: 4, price: 310 }, { type: 'monitor', specs: { brand: brand('Lenovo') }, qty: 4, price: 88 }],
    },
    {
      by: V2, customer: cMexico, seller: sellerDiego, days: 13, end: 'completed',
      lines: [{ type: 'memory', specs: { brand: brand('Kingston') }, qty: 10, price: 24 }, { type: 'hard_drive', specs: { storage_type: item('storage_type', 'SSD SATA') }, qty: 6 }],
    },
    {
      by: V1, customer: cPeru, seller: sellerCarla, days: 11, end: 'completed', notes: 'Lote B: laptops y desktops.',
      lines: [{ type: 'laptop', specs: dellModel('Latitude 5480'), qty: 12 }, { type: 'laptop', specs: { brand: brand('HP'), model: mdl('laptop', 'HP', 'EliteBook 820 G3') }, qty: 8 }],
      adjustments: [{ label: 'Descuento cliente frecuente', kind: 'percent', value: -2 }],
      shipping: pkgs(3, 50),
    },
    {
      by: V2, customer: cJamaica, seller: sellerDiego, days: 9, end: 'completed',
      lines: [{ type: 'desktop', specs: { brand: brand('Dell'), model: mdl('desktop', 'Dell', 'OptiPlex 3020 SFF') }, qty: 8 }, { type: 'hard_drive', specs: { brand: brand('Samsung'), model: mdl('hard_drive', 'Samsung', '850 EVO') }, qty: 6 }],
      shipping: pkgs(2, 58),
    },
    // --- Abiertos con equipos reservados ---
    {
      by: V1, customer: cPanama, seller: sellerCarla, days: 7, end: 'open', notes: 'Esperan confirmación de pago.',
      lines: [{ type: 'laptop', specs: dellModel('Latitude 7490'), qty: 4 }, { type: 'monitor', specs: { brand: brand('LG') }, qty: 4 }],
    },
    {
      by: V2, customer: cChile, seller: sellerDiego, days: 5, end: 'open', notes: 'Piden más MacBook de las que hay: faltan equipos.',
      lines: [{ type: 'laptop', specs: { brand: brandApple }, qty: 8, price: 449 }, { type: 'memory', specs: { brand: brand('Crucial') }, qty: 8 }],
    },
    {
      by: o.adminUserId, customer: cEscuelas, seller: sellerSofia, days: 4, end: 'open', notes: 'Donación con descuento institucional.',
      lines: [{ type: 'laptop', specs: { brand: brand('Samsung') }, qty: 4 }, { type: 'desktop', specs: { brand: brand('Lenovo') }, qty: 4 }],
      adjustments: [{ label: 'Descuento institucional', kind: 'percent', value: -5 }],
    },
    // --- Abierto sin reservar todavía ---
    { by: V1, customer: cMexico, seller: sellerCarla, days: 1, end: 'open', noFill: true, notes: 'Cotización aceptada; falta reservar equipos.', lines: [{ type: 'laptop', specs: { brand: brand('Lenovo'), model: mdl('laptop', 'Lenovo', 'ThinkPad T470') }, qty: 5, price: 255 }] },
  ];

  const orderIds: { id: number; days: number; end: string }[] = [];
  for (const p of plans) orderIds.push(await createOrder(p));

  // Pedido armado escaneando códigos (como en el rack).
  {
    const scan = await createOrder({ by: V2, customer: cColombia, seller: sellerDiego, days: 2, end: 'open', noFill: true, notes: 'Se van agregando equipos escaneando el código.', lines: [{ type: 'laptop', specs: { brand: brand('HP'), model: mdl('laptop', 'HP', 'EliteBook 840 G5') }, qty: 3 }] });
    const codes = (await admin('GET', `/api/units?statusKey=available&typeId=${type('laptop')}&specs=${encodeURIComponent(JSON.stringify({ brand: brand('HP'), model: mdl('laptop', 'HP', 'EliteBook 840 G5') }))}&pageSize=3&sort=oldest`)).items.map((u: any) => u.code as string);
    if (codes.length) await call(V2, 'POST', `/api/orders/${scan.id}/pick`, { codes });
    orderIds.push(scan);
  }

  // Ventas rápidas (sin pedido)
  const quick = async (by: number, typeKey: TypeKey, n: number, extra: { specs?: Record<string, unknown>; customerId?: number; sellerId?: number; unitPrice?: number; notes?: string; days: number }) => {
    const q = new URLSearchParams({ statusKey: 'available', typeId: String(type(typeKey)), pageSize: String(n), sort: 'oldest' });
    if (extra.specs) q.set('specs', JSON.stringify(extra.specs));
    const ids = (await admin('GET', `/api/units?${q}`)).items.map((u: any) => u.id as number);
    if (!ids.length) return;
    const r = await call(by, 'POST', '/api/quick-sales', { unitIds: ids, customerId: extra.customerId, sellerId: extra.sellerId, unitPrice: extra.unitPrice, notes: extra.notes });
    summary.quickSales++;
    orderIds.push({ id: r.id, days: extra.days, end: 'completed' });
  };
  await quick(o.adminUserId, 'laptop', 2, { specs: { brand: brand('Dell') }, days: 9, notes: 'Cliente de mostrador' });
  await quick(V1, 'desktop', 1, { customerId: cMiami, sellerId: sellerCarla, unitPrice: 150, days: 8 });
  await quick(V2, 'monitor', 3, { specs: { brand: brand('Samsung') }, sellerId: sellerDiego, days: 6, notes: 'Venta en el almacén' });
  await quick(o.adminUserId, 'memory', 4, { specs: { brand: brand('Kingston') }, days: 3 });
  await quick(V1, 'hard_drive', 2, { specs: { brand: brand('Seagate') }, customerId: cJamaica, days: 2 });

  // =====================================================================================================================
  // 9. Activos de la empresa
  // =====================================================================================================================
  log('Activos de la empresa...');
  const assetStatus = (k: string) => sys('asset_status', k);
  const gen = (desc: string, extra: Record<string, unknown> = {}) => ({ description: desc, ...extra });
  interface AssetPlan { type: TypeKey; name: string; specs: Record<string, unknown>; status: string; assignedTo?: string; location?: string; acquired: string; serial?: string; qty?: number; notes?: string }
  const assets: AssetPlan[] = [
    { type: 'laptop', name: 'Laptop de Carla (Ventas)', specs: { brand: brand('Dell'), model: mdl('laptop', 'Dell', 'Latitude 7490'), ram: item('ram_size', '16') }, status: 'in_use', assignedTo: 'Carla Méndez', location: 'Oficina - Ventas', acquired: '2024-03-12', serial: 'AST-DL-7490-01' },
    { type: 'laptop', name: 'Laptop de Diego (Ventas)', specs: { brand: brand('HP'), model: mdl('laptop', 'HP', 'EliteBook 840 G5'), ram: item('ram_size', '8') }, status: 'in_use', assignedTo: 'Diego Ramírez', location: 'Oficina - Ventas', acquired: '2024-05-20', serial: 'AST-HP-840-02' },
    { type: 'laptop', name: 'Laptop de gerencia', specs: { brand: brand('Lenovo'), model: mdl('laptop', 'Lenovo', 'ThinkPad T480'), ram: item('ram_size', '16') }, status: 'in_use', assignedTo: 'Gerencia', location: 'Oficina - Gerencia', acquired: '2023-11-02', serial: 'AST-LN-T480-03' },
    { type: 'laptop', name: 'Laptop de pruebas (vieja)', specs: { brand: brand('Toshiba'), model: mdl('laptop', 'Toshiba', 'Satellite C55-B') }, status: 'retired', location: 'Depósito', acquired: '2019-08-15', serial: 'AST-TS-C55-04', notes: 'Dada de baja: pantalla dañada' },
    { type: 'desktop', name: 'PC de recepción', specs: { brand: brand('Dell'), model: mdl('desktop', 'Dell', 'OptiPlex 7050 SFF'), ram: item('ram_size', '8') }, status: 'in_use', assignedTo: 'Recepción', location: 'Recepción', acquired: '2023-02-01', serial: 'AST-DL-7050-05' },
    { type: 'desktop', name: 'Servidor de archivos', specs: { brand: brand('Lenovo'), model: mdl('desktop', 'Lenovo', 'ThinkCentre M920s'), ram: item('ram_size', '32') }, status: 'in_use', location: 'Cuarto de servidores', acquired: '2022-10-10', serial: 'AST-LN-M920-06' },
    { type: 'monitor', name: 'Monitor de estación de testeo', specs: { brand: brand('Dell'), model: mdl('monitor', 'Dell', 'P2419H'), screen_size: item('screen_size', '23.8') }, status: 'in_use', location: 'Área de testeo', acquired: '2024-01-15', qty: 4 },
    { type: 'monitor', name: 'Pantalla de sala de reuniones', specs: { brand: brand('LG'), model: mdl('monitor', 'LG', '27MK430H-B'), screen_size: item('screen_size', '27') }, status: 'stored', location: 'Depósito', acquired: '2024-06-30', serial: 'AST-LG-27-08' },
    { type: 'hard_drive', name: 'Disco de respaldo', specs: { brand: brand('Seagate'), model: mdl('hard_drive', 'Seagate', 'Barracuda ST2000DM008'), storage_size: item('storage_size', '2TB') }, status: 'stored', location: 'Cuarto de servidores', acquired: '2023-07-07', serial: 'AST-SG-2TB-09' },
    { type: 'memory', name: 'Memorias de repuesto para testeo', specs: { brand: brand('Kingston'), ram: item('ram_size', '8'), ram_type: item('ram_type', 'DDR4') }, status: 'stored', location: 'Área de testeo', acquired: '2024-02-14', qty: 2 },
    { type: 'generic', name: 'Impresora de etiquetas Zebra ZD420', specs: gen('Impresora térmica de etiquetas'), status: 'in_use', location: 'Almacén', acquired: '2024-04-04', serial: 'AST-ZB-ZD420-11' },
    { type: 'generic', name: 'Escáner de códigos Zebra DS2208', specs: gen('Escáner de códigos de barras USB'), status: 'in_use', location: 'Almacén', acquired: '2024-04-04', qty: 2 },
    { type: 'generic', name: 'Estación de aire caliente', specs: gen('Estación de soldadura por aire caliente'), status: 'repair', assignedTo: 'Luis Ortega', location: 'Área de testeo', acquired: '2022-05-19', serial: 'AST-SD-HOT-13', notes: 'Se le dañó la resistencia; espera repuesto' },
    { type: 'generic', name: 'Multímetro Fluke 117', specs: gen('Multímetro digital'), status: 'in_use', assignedTo: 'Marta Suárez', location: 'Área de testeo', acquired: '2023-09-21', serial: 'AST-FL-117-14' },
    { type: 'generic', name: 'Kit de destornilladores iFixit', specs: gen('Kit de reparación de electrónica'), status: 'in_use', assignedTo: 'Luis Ortega', location: 'Área de testeo', acquired: '2023-09-21', qty: 3 },
    { type: 'generic', name: 'Carrito de transporte', specs: gen('Carrito plegable para mover cajas'), status: 'stored', location: 'Almacén', acquired: '2021-12-01', notes: 'De reserva' },
  ];
  for (const a of assets) {
    const r = await admin('POST', '/api/assets', {
      equipmentTypeId: type(a.type), name: a.name, specs: a.specs, statusId: assetStatus(a.status), assignedTo: a.assignedTo, location: a.location,
      acquiredAt: a.acquired, serialNumber: a.serial, quantity: a.qty ?? 1, notes: a.notes,
    });
    summary.assets += r.items.length;
  }

  // =====================================================================================================================
  // 10. Fechas repartidas en el tiempo (para que los reportes y gráficos tengan historia)
  // =====================================================================================================================
  log('Repartiendo las fechas en el tiempo...');
  try {
    await withTenant(o.companyId, async (db) => {
      const lotAges: [CreatedLot, number, number | null][] = [[lotA, 38, null], [lotB, 62, 33], [lotC, 9, null], [lotE, 5, null]];
      for (const [lot, age, closedAfter] of lotAges) {
        await db.query(
          `UPDATE lots SET created_at = $2::timestamptz,
                  counted_at = CASE WHEN counted_at IS NULL THEN NULL ELSE $2::timestamptz + interval '1 day' END,
                  closed_at = CASE WHEN closed_at IS NULL THEN NULL ELSE $2::timestamptz + make_interval(days => $3::int) END
            WHERE id = $1`, [lot.id, daysAgo(age).toISOString(), closedAfter ?? 0]);
        // Los equipos se van testeando a lo largo del tiempo (los ya vendidos, en los primeros días; el resto, hasta hoy o hasta el cierre).
        const spread = closedAfter !== null ? Math.max(1, closedAfter - 4) : Math.max(1, age - 3);
        await db.query(
          `UPDATE units u SET tested_at = CASE WHEN u.tested_at IS NULL THEN NULL
                  ELSE $2::timestamptz + interval '2 days' + random() * make_interval(days => CASE WHEN st.system_key = 'sold' THEN 10 ELSE $3::int END) END
             FROM catalog_items st WHERE st.id = u.status_id AND u.lot_id = $1`, [lot.id, daysAgo(age).toISOString(), spread]);
        await db.query(
          `UPDATE units SET created_at = COALESCE(tested_at - random() * interval '3 hours',
                  $2::timestamptz + interval '2 days' + random() * make_interval(days => $3::int))
            WHERE lot_id = $1`, [lot.id, daysAgo(age).toISOString(), spread]);
      }
      for (const od of orderIds) {
        await db.query(
          `UPDATE sales_orders SET created_at = $2::timestamptz - interval '1 day',
                  completed_at = CASE WHEN completed_at IS NULL THEN NULL ELSE $2::timestamptz END,
                  cancelled_at = CASE WHEN cancelled_at IS NULL THEN NULL ELSE $2::timestamptz END
            WHERE id = $1`, [od.id, daysAgo(od.days).toISOString()]);
      }
    });
  } catch (e: any) {
    log(`  (No se pudieron repartir las fechas: ${e.message})`);
  }

  summary.unitsAvailable = (await admin('GET', `/api/units?statusKey=available&pageSize=1`)).total;
  return summary;
}
