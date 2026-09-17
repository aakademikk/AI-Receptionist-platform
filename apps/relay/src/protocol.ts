/**
 * The ConversationRelay message protocol and the turn logic.
 *
 * Twilio sends JSON frames down the socket and we send JSON frames back. Everything in
 * this file is pure in the sense that matters: it touches no socket, no database and no
 * network of its own. The one thing it does reach for is the reply function it was handed
 * at construction, which is what makes the turn logic testable without a phone call — a
 * test injects a fake and gets a whole conversation's worth of behaviour to assert on.
 *
 * Four asymmetries in the protocol shape everything here:
 *
 *  * **Inbound frames are untrusted input.** They come off a network socket. A frame we
 *    cannot parse is logged and dropped, never thrown — an exception here would kill the
 *    socket and end a live call. Twilio tolerates being sent nothing; it does not
 *    tolerate being sent rubbish (ten consecutive unidentifiable messages and it closes
 *    the socket with 1007), so silence is always the safe failure.
 *  * **`prompt` frames arrive in two flavours.** Interim results carry `last: false` and
 *    final ones `last: true`. Replying to an interim result means talking over the caller
 *    every time they pause mid-sentence, which is the single most obviously-broken thing
 *    a voice assistant can do. Only a final frame earns a reply.
 *  * **A reply is slower than the caller.** Composing one takes a model round trip, and
 *    callers do not wait. `interrupt` and a second final prompt both mean a turn in
 *    flight is no longer worth speaking, and the session has to notice — see `pendingTurn`.
 *  * **The id has to be minted here.** Twilio sends text, not a message SID. See the
 *    relay's `server.ts`, which is where `callSid:turn` is built.
 */

/** A frame Twilio sends us. Every field is optional except `type` — see the parser. */
export interface InboundFrame {
  type: string;
  [key: string]: unknown;
}

export interface SetupFrame extends InboundFrame {
  type: 'setup';
  sessionId?: string;
  callSid?: string;
  from?: string;
  to?: string;
  callType?: string;
  direction?: string;
  customParameters?: Record<string, string>;
}

export interface PromptFrame extends InboundFrame {
  type: 'prompt';
  voicePrompt?: string;
  lang?: string;
  last?: boolean;
}

/** A frame we send Twilio. */
export type OutboundFrame =
  | { type: 'text'; token: string; last?: boolean; lang?: string }
  | { type: 'sendDigits'; digits: string }
  | { type: 'end'; handoffData?: string };

/**
 * Parse a socket payload into a frame.
 *
 * Returns `null` rather than throwing for anything that is not a JSON object with a
 * string `type`. The caller logs the raw text at debug and carries on.
 */
export function parseFrame(raw: string): InboundFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;

  const frame = parsed as Record<string, unknown>;
  if (typeof frame.type !== 'string' || frame.type === '') return null;

  return frame as InboundFrame;
}

/**
 * Strip anything that could be read as markup out of a string before it goes back out as
 * a TTS token.
 *
 * `text` tokens are passed to the TTS provider, where SSML is live — so this is the last
 * thing between a model's output and control syntax in our outbound audio. `cleanForSpeech`
 * in core strips the same characters, and the duplication is deliberate rather than
 * redundant: that one guards the content and knows about markdown and lists, this one
 * guards the transport and knows about nothing at all. A frame can only leave here having
 * passed through this function, whichever branch produced it. `<` and `>` are not sounds;
 * losing them costs nothing.
 */
