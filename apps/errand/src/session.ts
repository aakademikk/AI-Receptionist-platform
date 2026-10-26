import type { Brief } from './brief.ts';
import { MAX_CALL_S, MAX_LENGTH_LEAD_MS, OPENING_LINE, PLAY_MS_MIN, PLAY_MS_PER_WORD, errandHome, maskSid } from './config.ts';
import { renderWindow } from './readback.ts';
import { appendEvent, appendTranscript, isErrandId, readBrief, writeOutcome } from './store.ts';
import { type ModelFn, type TurnEnd, type TurnState, newTurnState, nextTurn } from './turn.ts';

/**
 * One errand call's socket session (must-dos 8, 12, 13, 14, 17; fact F1).
 *
 * Twilio's ConversationRelay opens `/errand/ws` once the call instructions have chosen a
 * person or a voicemail, and this class runs that one call. It declares its own frame types
 * (facts B3: the errand package must not import the relay's) and knows nothing about the
 * receptionist.
 *
 *  * **Person mode waits.** Nothing is sent until the other side's first final prompt: Amy
 *    lets the person who answered speak first (must-do 8), and the TwiML has no welcome
 *    greeting for the same reason. Each final prompt is one turn through the engine; partial
 *    prompts are ignored. Turns run one at a time, in order, so a quick second utterance
 *    cannot overtake the answer to the first.
 *  * **Menus are keys.** A decision with digits sends a `sendDigits` frame after the line (fact
 *    F1), and logs a `digits` event. Keys pressed on the line arrive as `dtmf` frames and are
 *    logged too.
 *  * **Voicemail mode speaks once.** One message — the opening line, the request, Colin's mobile
 *    to call back — then `end` after it has had time to play. Every prompt is ignored: no
 *    back-and-forth with a machine (must-do 14).
 *  * **An ending is spoken, then ended.** Twilio gives no "finished speaking" signal for a
 *    text token, so the session waits a fixed allowance per word before sending `end`.
 *  * **Maximum length.** Ten seconds before the 8-minute limit the session says a polite
 *    ring-off line and ends with outcome "ended early: maximum length". Twilio's `TimeLimit`
 *    is the hard stop behind it. A socket that drops with no outcome is settled by the
 *    status callback (T17).
 *
 * Every line either side says goes to the transcript with its time; every decision that
 * ends the call writes the outcome once (the store refuses a second). The session never
 * sends Telegram: the status callback reports, once (T17).
 */

export type InboundFrame =
  | { type: 'setup'; callSid?: string; customParameters?: Record<string, string> }
  | { type: 'prompt'; voicePrompt?: string; last?: boolean; lang?: string }
  | { type: 'dtmf'; digit?: string }
  | { type: 'interrupt'; utteranceUntilInterrupt?: string; durationUntilInterruptMs?: number }
  | { type: 'error'; description?: string }
  | { type: string; [key: string]: unknown };

export type OutboundFrame = { type: 'text'; token: string; last: true } | { type: 'sendDigits'; digits: string } | { type: 'end' };

export const MAX_LENGTH_LINE = "I'm sorry, I'll have to leave it there. Colin will be in touch directly. Thank you, goodbye.";

export interface SessionDeps {
  send: (frame: OutboundFrame) => void;
  model: ModelFn;
  home?: string;
  now?: () => Date;
}

/** How long a line is given to play before the session ends the call. */
export function playAllowanceMs(line: string): number {
  const words = line.split(/\s+/).filter(Boolean).length;
  return Math.max(PLAY_MS_MIN, words * PLAY_MS_PER_WORD);
}

/** The one voicemail message: opening line, the request in one sentence, the callback number. */
export function voicemailMessage(brief: Brief): string {
  return `${OPENING_LINE} I'm calling to ${brief.goal}, ${renderWindow(brief.window)}. Please call Colin back on ${brief.contact.mobile}. Thank you, goodbye.`;
}

export class ErrandSession {
  private readonly home: string;
  private readonly now: () => Date;
  private errandId: string | null = null;
  private mode: 'person' | 'voicemail' | null = null;
  private state: TurnState | null = null;
  private ended = false;
  private chain: Promise<void> = Promise.resolve();
  private maxTimer: ReturnType<typeof setTimeout> | undefined;
  private endTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly deps: SessionDeps;

  constructor(deps: SessionDeps) {
    this.deps = deps;
    this.home = deps.home ?? errandHome();
    this.now = deps.now ?? (() => new Date());
  }

