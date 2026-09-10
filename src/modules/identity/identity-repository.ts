import type { Pool, PoolClient } from 'pg';

import type { AuthContext, UserRole } from '../../types/fastify.js';

export interface LoginUserRow {
  id: string;
  email_normalized: string;
  password_hash: string;
  display_name: string;
  status: 'active' | 'disabled';
  auth_version: number;
}

export interface RefreshTokenRow {
  id: string;
  session_family_id: string;
  user_id: string;
  user_auth_version: number;
  family_auth_version: number;
  used_at: Date | null;
  token_expires_at: Date;
  family_expires_at: Date;
  revoked_at: Date | null;
}

export async function findLoginUser(pool: Pool, email: string): Promise<LoginUserRow | undefined> {
  const result = await pool.query<LoginUserRow>(
    `SELECT id, email_normalized, password_hash, display_name, status, auth_version
       FROM users
      WHERE email_normalized = $1`,
    [email],
  );
  return result.rows[0];
}

export async function insertBuyer(
  client: PoolClient,
  email: string,
  passwordHash: string,
  displayName: string,
): Promise<string | undefined> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO users (email_normalized, password_hash, display_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (email_normalized) DO NOTHING
     RETURNING id`,
    [email, passwordHash, displayName],
  );
  const userId = result.rows[0]?.id;
  if (userId) {
    await client.query('INSERT INTO user_roles (user_id, role) VALUES ($1, $2)', [userId, 'buyer']);
  }
  return userId;
}

export async function findAccessContext(
  pool: Pool,
  tokenHash: string,
): Promise<AuthContext | undefined> {
  const result = await pool.query<{
    user_id: string;
    email_normalized: string;
    display_name: string;
    created_at: Date;
    roles: UserRole[];
    seller_id: string | null;
    session_family_id: string;
  }>(
    `SELECT
       u.id AS user_id,
       u.email_normalized,
       u.display_name,
       u.created_at,
       array_agg(DISTINCT ur.role)::text[] AS roles,
       s.id AS seller_id,
       sf.id AS session_family_id
     FROM access_tokens at
     JOIN session_families sf ON sf.id = at.session_family_id
     JOIN users u ON u.id = sf.user_id
     JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN sellers s ON s.owner_user_id = u.id AND s.status = 'active'
     WHERE at.token_hash = $1
       AND at.revoked_at IS NULL
       AND at.expires_at > now()
       AND sf.revoked_at IS NULL
       AND sf.expires_at > now()
       AND sf.auth_version = u.auth_version
       AND u.status = 'active'
     GROUP BY u.id, u.email_normalized, u.display_name, u.created_at, s.id, sf.id`,
    [tokenHash],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    userId: row.user_id,
    email: row.email_normalized,
    displayName: row.display_name,
    createdAt: row.created_at.toISOString(),
    roles: row.roles,
    sessionFamilyId: row.session_family_id,
    ...(row.seller_id ? { sellerId: row.seller_id } : {}),
  };
}

export async function findRefreshForUpdate(
  client: PoolClient,
  tokenHash: string,
): Promise<RefreshTokenRow | undefined> {
  const result = await client.query<RefreshTokenRow>(
    `SELECT
       rt.id,
       rt.session_family_id,
       sf.user_id,
       u.auth_version AS user_auth_version,
       sf.auth_version AS family_auth_version,
       rt.used_at,
       rt.expires_at AS token_expires_at,
       sf.expires_at AS family_expires_at,
       sf.revoked_at
     FROM refresh_tokens rt
     JOIN session_families sf ON sf.id = rt.session_family_id
     JOIN users u ON u.id = sf.user_id
     WHERE rt.token_hash = $1
     FOR UPDATE OF rt, sf`,
    [tokenHash],
  );
  return result.rows[0];
}

export async function findRefreshContextForLogout(
  pool: Pool,
  tokenHash: string,
): Promise<AuthContext | undefined> {
  const result = await pool.query<{
    user_id: string;
    email_normalized: string;
    display_name: string;
    created_at: Date;
    roles: UserRole[];
    seller_id: string | null;
    session_family_id: string;
  }>(
    `SELECT
       u.id AS user_id,
       u.email_normalized,
       u.display_name,
       u.created_at,
       array_agg(DISTINCT ur.role)::text[] AS roles,
       s.id AS seller_id,
       sf.id AS session_family_id
     FROM refresh_tokens rt
     JOIN session_families sf ON sf.id = rt.session_family_id
     JOIN users u ON u.id = sf.user_id
     JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN sellers s ON s.owner_user_id = u.id AND s.status = 'active'
     WHERE rt.token_hash = $1
       AND rt.expires_at > now()
       AND sf.revoked_at IS NULL
       AND sf.expires_at > now()
       AND sf.auth_version = u.auth_version
       AND u.status = 'active'
     GROUP BY u.id, u.email_normalized, u.display_name, u.created_at, s.id, sf.id`,
    [tokenHash],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    userId: row.user_id,
    email: row.email_normalized,
    displayName: row.display_name,
    createdAt: row.created_at.toISOString(),
    roles: row.roles,
    sessionFamilyId: row.session_family_id,
    ...(row.seller_id ? { sellerId: row.seller_id } : {}),
  };
}
