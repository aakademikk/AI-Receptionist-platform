import { getAdminClient } from '../supabase/admin.ts';
import type { HandoverReason } from '../types/domain.ts';
import { logger, newTraceId } from '../utils/logger.ts';
import { cleanForSpeech } from '../utils/speech.ts';
import {
  ANYTHING_ELSE_LINE,
  GOODBYE_LINE,
  decideCallerClosing,
  decideMutedTurn,
  isWrapUpLine,
} from './closing.ts';
import { handleInboundMessage, type HandleInboundMessageResult } from './pipeline.ts';

/**
 * One turn of a phone call.
 *
 * This is the seam between the relay, which knows about sockets and frames, and the
 * pipeline, which knows about customers and leads. The relay depends on this function
 * and on nothing else in the domain layer, so the relay's tests inject a fake and never
 * touch a model, a database or a network.
 *
 * Most of what happens here is `handleInboundMessage` with `channel: 'voice'`. The rest
 * is the four ways a phone call is not a text message:
 *
 *  1. **Nothing else records what the assistant said.** On SMS the composed reply is
 *     handed to a messaging workflow, which sends it and appends it to the conversation.
 *     A spoken turn has no sender to do that — we are the sender — so if this does not
 *     write it down, the transcript keeps only the caller's half. The model would then
 *     read a one-sided conversation and repeat itself, `ai_turn_count` would never
 *     advance, and the turn budget that ends a runaway call would never fire. See
 *     `recordAssistantTurn`.
 *  2. **Extraction is deferred.** The caller is listening; see `deferExtraction`.
 *  3. **The id has to be minted here.** Twilio sends text, not a message SID, so the
 *     idempotency key is built from the call and the turn.
 *  4. **Every failure has to say something.** A socket that emits no text frame leaves
 *     the caller in silence, unable to tell a fault from a pause. Hence the two lines
 *     below — templates rather than model output, for the same reason
 *     `renderHandoverMessage` is: when something has gone wrong, the words that cover it
 *     should be ones we chose in advance.
 */

/**
 * We could not place what was said.
 *
 * Reached only on a duplicate turn, which — since `append_message` gates the inbound
 * message on `callSid:turn` — means two frames arrived carrying the same turn number.
 * That is our bug, not the caller's, so the call stays up and they are asked again
 * rather than cut off for something they did not do.
 */
const DID_NOT_CATCH = 'Sorry, I did not quite catch that. Could you say it again?';

/**
 * The assistant cannot take this call, or the turn failed outright.
 *
 * Covers both the muted case (a person has taken the conversation over) and a pipeline
 * that threw. Neither can be recovered from on this line, and both end the call — but
 * not before telling the caller so, because a line that simply goes quiet reads as a
 * dropped call and they will ring back.
 */
const CANNOT_TAKE_CALL =
  "I'm sorry, I can't help with this one over the phone. I'll make sure a colleague picks it up with you.";

export interface VoiceTurnInput {
  /** The call this turn belongs to. Twilio's `CallSid`. */
  callSid: string;
  /** The number that was dialled, i.e. the tenant's. */
  toNumber: string;
  /** The caller's number, as Twilio reports it. */
  fromNumber: string;
  /** What recognition produced, as text. */
  heard: string;
  /** 1-based, counted within this call. */
  turn: number;
  /**
   * True once "anything else?" has been asked and heard on this call. The relay keeps it,
   * because the relay is what outlives a turn; see `closing.ts` for what it changes.
   */
  anythingElseAsked?: boolean;
  /**
   * True when the reply the caller is now answering was "anything else?" itself. Only then
   * is a bare "no" a request to end the call; see `decideCallerClosing`.
   */
  anythingElseJustAsked?: boolean;
  traceId?: string;
}

/**
 * What kind of turn this was, as far as the end of the call is concerned.
 *
 *  * `asked_anything_else` — the assistant asked "anything else?". The relay remembers
 *    it, so the question is never asked twice, and arms its silence backstop.
 *  * `wrapped_up` — the assistant signed off and the call is still open. The relay arms
 *    its silence backstop.
 *  * `none` — anything else, including a turn that ends the call.
 */
