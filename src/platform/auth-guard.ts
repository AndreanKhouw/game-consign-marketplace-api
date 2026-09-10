import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { IdentityService } from '../modules/identity/identity-service.js';
import { AppError } from './errors.js';

function extractBearer(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header) return undefined;
  const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(header);
  return match?.[1];
}

export function registerAuthGuard(app: FastifyInstance, identity: IdentityService): void {
  app.addHook('onRequest', async (request) => {
    const mode = request.routeOptions.config.authMode ?? 'access';
    if (mode === 'public' || mode === 'refresh' || mode === 'webhook') return;

    const bearer = extractBearer(request);
    if (bearer) {
      request.auth = await identity.authenticateAccess(bearer);
    } else if (mode === 'access_or_refresh') {
      request.auth = await identity.authenticateRefreshForLogout(
        request.cookies.refresh_token ?? '',
      );
    } else {
      throw new AppError(401, 'INVALID_SESSION', 'Session is invalid or expired');
    }

    const requiredRoles = request.routeOptions.config.roles ?? [];
    if (
      requiredRoles.length > 0 &&
      !requiredRoles.some((role) => request.auth?.roles.includes(role))
    ) {
      throw new AppError(403, 'FORBIDDEN', 'Required capability is missing');
    }
  });
}
