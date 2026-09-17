import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  buildConversationRelayTwiml,
  buildGatherTwiml,
  buildMissedCallTwiml,
  diagnoseTwilioSignature,
  isMissedRedirect,
  markMissedRedirect,
  parseInboundCall,
  placeCall,
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
      requestUrl: 'http://localhost:3000/api/webhooks/twilio/sms?tenant=volta',
      baseUrlOverride: 'https://tunnel.example.com',
    });
    assert.equal(result, 'https://tunnel.example.com/api/webhooks/twilio/sms?tenant=volta');
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

/**
 * Phase B is a `<Gather>` and nothing else: no speech recognition, no model. What
 * these cases protect is the handful of attributes that decide whether an unanswered
 * call is *recorded* or silently lost, because that is the difference between a
 * system that knows an appointment was never confirmed and one that merely assumes.
 */
describe('buildGatherTwiml', () => {
  const base = { prompt: 'Press 1 to confirm.', actionUrl: 'https://x.example.com/gather' };

  it('asks for one digit and fires the action even when nothing is pressed', () => {
    // actionOnEmptyResult is the whole reason an unanswered call is visible: without
    // it a caller who says nothing produces no callback at all, and "no response"
    // becomes indistinguishable from "we never rang".
    const xml = buildGatherTwiml(base);
    assert.match(xml, /<Gather[^>]*numDigits="1"/);
    assert.match(xml, /actionOnEmptyResult="true"/);
    assert.match(xml, /method="POST"/);
    assert.match(xml, /input="dtmf"/);
  });

  it('puts the prompt inside the gather, so a keypress interrupts it', () => {
    const xml = buildGatherTwiml(base);
    const gather = xml.slice(xml.indexOf('<Gather'), xml.indexOf('</Gather>'));
    assert.match(gather, /Press 1 to confirm\./);
  });

  it('plays the fallback after the gather, not inside it', () => {
    // Inside, it would be read as part of the prompt on every call. Sibling verbs run
    // in order, so being outside is what makes it conditional on the timeout.
    const xml = buildGatherTwiml({ ...base, fallbackMessage: 'No response received.' });
    assert.ok(
      xml.indexOf('</Gather>') < xml.indexOf('No response received.'),
      'the fallback must come after the gather closes',
    );
    assert.match(xml, /<Hangup\/>/);
  });

  it('omits the fallback entirely when there is not one', () => {
    const xml = buildGatherTwiml(base);
    const says = xml.match(/<Say /g) ?? [];
    assert.equal(says.length, 1, 'only the prompt should be spoken');
  });

  it('escapes the prompt, so a business name cannot break the document', () => {
    const xml = buildGatherTwiml({ ...base, prompt: 'Ring O&S <now> "please"' });
    assert.match(xml, /O&amp;S/);
    assert.match(xml, /&lt;now&gt;/);
    assert.match(xml, /&quot;please&quot;/);
    assert.doesNotMatch(xml, /<now>/);
  });

  it('escapes an action URL containing a query string', () => {
    // Every action URL we generate carries `?call_id=…`, and any additional
    // parameter would put a bare `&` in the attribute.
    const xml = buildGatherTwiml({
      prompt: 'x',
      actionUrl: 'https://x.example.com/gather?call_id=abc&attempt=1',
    });
    assert.match(xml, /call_id=abc&amp;attempt=1/);
    assert.doesNotMatch(xml, /call_id=abc&attempt=1/);
  });

  it('honours a custom timeout and digit count', () => {
    const xml = buildGatherTwiml({ ...base, timeoutSeconds: 12, numDigits: 2 });
    assert.match(xml, /timeout="12"/);
    assert.match(xml, /numDigits="2"/);
  });

  it('defaults the timeout to something shorter than a caller will wait', () => {
    assert.match(buildGatherTwiml(base), /timeout="6"/);
  });

  it('leaves bargeIn at its default so an eager keypress is heard', () => {
    // Setting bargeIn="false" would ignore a caller who presses 1 while the prompt is
    // still being read — the exact behaviour a keypad prompt must not have.
    assert.doesNotMatch(buildGatherTwiml(base), /bargeIn="false"/);
  });
});

/**
 * The digit Twilio posts back on a gather callback. A missing `Digits` parameter and
 * an empty one must both read as "nothing was pressed" rather than as different
 * things, since the gather is configured to fire either way.
 */