export type VoiceTurnClosing = 'asked_anything_else' | 'wrapped_up' | 'none';

export interface VoiceTurnResult {
  /** What to say. Never empty — a silent turn is a dropped call to the caller's ear. */
  speak: string;
  /** True when the call should end once this has been spoken. */
  endCall: boolean;
  traceId: string;
  /** Null when the turn failed before the tenant could be resolved. */
  businessId: string | null;
  conversationId: string | null;
  handover: HandoverReason | null;
  closing: VoiceTurnClosing;
}

export async function replyToCaller(input: VoiceTurnInput): Promise<VoiceTurnResult> {
  const traceId = input.traceId ?? newTraceId();

  /*
   * Decided from the caller's words before the pipeline runs, because the closing lines
   * replace the model call rather than follow it. The pipeline still records the turn and
   * still runs the escalation check first, so a handover beats a closing line below.
   */
  const closingDecision = decideCallerClosing({
    heard: input.heard,
    anythingElseAsked: input.anythingElseAsked ?? false,
    anythingElseJustAsked: input.anythingElseJustAsked ?? false,
  });
  const cannedReply =
    closingDecision === 'ask_anything_else'
      ? ANYTHING_ELSE_LINE
      : closingDecision === 'goodbye'
        ? GOODBYE_LINE
        : undefined;

  let result: HandleInboundMessageResult;
  try {
    result = await handleInboundMessage({
      toNumber: input.toNumber,
      fromNumber: input.fromNumber,
      body: input.heard,
      channel: 'voice',
      /*
       * Minted from the call and the turn because Twilio gives us no message SID down the
       * socket. `append_message` is idempotent on this, so a repeated frame cannot become
       * a second caller turn — and a second model call, and a second charge for one.
       */
      providerMessageId: `${input.callSid}:${input.turn}`,
      /*
       * Lets the pipeline tell a handover on this call from one on an earlier call: only
       * the first mutes this call. See `isMuteFromEarlierCall`.
       */
      callSid: input.callSid,
      deferExtraction: true,
      cannedReply,
      traceId,
    });
  } catch (error) {
    /*
     * The pipeline threw: no tenant, no database, or a provider that refused in a way
     * that propagated. None of those is recoverable on this call, and all of them are
     * invisible to the person holding the phone. Catch here rather than in the relay so
     * that the one place which knows what to say is also the one place that handles it.
     */
    logger.error('Voice turn failed', {
      traceId,
      callSid: input.callSid,
      turn: input.turn,
      message: error instanceof Error ? error.message : String(error),
    });

    return {
      speak: CANNOT_TAKE_CALL,
      endCall: true,
      traceId,
      businessId: null,
      conversationId: null,
      handover: null,
      closing: 'none',
    };
  }

  const base = {
    traceId,
    businessId: result.businessId,
    conversationId: result.conversationId,
    handover: result.handover?.reason ?? null,
  };

  if (!result.isNewMessage) {
    logger.warn('Duplicate voice turn', { traceId, callSid: input.callSid, turn: input.turn });
    return { ...base, speak: DID_NOT_CATCH, endCall: false, closing: 'none' };
  }

  if (!result.reply) {
    /*
     * The assistant is muted. On voice that only happens after a handover earlier on this
     * same call: a caller ringing back is answered (see `isMuteFromEarlierCall`).
     * On SMS a muted thread correctly produces no outbound message; on a call it would be
     * dead air, so the caller is told their details have been passed on.
     *
     * This used to hang up on the first answer with "I can't help with this one over the
     * phone", which is the wrong thing to say to someone who has just reported a fire, and
     * it cut them off at their first pause. Now the line stays open for one more answer;
     * see `decideMutedTurn`. The details are extracted by the pipeline on each such turn.
     *
     * No second notification is raised: the pipeline has already enqueued one for the
     * owner, and this turn adds nothing they do not have.
     */
    const muted = decideMutedTurn({ anythingElseJustAsked: input.anythingElseJustAsked ?? false });
    logger.info('Voice turn on a muted conversation', {
      traceId,
      conversationId: result.conversationId,
      endCall: muted.endCall,
    });
    return { ...base, ...muted };
  }

  await recordAssistantTurn(result, traceId);

  /*
   * The last guard before text becomes audio. `generateReply` has already shaped this
   * for speech, but the handover line and the refusal line did not go through it, and
   * this is also the only place that can promise the caller hears no markdown even if
   * a future branch forgets.
   */
  const speak = cleanForSpeech(result.reply.body) || CANNOT_TAKE_CALL;

  if (base.handover === null) {
    /*
     * The closing lines, and only when no handover happened: a caller who says "bye" in
     * the same breath as an emergency is handed over, and the handover's own rule below
     * decides whether the line closes. That rule is also what keeps `endCall` false while
     * `capturePending` is true, so nothing here can break it.
     */
    if (closingDecision === 'goodbye') {
      // They have nothing else. Say goodbye and close the line, with no silence wait.
      return { ...base, speak, endCall: true, closing: 'none' };
    }
    if (closingDecision === 'ask_anything_else') {
      return { ...base, speak, endCall: false, closing: 'asked_anything_else' };
    }
    return {
      ...base,
      speak,
      endCall: false,
      closing: isWrapUpLine(speak) ? 'wrapped_up' : 'none',
    };
  }

  return {
    ...base,
    speak,
    closing: 'none',
    /*
     * Handing over ends the call, because there is nothing further the assistant can
     * truthfully offer: the caller has been told a colleague will be in touch, and
     * exactly one of those two things is happening on this line. It is also where the
     * turn budget lands — a conversation out of turns is out of assistant.
     *
     * Except when there is something further to offer, which is the one case a handover
     * was ever wrong about: `capturePending` means the caller has been asked for their
     * details rather than told goodbye, so the line stays open for the answer. That answer
     * arrives on a muted conversation, so the `!result.reply` branch above takes it from
     * there (thank them, one more answer, then goodbye) — the capture does not need a
     * second branch here, it just needs this one not to hang up first.
     */
    endCall: base.handover !== null && !result.capturePending,
  };
}

