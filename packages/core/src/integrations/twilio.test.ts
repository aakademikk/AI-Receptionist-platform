import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  diagnoseTwilioSignature,
  reconstructTwilioUrl,
  requireValidTwilioSignature,
  validateTwilioSignature,
} from './twilio.ts';

/**
 * Every case here is a real deployment shape. The signature covers this URL exactly,
 * so a single character wrong rejects every inbound webhook — and the symptom looks
 * like a bad auth token rather than a URL problem.
 */
describe('reconstructTwilioUrl', () => {
  const LOCAL = 'http://localhost:3000/api/webhooks/twilio/sms';

  it('drops the local port when the override has none', () => {
    // The regression this exists for. Assigning to `url.host` keeps the existing port
    // when the new value omits one, producing tunnel.example.com:3000 against a
    // signature computed over a URL with no port.
    const result = reconstructTwilioUrl({
      requestUrl: LOCAL,
      baseUrlOverride: 'https://delicious-honors.trycloudflare.com',
    });

    assert.equal(result, 'https://delicious-honors.trycloudflare.com/api/webhooks/twilio/sms');
    assert.doesNotMatch(result, /:3000/, 'the origin port must not survive');
  });

  it('keeps a port the override genuinely specifies', () => {
    const result = reconstructTwilioUrl({
      requestUrl: LOCAL,
      baseUrlOverride: 'https://internal.example.com:8443',
    });
    assert.equal(result, 'https://internal.example.com:8443/api/webhooks/twilio/sms');
  });

  it('drops the local port when a forwarded host has none', () => {
    // Same trap on the header path, which is what Vercel and most proxies use.
    const result = reconstructTwilioUrl({
      requestUrl: LOCAL,
      forwardedProto: 'https',
      forwardedHost: 'app.atwood.systems',
    });
    assert.equal(result, 'https://app.atwood.systems/api/webhooks/twilio/sms');
  });

  it('takes the first entry when a proxy chain appends several', () => {
    // `x-forwarded-*` accumulates left to right; the client-supplied value is first.
    const result = reconstructTwilioUrl({
      requestUrl: LOCAL,
      forwardedProto: 'https, http',
      forwardedHost: 'app.atwood.systems, internal-lb',
    });
    assert.equal(result, 'https://app.atwood.systems/api/webhooks/twilio/sms');
  });

  it('falls back to the Host header when there is no forwarded host', () => {
    const result = reconstructTwilioUrl({
      requestUrl: LOCAL,
      forwardedProto: 'https',
      host: 'app.atwood.systems',
    });
    assert.equal(result, 'https://app.atwood.systems/api/webhooks/twilio/sms');
  });

  it('preserves the query string', () => {
    // Twilio signs the URL as configured, query included.
    const result = reconstructTwilioUrl({
      requestUrl: 'http://localhost:3000/api/webhooks/twilio/sms?tenant=parkfords',
      baseUrlOverride: 'https://tunnel.example.com',
    });
    assert.equal(result, 'https://tunnel.example.com/api/webhooks/twilio/sms?tenant=parkfords');
  });

  it('leaves the URL alone when nothing overrides it', () => {
    assert.equal(reconstructTwilioUrl({ requestUrl: LOCAL }), LOCAL);
  });

  it('ignores an unparseable override rather than throwing', () => {
    // A bad env value must not take every webhook down with it.
    const result = reconstructTwilioUrl({
      requestUrl: LOCAL,
      forwardedProto: 'https',
      forwardedHost: 'app.atwood.systems',
      baseUrlOverride: 'not a url',
    });
    assert.equal(result, 'https://app.atwood.systems/api/webhooks/twilio/sms');
  });

  it('ignores an empty forwarded header rather than producing a broken origin', () => {
    assert.equal(reconstructTwilioUrl({ requestUrl: LOCAL, forwardedHost: '  ' }), LOCAL);
  });
});

