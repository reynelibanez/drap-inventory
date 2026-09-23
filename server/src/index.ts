import { buildApp } from './app.js';
import { config } from './config.js';
import { pool, withGlobal } from './db.js';
import { syncPermissions } from './permissions.js';
import { applyPendingMigrations, ensureCompanyDefaults } from './services/startup.js';
import { startPushDispatcher } from './services/notifications.js';
import { startSweeper } from './services/sweeper.js';
import { ensureTlsCert } from './services/tls.js';

async function main() {
  // Certificados para HTTPS (con una autoridad local propia, ver services/tls.ts): se calculan antes
  // de armar la app para que el enlace de descarga de la CA (/ca.crt) también esté en el HTTP normal.
  // Es "mejor esfuerzo": si algo falla, el sistema sigue funcionando por HTTP igual.
  let tls: { key: string; cert: string; caCert: string; ips: string[] } | null = null;
  let tlsError: unknown = null;
  if (config.https.enabled) {
    try { tls = await ensureTlsCert(); } catch (err) { tlsError = err; }
  }

  const app = await buildApp({ caCert: tls?.caCert });
  if (tlsError) app.log.warn({ err: tlsError }, 'No se pudo preparar el certificado HTTPS; el sistema sigue funcionando por HTTP normalmente.');
  await applyPendingMigrations(app.log);
  // El catálogo de funciones (permisos) vive en el código y se sincroniza con la base en cada arranque.
  await withGlobal((db) => syncPermissions(db));
  await ensureCompanyDefaults();
  const stopSweeper = startSweeper(app.log);
  const stopPush = startPushDispatcher(app.log);

  let httpsApp: Awaited<ReturnType<typeof buildApp>> | null = null;
  const shutdown = async (signal: string) => {
    app.log.info(`${signal}: cerrando...`);
    stopSweeper();
    stopPush();
    await app.close();
    if (httpsApp) await httpsApp.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.port, host: config.host });

  // Además del HTTP normal, se sirve por HTTPS: el navegador exige HTTPS (o "localhost") para permitir
  // notificaciones push y, para poder instalar la app, además exige que el certificado sea de confianza.
  if (tls) {
    try {
      httpsApp = await buildApp({ https: { key: tls.key, cert: tls.cert }, caCert: tls.caCert });
      await httpsApp.listen({ port: config.https.port, host: config.host });
      const portSuffix = config.https.port === 443 ? '' : `:${config.https.port}`;
      const host = tls.ips[0] ?? 'localhost';
      app.log.info(
        `HTTPS disponible (necesario para notificaciones push fuera de esta PC, p. ej. desde el celular):\n` +
        tls.ips.map((ip) => `  https://${ip}${portSuffix}`).join('\n') +
        `\n\n  Para que el navegador confíe sin avisos y se pueda INSTALAR LA APP, en cada dispositivo se ` +
        `entra una vez (celular, otra PC) a:\n  http://${host}:${config.port}/ca.crt\n` +
        `  y se instala/confía en ese certificado (una vez por dispositivo).\n` +
        `  Sin ese paso, https también funciona, pero el navegador avisa "conexión no privada" cada vez ` +
        `y no ofrece instalar la app.`,
      );
    } catch (err) {
      app.log.warn({ err }, 'No se pudo iniciar HTTPS; el sistema sigue funcionando por HTTP normalmente.');
    }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
