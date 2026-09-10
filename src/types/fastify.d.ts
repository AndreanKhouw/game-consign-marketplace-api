import 'fastify';

export type UserRole = 'buyer' | 'seller' | 'admin';

export interface AuthContext {
  userId: string;
  email: string;
  displayName: string;
  createdAt: string;
  roles: UserRole[];
  sellerId?: string;
  sessionFamilyId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
    rawBody?: Buffer;
  }

  interface FastifyContextConfig {
    authMode?: 'public' | 'access' | 'refresh' | 'access_or_refresh' | 'webhook';
    roles?: UserRole[];
  }
}
