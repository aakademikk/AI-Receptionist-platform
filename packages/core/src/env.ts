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

/*
 * Everything here is trimmed.
 *
 * Every value in this file is a token, key or URL, and none of them can legitimately
 * carry leading or trailing whitespace — but a stray space survives a copy-paste into
 * an .env file invisibly. The consequences are silent and awful: a padded
 * TWILIO_AUTH_TOKEN becomes part of the HMAC key, so every inbound webhook is
 * rejected as an invalid signature while the token *looks* correct in the file.
 *
 * These previously validated with .trim() and then returned the untrimmed value,
 * which is the worst of both — the emptiness check passed and the padding stayed.
 */
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === '') {
    throw new ConfigError(
      `Missing required environment variable ${name}. See .env.example.`,
    );
  }
  return value;
}

function optional(name: string, fallback?: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value === '' ? fallback : value;
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

/**
 * Catch the Supabase URLs that are wrong in a way the Supabase client cannot
 * report usefully.
 *
 * When the URL points at something that answers with a web page rather than the
 * auth API, the client tries to `JSON.parse` the HTML and surfaces
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON` — a message that says
 * nothing about the actual mistake, and which arrives at sign-in rather than at
 * boot. These checks fail earlier and name the fix.
 *
 * Deliberately narrow. Self-hosted Supabase lives on any host and port behind any
 * reverse proxy, so this rejects only what cannot be right — and where the correct
 * value is derivable, it names it, because "wrong URL" is a far less useful message
 * than "use this one".
 *
 * Every case here is one someone has actually hit. They share a cause: the URLs a
 * human has to hand — the browser address bar, the storage section of
 * `supabase start` output — are not the API root.
 */
function assertSupabaseApiUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError(
      `NEXT_PUBLIC_SUPABASE_URL is not a valid URL: "${value}". ` +
        `Expected something like http://127.0.0.1:54321 or https://<ref>.supabase.co.`,
    );
  }

  if (parsed.hostname === 'your-project.supabase.co') {
    throw new ConfigError(
      'NEXT_PUBLIC_SUPABASE_URL is still the placeholder from .env.example. ' +
        'Run `pnpm db:start` and use the API URL it prints (http://127.0.0.1:54321), ' +
        "or your hosted project's URL from its API settings.",
    );
  }

  // The dashboard URL. This is the one in the address bar while you are looking for
  // the API URL, and the project ref in its path is exactly what the API hostname is
  // built from — so the right answer can be handed over rather than described.
  if (parsed.hostname === 'supabase.com' || parsed.hostname === 'www.supabase.com') {
    const ref = /\/dashboard\/project\/([a-z0-9]+)/i.exec(parsed.pathname)?.[1];
    throw new ConfigError(
      'NEXT_PUBLIC_SUPABASE_URL is the Supabase dashboard, which is a web page rather ' +
        'than your project API. ' +
        (ref
          ? `For this project the API URL is https://${ref}.supabase.co`
          : 'Use the Project URL from Project Settings → API, which looks like ' +
            'https://<ref>.supabase.co.') +
        '. Note a hosted project has none of this repo\'s migrations applied — ' +
        '`pnpm db:start` plus `pnpm db:reset` gives you the seeded local stack instead.',
    );
  }

  if (parsed.port === '54323') {
    throw new ConfigError(
      'NEXT_PUBLIC_SUPABASE_URL points at Supabase Studio (port 54323), which serves ' +
        'a web page rather than the API. Use the API URL instead: ' +
        `${parsed.protocol}//${parsed.hostname}:54321`,
    );
  }

  /*
   * A sub-API path rather than the API root. `supabase start` prints an "API URL"
   * under its S3 storage section that ends in /storage/v1/s3, and it is easy to take
   * that for the API URL because it is literally labelled one. The client appends
   * /auth/v1/... to whatever it is given, so the result 404s as HTML.
   *
   * Matching specific known sub-paths rather than "any path", because a self-hosted
   * instance behind a path prefix is legitimate.
   */
  const subApi = /^\/(storage|auth|rest|realtime|functions)\/v\d/.exec(parsed.pathname);
  if (subApi) {
    throw new ConfigError(
      `NEXT_PUBLIC_SUPABASE_URL includes the "${subApi[1]}" sub-API path ` +
        `("${parsed.pathname}"). The client appends its own paths, so it needs the ` +
        `root only: ${parsed.origin}`,
    );
  }

  return value;
}

/** Values that are safe to expose to the browser. */
export const publicEnv = {
  get supabaseUrl(): string {
    return assertSupabaseApiUrl(required('NEXT_PUBLIC_SUPABASE_URL'));
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

  /**
   * The account's other auth token, during a rotation.
   *
   * Twilio no longer offers an in-place regenerate: you request a secondary token,
   * move your systems onto it, then promote it to primary. Both are valid account
   * credentials throughout, and a webhook in flight may have been signed with either
   * — so a deployment that only knows one of them rejects real traffic for the whole
   * rotation window.
   *
   * Set it during a rotation, clear it once the promotion has settled.
   */
  get twilioAuthTokenSecondary(): string | undefined {
    assertServer('TWILIO_AUTH_TOKEN_SECONDARY');
    return optional('TWILIO_AUTH_TOKEN_SECONDARY');
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

  /**
   * Trailing slash stripped: callers append `/webhook/...`, and a base ending in `/`
   * produces a double slash that some reverse proxies answer with a 404 rather than
   * normalising. Cheaper to handle here than to explain each time.
   */
  get n8nWebhookBaseUrl(): string | undefined {
    return optional('N8N_WEBHOOK_BASE_URL')?.replace(/\/+$/, '');
  },

  /**
   * Public origin Twilio signed its request against, when the app cannot work it out
   * itself.
   *
   * The signature covers the exact URL configured in Twilio, so validation needs that
   * URL rebuilt byte for byte. Normally `x-forwarded-proto` / `x-forwarded-host` carry
   * it, but a tunnel that rewrites the Host header to the origin (which is what a
   * quick tunnel does by default) leaves the app reconstructing
   * `http://localhost:3000/...` and rejecting every request as a bad signature.
   *
   * Set this to the public base — `https://<tunnel>.trycloudflare.com` — and the
   * scheme and host come from here instead. Path and query still come from the
   * request, so it stays correct across every route.
   */
  get twilioWebhookBaseUrl(): string | undefined {
    return optional('TWILIO_WEBHOOK_BASE_URL')?.replace(/\/+$/, '');
  },

  get logLevel(): string {
    return optional('LOG_LEVEL', 'info')!;
  },
  get nodeEnv(): string {
    return optional('NODE_ENV', 'development')!;
  },
} as const;

export const isProduction = (): boolean => serverEnv.nodeEnv === 'production';
