/**
 * Environment access.
 *
 * Two rules, both learned the hard way in multi-tenant systems:
 *
 *  1. Nothing reads `process.env` directly outside this file. Every secret has
 *     exactly one name, declared once, and a missing one fails at boot with a
 *     useful message rather than at 2am with `undefined is not a function`.
 *
 *  2. Server-only secrets are never re-exported into anything the bundler could
 *     reach from client code. `assertServer()` guards the accessors that must
 *     never be evaluated in a browser.
 */

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function assertServer(name: string): void {
  // `window` present means we are in a browser bundle; a server secret being
  // read there is a build mistake, not a runtime condition to handle.
  if (typeof window !== 'undefined') {
    throw new ConfigError(
      `${name} is a server-only secret and was read in a browser context. ` +
        `Move the call into a route handler or server component.`,
    );
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new ConfigError(
      `Missing required environment variable ${name}. See .env.example.`,
    );
  }
  return value;
}

function optional(name: string, fallback?: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? fallback : value;
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new ConfigError(`Environment variable ${name} must be an integer, got "${raw}".`);
  }
  return parsed;
}

/** Values that are safe to expose to the browser. */
export const publicEnv = {
  get supabaseUrl(): string {
    return required('NEXT_PUBLIC_SUPABASE_URL');
  },
  get supabaseAnonKey(): string {
    return required('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  },
  get appUrl(): string {
    return optional('NEXT_PUBLIC_APP_URL', 'http://localhost:3000')!;
  },
} as const;

/** Server-only configuration. Every accessor is guarded. */
export const serverEnv = {
  get supabaseServiceRoleKey(): string {
    assertServer('SUPABASE_SERVICE_ROLE_KEY');
    return required('SUPABASE_SERVICE_ROLE_KEY');
  },

  /**
   * Shared secret that n8n presents on every internal API call. Rotating it is a
   * single env change on both sides.
   */
  get internalApiSecret(): string {
    assertServer('INTERNAL_API_SECRET');
    return required('INTERNAL_API_SECRET');
  },

  /** 32-byte key, base64. Encrypts per-tenant integration credentials at rest. */
  get credentialEncryptionKey(): string {
    assertServer('CREDENTIAL_ENCRYPTION_KEY');
    return required('CREDENTIAL_ENCRYPTION_KEY');
  },
  get credentialKeyVersion(): number {
    return integer('CREDENTIAL_KEY_VERSION', 1);
  },

  // --- AI providers. Only the ones a tenant actually selects need to be set. ---
  get anthropicApiKey(): string | undefined {
    assertServer('ANTHROPIC_API_KEY');
    return optional('ANTHROPIC_API_KEY');
  },
  get openaiApiKey(): string | undefined {
    assertServer('OPENAI_API_KEY');
    return optional('OPENAI_API_KEY');
  },
  get googleApiKey(): string | undefined {
    assertServer('GOOGLE_API_KEY');
    return optional('GOOGLE_API_KEY');
  },

  // --- Twilio. Platform-level account; tenants get subaccounts or shared numbers. ---
  get twilioAccountSid(): string {
    assertServer('TWILIO_ACCOUNT_SID');
    return required('TWILIO_ACCOUNT_SID');
  },
  get twilioAuthToken(): string {
    assertServer('TWILIO_AUTH_TOKEN');
    return required('TWILIO_AUTH_TOKEN');
  },
  get twilioMessagingServiceSid(): string | undefined {
    return optional('TWILIO_MESSAGING_SERVICE_SID');
  },

  get firecrawlApiKey(): string | undefined {
    assertServer('FIRECRAWL_API_KEY');
    return optional('FIRECRAWL_API_KEY');
  },

  get resendApiKey(): string | undefined {
    assertServer('RESEND_API_KEY');
    return optional('RESEND_API_KEY');
  },
  get notificationFromEmail(): string {
    return optional('NOTIFICATION_FROM_EMAIL', 'notifications@atwood.systems')!;
  },

  get n8nWebhookBaseUrl(): string | undefined {
    return optional('N8N_WEBHOOK_BASE_URL');
  },

  get logLevel(): string {
    return optional('LOG_LEVEL', 'info')!;
  },
  get nodeEnv(): string {
    return optional('NODE_ENV', 'development')!;
  },
} as const;

export const isProduction = (): boolean => serverEnv.nodeEnv === 'production';
