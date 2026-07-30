/**
 * @atwood/core — the shared domain layer.
 *
 * Everything that is not a database migration, an n8n workflow or a React
 * component lives here, so the Next.js app and any future worker share one
 * implementation of the rules.
 *
 * Import from the sub-paths (`@atwood/core/domain`, `@atwood/core/ai`) in
 * application code — it keeps the import graph honest about what depends on what.
 * This barrel exists for convenience and for tests.
 */

export * from './env.ts';
export * from './types/domain.ts';

export * from './ai/index.ts';
export * from './domain/index.ts';
export * from './prompts/index.ts';
export * from './integrations/index.ts';
export * from './utils/index.ts';

export { getAdminClient, unwrap, unwrapMaybe } from './supabase/admin.ts';
export {
  encryptSecret,
  decryptSecret,
  generateEncryptionKey,
  generateApiKey,
  hashApiKey,
  verifyApiKey,
  verifySharedSecret,
  CryptoError,
  type GeneratedApiKey,
} from './crypto/secrets.ts';