describe('parseInboundCall — gather digits', () => {
  const wire = (extra: Record<string, string>) => ({
    CallSid: 'CA123',
    From: '+447700900123',
    To: '+441134960001',
    CallStatus: 'in-progress',
    ...extra,
  });

  it('returns the pressed digit', () => {
    assert.equal(parseInboundCall(wire({ Digits: '1' })).digits, '1');
  });

  it('returns null when the parameter is absent', () => {
    assert.equal(parseInboundCall(wire({})).digits, null);
  });

  it('returns null for an empty value rather than an empty string', () => {
    // actionOnEmptyResult posts the full callback with no Digits key at all on some
    // Twilio paths and an empty string on others; both mean the same thing here.
    assert.equal(parseInboundCall(wire({ Digits: '' })).digits, null);
    assert.equal(parseInboundCall(wire({ Digits: '   ' })).digits, null);
  });

  it('still reads the missed-call signals it always did', () => {
    const missed = parseInboundCall(wire({ DialCallStatus: 'no-answer' }));
    assert.equal(missed.isMissed, true);
    assert.equal(missed.dialCallStatus, 'no-answer');
  });
});

/**
 * Origination. The first thing in the platform that places a call rather than
 * answering one, so the request it builds and the errors it maps are both worth
 * pinning — a mis-mapped 4xx here is a retry loop that rings a real person twice.
 */
