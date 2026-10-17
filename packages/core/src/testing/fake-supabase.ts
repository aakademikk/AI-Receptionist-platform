import type { SupabaseClient } from '@supabase/supabase-js';

import type { BusinessContext } from '../types/domain.ts';

/**
 * A small in-memory stand-in for the service-role Supabase client, for tests that run a
 * whole turn (`replyToCaller`, `handleInboundMessage`). Install it with
 * `setAdminClientForTests` from `supabase/admin.ts`.
 *
 * It covers exactly what a voice turn touches and nothing more:
 *
 *  * `rpc('resolve_inbound' | 'append_message' | 'request_handover' | 'enqueue_notification'
 *    | 'upsert_lead')`;
 *  * `from(...)` with select / insert / update, `eq` / `like` / `is` filters, `order`,
 *    `limit`, `single` and `maybeSingle`, on `business_ai_context`, `conversations`,
 *    `messages`, `leads`, `knowledge_items` and `ai_logs`.
 *
 * Anything else throws, so a turn that starts touching a new table fails loudly in the
 * test rather than quietly returning nothing.
 *
 * Every call is recorded in order with a timestamp (`calls`), and `delay` makes any one
 * kind of call slow, which is how a test reproduces a sluggish outbound `append_message`.
 * State is real but tiny: `append_message` adds a row that a later read of `messages`
 * sees, and a repeated `p_provider_message_id` comes back with `was_created: false`,
 * which is what the database's idempotency key does.
 */

export const FAKE_BUSINESS_ID = 'b-volta';
export const FAKE_CONVERSATION_ID = 'c-1';
export const FAKE_CONTACT_ID = 'k-1';
export const FAKE_TO_NUMBER = '+441632960489';

/** One recorded call. `at` is when it arrived, `doneAt` when it resolved (after any delay). */
export interface RecordedCall {
  seq: number;
  /** `rpc:append_message`, or `from:messages:insert` / `from:messages:select` / `from:messages:update`. */
  key: string;
  /** For an rpc, its parameters; for a table call, the insert / update payload (else null). */
  args: Record<string, unknown> | null;
  filters: Array<{ column: string; op: 'eq' | 'like' | 'is'; value: unknown }>;
  at: number;
  doneAt: number | null;
}

type Row = Record<string, unknown>;
type Result = { data: unknown; error: { message: string; code?: string } | null; count?: number | null };

interface DelayRule {
  key: string;
  ms: number;
  match?: (call: RecordedCall) => boolean;
}

export class FakeSupabase {
  readonly calls: RecordedCall[] = [];
  readonly tables: Record<string, Row[]>;
  private readonly delays: DelayRule[] = [];
  private readonly seenProviderIds = new Map<string, string>();
  private seq = 0;
  private ids = 0;

  constructor(context: BusinessContext = voltaContext()) {
    this.tables = {
      business_ai_context: [context as unknown as Row],
      conversations: [
        {
          id: FAKE_CONVERSATION_ID,
          business_id: context.business_id,
          contact_id: FAKE_CONTACT_ID,
          channel: 'voice',
          status: 'active',
          customer_phone: '+447700900123',
          customer_name: null,
          summary: null,
          current_topic: null,
          lead_status: 'new',
          ai_enabled: true,
          ai_turn_count: 0,
          confusion_count: 0,
          message_count: 0,
          handover_at: null,
          taken_over_at: null,
          handover_reason_code: null,
        },
      ],
      messages: [],
      leads: [],
      knowledge_items: [],
      ai_logs: [],
    };
  }

  /** The client to pass to `setAdminClientForTests`. */
  asClient(): SupabaseClient {
    return this as unknown as SupabaseClient;
  }

  /**
   * Make every matching call take `ms` longer. `key` is a call key such as
   * `rpc:append_message`; `match` narrows it further (for example to the outbound one).
   */
  delay(key: string, ms: number, match?: (call: RecordedCall) => boolean): void {
    this.delays.push({ key, ms, match });
  }

