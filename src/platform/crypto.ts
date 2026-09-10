import {
  createHash,
  createHmac,
  randomBytes,
  scrypt as nodeScrypt,
  timingSafeEqual,
} from 'node:crypto';
const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;

export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

export function randomReference(prefix: string): string {
  return `${prefix}_${randomBytes(18).toString('base64url')}`;
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function keyedFingerprint(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await deriveScrypt(password.normalize('NFKC'), salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAX_MEMORY,
  });

  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, nRaw, rRaw, pRaw, saltRaw, expectedRaw] = encoded.split('$');
  if (!algorithm || !nRaw || !rRaw || !pRaw || !saltRaw || !expectedRaw || algorithm !== 'scrypt') {
    return false;
  }

  const n = Number.parseInt(nRaw, 10);
  const r = Number.parseInt(rRaw, 10);
  const p = Number.parseInt(pRaw, 10);
  if (n !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P) return false;

  const salt = Buffer.from(saltRaw, 'base64url');
  const expected = Buffer.from(expectedRaw, 'base64url');
  const actual = await deriveScrypt(password.normalize('NFKC'), salt, expected.length, {
    N: n,
    r,
    p,
    maxmem: SCRYPT_MAX_MEMORY,
  });

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function verifyHmacSha256(
  secret: string,
  timestamp: string,
  rawBody: Buffer,
  providedHex: string,
): boolean {
  const expected = createHmac('sha256', secret)
    .update(timestamp)
    .update('.')
    .update(rawBody)
    .digest();

  if (!/^[0-9a-fA-F]{64}$/.test(providedHex)) {
    timingSafeEqual(expected, Buffer.alloc(expected.length));
    return false;
  }

  const provided = Buffer.from(providedHex, 'hex');
  return provided.length === expected.length && timingSafeEqual(expected, provided);
}

export function canonicalFingerprint(value: unknown): string {
  return sha256Hex(stableJson(value));
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

function deriveScrypt(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: { N: number; r: number; p: number; maxmem: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(Buffer.from(derivedKey));
    });
  });
}