/**
 * Signature vectors generated from Twilio's own SDK (`getExpectedTwilioSignature` in
 * `twilio/lib/webhooks/webhooks.js`), then pinned here so the check is permanent
 * without carrying the dependency.
 *
 * This exists because a signature mismatch in the field is close to undiagnosable:
 * the URL, the token and the payload are all suspects, and nothing in the failure
 * says which. Proving our HMAC matches the vendor's removes one of the three for
 * good.
 */
const AUTH_TOKEN = 'my_auth_token_1234567890abcdef12';

interface SignatureVector {
  name: string;
  url: string;
  params: Record<string, string>;
  expected: string;
}

const VECTORS: SignatureVector[] = [
  { name: 'a plain inbound SMS', url: 'https://tunnel.example.com/api/webhooks/twilio/sms', params: { MessageSid: 'SM123', From: '+447700900123', To: '+441134960001', Body: 'hello' }, expected: 'Gv/5gWvTi9U2mLHrbyASTe0wExA=' },
  { name: 'a URL carrying a query string', url: 'https://tunnel.example.com/api/webhooks/twilio/sms?x=1', params: { From: '+447700900123', Body: 'hi there' }, expected: 'wT+6U+RZuwp6IaMipzeSPOS5F9Y=' },
  { name: 'a body with unicode and punctuation', url: 'https://tunnel.example.com/api/webhooks/twilio/sms', params: { Body: "Ben's café — 50% off?", From: '+447700900123' }, expected: '6FLE5ICsFJ/wNMFnkfXfvI6OHO4=' },
  { name: 'no parameters at all', url: 'https://tunnel.example.com/api/webhooks/twilio/voice', params: {}, expected: '0aW7bpft1OPYBjQJb7x1WeAAHQk=' },
  { name: 'keys needing a stable sort', url: 'https://tunnel.example.com/api/webhooks/twilio/sms', params: { '1': '5', b: '2', A: '1', a: '3', B: '4' }, expected: 'mjawymVxEDwrEJNbyflZUDc5H3g=' },
];

describe('validateTwilioSignature', () => {
  const withToken = <T>(fn: () => T): T => {
    const previous = process.env['TWILIO_AUTH_TOKEN'];
    process.env['TWILIO_AUTH_TOKEN'] = AUTH_TOKEN;
    try {
      return fn();
    } finally {
      if (previous === undefined) delete process.env['TWILIO_AUTH_TOKEN'];
      else process.env['TWILIO_AUTH_TOKEN'] = previous;
    }
  };

  for (const vector of VECTORS) {
    it(`accepts the signature Twilio computes for ${vector.name}`, () => {
      withToken(() => {
        assert.equal(
          validateTwilioSignature({ signature: vector.expected, url: vector.url, params: vector.params }),
          true,
        );
      });
    });
  }

  it('rejects a signature computed over a different URL', () => {
    const vector = VECTORS[0]!;
    withToken(() => {
      assert.equal(
        validateTwilioSignature({
          signature: vector.expected,
          url: 'https://tunnel.example.com:3000/api/webhooks/twilio/sms',
          params: vector.params,
        }),
        false,
        'the port regression must stay caught',
      );
    });
  });

  it('rejects a tampered parameter', () => {
    const vector = VECTORS[0]!;
    withToken(() => {
      assert.equal(
        validateTwilioSignature({
          signature: vector.expected,
          url: vector.url,
          params: { ...vector.params, Body: 'hello ' },
        }),
        false,
      );
    });
  });

  it('rejects a missing signature header', () => {
    withToken(() => {
      assert.equal(
        validateTwilioSignature({ signature: null, url: VECTORS[0]!.url, params: VECTORS[0]!.params }),
        false,
      );
    });
  });
});

