import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  canonicalFingerprint,
  hashPassword,
  verifyHmacSha256,
  verifyPassword,
} from '../../src/platform/crypto.js';

describe('password hashing', () => {
  it('uses a random salt and verifies only the correct password', async () => {
    const first = await hashPassword('Correct Horse Battery Staple 2026!');
    const second = await hashPassword('Correct Horse Battery Staple 2026!');

    expect(first).not.toBe(second);
    await expect(verifyPassword('Correct Horse Battery Staple 2026!', first)).resolves.toBe(true);
    await expect(verifyPassword('wrong password', first)).resolves.toBe(false);
  });
});

describe('cryptographic request helpers', () => {
  it('fingerprints canonical objects independently of key insertion order', () => {
    expect(canonicalFingerprint({ cart_id: 'a', cart_version: 2 })).toBe(
      canonicalFingerprint({ cart_version: 2, cart_id: 'a' }),
    );
  });

  it('verifies the exact timestamp and raw webhook bytes', () => {
    const secret = 'test-webhook-secret-that-is-at-least-32-bytes';
    const timestamp = '1800000000';
    const body = Buffer.from('{"status":"paid","amount":1000}');
    const signature = createHmac('sha256', secret)
      .update(timestamp)
      .update('.')
      .update(body)
      .digest('hex');

    expect(verifyHmacSha256(secret, timestamp, body, signature)).toBe(true);
    expect(
      verifyHmacSha256(
        secret,
        timestamp,
        Buffer.from('{"status":"failed","amount":1000}'),
        signature,
      ),
    ).toBe(false);
    expect(verifyHmacSha256(secret, timestamp, body, 'not-a-mac')).toBe(false);
  });
});
