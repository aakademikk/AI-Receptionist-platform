import { buildConversationRelayTwiml } from '@atwood/core';

import { publicOrigin } from '@/lib/twilio-webhook';

/**
 * The conversational voice path, in one place.
 *
 * Two routes can hand a call to the assistant — `/voice` when the number's
 * `answer_mode` says so, and `/voice/relay` when a number is pointed at it directly.
 * They must produce byte-identical TwiML, because a caller cannot tell which route
 * answered and neither should we: a drift between them would present as "the
 * assistant behaves differently on some numbers" with nothing in the config to
 * explain why. So both call this.
 */

/** Must match the path prefix routed to the relay process by the cloudflared tunnel. */
export const RELAY_PATH = '/relay';

/**
 * The spoken voice, chosen by ear from the ElevenLabs library.
 *
 * ElevenLabs voice IDs are opaque and Twilio takes them bare — no provider prefix,
 * unlike `<Say>`. A pairing Twilio does not recognise fails loudly rather than
 * quietly: the docs say an invalid provider/voice combination produces an error and
 * disconnects the call, so a bad ID costs one call and names itself.
 */
const VOICE_ID = '6fZce9LFNG3iEITDfqZZ';

/**
 * TwiML that answers the call with our ConversationRelay socket instead of forwarding it.
 *
 * The tenant identity travels to the socket as a `<Parameter>`, not as a query string.
 * The TwiML is signature-protected and the socket URL is ours, so a caller cannot pick a
 * different tenant by editing anything they control.
 *
 * The greeting is passed in rather than looked up here. It is the tenant's own words,
 * rendered from `business_ai_context` by `renderVoiceGreeting`, and this module holds no
 * I/O of its own by design — both routes already hold a `business_id` and already have a
 * database connection open, so the read belongs where the connection is. It also keeps
 * the greeting in the TwiML, which is what makes it play even when the socket does not.
 */
export function conversationRelayTwiml(input: {
  request: Request;
  businessId: string;
  callSid: string;
  to: string;
  /** What the caller hears first, already shaped for speech. */
  greeting: string;
}): string {
  return buildConversationRelayTwiml({
    url: socketUrl(input.request),
    /*
     * Delivered in the TwiML rather than sent down the socket once it connects.
     *
     * That ordering is the point: the greeting plays even if the socket never comes up,
     * so a broken relay sounds like a greeting followed by silence — which names the fault
     * — rather than a line that answers and says nothing, which is indistinguishable from
     * a dropped call and gets rung back.
     */
    welcomeGreeting: input.greeting,
    language: 'en-GB',
    /*
     * `ttsLanguage` is pinned rather than inferred from `language`. Both were unset
     * originally and the fallback silently produced a voice nobody chose — Twilio's
     * documented en-GB default, ElevenLabs "Archer". Pinning it means the next edit
     * cannot drift the accent without saying so.
     */
    ttsLanguage: 'en-GB',
    transcriptionProvider: 'Deepgram',
    ttsProvider: 'ElevenLabs',
    voice: VOICE_ID,
    parameters: {
      businessId: input.businessId,
      callSid: input.callSid,
      to: input.to,
    },
  });
}

/**
 * Where the socket lives, derived rather than configured twice.
 *
 * The origin comes from `publicOrigin`, which is already the trusted public origin —
 * `TWILIO_WEBHOOK_BASE_URL` where set, falling back to the request origin on preview
 * deployments. Deriving the socket from it means the tunnel hostname and the socket URL
 * cannot drift apart, which is the failure this platform has already paid for once.
 *
 * **The `/relay` path is a contract with `~/.cloudflared/receptionist.yml`.** The tunnel
 * routes that prefix to the relay process and everything else to Next.js. Changing it in
 * one place and not the other produces a WebSocket that 404s, which Twilio reports as a
 * failed call with no useful reason attached.
 */
function socketUrl(request: Request): string {
  return `wss://${new URL(publicOrigin(request)).host}${RELAY_PATH}`;
}
