import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import type { AppConfig } from '../../platform/config.js';
import { AppError } from '../../platform/errors.js';
import type { IdentityService } from './identity-service.js';

const Email = Type.String({ format: 'email', maxLength: 254 });
const Password = Type.String({ minLength: 1, maxLength: 128 });

export function registerIdentityRoutes(
  app: FastifyInstance,
  identity: IdentityService,
  config: AppConfig,
): void {
  const cookieOptions = {
    path: '/v1/auth',
    httpOnly: true,
    secure: config.nodeEnv === 'production',
    sameSite: 'lax' as const,
    maxAge: config.refreshTokenTtlSeconds,
  };

  app.post(
    '/v1/auth/register',
    {
      config: { authMode: 'public', rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        body: Type.Object(
          {
            email: Email,
            password: Type.String({ minLength: 12, maxLength: 128 }),
            display_name: Type.String({ minLength: 1, maxLength: 100 }),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      const body = request.body as { email: string; password: string; display_name: string };
      await identity.register(
        { email: body.email, password: body.password, displayName: body.display_name },
        request.id,
      );
      return reply.code(202).send({
        message: 'If the request can be completed, the account will be available shortly.',
      });
    },
  );

  app.post(
    '/v1/auth/login',
    {
      config: { authMode: 'public', rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        body: Type.Object({ email: Email, password: Password }, { additionalProperties: false }),
      },
    },
    async (request, reply) => {
      const body = request.body as { email: string; password: string };
      const tokens = await identity.login(body.email, body.password, request.id);
      reply.setCookie('refresh_token', tokens.refreshToken, cookieOptions);
      return {
        access_token: tokens.accessToken,
        token_type: 'Bearer',
        expires_in: tokens.accessExpiresIn,
      };
    },
  );

  app.post(
    '/v1/auth/refresh',
    {
      config: { authMode: 'refresh', rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      assertAllowedOrigin(request.headers.origin, config);
      const tokens = await identity.refresh(request.cookies.refresh_token, request.id);
      reply.setCookie('refresh_token', tokens.refreshToken, cookieOptions);
      return {
        access_token: tokens.accessToken,
        token_type: 'Bearer',
        expires_in: tokens.accessExpiresIn,
      };
    },
  );

  app.post(
    '/v1/auth/logout',
    { config: { authMode: 'access_or_refresh' } },
    async (request, reply) => {
      if (request.cookies.refresh_token) assertAllowedOrigin(request.headers.origin, config);
      if (!request.auth)
        throw new AppError(401, 'INVALID_SESSION', 'Session is invalid or expired');
      await identity.logout(request.auth, request.id);
      reply.clearCookie('refresh_token', cookieOptions);
      return reply.code(204).send();
    },
  );

  app.get('/v1/me', (request) => {
    if (!request.auth) throw new AppError(401, 'INVALID_SESSION', 'Session is invalid or expired');
    return {
      id: request.auth.userId,
      email: request.auth.email,
      display_name: request.auth.displayName,
      roles: request.auth.roles,
      created_at: request.auth.createdAt,
    };
  });
}

function assertAllowedOrigin(origin: string | undefined, config: AppConfig): void {
  if (origin && !config.corsOrigins.includes(origin)) {
    throw new AppError(403, 'ORIGIN_NOT_ALLOWED', 'Request origin is not allowed');
  }
}
