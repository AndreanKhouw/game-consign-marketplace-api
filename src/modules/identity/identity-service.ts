import type { Pool, PoolClient } from 'pg';

import { appendAudit } from '../audit/audit-repository.js';
import type { AppConfig } from '../../platform/config.js';
import {
  hashPassword,
  keyedFingerprint,
  randomToken,
  sha256Hex,
  verifyPassword,
} from '../../platform/crypto.js';
import { withTransaction } from '../../platform/database.js';
import { AppError } from '../../platform/errors.js';
import type { AuthContext } from '../../types/fastify.js';
import {
  findAccessContext,
  findLoginUser,
  findRefreshContextForLogout,
  findRefreshForUpdate,
  insertBuyer,
} from './identity-repository.js';

interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresIn: number;
}

interface RefreshSuccess extends SessionTokens {
  outcome: 'success';
}

interface RefreshFailure {
  outcome: 'invalid' | 'reuse';
}

export class IdentityService {
  private dummyPasswordHash?: Promise<string>;

  constructor(
    private readonly pool: Pool,
    private readonly config: AppConfig,
  ) {}

  normalizeEmail(email: string): string {
    return email.trim().toLowerCase().normalize('NFC');
  }

  async initialize(): Promise<void> {
    await this.getDummyPasswordHash();
  }

  async register(
    input: { email: string; password: string; displayName: string },
    requestId: string,
  ): Promise<void> {
    const email = this.normalizeEmail(input.email);
    const passwordHash = await hashPassword(input.password);
    await withTransaction(this.pool, this.config.databaseLockTimeoutMs, async (client) => {
      const userId = await insertBuyer(client, email, passwordHash, input.displayName.trim());
      await appendAudit(client, {
        ...(userId ? { actorUserId: userId } : {}),
        action: 'identity.register_attempt',
        targetType: 'user',
        ...(userId ? { targetId: userId } : {}),
        outcome: 'success',
        requestId,
        safeMetadata: {
          email_fingerprint: keyedFingerprint(this.config.auditHmacSecret, email),
          created: Boolean(userId),
        },
      });
    });
  }

  async login(emailInput: string, password: string, requestId: string): Promise<SessionTokens> {
    const email = this.normalizeEmail(emailInput);
    const user = await findLoginUser(this.pool, email);
    const hash = user?.password_hash ?? (await this.getDummyPasswordHash());
    const passwordMatches = await verifyPassword(password, hash);

    if (!user || user.status !== 'active' || !passwordMatches) {
      await appendAudit(this.pool, {
        action: 'identity.login',
        targetType: 'user',
        outcome: 'failure',
        requestId,
        safeMetadata: {
          email_fingerprint: keyedFingerprint(this.config.auditHmacSecret, email),
        },
      });
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is invalid');
    }

    return withTransaction(this.pool, this.config.databaseLockTimeoutMs, async (client) => {
      const tokens = await this.createSession(client, user.id, user.auth_version);
      await appendAudit(client, {
        actorUserId: user.id,
        action: 'identity.login',
        targetType: 'session_family',
        targetId: tokens.sessionFamilyId,
        outcome: 'success',
        requestId,
      });
      return tokens;
    });
  }

  async authenticateAccess(rawToken: string): Promise<AuthContext> {
    const context = await findAccessContext(this.pool, sha256Hex(rawToken));
    if (!context) throw new AppError(401, 'INVALID_SESSION', 'Session is invalid or expired');
    return context;
  }

  async authenticateRefreshForLogout(rawToken: string): Promise<AuthContext> {
    const context = await findRefreshContextForLogout(this.pool, sha256Hex(rawToken));
    if (!context) throw new AppError(401, 'INVALID_SESSION', 'Session is invalid or expired');
    return context;
  }

