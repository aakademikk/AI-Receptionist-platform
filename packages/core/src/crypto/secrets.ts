import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

import { serverEnv } from '../env.ts';

/**
 * Envelope encryption for per-tenant integration credentials.
 *
 * AES-256-GCM, application-side. The database stores only an opaque base64 blob,
 * which means a leaked database dump does not leak a single tenant's Twilio or
 * Google credentials.
 *
 * Why not Supabase Vault / pgsodium: Vault is a good option and this design does
 * not preclude it. Doing it in the application keeps the encryption boundary
 * outside the database, so the same envelope decrypts identically from n8n, from a
 * Vercel function, or from a local script, and moving to self-hosted Postgres
 * later needs no migration. See docs/07-security-and-gdpr.md for the trade-off.
 *
 * Format: `v<keyVersion>.<iv>.<authTag>.<ciphertext>`, all base64url.
 * The version prefix is what makes key rotation possible without a flag day:
 * new writes use the current key, old envelopes still decrypt with the key that
 * wrote them.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM standard; 96 bits
const KEY_LENGTH = 32; // AES-256

export class CryptoError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'CryptoError';
  }
}

function loadKey(version: number): Buffer {
  // Rotation: CREDENTIAL_ENCRYPTION_KEY holds the current key;
  // CREDENTIAL_ENCRYPTION_KEY_V<n> holds superseded ones so old rows still open.
  const raw =
    version === serverEnv.credentialKeyVersion
      ? serverEnv.credentialEncryptionKey
      : process.env[`CREDENTIAL_ENCRYPTION_KEY_V${version}`];

  if (!raw) {
    throw new CryptoError(
      `No encryption key available for version ${version}. ` +
        `Set CREDENTIAL_ENCRYPTION_KEY_V${version} to decrypt credentials written by that key.`,
    );
  }

  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_LENGTH) {
    throw new CryptoError(
      `Encryption key v${version} must be ${KEY_LENGTH} bytes base64-encoded, got ${key.length}.`,
    );
  }
  return key;
}

/** Encrypt a JSON-serialisable secret. Returns the storable envelope. */
export function encryptSecret(secret: unknown): { ciphertext: string; keyVersion: number } {
  const version = serverEnv.credentialKeyVersion;
  const key = loadKey(version);
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(secret), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const envelope = [
    `v${version}`,
    iv.toString('base64url'),
    authTag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.');

  return { ciphertext: envelope, keyVersion: version };
}

/**
 * Decrypt an envelope.
 *
 * GCM authenticates as well as encrypts, so a tampered envelope fails here rather
 * than yielding plausible garbage — the `authTag` check is doing that work.
 */
export function decryptSecret<T = unknown>(envelope: string): T {
  const parts = envelope.split('.');
  if (parts.length !== 4) {
    throw new CryptoError('Malformed credential envelope');
  }

  const [versionPart, ivPart, tagPart, dataPart] = parts as [string, string, string, string];

  if (!versionPart.startsWith('v')) {
    throw new CryptoError('Malformed credential envelope: missing version prefix');
  }
  const version = Number.parseInt(versionPart.slice(1), 10);
  if (Number.isNaN(version)) {
    throw new CryptoError('Malformed credential envelope: unparseable version');
  }

  const key = loadKey(version);

  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivPart, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataPart, 'base64url')),
      decipher.final(),
    ]);
    return JSON.parse(decrypted.toString('utf8')) as T;
  } catch (cause) {
    // Deliberately vague: a detailed crypto error is an oracle.
    throw new CryptoError('Failed to decrypt credential', cause);
  }
}

/** Generate a 32-byte key, base64. For `CREDENTIAL_ENCRYPTION_KEY`. */
export function generateEncryptionKey(): string {
  return randomBytes(KEY_LENGTH).toString('base64');
}

// -----------------------------------------------------------------------------
// API keys
// -----------------------------------------------------------------------------

export interface GeneratedApiKey {
  /** Shown to the user exactly once. */
  plaintext: string;
  /** Stored, for lookup and display. */
  prefix: string;
  /** Stored, for verification. */
  hash: string;
}

/**
 * Mint an API key.
 *
 * The key is hashed with plain SHA-256 rather than a slow KDF. That is the right
 * call here and the wrong call for passwords: this is a 256-bit random value, so
 * there is no dictionary to attack and no rainbow table to build — the only attack
 * is brute force against full entropy, which a KDF would not improve. Meanwhile
 * the hash is computed on every internal API request, where bcrypt's cost would
 * be a per-request latency tax.
 */
export function generateApiKey(prefix = 'atw'): GeneratedApiKey {
  const secret = randomBytes(32).toString('base64url');
  const plaintext = `${prefix}_${secret}`;
  return {
    plaintext,
    prefix: plaintext.slice(0, 12),
    hash: hashApiKey(plaintext),
  };
}

export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/** Constant-time comparison, so a timing side channel cannot leak the hash. */
export function verifyApiKey(plaintext: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashApiKey(plaintext), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/**
 * Compare the internal API shared secret in constant time.
 *
 * Used on every n8n -> API call. A plain `===` on a secret is a timing oracle;
 * the difference is small but the fix is free.
 */
export function verifySharedSecret(presented: string | null | undefined, expected: string): boolean {
  if (!presented) return false;
  // Hash both sides first so the comparison length is fixed regardless of how
  // long the presented value is — otherwise length itself leaks.
  const a = createHash('sha256').update(presented, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}