describe('diagnoseTwilioSignature', () => {
  const params = { MessageSid: 'SM123', From: '+447700900123', Body: 'hello' };

  const withToken = <T>(fn: () => T): T => {
    const previous = process.env['TWILIO_AUTH_TOKEN'];
    process.env['TWILIO_AUTH_TOKEN'] = AUTH_TOKEN;
    try {
      return fn();
    } finally {
      if (previous === undefined) delete process.env['TWILIO_AUTH_TOKEN'];
      else process.env['TWILIO_AUTH_TOKEN'] = previous;
    }
  };

  /** The signature Twilio would send having signed `url`. */
  const signFor = (url: string): string => {
    let payload = url;
    for (const key of Object.keys(params).sort()) {
      payload += key + params[key as keyof typeof params];
    }
    return createHmac('sha1', AUTH_TOKEN).update(Buffer.from(payload, 'utf8')).digest('base64');
  };

  it('identifies a console entry using http where we reconstructed https', () => {
    const signed = 'http://tunnel.example.com/api/webhooks/twilio/sms';
    withToken(() => {
      const found = diagnoseTwilioSignature({
        signature: signFor(signed),
        url: 'https://tunnel.example.com/api/webhooks/twilio/sms',
        params,
      });
      assert.equal(found, signed);
    });
  });

  it('identifies a console entry carrying a trailing slash', () => {
    const signed = 'https://tunnel.example.com/api/webhooks/twilio/sms/';
    withToken(() => {
      const found = diagnoseTwilioSignature({
        signature: signFor(signed),
        url: 'https://tunnel.example.com/api/webhooks/twilio/sms',
        params,
      });
      assert.equal(found, signed);
    });
  });

  it('returns null when no variant matches, rather than guessing', () => {
    // A genuinely wrong token must not be reported as a URL problem.
    withToken(() => {
      const found = diagnoseTwilioSignature({
        signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        url: 'https://tunnel.example.com/api/webhooks/twilio/sms',
        params,
      });
      assert.equal(found, null);
    });
  });

  it('never reports the URL that already failed', () => {
    const url = 'https://tunnel.example.com/api/webhooks/twilio/sms';
    withToken(() => {
      const found = diagnoseTwilioSignature({ signature: signFor(url), url, params });
      assert.notEqual(found, url, 'the caller already rejected this one');
    });
  });
});

describe('validateTwilioSignature during an auth token rotation', () => {
  const SECONDARY = 'the_secondary_token_0987654321zyxw';
  const params = { MessageSid: 'SM123', From: '+447700900123', Body: 'hello' };

  const signWith = (token: string, url: string): string => {
    let payload = url;
    for (const key of Object.keys(params).sort()) {
      payload += key + params[key as keyof typeof params];
    }
    return createHmac('sha1', token).update(Buffer.from(payload, 'utf8')).digest('base64');
  };

  const url = 'https://tunnel.example.com/api/webhooks/twilio/sms';

  const withTokens = <T>(primary: string, secondary: string | undefined, fn: () => T): T => {
    const prevP = process.env['TWILIO_AUTH_TOKEN'];
    const prevS = process.env['TWILIO_AUTH_TOKEN_SECONDARY'];
    process.env['TWILIO_AUTH_TOKEN'] = primary;
    if (secondary === undefined) delete process.env['TWILIO_AUTH_TOKEN_SECONDARY'];
    else process.env['TWILIO_AUTH_TOKEN_SECONDARY'] = secondary;
    try {
      return fn();
    } finally {
      if (prevP === undefined) delete process.env['TWILIO_AUTH_TOKEN'];
      else process.env['TWILIO_AUTH_TOKEN'] = prevP;
      if (prevS === undefined) delete process.env['TWILIO_AUTH_TOKEN_SECONDARY'];
      else process.env['TWILIO_AUTH_TOKEN_SECONDARY'] = prevS;
    }
  };

  it('accepts a request signed with the primary', () => {
    withTokens(AUTH_TOKEN, SECONDARY, () => {
      assert.equal(
        validateTwilioSignature({ signature: signWith(AUTH_TOKEN, url), url, params }),
        true,
      );
    });
  });

  it('accepts a request signed with the secondary', () => {
    // The whole point: mid-rotation, Twilio may sign with either and both are real
    // account credentials.
    withTokens(AUTH_TOKEN, SECONDARY, () => {
      assert.equal(
        validateTwilioSignature({ signature: signWith(SECONDARY, url), url, params }),
        true,
      );
    });
  });

  it('still rejects a signature from neither token', () => {
    withTokens(AUTH_TOKEN, SECONDARY, () => {
      assert.equal(
        validateTwilioSignature({ signature: signWith('some_other_token_entirely_000000', url), url, params }),
        false,
      );
    });
  });

  it('rejects the secondary once it is cleared', () => {
    // Removing the variable must actually remove the trust, not just the intent.
    withTokens(AUTH_TOKEN, undefined, () => {
      assert.equal(
        validateTwilioSignature({ signature: signWith(SECONDARY, url), url, params }),
        false,
      );
    });
  });

  it('still rejects a wrong URL when two tokens are configured', () => {
    withTokens(AUTH_TOKEN, SECONDARY, () => {
      assert.equal(
        validateTwilioSignature({
          signature: signWith(SECONDARY, url),
          url: 'https://tunnel.example.com:3000/api/webhooks/twilio/sms',
          params,
        }),
        false,
      );
    });
  });
});

