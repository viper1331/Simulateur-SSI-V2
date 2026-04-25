import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const HASH_PREFIX = 'scrypt:v1';
const KEY_LENGTH = 32;
const MASKED_CODE = '••••';

export interface AccessCodeMetadata {
  level: number;
  code: string;
  configured: boolean;
  updatedAt: string;
}

export function hashAccessCode(code: string): string {
  const normalizedCode = normalizeAccessCodeInput(code);
  const salt = randomBytes(16).toString('base64url');
  const key = scryptSync(normalizedCode, salt, KEY_LENGTH).toString('base64url');
  return `${HASH_PREFIX}:${salt}:${key}`;
}

export function verifyAccessCodeHash(code: string, storedHash: string | null | undefined): boolean {
  if (!storedHash) {
    return false;
  }
  const [prefix, version, salt, expectedKey] = storedHash.split(':');
  if (`${prefix}:${version}` !== HASH_PREFIX || !salt || !expectedKey) {
    return false;
  }

  const normalizedCode = normalizeAccessCodeInput(code);
  const actualKey = scryptSync(normalizedCode, salt, KEY_LENGTH);
  const expectedKeyBuffer = Buffer.from(expectedKey, 'base64url');
  if (actualKey.length !== expectedKeyBuffer.length) {
    return false;
  }
  return timingSafeEqual(actualKey, expectedKeyBuffer);
}

export function formatAccessCodeMetadata(
  level: number,
  codeHash: string | null | undefined,
  updatedAt: Date | string,
): AccessCodeMetadata {
  return {
    level: Number(level),
    code: MASKED_CODE,
    configured: Boolean(codeHash),
    updatedAt: new Date(updatedAt).toISOString(),
  };
}

function normalizeAccessCodeInput(code: string): string {
  return code.trim();
}
