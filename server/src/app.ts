import Fastify, { type FastifyError } from 'fastify';
import compress from '@fastify/compress';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ZodError } from 'zod';
import { config } from './config.js';
import { pool } from './db.js';
import { AppError, mapDbError } from './errors.js';
import { adminRoutes } from './modules/admin.js';
import { assetRoutes } from './modules/assets.js';
import { billingRoutes, stripeWebhookRoutes } from './modules/billing.js';
import { dashboardRoutes } from './modules/dashboard.js';
import { authRoutes } from './modules/auth.js';
import { catalogRoutes } from './modules/catalogs.js';
import { costRoutes } from './modules/costs.js';
import { documentRoutes } from './modules/documents.js';
import { importRoutes } from './modules/imports.js';
import { importTechRoutes } from './modules/importsTech.js';
import { labelRoutes } from './modules/labels.js';
import { notificationRoutes } from './modules/notifications.js';
import { locationRoutes } from './modules/locations.js';
import { lotRoutes } from './modules/lots.js';
import { partnerRoutes } from './modules/partners.js';
import { platformRoutes } from './modules/platform.js';
import { priceRoutes } from './modules/prices.js';
import { reportRoutes } from './modules/reports.js';
import { salesRoutes } from './modules/sales.js';
import { teamRoutes } from './modules/team.js';
import { unitRoutes } from './modules/units.js';

export async function buildApp(opts: { logger?: boolean; https?: { key: string; cert: string }; caCert?: string } = {}) {
  const app = Fastify({
    logger: opts.logger ?? true,
    trustProxy: true,           // detrás de Caddy/Nginx en la VPS
    bodyLimit: 2 * 1024 * 1024,
    ...(opts.https ? { https: opts.https } : {}),
  });

  await app.register(cookie);
  await app.register(jwt, { secret: config.jwtSecret });
  await app.register(rateLimit, { global: false });
  if (config.corsOrigin) await app.register(cors, { origin: config.corsOrigin, credentials: true });
  // Comprime las respuestas (json y la interfaz compilada) cuando el navegador lo acepta. Ya lo hace Caddy
  // delante del contenedor en la VPS, pero esto cubre igual la instalación manual (sin Caddy) y la PC/LAN.
  await app.register(compress, { global: true, encodings: ['br', 'gzip', 'deflate'] });

  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, params: err.params } });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: { code: 'validation', params: { issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } },
      });
    }
    const mapped = mapDbError(err);
    if (mapped) {
      if (mapped.status >= 500) req.log.warn({ err }, 'db retryable');
      return reply.status(mapped.status).send({ error: { code: mapped.code, params: mapped.params } });
    }
    const fe = err as FastifyError;
    if (fe.statusCode && fe.statusCode < 500) {
      return reply.status(fe.statusCode).send({ error: { code: fe.statusCode === 429 ? 'too_many_requests' : 'bad_request', params: {} } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'internal', params: {} } });
  });

  app.get('/api/health', async () => {
    await pool.query('SELECT 1');
    return { ok: true };
  });

  // Certificado de la autoridad local (CA) que firma el de este servidor: se descarga sin avisos
  // (incluso por http normal) para marcarla como confiable una vez en cada dispositivo, y así dejar
  // de ver "conexión no privada" en https y habilitar instalar la app. No es sensible: es la parte
  // pública, nunca su llave.
  if (opts.caCert) {
    const caCert = opts.caCert;
    app.get('/ca.crt', async (_req, reply) => {
      reply.header('Content-Type', 'application/x-x509-ca-cert');
      reply.header('Content-Disposition', 'attachment; filename="drap-inventory-ca.crt"');
      return caCert;
    });
  }

  // Aislado en su propio contexto: usa cuerpo crudo para verificar la firma de Stripe, sin afectar al resto.
  await app.register(stripeWebhookRoutes);

  await app.register(authRoutes);
  await app.register(platformRoutes);
  await app.register(billingRoutes);
  await app.register(teamRoutes);
  await app.register(catalogRoutes);
  await app.register(partnerRoutes);
  await app.register(lotRoutes);
  await app.register(importRoutes);
  await app.register(importTechRoutes);
  await app.register(unitRoutes);
  await app.register(costRoutes);
  await app.register(priceRoutes);
  await app.register(assetRoutes);
  await app.register(locationRoutes);
  await app.register(salesRoutes);
  await app.register(labelRoutes);
  await app.register(documentRoutes);
  await app.register(adminRoutes);
  await app.register(dashboardRoutes);
  await app.register(reportRoutes);
  await app.register(notificationRoutes);

  // La interfaz compilada (React) se sirve desde el mismo proceso: en la VPS es un solo servicio.
  const notFoundApi = { error: { code: 'not_found', params: {} } };
  if (existsSync(resolve(config.webDist, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: config.webDist,
      setHeaders: (reply, path) => {
        // Los archivos con hash en /assets pueden cachearse para siempre; index.html nunca.
        // Además, el service worker y el manifiesto nunca se cachean para que las actualizaciones lleguen enseguida.
        reply.header('cache-control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
        if (path.endsWith('/sw.js')) reply.header('service-worker-allowed', '/');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send(notFoundApi);
      return reply.header('cache-control', 'no-cache').sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.status(404).send(notFoundApi));
  }

  return app;
}
