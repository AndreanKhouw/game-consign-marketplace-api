import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { setTimeout as delay } from 'node:timers/promises';

import type { AppConfig } from './config.js';
import { keyedFingerprint, sha256Hex } from './crypto.js';
import { AppError } from './errors.js';

const FIXED_WINDOW_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return current
`;

export function registerLayeredRateLimit(
  app: FastifyInstance,
  redis: Redis,
  config: AppConfig,
): void {
  app.addHook('preHandler', async (request) => {
    let key: string | undefined;
    let limit = 300;

    if (request.auth) {
      key = `user:${request.auth.userId}`;
      if (request.routeOptions.url === '/v1/checkout') limit = 20;
    } else if (
      request.routeOptions.url === '/v1/auth/login' ||
      request.routeOptions.url === '/v1/auth/register'
    ) {
      const body = request.body as { email?: unknown } | undefined;
      if (typeof body?.email === 'string') {
        const email = body.email.trim().toLowerCase().normalize('NFC');
        key = `identity:${keyedFingerprint(config.auditHmacSecret, email)}`;
        limit = 10;
      }
    } else if (request.routeOptions.url === '/v1/auth/refresh') {
      const token = request.cookies.refresh_token;
      if (token) {
        key = `refresh:${sha256Hex(token)}`;
        limit = 20;
      }
    }

    if (!key) return;
    const bucket = Math.floor(Date.now() / 60_000);
    const count = Number(await redis.eval(FIXED_WINDOW_SCRIPT, 1, `rate:${key}:${bucket}`, '65'));
    if (
      (request.routeOptions.url === '/v1/auth/login' ||
        request.routeOptions.url === '/v1/auth/register') &&
      count > 3 &&
      count <= limit
    ) {
      await delay(Math.min((count - 3) * 100, 700));
    }
    if (count > limit) {
      throw new AppError(429, 'RATE_LIMITED', 'Too many requests');
    }
  });
}
