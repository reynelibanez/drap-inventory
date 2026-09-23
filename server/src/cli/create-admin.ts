/**
 * Crea al administrador de plataforma y (opcionalmente) la primera empresa con sus catálogos.
 * Uso interactivo:  npm run create-admin
 * Sin preguntas:    npm run create-admin -- --username admin --name "Nombre" --password "..." --company "Refurbiz" --lang es
 */
import { createInterface } from 'node:readline';
import { pool, withGlobal } from '../db.js';
import { hashPassword, passwordProblem } from '../auth/password.js';
import { syncPermissions } from '../permissions.js';
import { createCompanyWithAdmin } from '../services/companies.js';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args.set(a.slice(2), process.argv[i + 1]?.startsWith('--') || process.argv[i + 1] === undefined ? '' : process.argv[++i]);
}

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
let muted = false;
(rl as any)._writeToOutput = function (s: string) { if (!muted || s.includes('\n')) (rl as any).output.write(s); };

const ask = (q: string, def?: string, secret = false) => new Promise<string>((resolve) => {
  rl.question(`${q}${def ? ` [${def}]` : ''}: `, (a) => { muted = false; if (secret) console.log(); resolve(a.trim() || def || ''); });
  muted = secret;
});

async function main() {
  console.log('\n=== Configuración inicial de DRAP Inventory ===\n');
  const username = args.get('username') || (await ask('Usuario (para iniciar sesión)', 'admin'));
  const fullName = args.get('name') || (await ask('Nombre completo'));
  let password = args.get('password') || '';
  while (!password || passwordProblem(password)) {
    password = await ask('Contraseña (mínimo 8 caracteres)', undefined, true);
    if (passwordProblem(password)) console.log('  La contraseña es demasiado corta.');
  }
  const companyName = args.get('company') ?? (await ask('Nombre de la primera empresa (deja vacío para omitir)', 'Refurbiz'));
  const lang = (args.get('lang') || (companyName ? await ask('Idioma por defecto de la empresa (es/en)', 'es') : 'es')) as 'es' | 'en';
  rl.close();

  await withGlobal((db) => syncPermissions(db));
  const result = await withGlobal(async (db) => {
    let user = await db.opt<{ id: number }>('SELECT id FROM users WHERE lower(username) = lower($1)', [username]);
    // El administrador principal es único: si ya existe otro, no se crea uno nuevo.
    const owner = await db.opt<{ id: number; username: string }>('SELECT id, username FROM users WHERE is_platform_admin');
    if (owner && owner.id !== user?.id) throw new Error(`Ya existe un administrador principal (${owner.username}). Solo puede haber uno.`);
    if (user) {
      await db.query('UPDATE users SET is_platform_admin = true, password_hash = $2, must_change_password = false WHERE id = $1', [user.id, await hashPassword(password)]);
    } else {
      user = await db.one<{ id: number }>(
        `INSERT INTO users (username, full_name, password_hash, is_platform_admin) VALUES ($1,$2,$3,true) RETURNING id`,
        [username, fullName || username, await hashPassword(password)]);
    }
    let company: { id: number; slug: string } | null = null;
    if (companyName) {
      company = await createCompanyWithAdmin(db, {
        name: companyName, defaultLanguage: lang === 'en' ? 'en' : 'es', currency: 'USD', timezone: 'America/New_York',
        admin: { existingUserId: user.id },
      });
    }
    return { userId: user.id, company };
  });
  console.log(`\nListo. Usuario administrador: ${username}`);
  if (result.company) console.log(`Empresa creada: ${companyName} (${result.company.slug})`);
  console.log('Ya puedes iniciar el sistema (start.bat / iniciar.bat, o: npm start).\n');
  await pool.end();
}
main().catch(async (e) => { console.error('\nERROR:', e.message ?? e); await pool.end(); process.exit(1); });