  async refresh(rawToken: string | undefined, requestId: string): Promise<SessionTokens> {
    if (!rawToken || rawToken.length > 256) {
      throw new AppError(401, 'INVALID_SESSION', 'Session is invalid or expired');
    }

    const result = await withTransaction<RefreshSuccess | RefreshFailure>(
      this.pool,
      this.config.databaseLockTimeoutMs,
      async (client) => {
        const row = await findRefreshForUpdate(client, sha256Hex(rawToken));
        const now = new Date();
        if (
          !row ||
          row.revoked_at ||
          row.token_expires_at <= now ||
          row.family_expires_at <= now ||
          row.user_auth_version !== row.family_auth_version
        ) {
          return { outcome: 'invalid' };
        }

        if (row.used_at) {
          await this.revokeFamily(client, row.session_family_id, 'refresh_token_reuse');
          await appendAudit(client, {
            actorUserId: row.user_id,
            action: 'identity.refresh_reuse',
            targetType: 'session_family',
            targetId: row.session_family_id,
            outcome: 'failure',
            requestId,
          });
          return { outcome: 'reuse' };
        }

        const accessToken = randomToken();
        const refreshToken = randomToken();
        const refreshResult = await client.query<{ id: string }>(
          `INSERT INTO refresh_tokens
             (session_family_id, token_hash, expires_at)
           VALUES ($1, $2, $3)
           RETURNING id`,
          [row.session_family_id, sha256Hex(refreshToken), row.family_expires_at],
        );
        const replacementId = refreshResult.rows[0]!.id;
        await client.query(
          `UPDATE refresh_tokens
              SET used_at = now(), replaced_by_id = $2
            WHERE id = $1`,
          [row.id, replacementId],
        );
        await client.query(
          `INSERT INTO access_tokens
             (session_family_id, token_hash, expires_at)
           VALUES ($1, $2, now() + ($3 * interval '1 second'))`,
          [row.session_family_id, sha256Hex(accessToken), this.config.accessTokenTtlSeconds],
        );
        await appendAudit(client, {
          actorUserId: row.user_id,
          action: 'identity.refresh',
          targetType: 'session_family',
          targetId: row.session_family_id,
          outcome: 'success',
          requestId,
        });
        return {
          outcome: 'success',
          accessToken,
          refreshToken,
          accessExpiresIn: this.config.accessTokenTtlSeconds,
        };
      },
    );

    if (result.outcome !== 'success') {
      throw new AppError(
        401,
        result.outcome === 'reuse' ? 'REFRESH_TOKEN_REUSE' : 'INVALID_SESSION',
        'Session is invalid or expired',
      );
    }
    return result;
  }

  async logout(context: AuthContext, requestId: string): Promise<void> {
    await withTransaction(this.pool, this.config.databaseLockTimeoutMs, async (client) => {
      await this.revokeFamily(client, context.sessionFamilyId, 'logout');
      await appendAudit(client, {
        actorUserId: context.userId,
        action: 'identity.logout',
        targetType: 'session_family',
        targetId: context.sessionFamilyId,
        outcome: 'success',
        requestId,
      });
    });
  }

  private async createSession(
    client: PoolClient,
    userId: string,
    authVersion: number,
  ): Promise<SessionTokens & { sessionFamilyId: string }> {
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const family = await client.query<{ id: string }>(
      `INSERT INTO session_families (user_id, auth_version, expires_at)
       VALUES ($1, $2, now() + ($3 * interval '1 second'))
       RETURNING id`,
      [userId, authVersion, this.config.refreshTokenTtlSeconds],
    );
    const sessionFamilyId = family.rows[0]!.id;
    await client.query(
      `INSERT INTO access_tokens (session_family_id, token_hash, expires_at)
       VALUES ($1, $2, now() + ($3 * interval '1 second'))`,
      [sessionFamilyId, sha256Hex(accessToken), this.config.accessTokenTtlSeconds],
    );
    await client.query(
      `INSERT INTO refresh_tokens (session_family_id, token_hash, expires_at)
       VALUES ($1, $2, now() + ($3 * interval '1 second'))`,
      [sessionFamilyId, sha256Hex(refreshToken), this.config.refreshTokenTtlSeconds],
    );
    return {
      accessToken,
      refreshToken,
      accessExpiresIn: this.config.accessTokenTtlSeconds,
      sessionFamilyId,
    };
  }

  private async revokeFamily(
    client: PoolClient,
    sessionFamilyId: string,
    reason: string,
  ): Promise<void> {
    await client.query(
      `UPDATE session_families
          SET revoked_at = COALESCE(revoked_at, now()),
              revoke_reason = COALESCE(revoke_reason, $2)
        WHERE id = $1`,
      [sessionFamilyId, reason],
    );
    await client.query(
      `UPDATE access_tokens
          SET revoked_at = COALESCE(revoked_at, now())
        WHERE session_family_id = $1`,
      [sessionFamilyId],
    );
  }

  private getDummyPasswordHash(): Promise<string> {
    this.dummyPasswordHash ??= hashPassword('not-the-submitted-password');
    return this.dummyPasswordHash;
  }
}