export function sanitiseForSpeech(text: string): string {
  return text.replace(/[<>]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * What the session needs to know to ask for a reply.
 *
 * Deliberately declared here rather than imported from `@atwood/core`, so that this
 * module's contract with the domain layer is a shape rather than a dependency. It cannot
 * drift out of step unnoticed: `server.ts` passes core's `replyToCaller` where a
 * `RelayReplyFn` is expected, so the two definitions are checked against each other on
 * every typecheck.
 */
export interface RelayReplyRequest {
  callSid: string;
  toNumber: string;
  fromNumber: string;
  /** What recognition produced, as text. */
  heard: string;
  /** 1-based, counted within this call. */
  turn: number;
}

export interface RelayReply {
  /** What to say. Empty means say nothing. */
  speak: string;
  /** True when the call should end once this has been spoken. */
  endCall: boolean;
}

export type RelayReplyFn = (request: RelayReplyRequest) => Promise<RelayReply>;

export interface RelaySessionOptions {
  /**
   * Caller turns before the session hangs up regardless of what the reply function says.
   *
   * **This is a backstop, not the product's limit.** The limit a tenant sets is
   * `ai_max_turns`, and it is enforced in the domain layer, which ends the call by asking
   * for it — the assistant winding the conversation up in words rather than the socket
   * cutting the line. This exists so that a bug in that logic cannot bill somebody for an
   * hour-long call, and it is set far above any real limit for that reason.
   */
  maxTurns?: number;
  /** The domain layer. Injected so the turn logic can be tested without one. */
  reply?: RelayReplyFn;
  /** Called for each event once parsed, for the call log. */
  onEvent?: (event: string, fields: Record<string, unknown>) => void;
}

const NO_REPLY: RelayReplyFn = async () => ({
  speak: 'Sorry, something has gone wrong at our end. Please try again shortly.',
  endCall: true,
});

/**
 * One call's worth of turn logic.
 *
 * Holds the call's identity from the `setup` frame, turns each final `prompt` into a
 * reply from the injected function, and decides when the call is over.
 */
export class RelaySession {
  private readonly maxTurns: number;
  private readonly reply: RelayReplyFn;
  private readonly onEvent: (event: string, fields: Record<string, unknown>) => void;

  private call: SetupFrame | null = null;
  private turns = 0;
  /**
   * The turn whose reply is still worth speaking; 0 when none is in flight.
   *
   * A reply takes a model round trip to compose, and the caller does not stop talking
   * while it does. Both a barge-in and a fresh final prompt mean the answer being
   * composed is now an answer to something the caller has moved on from, and speaking it
   * would be talking over them with a stale thought. Checking this after the await — rather
   * than trying to cancel the call, which the provider interface cannot do — is what keeps
   * that from happening.
   */
  private pendingTurn = 0;
  private ended = false;

  constructor(options: RelaySessionOptions = {}) {
    this.maxTurns = options.maxTurns ?? 40;
    this.reply = options.reply ?? NO_REPLY;
    this.onEvent = options.onEvent ?? (() => {});
  }

  /** True once we have told Twilio to end the call. */
  get isEnded(): boolean {
    return this.ended;
  }

  /**
   * Handle one inbound frame and return the frames to send back — often none.
   *
   * Asynchronous because a reply is, and the caller must not await it: awaiting would
   * queue every later frame behind a model call while Twilio keeps sending. Whoever
   * drives this is responsible for sending what it resolves to, and for tolerating the
   * fact that two frames may be in flight at once. Deciding which of them is still worth
   * sending is this class's job, not theirs.
   */
  async handle(frame: InboundFrame): Promise<OutboundFrame[]> {
    if (this.ended) {
      // Twilio should not send anything after an `end`, but a late prompt would
      // otherwise restart a call we have already finished.
      this.onEvent('frame_after_end', { type: frame.type });
      return [];
    }

    switch (frame.type) {
      case 'setup':
        return this.handleSetup(frame as SetupFrame);
      case 'prompt':
        return this.handlePrompt(frame as PromptFrame);
      case 'interrupt':
        /*
         * Barge-in. Twilio stopped the audio itself and is telling us it did, so there is
         * no frame to send — but there may be a reply mid-flight, and that one must not
         * be spoken. Clearing `pendingTurn` is what discards it.
         *
         * Logged because this is the proof that barge-in works, and it is invisible
         * otherwise: the caller hears their interruption take effect, but nothing in the
         * call record shows it.
         */
        this.onEvent('interrupt', {
          utteranceUntilInterrupt: frame.utteranceUntilInterrupt,
          durationUntilInterruptMs: frame.durationUntilInterruptMs,
          discardedTurn: this.pendingTurn || null,
        });
        this.pendingTurn = 0;
        return [];

      case 'dtmf':
        // Detection is off in our TwiML, so this should not arrive. If it does, say so
        // rather than silently dropping a keypress the caller believed they sent.
        this.onEvent('dtmf', { digit: frame.digit });
        return [];

      case 'error':
        this.onEvent('twilio_error', { description: frame.description });
        return [];

      default:
        this.onEvent('unhandled_frame', { type: frame.type });
        return [];
    }
  }

  private handleSetup(frame: SetupFrame): OutboundFrame[] {
    /*
     * Nothing is spoken here. The greeting is in the TwiML's `welcomeGreeting`, so it
     * plays even if this socket never connects — which means a caller never gets dead
     * air from an infrastructure failure. It also makes the first socket-sent turn a
     * distinct signal: you hear the greeting and know TwiML worked, then you hear the
     * reply and know the socket did.
     */
    this.call = frame;

    this.onEvent('setup', {
      sessionId: frame.sessionId,
      callSid: frame.callSid,
      from: frame.from,
      to: frame.to,
      callType: frame.callType,
      direction: frame.direction,
      customParameters: frame.customParameters ?? {},
    });
    return [];
  }

  private async handlePrompt(frame: PromptFrame): Promise<OutboundFrame[]> {
    const text = typeof frame.voicePrompt === 'string' ? frame.voicePrompt : '';

    if (frame.last !== true) {
      // An interim result. Logged, never answered — see the file header.
      this.onEvent('prompt_partial', { text });
      return [];
    }

    this.turns += 1;
    const turn = this.turns;
    this.onEvent('prompt_final', { text, turn });

    if (!this.call) {
      /*
       * A prompt before the setup frame, which Twilio does not send. There is no call
       * identity, so there is nothing to resolve a tenant from and no idempotency key to
       * mint. Silence is the protocol's safe failure — see the file header — and
       * inventing a line here would put copy in the transport layer, which is the thing
       * this file exists not to do.
       */
      this.onEvent('prompt_before_setup', { turn });
      return [];
    }

    this.pendingTurn = turn;

    const reply = await this.reply({
      callSid: this.call.callSid ?? '',
      toNumber: this.call.to ?? '',
      fromNumber: this.call.from ?? '',
      heard: text,
      turn,
    });

    if (this.pendingTurn !== turn) {
      // Superseded while we were composing. See `pendingTurn`.
      this.onEvent('turn_superseded', { turn, pendingTurn: this.pendingTurn });
      return [];
    }
    this.pendingTurn = 0;

    const messages: OutboundFrame[] = [];
    const token = sanitiseForSpeech(reply.speak);

    if (token === '') {
      // Twilio rejects an empty `text` token outright. Saying nothing is the safe
      // failure; sending an empty one is a protocol error that ends the call.
      this.onEvent('empty_reply', { turn });
    } else {
      messages.push({ type: 'text', token, last: true });
    }

    this.onEvent('turn_answered', { turn, endCall: reply.endCall, spokenChars: token.length });

    if (reply.endCall || this.turns >= this.maxTurns) {
      this.ended = true;
      messages.push({ type: 'end' });
      this.onEvent('session_end', {
        turns: this.turns,
        reason: reply.endCall ? 'domain' : 'hard_turn_limit',
      });
    }

    return messages;
  }
}