  /** Handle one frame. Frames are processed in arrival order; the promise settles when this one is done. */
  handle(frame: InboundFrame): Promise<void> {
    this.chain = this.chain.then(() => this.process(frame)).catch(() => undefined);
    return this.chain;
  }

  get isEnded(): boolean {
    return this.ended;
  }

  dispose(): void {
    clearTimeout(this.maxTimer);
    clearTimeout(this.endTimer);
    if (this.errandId && !this.ended) {
      try {
        appendEvent(this.errandId, { kind: 'socket_closed' }, this.now(), this.home);
      } catch {
        // The folder may be gone (pruned, or a test's temp folder). A close must never throw.
      }
    }
    this.ended = true;
  }

  private event(kind: string, fields: Record<string, unknown> = {}): void {
    if (this.errandId) appendEvent(this.errandId, { kind, ...fields }, this.now(), this.home);
  }

  private say(line: string): void {
    this.deps.send({ type: 'text', token: line, last: true });
    if (this.errandId) appendTranscript(this.errandId, 'amy', line, this.now(), this.home);
  }

  /** Settle the outcome, let the last line play, then end the call. */
  private finish(end: TurnEnd, lastLine: string): void {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.maxTimer);
    if (this.errandId) writeOutcome(this.errandId, { ...end, source: 'session', at: this.now().toISOString() }, this.home);
    this.event('session_end', { outcome: end.kind, limit: end.limit ?? null });
    this.endTimer = setTimeout(() => this.deps.send({ type: 'end' }), playAllowanceMs(lastLine));
  }

  private async process(frame: InboundFrame): Promise<void> {
    if (frame.type === 'setup') return this.setup(frame as Extract<InboundFrame, { type: 'setup' }>);
    if (!this.errandId) return;
    if (frame.type === 'dtmf') return this.event('dtmf_in', { digit: typeof frame.digit === 'string' ? frame.digit : null });
    if (frame.type === 'interrupt') return this.event('interrupted');
    if (frame.type === 'error') return this.event('relay_error', { description: typeof frame.description === 'string' ? frame.description : null });
    if (frame.type !== 'prompt' || this.ended || this.mode !== 'person' || !this.state) return;
    const prompt = frame as Extract<InboundFrame, { type: 'prompt' }>;
    if (prompt.last !== true) return;
    const words = (prompt.voicePrompt ?? '').trim();
    if (!words) return;

    appendTranscript(this.errandId, 'them', words, this.now(), this.home);
    const result = await nextTurn(this.state, words, { model: this.deps.model });
    if (this.ended) return;
    if (result.guarded?.length) this.event('guarded', { guards: result.guarded });
    if (result.droppedDigits) this.event('digits_dropped', { dropped: result.droppedDigits });
    if (result.say) this.say(result.say);
    if (result.digits) {
      this.deps.send({ type: 'sendDigits', digits: result.digits });
      this.event('digits', { digits: result.digits });
    }
    if (result.end) this.finish(result.end, result.say);
  }

  private setup(frame: Extract<InboundFrame, { type: 'setup' }>): void {
    if (this.errandId || this.ended) return;
    const params = frame.customParameters ?? {};
    const id = params.errandId;
    const brief = isErrandId(id) ? readBrief(id, this.home) : null;
    if (!brief || !isErrandId(id)) {
      // An unknown errand ends at once: there is nothing Amy could say on its behalf.
      this.ended = true;
      this.deps.send({ type: 'end' });
      return;
    }
    this.errandId = id;
    this.mode = params.mode === 'voicemail' ? 'voicemail' : 'person';
    this.event('session_start', { mode: this.mode, answeredBy: params.answeredBy ?? null, callSid: maskSid(frame.callSid) });

    this.maxTimer = setTimeout(() => {
      if (this.ended) return;
      this.say(MAX_LENGTH_LINE);
      this.finish({ kind: 'ended_early', limit: 'maximum length', offeredTimes: [...(this.state?.offeredTimes ?? [])] }, MAX_LENGTH_LINE);
    }, MAX_CALL_S * 1000 - MAX_LENGTH_LEAD_MS);
    // The server keeps the process alive during a call; this timer alone must not.
    (this.maxTimer as { unref?: () => void }).unref?.();

    if (this.mode === 'voicemail') {
      const message = voicemailMessage(brief);
      this.say(message);
      this.finish({ kind: 'voicemail_left' }, message);
      return;
    }
    this.state = newTurnState(brief);
  }
}
