import { config as loadEnv } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
/** Raíz del repositorio (server/src o server/dist → ../..). */
export const ROOT_DIR = resolve(here, '..', '..');
export const SERVER_DIR = resolve(here, '..');

const envFile = resolve(ROOT_DIR, '.env');
if (existsSync(envFile)) loadEnv({ path: envFile, quiet: true });

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== '') return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Falta la variable de entorno ${name}. Revisa tu archivo .env`);
}

const isProd = process.env.NODE_ENV === 'production';

let jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  if (isProd) throw new Error('JWT_SECRET es obligatorio en producción');
  // En desarrollo se genera uno por arranque (las sesiones se cierran al reiniciar).
  jwtSecret = randomBytes(32).toString('hex');
}

export const config = {
  isProd,
  port: Number(env('PORT', '3000')),
  host: env('HOST', '0.0.0.0'),
  /** Además de PORT (http), se sirve por HTTPS con un certificado propio de esta PC (necesario para
   * notificaciones push fuera de "localhost", p. ej. desde el celular en la misma red). Puerto 443
   * (el estándar de https, sin necesitar escribirlo en la dirección); en Windows no hace falta ser
   * administrador para usarlo. Se puede apagar con HTTPS_ENABLED=false o cambiar con HTTPS_PORT; si
   * algo falla al generarlo o el puerto ya está ocupado, el sistema sigue funcionando por HTTP igual. */
  https: {
    enabled: env('HTTPS_ENABLED', 'true') === 'true',
    port: Number(env('HTTPS_PORT', '443')),
  },
  jwtSecret,
  accessTokenMinutes: Number(env('ACCESS_TOKEN_MINUTES', '30')),
  refreshTokenDays: Number(env('REFRESH_TOKEN_DAYS', '14')),
  /** true cuando se sirve por HTTPS (VPS con dominio). */
  cookieSecure: env('COOKIE_SECURE', isProd ? 'true' : 'false') === 'true',
  /** Solo para desarrollo con Vite en otro puerto. */
  corsOrigin: process.env.CORS_ORIGIN || (isProd ? '' : 'http://localhost:5173'),
  webDist: resolve(ROOT_DIR, env('WEB_DIST', 'web/dist')),
  db: {
    host: env('DB_HOST', 'localhost'),
    port: Number(env('DB_PORT', '5432')),
    database: env('DB_NAME', 'refurbiz'),
    /** Usuario con el que corre la app (SIN privilegios de superusuario, para que RLS aplique). */
    appUser: env('DB_APP_USER', 'refurbiz_app'),
    appPassword: env('DB_APP_PASSWORD', 'refurbiz_app_dev'),
    /** Usuario administrador (solo para crear la base y aplicar migraciones). */
    adminUser: env('DB_ADMIN_USER', 'postgres'),
    adminPassword: process.env.DB_ADMIN_PASSWORD ?? '',
    ssl: env('DB_SSL', 'false') === 'true',
  },
  stripe: {
    /** Clave secreta (sk_...). Vacía = Stripe no está configurado (checkout/portal quedan deshabilitados). */
    secretKey: process.env.STRIPE_SECRET_KEY ?? '',
    /** Clave publicable (pk_...), informativa para el frontend. */
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY ?? '',
    /** Firma para validar los webhooks (whsec_...); se obtiene al crear el endpoint en Stripe. */
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
    /** URL pública de la app (para volver del Checkout/Portal de Stripe). Sin barra final. */
    appUrl: (process.env.APP_URL ?? 'http://localhost:5173').replace(/\/+$/, ''),
  },
} as const;

export type AppLanguage = 'es' | 'en';
export const LANGUAGES: AppLanguage[] = ['es', 'en'];