describe('placeCall', () => {
  const ACCOUNT_SID = 'AC_test_account_sid_0000000000';
  const AUTH_TOKEN = 'test_auth_token_0000000000000000';

  interface Captured {
    url: string;
    method: string | undefined;
    headers: Record<string, string>;
    form: URLSearchParams;
  }

  /**
   * Run `body` with `fetch` replaced by a stub, and hand back what was sent.
   *
   * The environment is restored whether the body succeeds or throws, so a failing
   * assertion cannot leave a fake `fetch` installed for the next test.
   */
  const capture = async <T>(
    responder: (request: Captured) => { status: number; body: unknown },
    body: () => Promise<T>,
  ): Promise<{ sent: Captured; result: T }> => {
    const previousFetch = globalThis.fetch;
    const previousEnv = {
      sid: process.env['TWILIO_ACCOUNT_SID'],
      token: process.env['TWILIO_AUTH_TOKEN'],
      messaging: process.env['TWILIO_MESSAGING_SERVICE_SID'],
    };

    process.env['TWILIO_ACCOUNT_SID'] = ACCOUNT_SID;
    process.env['TWILIO_AUTH_TOKEN'] = AUTH_TOKEN;
    delete process.env['TWILIO_MESSAGING_SERVICE_SID'];

    let captured: Captured | null = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      const request: Captured = {
        url: String(url),
        method: init.method,
        headers: (init.headers ?? {}) as Record<string, string>,
        form: new URLSearchParams(String(init.body)),
      };
      captured = request;
      const { status, body: payload } = responder(request);
      return new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    let result!: T;
    try {
      result = await body();
    } finally {
      globalThis.fetch = previousFetch;
      if (previousEnv.sid === undefined) delete process.env['TWILIO_ACCOUNT_SID'];
      else process.env['TWILIO_ACCOUNT_SID'] = previousEnv.sid;
      if (previousEnv.token === undefined) delete process.env['TWILIO_AUTH_TOKEN'];
      else process.env['TWILIO_AUTH_TOKEN'] = previousEnv.token;
      if (previousEnv.messaging === undefined) delete process.env['TWILIO_MESSAGING_SERVICE_SID'];
      else process.env['TWILIO_MESSAGING_SERVICE_SID'] = previousEnv.messaging;
    }

    assert.ok(captured, 'placeCall made no request at all');
    return { sent: captured, result };
  };

  const ok = () => ({
    status: 201,
    body: { sid: 'CA_placed', status: 'queued', price: null, price_unit: 'USD' },
  });

  const call = {
    to: '+447700900123',
    from: '+441134960001',
    twimlUrl: 'https://app.example.com/api/webhooks/twilio/voice/outbound?call_id=abc',
  };

  /** Place a call under the stub and report what was sent. */
  const sending = async (
    responder: (request: Captured) => { status: number; body: unknown },
    input: Parameters<typeof placeCall>[0] = call,
  ): Promise<Captured> => (await capture(responder, () => placeCall(input))).sent;

  it('posts to the Calls endpoint for the configured account', async () => {
    const sent = await sending(ok);
    assert.equal(sent.url, `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Calls.json`);
    assert.equal(sent.method, 'POST');
  });

  it('sends the callee, the caller and the TwiML URL', async () => {
    const sent = await sending(ok);
    assert.equal(sent.form.get('To'), '+447700900123');
    assert.equal(sent.form.get('From'), '+441134960001');
    assert.equal(sent.form.get('Url'), call.twimlUrl);
  });

  it('fetches the TwiML with POST', async () => {
    // The webhook route verifies a signature over the POST body. A GET carries no
    // body, and the signature would then be computed over nothing.
    assert.equal((await sending(ok)).form.get('Method'), 'POST');
  });

  it('does not record by default', async () => {
    // Recording needs notification and a lawful basis. A default of "on" would put
    // that obligation on every tenant who never asked for it.
    assert.equal((await sending(ok)).form.get('Record'), null);
  });

  it('records only when asked', async () => {
    const sent = await sending(ok, { ...call, record: true });
    assert.equal(sent.form.get('Record'), 'record-from-answer-dual');
  });

  it('subscribes to every lifecycle event when a status callback is given', async () => {
    // Without the explicit event list Twilio posts only the terminal event, and an
    // answered call becomes indistinguishable from one that rang out.
    const sent = await sending(ok, { ...call, statusCallbackUrl: 'https://app.example.com/status' });
    assert.equal(sent.form.get('StatusCallback'), 'https://app.example.com/status');
    assert.match(sent.form.get('StatusCallbackEvent') ?? '', /answered/);
    assert.match(sent.form.get('StatusCallbackEvent') ?? '', /completed/);
  });

  it('authenticates with basic auth over the account credentials', async () => {
    const expected = Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64');
    assert.equal((await sending(ok)).headers['authorization'], `Basic ${expected}`);
  });

  it('passes the idempotency key through as Twilio understands it', async () => {
    // The guard against a retry ringing someone twice.
    const sent = await sending(ok, { ...call, idempotencyKey: 'originate:call-1' });
    assert.equal(sent.headers['I-Twilio-Idempotency-Token'], 'originate:call-1');
  });

  it('omits the idempotency header when there is no key', async () => {
    assert.equal((await sending(ok)).headers['I-Twilio-Idempotency-Token'], undefined);
  });

  it('returns the call sid and status', async () => {
    const { result } = await capture(
      () => ({ status: 201, body: { sid: 'CA_placed', status: 'queued', price: '-0.0150', price_unit: 'GBP' } }),
      () => placeCall(call),
    );
    assert.equal(result.sid, 'CA_placed');
    assert.equal(result.status, 'queued');
    // Twilio reports price negative; the magnitude is what we store.
    assert.equal(result.priceAmount, 0.015);
    assert.equal(result.priceCurrency, 'GBP');
  });

  it('maps a 4xx to a non-retryable unprocessable error', async () => {
    // A number we do not own, or a geo-permission block. Retrying fails identically.
    await assert.rejects(
      sending(() => ({ status: 400, body: { code: 21215, message: 'Geo permissions' } })),
      (error: unknown) => {
        const appError = error as { code: string; status: number };
        assert.equal(appError.code, 'unprocessable');
        assert.equal(appError.status, 422);
        return true;
      },
    );
  });

  it('maps a 5xx to a retryable provider error', async () => {
    await assert.rejects(
      sending(() => ({ status: 503, body: { code: 20500, message: 'Service unavailable' } })),
      (error: unknown) => {
        const appError = error as { code: string; status: number };
        assert.equal(appError.code, 'provider_error');
        assert.equal(appError.status, 502);
        return true;
      },
    );
  });

  it('never reports the Twilio error message to a customer', async () => {
    await assert.rejects(
      sending(() => ({ status: 400, body: { code: 21215, message: 'Geo permissions for GB' } })),
      (error: unknown) => {
        const appError = error as { publicMessage: string };
        assert.equal(appError.publicMessage, 'The call could not be placed.');
        return true;
      },
    );
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

/**
 * The no-forwarding-number path. A `<Redirect>` carries no `DialCallStatus` and the
 * parent call is still live, so nothing in the request says the call was missed — the
 * action URL has to carry it. Getting this wrong fails silently: the webhook answers
 * 200, the caller hears the call end, and no SMS is ever sent.
 */
describe('missed-redirect marker', () => {
  const ACTION = 'https://reception.example.com/api/webhooks/twilio/voice/missed';

  it('marks a URL so the callback can tell it was missed', () => {
    const marked = markMissedRedirect(ACTION);
    assert.equal(marked, `${ACTION}?atwood_missed=1`);
    assert.equal(isMissedRedirect(marked), true);
  });

  it('is idempotent', () => {
    assert.equal(markMissedRedirect(markMissedRedirect(ACTION)), markMissedRedirect(ACTION));
  });

  it('leaves an unmarked URL alone', () => {
    assert.equal(isMissedRedirect(ACTION), false);
  });

  it('does not mistake another query value for the marker', () => {
    assert.equal(isMissedRedirect(`${ACTION}?atwood_missed=0`), false);
    assert.equal(isMissedRedirect(`${ACTION}?something_else=1`), false);
  });

  it('returns false rather than throwing on a URL it cannot parse', () => {
    assert.equal(isMissedRedirect('not a url'), false);
  });

  it('emits the marked URL on the redirect path, and a Dial when forwarding', () => {
    const redirect = buildMissedCallTwiml({
      forwardTo: null,
      actionUrl: markMissedRedirect(ACTION),
    });
    assert.match(redirect, /<Redirect method="POST">\S+missed\?atwood_missed=1<\/Redirect>/);
    assert.doesNotMatch(redirect, /<Dial/);

    const dial = buildMissedCallTwiml({ forwardTo: '+447700900123', actionUrl: ACTION });
    assert.match(dial, /<Dial timeout="20" action="\S+missed" method="POST">\+447700900123<\/Dial>/);
    assert.doesNotMatch(dial, /<Redirect/);
  });
});

const RELAY_URL = 'wss://receptionist.aaa123.uk/relay';

/**
 * The Phase C entry point. Small, but every attribute here is a decision, and the two
 * that would fail silently are the scheme check and the greeting's placement.
 */
describe('buildConversationRelayTwiml', () => {
  it('connects under <Connect> rather than as a bare verb', () => {
    const xml = buildConversationRelayTwiml({ url: RELAY_URL });
    assert.match(xml, /<Connect>\s*<ConversationRelay url="wss:\/\/receptionist\.aaa123\.uk\/relay" \/>\s*<\/Connect>/);
  });

  it('rejects a non-secure url at build time rather than letting Twilio fail the call', () => {
    // Twilio requires wss:// and fails the call on anything else, with the reason buried in
    // the call debugger. Throwing here turns that into a named config error.
    assert.throws(
      () => buildConversationRelayTwiml({ url: 'ws://receptionist.aaa123.uk/relay' }),
      /must start with wss:\/\//,
    );
    assert.throws(
      () => buildConversationRelayTwiml({ url: 'https://receptionist.aaa123.uk/relay' }),
      /must start with wss:\/\//,
    );
  });

  it('omits every attribute that was not asked for, rather than pinning defaults', () => {
    const xml = buildConversationRelayTwiml({ url: RELAY_URL });
    for (const attribute of ['welcomeGreeting', 'language', 'ttsLanguage', 'ttsProvider', 'voice', 'speechModel']) {
      assert.doesNotMatch(xml, new RegExp(attribute), `${attribute} should not be pinned`);
    }
  });

  it('carries the tenant as a <Parameter>, not on the query string', () => {
    // The TwiML is signature-protected and the socket URL is ours, so a caller cannot
    // choose their own tenant by editing anything they control.
    const xml = buildConversationRelayTwiml({
      url: RELAY_URL,
      parameters: { businessId: 'biz-1', callSid: 'CA123' },
    });
    assert.match(xml, /<ConversationRelay [^>]*>\n\s+<Parameter name="businessId" value="biz-1" \/>/);
    assert.match(xml, /<Parameter name="callSid" value="CA123" \/>/);
    assert.match(xml, /<\/ConversationRelay>\s*<\/Connect>/);
  });

  it('pins the speech language separately from the recognition language', () => {
    // `language` supplies the TTS language by fallback when `ttsLanguage` is absent, so a
    // voice and an accent can both be inherited from defaults that are invisible in the
    // TwiML. Sending both makes the call's accent a decision rather than a side effect.
    const xml = buildConversationRelayTwiml({
      url: RELAY_URL,
      language: 'en-GB',
      ttsLanguage: 'en-GB',
    });
    assert.match(xml, /\slanguage="en-GB"/);
    assert.match(xml, /\sttsLanguage="en-GB"/);
  });

  it('escapes values that would otherwise break the XML', () => {
    const xml = buildConversationRelayTwiml({
      url: RELAY_URL,
      welcomeGreeting: 'Hello & welcome to "Atwood" <test>',
    });
    assert.match(xml, /Hello &amp; welcome to &quot;Atwood&quot; &lt;test&gt;/);
    assert.doesNotMatch(xml, /<test>/);
  });

  it('leaves barge-in on by default, because muting it is what makes an assistant feel broken', () => {
    const xml = buildConversationRelayTwiml({ url: RELAY_URL });
    assert.doesNotMatch(xml, /interruptible/);
  });

  it('only turns on DTMF when asked, since nothing handles it otherwise', () => {
    assert.doesNotMatch(buildConversationRelayTwiml({ url: RELAY_URL }), /dtmfDetection/);
    assert.match(
      buildConversationRelayTwiml({ url: RELAY_URL, dtmfDetection: true }),
      /dtmfDetection="true"/,
    );
  });
});