/**
 * Write the assistant's own spoken turn into the conversation.
 *
 * See point 1 in the module header for what breaks without this. The trigger on
 * `messages` is what advances `ai_turn_count`, `last_ai_response` and the outbound
 * counters, so a row that never lands is a conversation whose numbers quietly stop
 * being true.
 *
 * `p_provider_message_id` is deliberately absent rather than invented. Nothing external
 * issued this message, and a made-up id would give the idempotency check in
 * `append_message` a meaning it does not have. The gate that matters is upstream: a
 * replayed frame never reaches here, because `isNewMessage` is false for it and
 * `replyToCaller` has already returned.
 *
 * Awaited rather than fired and forgotten, because the *next* turn's memory is loaded
 * from this table. The caller has to speak before there is a next turn, so an unawaited
 * write would nearly always win the race — and "nearly always" is not a standard to hold
 * the transcript a model is about to reason over.
 *
 * Failure is logged and swallowed. The caller has already heard the words; throwing now
 * would turn a slightly incomplete transcript into a dropped call.
 */
async function recordAssistantTurn(
  result: HandleInboundMessageResult,
  traceId: string,
): Promise<void> {
  const reply = result.reply;
  if (!reply) return;

  try {
    const { error } = await getAdminClient().rpc('append_message', {
      p_conversation_id: result.conversationId,
      p_direction: 'outbound',
      p_sender: reply.sender,
      p_body: reply.body,
      p_channel: reply.channel,
      p_provider: 'twilio',
      // Spoken, not queued. The default for an outbound message is `queued`, which for a
      // row written after the caller has already heard it is a lie the dashboard shows.
      p_status: 'delivered',
      p_ai_log_id: reply.aiLogId,
    });

    if (error) throw new Error(error.message);
  } catch (error) {
    logger.warn('Could not record the assistant turn', {
      traceId,
      conversationId: result.conversationId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