  /** Recorded calls whose key is `key`, oldest first. */
  callsTo(key: string): RecordedCall[] {
    return this.calls.filter((c) => c.key === key);
  }

  rpc(name: string, params: Record<string, unknown> = {}): PromiseLike<Result> {
    return this.run(`rpc:${name}`, params, [], () => this.handleRpc(name, params));
  }

  from(table: string): FakeQuery {
    if (!(table in this.tables)) throw new Error(`FakeSupabase: no table '${table}'`);
    return new FakeQuery(this, table);
  }

  /** Used by `FakeQuery`; not for tests. */
  run(
    key: string,
    args: Record<string, unknown> | null,
    filters: RecordedCall['filters'],
    work: () => Result,
  ): PromiseLike<Result> {
    const call: RecordedCall = { seq: this.seq++, key, args, filters, at: Date.now(), doneAt: null };
    this.calls.push(call);
    const ms = this.delays
      .filter((d) => d.key === key && (d.match ? d.match(call) : true))
      .reduce((total, d) => total + d.ms, 0);

    const finish = (): Result => {
      const result = work();
      call.doneAt = Date.now();
      return result;
    };
    // A thenable, like supabase-js's builders, so `await` and `Promise.all` both work.
    return {
      then: (onFulfilled, onRejected) =>
        (ms > 0 ? new Promise<Result>((r) => setTimeout(() => r(finish()), ms)) : Promise.resolve().then(finish)).then(
          onFulfilled,
          onRejected,
        ),
    };
  }

  private nextId(prefix: string): string {
    this.ids += 1;
    return `${prefix}-${this.ids}`;
  }

  private handleRpc(name: string, p: Record<string, unknown>): Result {
    const conversation = this.tables.conversations![0]!;
    switch (name) {
      case 'resolve_inbound':
        return ok([
          {
            business_id: conversation.business_id,
            phone_number_id: 'pn-1',
            contact_id: FAKE_CONTACT_ID,
            conversation_id: FAKE_CONVERSATION_ID,
            is_new_conversation: this.tables.messages!.length === 0,
          },
        ]);
      case 'append_message': {
        const providerId = (p.p_provider_message_id as string | null | undefined) ?? null;
        if (providerId !== null && this.seenProviderIds.has(providerId)) {
          return ok([{ message_id: this.seenProviderIds.get(providerId), was_created: false }]);
        }
        const id = this.nextId('m');
        if (providerId !== null) this.seenProviderIds.set(providerId, id);
        this.tables.messages!.push({
          id,
          conversation_id: p.p_conversation_id,
          direction: p.p_direction,
          sender: p.p_sender,
          body: p.p_body,
          created_at: new Date().toISOString(),
          provider_message_id: providerId,
          metadata: p.p_metadata ?? {},
        });
        conversation.message_count = (conversation.message_count as number) + 1;
        if (p.p_direction === 'outbound' && p.p_sender === 'ai') {
          conversation.ai_turn_count = (conversation.ai_turn_count as number) + 1;
        }
        return ok([{ message_id: id, was_created: true }]);
      }
      case 'request_handover':
        conversation.status = 'waiting_for_human';
        conversation.ai_enabled = false;
        conversation.handover_at = new Date().toISOString();
        conversation.handover_reason_code = p.p_reason;
        return ok(null);
      case 'enqueue_notification':
        return ok(1);
      case 'upsert_lead': {
        const id = this.nextId('lead');
        this.tables.leads!.push({ id, conversation_id: p.p_conversation_id });
        return ok(id);
      }
      default:
        throw new Error(`FakeSupabase: unsupported rpc '${name}'`);
    }
  }
}

function ok(data: unknown, count: number | null = null): Result {
  return { data, error: null, count };
}

/** The value at `column`, following supabase-js's `a->>b` JSON path form. */
function valueAt(row: Row, column: string): unknown {
  const [head, ...path] = column.split('->>');
  let value: unknown = row[head!];
  for (const key of path) value = (value as Row | null | undefined)?.[key];
  return value;
}

