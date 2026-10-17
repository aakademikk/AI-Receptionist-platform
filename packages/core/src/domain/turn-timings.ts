/**
 * Per-stage timings for one voice turn.
 *
 * Colin needs to see where the milliseconds go between the caller finishing a sentence
 * and the reply being ready, so that he can choose between streaming the first sentence
 * and trimming the prompt on evidence. The stages live in three files (`voice.ts`,
 * `pipeline.ts`, `reply.ts`), so one timer is created by `replyToCaller` and passed down;
 * each place that owns a stage wraps it in `time`.
 *
 * Two rules keep the output honest. A stage that does not run on a turn is absent, never
 * zero, so a canned goodbye does not drag the model's average down. And nothing but
 * numbers, booleans and the fixed `kind` words may be recorded: the line is written to
 * the journal, and caller words, reply text and phone numbers must never reach it.
 */

/** The fixed set of stage names. A union rather than a string so a typo cannot add a column. */
export type TurnStage =
  | 'resolve_inbound'
  | 'append_inbound'
  | 'load_context_memory'
  | 'confusion_update'
  | 'callback_lookup'
  | 'prompt_build'
  | 'gemini_first_token'
  | 'gemini_last_token'
  | 'record_ai_log'
  | 'record_assistant_turn'
  | 'total';

export type TurnNoteKey = 'prompt_tokens' | 'visible_tokens' | 'thinking_tokens' | 'kind';

/** How the turn was answered, for telling a model turn from a fixed line in the journal. */
export type TurnKind = 'model' | 'canned' | 'handover' | 'muted' | 'duplicate' | 'failed';

export interface TurnTimerSnapshot {
  /** Milliseconds per stage that ran. */
  stages: Partial<Record<TurnStage, number>>;
  notes: Partial<Record<TurnNoteKey, number | string | boolean | null>>;
}

export interface TurnTimer {
  /** Await `fn` and record how long it took, even when it throws. Returns what `fn` returns. */
  time<T>(stage: TurnStage, fn: () => PromiseLike<T> | T): Promise<T>;
  /** Record a duration measured elsewhere (for example the streamed first-token time). */
  set(stage: TurnStage, ms: number): void;
  note(key: TurnNoteKey, value: number | string | boolean | null): void;
  snapshot(): TurnTimerSnapshot;
}

export function createTurnTimer(now: () => number = () => performance.now()): TurnTimer {
  const stages: TurnTimerSnapshot['stages'] = {};
  const notes: TurnTimerSnapshot['notes'] = {};

  return {
    async time(stage, fn) {
      const start = now();
      try {
        return await fn();
      } finally {
        stages[stage] = now() - start;
      }
    },
    set(stage, ms) {
      stages[stage] = ms;
    },
    note(key, value) {
      notes[key] = value;
    },
    snapshot() {
      return { stages: { ...stages }, notes: { ...notes } };
    },
  };
}

/**
 * Run `fn` under `timer` when there is one, and plainly when there is not, so the
 * pipeline's callers that do not time anything (SMS, the eval runner) behave as before.
 */
export function timed<T>(
  timer: TurnTimer | undefined,
  stage: TurnStage,
  fn: () => PromiseLike<T> | T,
): Promise<T> {
  return timer ? timer.time(stage, fn) : Promise.resolve(fn());
}
