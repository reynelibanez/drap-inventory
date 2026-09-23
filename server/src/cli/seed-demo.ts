/**
 * Carga datos de demostración en una empresa para probar el sistema sin escribir todo a mano:
 * usuarios de prueba, proveedores, clientes, vendedores, almacenes con racks, 5 lotes (uno en cada estado, el principal con ≈170 equipos
 * variados), costos, precios, pedidos en todos los estados, ventas rápidas y activos de la empresa.
 *
 * Uso:  npm run db:seed-demo                 (primera empresa)
 *       npm run db:seed-demo -- --company refurbiz
 *       npm run db:seed-demo -- --force      (cargarla aunque la empresa ya tenga lotes)
 * Usa la API real (mismas reglas y validaciones que la pantalla), así que también sirve de prueba.
 * Ver services/demoData.ts.
 */
import { buildApp } from '../app.js';
import { pool, withGlobal } from '../db.js';
import { syncPermissions } from '../permissions.js';
import { loadDemoData } from '../services/demoData.js';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith('--')) args.set(process.argv[i].slice(2), process.argv[i + 1]?.startsWith('--') ? '' : (process.argv[++i] ?? ''));
}

async function main() {
  const app = await buildApp({ logger: false });
  await withGlobal((db) => syncPermissions(db));
  await app.ready();

  const target = await withGlobal(async (db) => {
    const slug = args.get('company');
    const company = slug
      ? await db.opt<{ id: number; name: string }>('SELECT id, name FROM companies WHERE slug = $1', [slug])
      : await db.opt<{ id: number; name: string }>('SELECT id, name FROM companies ORDER BY id LIMIT 1');
    if (!company) throw new Error('No hay ninguna empresa. Ejecuta primero:  npm run create-admin');
    const admin = await db.opt<{ user_id: number }>(
      'SELECT user_id FROM memberships WHERE company_id = $1 AND is_company_admin AND is_active ORDER BY id LIMIT 1', [company.id]);
    if (!admin) throw new Error('La empresa no tiene un administrador activo.');
    return { company, userId: admin.user_id };
  });

  const token = app.jwt.sign({ sub: target.userId, cid: target.company.id }, { expiresIn: '10m' });
  const existing = await app.inject({ method: 'GET', url: '/api/lots', headers: { authorization: `Bearer ${token}` } });
  const lots = JSON.parse(existing.body);
  if ((lots.items?.length ?? lots.total ?? 0) > 0 && !args.has('force')) {
    console.log(`La empresa "${target.company.name}" ya tiene lotes; no se cargan datos de demostración (usa --force para cargarlos igual).`);
    await app.close(); await pool.end(); return;
  }

  console.log(`Cargando demostración en "${target.company.name}"... (tarda unos segundos)`);
  const t0 = Date.now();
  const s = await loadDemoData(app, { companyId: target.company.id, adminUserId: target.userId, log: (m) => console.log('  ' + m) });
  const secs = Math.round((Date.now() - t0) / 1000);

  console.log(`\nListo en ${secs} s:`);
  console.log(`  ${s.lots} lotes (principal: ${s.mainLotCode}) · ${s.units} equipos registrados, ${s.unitsFinished} testeados, ${s.unitsAvailable} disponibles`);
  console.log(`  ${s.orders} pedidos + ${s.quickSales} ventas rápidas · ${s.customers} clientes · ${s.suppliers} proveedores · ${s.sellers} vendedores · ${s.assets} activos`);
  console.log('\nUsuarios de demostración (te piden cambiar la contraseña al entrar la primera vez):');
  for (const u of s.users) console.log(`  ${u.username.padEnd(11)} ${u.role.padEnd(14)} ${u.fullName}${u.created ? '' : '   (ya existía: su contraseña no cambió)'}`);
  console.log(`  Contraseña inicial: ${s.password}`);
  console.log('  Bórralos o desactívalos (Equipo → Usuarios) cuando termines de probar.');
  await app.close();
  await pool.end();
}

main().catch(async (e) => { console.error('\nERROR:', e.message ?? e); await pool.end().catch(() => {}); process.exit(1); });