/** The chainable half: `from(table)` followed by filters, then awaited. */
class FakeQuery implements PromiseLike<Result> {
  private op: 'select' | 'insert' | 'update' = 'select';
  private payload: Row | null = null;
  private head = false;
  private wantsCount = false;
  private shape: 'many' | 'single' | 'maybeSingle' = 'many';
  private readonly filters: RecordedCall['filters'] = [];
  private ordering: { column: string; ascending: boolean } | null = null;
  private max: number | null = null;
  private started: PromiseLike<Result> | null = null;

  private readonly db: FakeSupabase;
  private readonly table: string;

  constructor(db: FakeSupabase, table: string) {
    this.db = db;
    this.table = table;
  }

  select(_columns?: string, options?: { count?: 'exact'; head?: boolean }): this {
    // After an insert or update, `.select()` only asks for the written row back.
    if (this.op === 'select') {
      this.head = options?.head ?? false;
      this.wantsCount = options?.count === 'exact';
    }
    return this;
  }
  insert(row: Row): this {
    this.op = 'insert';
    this.payload = row;
    return this;
  }
  update(row: Row): this {
    this.op = 'update';
    this.payload = row;
    return this;
  }
  eq(column: string, value: unknown): this {
    this.filters.push({ column, op: 'eq', value });
    return this;
  }
  like(column: string, value: string): this {
    this.filters.push({ column, op: 'like', value });
    return this;
  }
  is(column: string, value: unknown): this {
    this.filters.push({ column, op: 'is', value });
    return this;
  }
  order(column: string, options: { ascending?: boolean } = {}): this {
    this.ordering = { column, ascending: options.ascending ?? true };
    return this;
  }
  limit(n: number): this {
    this.max = n;
    return this;
  }
  single<T = unknown>(): PromiseLike<Result & { data: T | null }> {
    this.shape = 'single';
    return this as unknown as PromiseLike<Result & { data: T | null }>;
  }
  maybeSingle<T = unknown>(): PromiseLike<Result & { data: T | null }> {
    this.shape = 'maybeSingle';
    return this as unknown as PromiseLike<Result & { data: T | null }>;
  }

