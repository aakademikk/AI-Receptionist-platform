import { getAdminClient } from '../supabase/admin.ts';
import type { BusinessContext, CommsChannel, HandoverReason } from '../types/domain.ts';
import { logger, newTraceId } from '../utils/logger.ts';
import { loadBusinessContext, loadConversationMemory, needsSummarisation } from './context.ts';
import {
  detectHandover,
  needsDetailCapture,
  renderCaptureMessage,
  renderHandoverMessage,
  shouldIncrementConfusion,
} from './handover.ts';
import { extractLead, leadNotificationEvents } from './lead.ts';
import { composeHandoverBody, enqueueNotification } from './notify.ts';
import { generateReply, summariseConversation } from './reply.ts';
import { sourceForChannel } from './source.ts';
import { renderMissedCallSms } from '../prompts/receptionist.ts';
import { publicEnv } from '../env.ts';

/**
 * The two pipelines.
 *
 * `handleMissedCall` and `handleInboundMessage` are the whole product, expressed
 * as two functions. n8n calls one endpoint per pipeline; the orchestration —
 * ordering, escalation, extraction, notification — lives here in TypeScript where
 * it can be read top to bottom and tested.
 *
 * The alternative shape (n8n nodes wired together, one per step) was rejected
 * deliberately: the ordering decisions below are subtle, and expressing them as a
 * node graph puts the important logic in a place that cannot be unit-tested and is
 * painful to review in a pull request. n8n keeps what it is genuinely best at —
 * webhook ingestion, retries, scheduling, queueing, human-in-the-loop and
 * per-execution observability. See docs/03-n8n-workflows.md.
 *
 * Neither function sends anything. They return the message to send and let the
 * caller do the sending, which keeps them runnable in a test with no Twilio.
 */

export interface HandleMissedCallInput {
  toNumber: string;
  fromNumber: string;
  callSid?: string | null;
  callStatus?: string | null;
  startedAt?: string | null;
  traceId?: string;
}

export interface HandleMissedCallResult {
  traceId: string;
  businessId: string;
  conversationId: string;
  callId: string;
  /** False on a webhook retry — the caller must not send a second SMS. */
  isNewCall: boolean;
  /** The SMS to send, or null when the tenant has the follow-up disabled. */
  reply: { body: string; toNumber: string; fromNumber: string; channel: CommsChannel } | null
}

/**
 * Missed call → branded SMS.
 *
 * The message is templated rather than model-generated. It is the same text every
 * time, the owner has usually approved the wording, and the caller has just hung up
 * — spending a model round trip to reproduce a fixed string would add a second of
 * latency at the moment it is least affordable.
 */
export async function handleMissedCall(
  input: HandleMissedCallInput,
): Promise<HandleMissedCallResult> {
  const traceId = input.traceId ?? newTraceId();
  const supabase = getAdminClient();

  // One transactional call: routes the number to a tenant, upserts the contact,
  // opens or reuses the conversation, and logs the call — idempotently on callSid.
  const { data, error } = await supabase.rpc('record_missed_call', {
    p_to_number: input.toNumber,
    p_from_number: input.fromNumber,
    p_provider_call_sid: input.callSid ?? null,
    p_call_status: input.callStatus ?? 'no-answer',
    p_started_at: input.startedAt ?? new Date().toISOString(),
    p_metadata: {},
  });

  if (error) throw new Error(`record_missed_call failed: ${error.message}`);

  const row = (Array.isArray(data) ? data[0] : data) as {
    call_id: string;
    business_id: string;
    conversation_id: string;
    contact_id: string;
    was_created: boolean;
    sms_enabled: boolean;
  };

  const log = logger.child({
    traceId,
    businessId: row.business_id,
    conversationId: row.conversation_id,
  });

  const base = {
    traceId,
    businessId: row.business_id,
    conversationId: row.conversation_id,
    callId: row.call_id,
    isNewCall: row.was_created,
  };

  if (!row.was_created) {
    log.info('Duplicate missed-call webhook; not re-sending');
    return { ...base, reply: null };
  }

  const context = await loadBusinessContext(row.business_id);

  // Owner alert regardless of whether the follow-up SMS is enabled — a missed call
  // is itself the news.
  await enqueueNotification({
    businessId: row.business_id,
    event: 'missed_call',
    subject: 'Missed call',
    body: `Missed call from ${input.fromNumber}.`,
    payload: { customer_phone: input.fromNumber, conversation_id: row.conversation_id },
    conversationId: row.conversation_id,
    dedupeKey: `missed_call:${row.call_id}`,
  });

  if (!row.sms_enabled) {
    log.info('Missed-call SMS is disabled for this business');
    return { ...base, reply: null };
  }

  const primary = context.phone_numbers.find((n) => n.channels.includes('sms'));
  if (!primary) {
    log.warn('No SMS-capable number configured; cannot send the follow-up');
    return { ...base, reply: null };
  }

  return {
    ...base,
    reply: {
      body: renderMissedCallSms(context),
      toNumber: input.fromNumber,
      fromNumber: primary.e164,
      channel: 'sms',
    },
  };
}

