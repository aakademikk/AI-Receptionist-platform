import { GoogleProvider, type ChatMessage } from '@atwood/core/ai';

import type { Brief } from './brief.ts';
import {
  CONFUSED_LIMIT,
  ERRAND_EFFORT,
  ERRAND_MAX_OUTPUT_TOKENS,
  ERRAND_MODEL,
  MODEL_TIMEOUT_MS,
  OPENING_LINE,
  TURN_CAP,
} from './config.ts';
import { checkAgreedTime, checkAmyLine, checkTheirWords } from './guardrails.ts';
import { DECISION_SCHEMA, type ModelDecision, buildErrandPrompt } from './prompt.ts';
import type { EarlyLimit, OutcomeKind } from './store.ts';

/**
 * The turn engine (must-dos 8, 9, 12, 13, 15; OPEN 3, OPEN 10, OPEN 17).
 *
 * One call to `nextTurn` per thing the other side says. The model proposes; code disposes.
 * In order:
 *
 *   1. the turn is counted (menu steps included, must-do 13);
 *   2. a payment ask in their words ends the call politely *before* the model is asked —
 *      outcome "ended early: payment asked" (must-do 11);
 *   3. the model is asked, with an 8-second limit; a timeout or error gets a fixed line, the
 *      call ends, and the outcome is "failed" (Robustness);
 *   4. any time the model agreed or heard offered is held to the window (must-do 9), and the
 *      line Amy is about to say is checked for personal details and extras (must-dos 10, 15);
 *   5. two turns in a row Amy cannot place end the call — "ended early: confused" — and the
 *      twentieth turn ends it — "ended early: turn cap" (must-do 12);
 *   6. digits are filtered to `0-9*#`; anything else is dropped and reported.
 *
 * Disclosure is code too (must-do 8): Amy's first spoken line always starts with the opening
 * line, and when she is asked whether she is a person the answer says "automated assistant".
 * A model that leaves either out gets it prefixed.
 *
 * The engine is pure apart from the injected model, so every rule is tested with a fake.
 */

/** A decision's outcome when it ends the call. The session writes it (T16). */
export interface TurnEnd {
  kind: OutcomeKind;
  limit?: EarlyLimit;
  reason?: string;
  agreedTime?: string;
  date?: string;
  nameBookedUnder?: string;
  reference?: string;
  offeredTimes?: string[];
}

export interface TurnResult {
  say: string;
  digits?: string;
  /** Characters the model asked for that are not keypad digits; dropped and logged. */
  droppedDigits?: string;
  /** Present when the call must end after this line. */
  end?: TurnEnd;
  /** Which guard changed the model's line, for the event log. */
  guarded?: string[];
}

export interface TurnState {
  brief: Brief;
  turns: number;
  confusedInRow: number;
  /** True once Amy has said a non-empty line; the first one carries the opening line. */
  spoken: boolean;
  offeredTimes: string[];
  agreedTime?: string;
  history: ChatMessage[];
}

/** The model as the engine sees it: system prompt and history in, a decision object out. */
export type ModelFn = (input: { system: string; messages: ChatMessage[] }) => Promise<unknown>;

export const PAYMENT_LINE = "I'm sorry, I'm not able to take any payment or card details. Colin will be in touch directly. Thank you, goodbye.";
export const FAILED_LINE = "Sorry, I'll have to call back another time. Goodbye.";
export const CONFUSED_LINE = "I'm sorry, I'm having trouble following. Colin will be in touch directly. Thank you, goodbye.";
export const TURN_CAP_LINE = "I'm sorry, I'll have to leave it there. Colin will be in touch directly. Thank you, goodbye.";
export const AUTOMATED_PREFIX = "I'm an automated assistant.";

const ASKED_IF_PERSON = /\b(real person|a person|human|robot|a machine|computer|automated|a bot|an ai|artificial)\b/i;

