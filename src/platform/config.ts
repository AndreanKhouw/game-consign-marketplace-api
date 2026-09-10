import 'dotenv/config';

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  logLevel: string;
  databaseUrl: string;
  databasePoolMax: number;
  databaseStatementTimeoutMs: number;
  databaseLockTimeoutMs: number;
  redisUrl: string;
  webhookHmacSecret: string;
  auditHmacSecret: string;
  corsOrigins: string[];
  trustProxy: boolean | string[];
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  webhookToleranceSeconds: number;
  maxBodyBytes: number;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function integer(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function parseNodeEnv(): AppConfig['nodeEnv'] {
  const value = process.env.NODE_ENV ?? 'development';
  if (value !== 'development' && value !== 'test' && value !== 'production') {
    throw new Error('NODE_ENV must be development, test, or production');
  }
  return value;
}

function parseTrustProxy(): AppConfig['trustProxy'] {
  const raw = process.env.TRUST_PROXY?.trim() ?? 'false';
  if (raw === 'false') return false;
  if (raw === 'true') return true;
  const proxies = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return proxies.length > 0 ? proxies : false;
}

export function loadConfig(): AppConfig {
  const nodeEnv = parseNodeEnv();
  const webhookHmacSecret = required('WEBHOOK_HMAC_SECRET');
  const auditHmacSecret = required('AUDIT_HMAC_SECRET');

  if (nodeEnv === 'production') {
    if (webhookHmacSecret.startsWith('dev-only') || webhookHmacSecret.length < 32) {
      throw new Error('WEBHOOK_HMAC_SECRET is not production safe');
    }
    if (auditHmacSecret.startsWith('dev-only') || auditHmacSecret.length < 32) {
      throw new Error('AUDIT_HMAC_SECRET is not production safe');
    }
  }

  const corsOrigins = required('CORS_ORIGINS')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (corsOrigins.some((origin) => origin === '*')) {
    throw new Error('CORS_ORIGINS must not contain a wildcard');
  }

  return {
    nodeEnv,
    host: process.env.HOST?.trim() || '0.0.0.0',
    port: integer('PORT', 3000, 1, 65_535),
    logLevel: process.env.LOG_LEVEL?.trim() || 'info',
    databaseUrl: required('DATABASE_URL'),
    databasePoolMax: integer('DATABASE_POOL_MAX', 10, 1, 100),
    databaseStatementTimeoutMs: integer('DATABASE_STATEMENT_TIMEOUT_MS', 5_000, 100, 60_000),
    databaseLockTimeoutMs: integer('DATABASE_LOCK_TIMEOUT_MS', 2_000, 100, 30_000),
    redisUrl: required('REDIS_URL'),
    webhookHmacSecret,
    auditHmacSecret,
    corsOrigins,
    trustProxy: parseTrustProxy(),
    accessTokenTtlSeconds: integer('ACCESS_TOKEN_TTL_SECONDS', 600, 60, 3_600),
    refreshTokenTtlSeconds: integer('REFRESH_TOKEN_TTL_SECONDS', 1_209_600, 3_600, 31_536_000),
    webhookToleranceSeconds: integer('WEBHOOK_TOLERANCE_SECONDS', 300, 30, 3_600),
    maxBodyBytes: integer('MAX_BODY_BYTES', 1_048_576, 1_024, 10_485_760),
  };
}