export interface HandleInboundMessageInput {
  toNumber: string;
  fromNumber: string;
  body: string;
  channel?: CommsChannel;
  providerMessageId?: string | null;
  /**
   * Return the reply as soon as it exists, and run the work that follows it in the
   * background.
   *
   * On SMS this is not worth having. The reply is handed to a messaging workflow and the
   * customer waits on their phone, not on the webhook, so an extra second spent
   * extracting is invisible. On a live call it is the whole problem: everything after the
   * reply is composed — the second model round trip for extraction, the lead row, the
   * owner's notification — happens while the caller is listening to silence, and they
   * have no way to tell a slow system from a dropped line.
   *
   * Set by the voice path only. **The work still runs, and the notifications still go
   * out**; they simply stop standing between the model's answer and the caller hearing
   * it. The one visible difference is that the returned `lead` is null, because it does
   * not exist yet — which is why this is opt-in rather than the default.
   *
   * Safe only where the process outlives the response. The relay is a long-running
   * service and is; a serverless invocation that returns and is frozen is not, and would
   * drop the work silently.
   */
  deferExtraction?: boolean;
  /**
   * Say this instead of asking the model.
   *
   * Set by the voice path only, for the lines that end a call ("anything else?", the
   * goodbye), which are fixed text and are said while the caller waits on the line — a
   * model round trip to reproduce a known sentence is latency for nothing.
   *
   * It replaces step 4 and nothing else. The caller's turn is still recorded, a replay is
   * still gated, and the escalation check still runs first, so a handover always wins
   * over a closing line; a muted conversation still gets no reply. The line is still an
   * `ai` turn, so it lands on the transcript like any other, and the extraction and
   * notifications after it run as they would after a generated reply.
   */
  cannedReply?: string;
  traceId?: string;
}

export interface HandleInboundMessageResult {
  traceId: string;
  businessId: string;
  conversationId: string;
  inboundMessageId: string;
  /** False on a webhook retry — the caller must not reply again. */
  isNewMessage: boolean;
  /** What to send back, or null when the AI is muted and no handover text applies. */
  reply: {
    body: string;
    toNumber: string;
    fromNumber: string;
    channel: CommsChannel;
    /** 'ai' or 'system'; a handover notice is a system message, not an AI turn. */
    sender: 'ai' | 'system';
    aiLogId: string | null;
  } | null;
  handover: { reason: HandoverReason; note: string | null } | null;
  /**
   * True when the assistant has handed over on a **call** but has no details yet, and has
   * asked the caller for them instead of saying goodbye.
   *
   * A call is the only channel where this is both necessary and possible: necessary
   * because the owner's alert otherwise carries a phone number and nothing else, and
   * possible because the line is still open and `voice.ts` decides when it closes.
   * `endCall` must not be true while this is.
   */
  capturePending: boolean;
  lead: { leadId: string | null; score: number } | null;
}

/**
 * Inbound message → reply.
 *
 * Step order is the substance of this function:
 *
 *  1. **Record first.** The message is persisted before anything else, so a crash
 *     later never loses what the customer said.
 *  2. **Idempotency gate.** A replayed webhook stops here.
 *  3. **Handover check before generation.** Cheap, deterministic, and it decides
 *     whether an AI reply is appropriate at all. Generating first and discarding
 *     would waste a model call and risk sending it.
 *  4. **Reply.** Only if the AI is still in charge.
 *  5. **Extraction after the reply is composed.** The customer's answer must not
 *     wait on the CRM write.
 *  6. **Notifications last.** Never let an email provider delay a customer.
 *
 * Steps 5 and 6 run in the order given above, but *when* they run is the caller's
 * decision: on a live call `deferExtraction` moves both off the path that the caller is
 * waiting on. See the option's own comment for why that matters and where it is safe.
 */