export function newTurnState(brief: Brief): TurnState {
  return { brief, turns: 0, confusedInRow: 0, spoken: false, offeredTimes: [], history: [] };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('model timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function asDecision(value: unknown): ModelDecision | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.say !== 'string') return null;
  const strings = (input: unknown): string[] | undefined =>
    Array.isArray(input) ? input.filter((item): item is string => typeof item === 'string') : undefined;
  return {
    say: record.say,
    digits: typeof record.digits === 'string' ? record.digits : undefined,
    agreedTime: typeof record.agreedTime === 'string' ? record.agreedTime : undefined,
    offeredTimes: strings(record.offeredTimes),
    reference: typeof record.reference === 'string' ? record.reference : undefined,
    nameBookedUnder: typeof record.nameBookedUnder === 'string' ? record.nameBookedUnder : undefined,
    done: record.done === 'booked' || record.done === 'not_booked' ? record.done : undefined,
    reason: typeof record.reason === 'string' ? record.reason : undefined,
    cannotPlace: record.cannotPlace === true,
  };
}

/** Disclosure in code: the opening line first, and "automated assistant" when asked. */
function disclose(state: TurnState, say: string, theirWords: string): string {
  let line = say.trim();
  if (!line) return line;
  if (ASKED_IF_PERSON.test(theirWords) && !/automated assistant/i.test(line)) line = `${AUTOMATED_PREFIX} ${line}`;
  if (!state.spoken && !line.startsWith(OPENING_LINE)) line = `${OPENING_LINE} ${line}`;
  return line;
}

function finish(state: TurnState, theirWords: string, result: TurnResult): TurnResult {
  const say = disclose(state, result.say, theirWords);
  if (say) state.spoken = true;
  state.history.push({ role: 'assistant', content: say || (result.digits ? `[pressed ${result.digits}]` : '') });
  return { ...result, say };
}

export async function nextTurn(state: TurnState, theirWords: string, deps: { model: ModelFn }): Promise<TurnResult> {
  state.turns += 1;
  state.history.push({ role: 'user', content: theirWords });

  const payment = checkTheirWords(theirWords);
  if (payment.kind === 'payment') {
    return finish(state, theirWords, { say: PAYMENT_LINE, end: { kind: 'ended_early', limit: 'payment asked', reason: `asked for ${payment.matched}` } });
  }

  let decision: ModelDecision | null;
  try {
    decision = asDecision(await withTimeout(deps.model({ system: buildErrandPrompt(state.brief), messages: [...state.history] }), MODEL_TIMEOUT_MS));
  } catch {
    decision = null;
  }
  if (!decision) {
    return finish(state, theirWords, { say: FAILED_LINE, end: { kind: 'failed', reason: 'model timed out or failed' } });
  }

  const guarded: string[] = [];
  let say = decision.say;

  for (const time of decision.offeredTimes ?? []) {
    // Inside times are fine to hear; only outside ones are kept for the report.
    checkAgreedTime(time, state.brief.window, state.offeredTimes);
  }
  if (decision.agreedTime) {
    const agreed = checkAgreedTime(decision.agreedTime, state.brief.window, state.offeredTimes);
    if (agreed.ok) {
      state.agreedTime = agreed.time;
    } else {
      guarded.push('window');
      say = `I'm afraid ${agreed.offered} doesn't work for Colin. Is there anything between ${state.brief.window.earliest} and ${state.brief.window.latest}?`;
    }
  }

  const line = checkAmyLine(say, state.brief);
  if (!line.ok) {
    guarded.push(line.kind);
    say = line.replacement;
  }

  let digits: string | undefined;
  let droppedDigits: string | undefined;
  if (decision.digits) {
    digits = decision.digits.replace(/[^0-9*#]/g, '');
    const dropped = decision.digits.replace(/[0-9*#]/g, '');
    if (dropped) droppedDigits = dropped;
    if (!digits) digits = undefined;
  }

  state.confusedInRow = decision.cannotPlace ? state.confusedInRow + 1 : 0;
  if (state.confusedInRow >= CONFUSED_LIMIT) {
    return finish(state, theirWords, { say: CONFUSED_LINE, end: { kind: 'ended_early', limit: 'confused', offeredTimes: [...state.offeredTimes] }, guarded });
  }

  const base: TurnResult = { say, ...(digits ? { digits } : {}), ...(droppedDigits ? { droppedDigits } : {}), ...(guarded.length ? { guarded } : {}) };

  // Booked only with an agreed time inside the window; a 'booked' with none carries on talking.
  if (decision.done === 'booked' && state.agreedTime && !guarded.includes('window')) {
    return finish(state, theirWords, {
      ...base,
      end: {
        kind: 'booked',
        agreedTime: state.agreedTime,
        date: state.brief.window.date,
        nameBookedUnder: decision.nameBookedUnder ?? state.brief.contact.name,
        ...(decision.reference ? { reference: decision.reference } : {}),
      },
    });
  }
  if (decision.done === 'not_booked') {
    return finish(state, theirWords, {
      ...base,
      end: {
        kind: 'not_booked',
        reason: decision.reason ?? (state.offeredTimes.length ? 'only times outside the window were offered' : 'could not book inside the window'),
        offeredTimes: [...state.offeredTimes],
      },
    });
  }

  if (state.turns >= TURN_CAP) {
    return finish(state, theirWords, { say: TURN_CAP_LINE, end: { kind: 'ended_early', limit: 'turn cap', offeredTimes: [...state.offeredTimes] }, guarded });
  }

  return finish(state, theirWords, base);
}

/**
 * The live model: Amy's Gemini flash at low effort (OPEN 10; facts B6), through core's
 * `GoogleProvider`, asking for the decision as structured JSON. The key is read from the
 * environment where the service runs (`GOOGLE_API_KEY`, supplied by `with-secrets`), never logged.
 */
export function googleModel(apiKey: string, provider: Pick<GoogleProvider, 'generate'> = new GoogleProvider(apiKey)): ModelFn {
  return async ({ system, messages }) => {
    const result = await provider.generate({
      system,
      messages,
      model: ERRAND_MODEL,
      effort: ERRAND_EFFORT,
      maxOutputTokens: ERRAND_MAX_OUTPUT_TOKENS,
      jsonSchema: { name: 'errand_turn', schema: DECISION_SCHEMA as unknown as Record<string, unknown> },
      timeoutMs: MODEL_TIMEOUT_MS,
    });
    if (result.refusal || result.truncated) throw new Error('model refused or truncated');
    return result.json;
  };
}