describe('TWILIO_SKIP_SIGNATURE_CHECK', () => {
  const url = 'https://tunnel.example.com/api/webhooks/twilio/sms';
  const params = { MessageSid: 'SM123', Body: 'hello' };

  const withEnv = <T>(vars: Record<string, string | undefined>, fn: () => T): T => {
    const previous: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
      previous[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      return fn();
    } finally {
      for (const [k, v] of Object.entries(previous)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  it('still rejects a bad signature when the flag is absent', () => {
    withEnv(
      { TWILIO_AUTH_TOKEN: AUTH_TOKEN, TWILIO_SKIP_SIGNATURE_CHECK: undefined, NODE_ENV: 'development' },
      () => {
        assert.throws(
          () => requireValidTwilioSignature({ signature: 'nope', url, params }),
          /Invalid Twilio signature/,
        );
      },
    );
  });

  it('only honours the exact string "true", not any truthy value', () => {
    // "1", "yes" and "TRUE" must not disable authentication by accident.
    for (const value of ['1', 'yes', 'TRUE', 'on']) {
      withEnv(
        { TWILIO_AUTH_TOKEN: AUTH_TOKEN, TWILIO_SKIP_SIGNATURE_CHECK: value, NODE_ENV: 'development' },
        () => {
          assert.throws(
            () => requireValidTwilioSignature({ signature: 'nope', url, params }),
            /Invalid Twilio signature/,
            `"${value}" must not disable verification`,
          );
        },
      );
    }
  });

  it('accepts a bad signature in development when explicitly enabled', () => {
    withEnv(
      { TWILIO_AUTH_TOKEN: AUTH_TOKEN, TWILIO_SKIP_SIGNATURE_CHECK: 'true', NODE_ENV: 'development' },
      () => {
        assert.doesNotThrow(() => requireValidTwilioSignature({ signature: 'nope', url, params }));
      },
    );
  });

  it('refuses to be honoured in production, loudly', () => {
    // Throwing rather than ignoring: a variable that silently does nothing in one
    // environment and everything in another is how it ends up live.
    withEnv(
      { TWILIO_AUTH_TOKEN: AUTH_TOKEN, TWILIO_SKIP_SIGNATURE_CHECK: 'true', NODE_ENV: 'production' },
      () => {
        assert.throws(
          () => requireValidTwilioSignature({ signature: 'nope', url, params }),
          /production build/,
        );
      },
    );
  });

  it('does not weaken a valid signature path', () => {
    const signature = createHmac('sha1', AUTH_TOKEN)
      .update(Buffer.from(url + 'BodyhelloMessageSidSM123', 'utf8'))
      .digest('base64');
    withEnv(
      { TWILIO_AUTH_TOKEN: AUTH_TOKEN, TWILIO_SKIP_SIGNATURE_CHECK: undefined, NODE_ENV: 'development' },
      () => {
        assert.doesNotThrow(() => requireValidTwilioSignature({ signature, url, params }));
      },
    );
  });
});