export async function handleInboundMessage(
  input: HandleInboundMessageInput,
): Promise<HandleInboundMessageResult> {
  const traceId = input.traceId ?? newTraceId();
  const supabase = getAdminClient();
  const channel: CommsChannel = input.channel ?? 'sms';

  // --- Resolve tenant + thread ---------------------------------------------
  const { data: resolvedData, error: resolveError } = await supabase.rpc('resolve_inbound', {
    p_to_number: input.toNumber,
    p_from_number: input.fromNumber,
    p_channel: channel,
    p_source: sourceForChannel(channel),
  });

  if (resolveError) throw new Error(`resolve_inbound failed: ${resolveError.message}`);

  const resolved = (Array.isArray(resolvedData) ? resolvedData[0] : resolvedData) as {
    business_id: string;
    phone_number_id: string;
    contact_id: string;
    conversation_id: string;
    is_new_conversation: boolean;
  };

  const log = logger.child({
    traceId,
    businessId: resolved.business_id,
    conversationId: resolved.conversation_id,
  });

  // --- 1 & 2. Record the inbound message, idempotently ----------------------
  const { data: appendData, error: appendError } = await supabase.rpc('append_message', {
    p_conversation_id: resolved.conversation_id,
    p_direction: 'inbound',
    p_sender: 'customer',
    p_body: input.body,
    p_channel: channel,
    p_provider: 'twilio',
    p_provider_message_id: input.providerMessageId ?? null,
    p_status: 'received',
  });

  if (appendError) throw new Error(`append_message failed: ${appendError.message}`);

  const appended = (Array.isArray(appendData) ? appendData[0] : appendData) as {
    message_id: string;
    was_created: boolean;
  };

  const base = {
    traceId,
    businessId: resolved.business_id,
    conversationId: resolved.conversation_id,
    inboundMessageId: appended.message_id,
    isNewMessage: appended.was_created,
  };

  if (!appended.was_created) {
    log.info('Duplicate inbound webhook; not replying again');
    return { ...base, reply: null, handover: null, capturePending: false, lead: null };
  }

  const [context, memory] = await Promise.all([
    loadBusinessContext(resolved.business_id),
    loadConversationMemory(resolved.conversation_id),
  ]);

  const fromNumber =
    context.phone_numbers.find((n) => n.channels.includes(channel))?.e164 ?? input.toNumber;

  /*
   * The transcript loaded from the database predates this message, so append it once here
   * for everything downstream that reasons over the conversation.
   *
   * Built before the escalation check rather than at the point of generation because two
   * callers need it: `generateReply`, and the extraction that runs *inside* a handover.
   * The handover path used to extract from the transcript without the message that
   * triggered the handover, which is the one message an owner most wants summarised.
   */
  const memoryWithInbound = {
    ...memory,
    transcript: [
      ...memory.transcript,
      {
        id: appended.message_id,
        direction: 'inbound' as const,
        sender: 'customer' as const,
        body: input.body,
        created_at: new Date().toISOString(),
      },
    ],
  };

  // --- 3. Escalation check --------------------------------------------------
  const decision = detectHandover({ context, memory, inboundText: input.body });

  // Track confusion even when it is below the threshold — that is how the counter
  // reaches the threshold on a later message.
  if (!decision.shouldHandover && shouldIncrementConfusion(input.body)) {
    await supabase
      .from('conversations')
      .update({ confusion_count: memory.confusion_count + 1 })
      .eq('id', resolved.conversation_id);
  }

  if (decision.shouldHandover && decision.reason) {
    // Captured as locals before the closure below: TypeScript drops property narrowing
    // inside a function that may run later, and a non-null assertion here would be a
    // claim rather than a fact.
    const reason = decision.reason;
    const note = decision.note;

    log.info('Handing over to a human', { reason });

    await supabase.rpc('request_handover', {
      p_conversation_id: resolved.conversation_id,
      p_reason: reason,
      p_note: note,
    });

    /*
     * Extract before notifying, so the owner's alert carries the summary rather than
     * telling them to go and read the conversation.
     *
     * Written as a closure so the same two calls can either be awaited or left to finish
     * in the background — see `deferExtraction`. One copy of them, so the two paths
     * cannot drift into doing different things.
     */
    const finishHandover = async () => {
      const lead = await extractLead({ context, memory: memoryWithInbound, traceId }).catch((error) => {
        log.warn('Extraction failed during handover', { error: String(error) });
        return null;
      });

      await notifyHandover({
        context,
        conversationId: resolved.conversation_id,
        reason,
        note,
        summary: lead?.extraction?.summary ?? memory.summary,
        customerName: lead?.extraction?.name ?? memory.customer_name,
        customerPhone: input.fromNumber,
        urgency: lead?.extraction?.urgency ?? null,
        lastMessage: input.body,
      });

      return lead;
    };

    /*
     * On a call, ask before saying goodbye.
     *
     * `renderHandoverMessage` promises the owner will be in touch, which is only worth
     * saying once there is something to be in touch *about*. Spoken as the first line of
     * a handover it is a promise the owner cannot keep, and on 2026-09-17 it was made to a
     * caller who had given nothing but a phone number.
     *
     * Why the line is asked *after* `request_handover` rather than before: that RPC is
     * what sets `status = 'waiting_for_human'` and `ai_enabled = false`. So the caller's
     * answer arrives with the assistant already muted, is recorded like any other turn,
     * raises no second model call, and the next turn closes the line. The capture is the
     * mute working in our favour instead of against the caller.
     *
     * Voice only. On SMS the handover message is the right and final word — the owner
     * picks the thread up from there, and a question nobody is listening for would just
     * be an unanswered text.
     */
    const capturePending =
      channel === 'voice' && decision.notifyCustomer && needsDetailCapture(memory);

    const handoverReply: HandleInboundMessageResult['reply'] = decision.notifyCustomer
      ? {
          body: capturePending
            ? renderCaptureMessage(context)
            : renderHandoverMessage(context, reason),
          toNumber: input.fromNumber,
          fromNumber,
          channel,
          // A handover notice is the platform speaking, not the assistant. Marking
          // it 'system' keeps the AI-handled percentage honest.
          sender: 'system',
          aiLogId: null,
        }
      : null;

    if (input.deferExtraction) {
      /*
       * The caller is about to hear "I'm passing you to a colleague", and on a call that
       * sentence is the last thing they hear before the line goes quiet. Making them wait
       * on a model round trip first turns a considered pause into a silence they will read
       * as the call dropping. So the line goes out immediately and the owner's alert
       * follows a moment later — unchanged, and still carrying the summary.
       */
      void finishHandover().catch((error) => {
        log.warn('Handover follow-up failed', { error: String(error) });
      });

      return {
        ...base,
        reply: handoverReply,
        handover: { reason, note },
        capturePending,
        lead: null,
      };
    }

    const lead = await finishHandover();

    return {
      ...base,
      reply: handoverReply,
      handover: { reason, note },
      capturePending,
      lead: lead ? { leadId: lead.leadId, score: lead.score } : null,
    };
  }

  // The AI may be muted because a human took the thread over.
  if (!memory.ai_enabled || !context.settings.ai_enabled) {
    log.info('AI is muted for this conversation; recorded the message only');

    /*
     * The answer to a capture we asked for on the previous turn.
     *
     * `request_handover` mutes the assistant, so the details a caller gives after being
     * asked for them arrive here and nowhere else. Unhandled, they would sit on the
     * transcript and never reach the lead — leaving the owner with the alert that says a
     * colleague will ring back, and a phone number but nothing to ring back about. That is
     * the original fault, one turn later.
     *
     * Voice only. On SMS a muted thread belongs to the person reading it, and extracting
     * there would spend a model call on every message of a conversation the assistant was
     * never asked about.
     *
     * Fired without awaiting: the caller is holding the phone waiting to be told the call
     * is ending, and a model round trip is not worth that silence. The relay is a
     * long-running service, so the work outlives the response — the same reasoning as
     * `deferExtraction`, and bounded to one turn here because this turn returns no reply
     * and `voice.ts` closes the line.
     */
    if (channel === 'voice' && memory.status === 'waiting_for_human') {
      void extractLead({ context, memory: memoryWithInbound, traceId }).catch((error) => {
        log.warn('Extraction of captured handover details failed', { error: String(error) });
      });
    }

    await enqueueNotification({
      businessId: resolved.business_id,
      event: 'new_message',
      subject: 'New message on a conversation you are handling',
      body: input.body,
      payload: { customer_phone: input.fromNumber, conversation_id: resolved.conversation_id },
      conversationId: resolved.conversation_id,
      dedupeKey: `new_message:${appended.message_id}`,
    });

    return { ...base, reply: null, handover: null, capturePending: false, lead: null };
  }

  // --- 4. Generate the reply -----------------------------------------------
  const generated =
    input.cannedReply !== undefined
      ? { body: input.cannedReply, aiLogId: null, refused: null }
      : await generateReply({ context, memory: memoryWithInbound, traceId });

  // A provider refusal is not an error — it means a person is needed.
  if (generated.refused) {
    await supabase.rpc('request_handover', {
      p_conversation_id: resolved.conversation_id,
      p_reason: 'ai_error',
      p_note: `The AI provider declined to respond (${generated.refused.category ?? 'unknown'}).`,
    });

    await notifyHandover({
      context,
      conversationId: resolved.conversation_id,
      reason: 'ai_error',
      note: 'The AI provider declined to respond to this message.',
      summary: memory.summary,
      customerName: memory.customer_name,
      customerPhone: input.fromNumber,
      urgency: null,
      lastMessage: input.body,
    });

    return {
      ...base,
      reply: {
        body: renderHandoverMessage(context, 'ai_error'),
        toNumber: input.fromNumber,
        fromNumber,
        channel,
        sender: 'system',
        aiLogId: generated.aiLogId,
      },
      handover: { reason: 'ai_error', note: 'Provider refusal' },
      capturePending: false,
      lead: null,
    };
  }

  // --- 5 & 6. Extract, then notify -----------------------------------------
  const previousStatus = memory.lead_status;

  /*
   * Steps 5 and 6 as one closure, for the same reason as the handover branch above: on a
   * call they can be left to finish after the caller has heard their answer, and there
   * must be exactly one copy of them whichever way they are called.
   */
  const finishReply = async () => {
    const lead = await extractLead({ context, memory: memoryWithInbound, traceId }).catch((error) => {
      // Extraction is valuable but not load-bearing: the reply still goes out, and the
      // next inbound message re-runs it.
      log.warn('Extraction failed', { error: String(error) });
      return null;
    });

    if (lead?.extraction) {
      for (const event of leadNotificationEvents(lead.extraction, previousStatus)) {
        await enqueueNotification({
          businessId: resolved.business_id,
          event,
          subject: event === 'lead_qualified' ? 'New qualified lead' : 'New enquiry',
          body: lead.extraction.summary,
          payload: {
            customer_name: lead.extraction.name,
            customer_phone: lead.extraction.phone || input.fromNumber,
            summary: lead.extraction.summary,
            urgency: lead.extraction.urgency,
            conversation_id: resolved.conversation_id,
          },
          conversationId: resolved.conversation_id,
          leadId: lead.leadId,
          // Namespaced by status so crossing into 'qualified' alerts once, not on
          // every subsequent message.
          dedupeKey: `${event}:${lead.leadId ?? resolved.conversation_id}`,
        });
      }
    }

    // Compaction runs after the reply is composed, so it never delays the customer.
    if (needsSummarisation(memoryWithInbound)) {
      void summariseConversation({ context, memory: memoryWithInbound, traceId }).catch(() => {
        /* already logged; a stale summary is an acceptable degradation */
      });
    }

    return lead;
  };

  const reply: HandleInboundMessageResult['reply'] = {
    body: generated.body,
    toNumber: input.fromNumber,
    fromNumber,
    channel,
    sender: 'ai',
    aiLogId: generated.aiLogId,
  };

  if (input.deferExtraction) {
    // The caller hears this now. The lead row and the owner's alert are a second behind,
    // which is the correct order on a call and the wrong one on a text.
    void finishReply().catch((error) => {
      log.warn('Extraction after the reply failed', { error: String(error) });
    });

    return { ...base, reply, handover: null, capturePending: false, lead: null };
  }

  const lead = await finishReply();

  return {
    ...base,
    reply,
    handover: null,
    capturePending: false,
    lead: lead ? { leadId: lead.leadId, score: lead.score } : null,
  };
}

