import { AppError } from './errors.js';

export function encodeCursor(value: Record<string, string | number>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeCursor<T extends object>(cursor: string | undefined): T | undefined {
  if (!cursor) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded))
      throw new Error('invalid');
    return decoded as T;
  } catch {
    throw new AppError(400, 'INVALID_CURSOR', 'Pagination cursor is invalid');
  }
}