  then<R1 = Result, R2 = never>(
    onFulfilled?: ((value: Result) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    this.started ??= this.db.run(
      `from:${this.table}:${this.op}`,
      this.payload,
      this.filters,
      () => this.execute(),
    );
    return this.started.then(onFulfilled, onRejected);
  }

  private matches(row: Row): boolean {
    return this.filters.every((f) => {
      const actual = valueAt(row, f.column);
      if (f.op === 'eq') return actual === f.value;
      if (f.op === 'is') return actual === f.value;
      const prefix = String(f.value).replace(/%$/, '');
      return typeof actual === 'string' && actual.startsWith(prefix);
    });
  }

  private execute(): Result {
    const rows = this.db.tables[this.table]!;

    if (this.op === 'insert') {
      const row = { id: `${this.table}-${rows.length + 1}`, ...this.payload };
      rows.push(row);
      return this.shaped([row]);
    }

    let found = rows.filter((r) => this.matches(r));
    if (this.op === 'update') {
      for (const row of found) Object.assign(row, this.payload);
      return this.shaped(found);
    }

    if (this.ordering) {
      const { column, ascending } = this.ordering;
      found = found.slice().sort((a, b) => {
        const x = String(valueAt(a, column) ?? '');
        const y = String(valueAt(b, column) ?? '');
        return ascending ? x.localeCompare(y) : y.localeCompare(x);
      });
    }
    if (this.max !== null) found = found.slice(0, this.max);
    if (this.head) return ok(null, found.length);
    return this.shaped(found, found.length);
  }

  private shaped(rows: Row[], count: number | null = null): Result {
    if (this.shape === 'many') return ok(rows, this.wantsCount ? count : null);
    if (rows.length === 1) return ok(rows[0]);
    if (this.shape === 'maybeSingle' && rows.length === 0) return ok(null);
    // PostgREST's own wording and code for "not exactly one row".
    return {
      data: null,
      error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' },
    };
  }
}

/**
 * The seeded VOLTA tenant (supabase/seed.sql) as one row of `business_ai_context`: an
 * electrical contractor in Essex whose assistant is called Amy. Settings carry the live
 * defaults (Gemini, handover on); pass overrides to change a setting for one test.
 */
export function voltaContext(settings: Partial<BusinessContext['settings']> = {}): BusinessContext {
  const area = (name: string, prefixes: string[]) => ({
    name,
    postcode_prefixes: prefixes,
    radius_miles: null,
    notes: null,
  });
  const day = (d: number, opens: string | null, closes: string | null) => ({
    day_of_week: d,
    opens_at: opens,
    closes_at: closes,
    is_closed: opens === null,
  });

  return {
    business_id: FAKE_BUSINESS_ID,
    slug: 'volta',
    name: 'VOLTA Electrical Contractors',
    status: 'active',
    timezone: 'Europe/London',
    locale: 'en-GB',
    default_region: 'GB',
    currency: 'GBP',
    profile: {
      legal_name: 'Volta Electrical Contractors Ltd (demo)',
      trading_name: 'VOLTA',
      tagline: 'Electrical, wired properly.',
      description: 'Certified electricians for rewires, EV chargers, lighting and consumer units.',
      industry: 'Electrical services',
      founded_year: null,
      website_url: 'https://volta-electric-demo.vercel.app',
      email: 'hello@volta.example',
      phone: FAKE_TO_NUMBER,
      city: 'Southend-on-Sea',
      region: 'Essex',
      postcode: null,
      tone_of_voice: 'warm, professional, plain-spoken; no jargon; never pushy',
      ai_assistant_name: 'Amy',
      greeting_template: null,
      voice_greeting_template: null,
      signature: null,
      custom_instructions:
        'Electrical emergencies first. We cover Southend, Rayleigh, Basildon, Wickford, Chelmsford, Brentwood, Billericay, Rochford, Benfleet, Canvey, Maldon and Braintree.',
    } as unknown as BusinessContext['profile'],
    settings: {
      ai_provider: 'google',
      ai_model: 'gemini-3.8-flash',
      ai_effort: 'low',
      ai_max_output_tokens: 1024,
      ai_temperature: null,
      extraction_provider: 'google',
      extraction_model: 'gemini-3.8-flash',
      ai_enabled: true,
      ai_max_turns: 20,
      max_sms_segments: 3,
      handover_enabled: true,
      handover_keywords: [],
      handover_on_emergency: true,
      handover_on_complaint: true,
      handover_confusion_threshold: 3,
      handover_sla_minutes: 30,
      notify_events: [],
      notify_channels: [],
      booking_enabled: false,
      ...settings,
    } as unknown as BusinessContext['settings'],
    services: [
      {
        id: 's-1',
        name: 'Sockets & repairs',
        description: 'Extra sockets, faulty circuits, tripping breakers.',
        category: null,
        price_text: 'from £90',
        duration_minutes: null,
        is_bookable: true,
      },
      {
        id: 's-2',
        name: 'EV chargers',
        description: 'Home and workplace charge points.',
        category: null,
        price_text: 'from £900',
        duration_minutes: null,
        is_bookable: true,
      },
    ],
    service_areas: [
      area('Southend', ['SS0', 'SS1', 'SS2', 'SS3']),
      area('Rayleigh', ['SS6']),
      area('Basildon', ['SS13', 'SS14', 'SS15', 'SS16']),
    ],
    opening_hours: [
      day(0, null, null),
      day(1, '08:00', '17:00'),
      day(2, '08:00', '17:00'),
      day(3, '08:00', '17:00'),
      day(4, '08:00', '17:00'),
      day(5, '08:00', '17:00'),
      day(6, '09:00', '13:00'),
    ],
    knowledge: [
      {
        id: 'kn-1',
        kind: 'policy',
        title: 'Where do you work?',
        content: 'Southend, Rayleigh, Basildon, Wickford, Chelmsford and the surrounding area.',
      },
    ],
    phone_numbers: [{ e164: FAKE_TO_NUMBER, channels: ['sms', 'voice'], is_primary: true }],
  };
}