async function notifyHandover(input: {
  context: BusinessContext;
  conversationId: string;
  reason: HandoverReason;
  note: string | null;
  summary: string | null;
  customerName: string | null;
  customerPhone: string | null;
  urgency: string | null;
  lastMessage: string;
}): Promise<void> {
  const businessName = input.context.profile.trading_name ?? input.context.name;
  const conversationUrl = `${publicEnv.appUrl}/app/${input.context.slug}/conversations/${input.conversationId}`;

  await enqueueNotification({
    businessId: input.context.business_id,
    event: 'handover_required',
    subject:
      input.reason === 'emergency'
        ? `URGENT: a conversation needs you now`
        : `A conversation needs you`,
    body: composeHandoverBody({
      businessName,
      customerName: input.customerName,
      customerPhone: input.customerPhone,
      reason: input.reason.replaceAll('_', ' '),
      note: input.note,
      summary: input.summary,
      lastMessage: input.lastMessage,
      conversationUrl,
    }),
    payload: {
      customer_name: input.customerName,
      customer_phone: input.customerPhone,
      summary: input.summary,
      urgency: input.urgency ?? (input.reason === 'emergency' ? 'emergency' : 'high'),
      reason: input.reason,
      conversation_id: input.conversationId,
    },
    conversationId: input.conversationId,
    // One alert per escalation, not per retry.
    dedupeKey: `handover:${input.conversationId}:${input.reason}`,
  });
}
