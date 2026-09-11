import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';

import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';

import { registerCartRoutes } from './modules/cart/cart-routes.js';
import { CartService } from './modules/cart/cart-service.js';
import { registerCatalogRoutes } from './modules/catalog/catalog-routes.js';
import { CatalogRepository } from './modules/catalog/catalog-repository.js';
import { registerCheckoutRoutes } from './modules/checkout/checkout-routes.js';
import { CheckoutService } from './modules/checkout/checkout-service.js';
import { registerIdentityRoutes } from './modules/identity/identity-routes.js';
import { IdentityService } from './modules/identity/identity-service.js';
import { registerOrderRoutes } from './modules/orders/order-routes.js';
import { OrderService } from './modules/orders/order-service.js';
import { registerPaymentRoutes } from './modules/payment/payment-routes.js';
import { PaymentService } from './modules/payment/payment-service.js';
import { registerSellerRoutes } from './modules/seller/seller-routes.js';
import { SellerService } from './modules/seller/seller-service.js';
import { registerAuthGuard } from './platform/auth-guard.js';
import { loadConfig, type AppConfig } from './platform/config.js';
import { createDatabasePool } from './platform/database.js';
import { AppError, registerErrorHandler } from './platform/errors.js';
import { registerLayeredRateLimit } from './platform/layered-rate-limit.js';
import { createRedis } from './platform/redis.js';

const SAFE_REQUEST_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface BuildAppOptions {
  loggerStream?: Writable;
}

export async function buildApp(
  config: AppConfig = loadConfig(),
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const pool = createDatabasePool(config);
  const redis = createRedis(config);
  await redis.connect();

  const app = Fastify({
    ajv: {
      customOptions: {
        removeAdditional: false,
      },
    },
    trustProxy: config.trustProxy,
    bodyLimit: config.maxBodyBytes,
    logger: {
      level: config.logLevel,
      ...(options.loggerStream ? { stream: options.loggerStream } : {}),
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers.x-payment-signature',
          'request.headers.authorization',
          'request.headers.cookie',
          'request.headers.x-payment-signature',
          'authorization',
          'cookie',
          'password',
          'access_token',
          'refresh_token',
          '*.password',
          '*.access_token',
          '*.refresh_token',
          'body.password',
          'body.access_token',
          'body.refresh_token',
          'req.body.password',
          'req.body.access_token',
          'req.body.refresh_token',
          'request.body.password',
          'request.body.access_token',
          'request.body.refresh_token',
        ],
        censor: '[REDACTED]',
      },
    },
    genReqId(request) {
      const inbound = request.headers['x-request-id'];
      return typeof inbound === 'string' && SAFE_REQUEST_ID.test(inbound) ? inbound : randomUUID();
    },
  });

  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    const raw = Buffer.isBuffer(body) ? body : Buffer.from(body);
    request.rawBody = raw;
    try {
      done(null, JSON.parse(raw.toString('utf8')) as unknown);
    } catch {
      done(new AppError(400, 'INVALID_JSON', 'Request body must be valid JSON'), undefined);
    }
  });

  await app.register(cookie);
  await app.register(cors, {
    credentials: true,
    origin(origin, callback) {
      if (!origin || config.corsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-ID'],
    exposedHeaders: ['X-Request-ID', 'Idempotency-Replayed', 'Retry-After'],
    methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
  });
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  await app.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: '1 minute',
    redis,
    keyGenerator: (request) => request.ip,
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Request-ID', request.id);
    return payload;
  });

  const identity = new IdentityService(pool, config);
  await identity.initialize();
  registerAuthGuard(app, identity);
  registerLayeredRateLimit(app, redis, config);
  registerErrorHandler(app);

  registerIdentityRoutes(app, identity, config);
  registerCatalogRoutes(app, new CatalogRepository(pool));
  registerSellerRoutes(app, new SellerService(pool, config));
  registerCartRoutes(app, new CartService(pool, config));
  registerCheckoutRoutes(app, new CheckoutService(pool, config));
  registerOrderRoutes(app, new OrderService(pool));
  registerPaymentRoutes(app, new PaymentService(pool, config));

  app.get('/health/live', { config: { authMode: 'public' } }, () => ({ status: 'ok' }));
  app.get('/health/ready', { config: { authMode: 'public' } }, async (_request, reply) => {
    try {
      await Promise.all([pool.query('SELECT 1'), redis.ping()]);
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  app.addHook('onClose', async () => {
    await Promise.allSettled([pool.end(), redis.quit()]);
  });

  await app.ready();
  return app;
}
