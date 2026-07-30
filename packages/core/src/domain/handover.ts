import type { BusinessContext, ConversationMemory, HandoverReason } from '../types/domain.ts';

/**
 * Handover detection.
 *
 * Deliberately deterministic and deliberately cheap. This runs *before* the reply
 * is generated, on every inbound message, because the situations it catches are
 * exactly the ones where an AI reply is worse than no reply — someone reporting a
 * flood does not want to be asked for their postcode.
 *
 * Why rules and not a model call:
 *
 *  * **Latency.** It sits in front of the reply, so a model call here would double
 *    the time to respond on every message.
 *  * **Auditability.** When an owner asks "why did this escalate?", `keyword:
 *    solicitor` is an answer. "The model judged it urgent" is not.
 *  * **Recall over precision.** A false escalation costs a human 20 seconds of
 *    reading. A missed emergency costs the business a customer, or worse. The
 *    patterns below are tuned accordingly — they over-trigger on purpose.
 *
 * Owners can extend it: `handover_keywords` is per-tenant, and a property manager
 * adds "Section 20" where a dentist adds "bleeding".
 */

export interface HandoverDecision {
  shouldHandover: boolean;
  reason: HandoverReason | null;
  /** Human-readable justification, stored on the conversation and shown in the UI. */
  note: string | null;
  /** True when the customer must be told a person is coming, not just the owner. */
  notifyCustomer: boolean;
}

const NO_HANDOVER: HandoverDecision = {
  shouldHandover: false,
  reason: null,
  note: null,
  notifyCustomer: false,
};

/**
 * Emergency language. Broad on purpose — see the recall note above.
 *
 * Word-boundary anchored so "gas" does not fire on "Glasgow" and "fire" does not
 * fire on "fireplace enquiry"... which it would, so `fire` carries qualifying
 * context rather than standing alone.
 */
const EMERGENCY_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\b(?:emergency|urgent(?:ly)?)\b/i, label: 'explicit urgency' },
  { pattern: /\b(?:flood(?:ing|ed)?|leak(?:ing)?|burst|water\s+(?:coming|pouring|everywhere))\b/i, label: 'water ingress' },
  { pattern: /\b(?:fire|smoke|burning)\b/i, label: 'fire or smoke' },
  { pattern: /\bgas\s+(?:leak|smell|escape)\b/i, label: 'gas' },
  // Both word orders. "I can smell gas" is at least as common as "gas smell",
  // and an earlier version of this rule only caught the latter.
  { pattern: /\bsmell(?:s|ing|t|ed)?\s+(?:of\s+)?(?:gas|burning|smoke)\b/i, label: 'gas or burning smell' },
  { pattern: /\b(?:no\s+(?:power|electric(?:ity)?|heating|hot\s+water)|power\s+cut)\b/i, label: 'loss of utility' },
  { pattern: /\b(?:injur(?:y|ed)|hurt|bleeding|collapsed|unconscious|ambulance|999|911)\b/i, label: 'injury' },
  { pattern: /\b(?:break[\s-]?in|burglar(?:y|s)?|broken\s+into|vandalis(?:m|ed))\b/i, label: 'security incident' },
  { pattern: /\b(?:dangerous|unsafe|hazard(?:ous)?|structural(?:ly)?\s+unsafe)\b/i, label: 'safety hazard' },
  { pattern: /\bceiling\s+(?:collapsed|falling|coming\s+down)\b/i, label: 'structural failure' },
];

const HUMAN_REQUEST_PATTERNS: RegExp[] = [
  /\b(?:speak|talk|spoke)\s+(?:to|with)\s+(?:a\s+)?(?:human|person|real\s+person|someone|somebody|manager|supervisor|advisor)\b/i,
  /\b(?:is\s+this|are\s+you)\s+(?:a\s+)?(?:bot|robot|ai|computer|machine|automated)\b/i,
  /\b(?:stop|no more)\s+(?:the\s+)?(?:bot|ai|automated|messages)\b/i,
  /\bcall\s+me\s+(?:back\s+)?(?:now|please|immediately|asap|right\s+away)\b/i,
  /\b(?:put\s+me\s+through|transfer\s+me|get\s+me)\s+(?:to\s+)?(?:a\s+)?(?:human|person|manager|someone)\b/i,
  /\bi\s+(?:want|need)\s+(?:to\s+speak\s+to\s+)?(?:a\s+)?(?:human|person|real\s+person)\b/i,
];

const COMPLAINT_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\b(?:complain(?:t|ing|ed)?|complaints?\s+procedure)\b/i, label: 'complaint' },
  { pattern: /\b(?:solicitor|lawyer|legal\s+action|sue|suing|litigation|court)\b/i, label: 'legal threat' },
  { pattern: /\b(?:ombudsman|trading\s+standards|regulator|tribunal|redress\s+scheme)\b/i, label: 'regulator' },
  { pattern: /\b(?:unacceptable|disgrace(?:ful)?|appalling|disgusting|furious|outrag(?:ed|eous))\b/i, label: 'strong dissatisfaction' },
  { pattern: /\b(?:refund|compensation|money\s+back)\b/i, label: 'refund or compensation' },
  { pattern: /\b(?:third|fourth|fifth|\d+(?:st|nd|rd|th))\s+time\s+(?:i(?:'ve| have)\s+)?(?:asked|called|rung|contacted|chased)/i, label: 'repeated chasing' },
  { pattern: /\bstill\s+(?:waiting|no\s+(?:one|response|reply|answer))\b/i, label: 'unanswered' },
];

/**
 * Signals that the AI is not understanding.
 *
 * Counted rather than acted on immediately: one "what?" is a typo, three is a
 * conversation going nowhere. The threshold is per-tenant.
 */
const CONFUSION_PATTERNS: RegExp[] = [
  /\b(?:that(?:'s| is)\s+not\s+what\s+i\s+(?:said|asked|meant))\b/i,
  /\b(?:you(?:'re| are)\s+not\s+(?:listening|understanding|getting\s+it))\b/i,
  /\b(?:i\s+(?:already\s+)?(?:said|told\s+you))\b/i,
  /\b(?:read\s+(?:my|what\s+i)\s+(?:message|wrote|said))\b/i,
  /^\s*(?:what|huh|eh|sorry\?+|\?+)\s*$/i,
  /\b(?:makes?\s+no\s+sense|not\s+making\s+sense|confus(?:ing|ed))\b/i,
];

export interface DetectHandoverInput {
  context: BusinessContext;
  memory: ConversationMemory;
  /** The message that just arrived. */
  inboundText: string;
}

export function detectHandover(input: DetectHandoverInput): HandoverDecision {
  const { context, memory, inboundText } = input;
  const settings = context.settings;

  // Already with a human: nothing to decide.
  if (memory.status === 'waiting_for_human' || memory.status === 'human_handling') {
    return NO_HANDOVER;
  }

  if (!settings.handover_enabled) return NO_HANDOVER;

  const text = inboundText.trim();
  if (text === '') return NO_HANDOVER;

  // --- 1. Emergencies. Checked first: highest cost of a miss. -----------------
  if (settings.handover_on_emergency) {
    for (const { pattern, label } of EMERGENCY_PATTERNS) {
      if (pattern.test(text)) {
        return {
          shouldHandover: true,
          reason: 'emergency',
          note: `Possible emergency detected (${label}): matched ${describePattern(pattern)}.`,
          notifyCustomer: true,
        };
      }
    }
  }

  // --- 2. Explicit request for a person. Never argue with this. ---------------
  for (const pattern of HUMAN_REQUEST_PATTERNS) {
    if (pattern.test(text)) {
      return {
        shouldHandover: true,
        reason: 'customer_request',
        note: 'The customer asked to speak to a person.',
        notifyCustomer: true,
      };
    }
  }

  // --- 3. Complaints and legal threats. --------------------------------------
  if (settings.handover_on_complaint) {
    for (const { pattern, label } of COMPLAINT_PATTERNS) {
      if (pattern.test(text)) {
        return {
          shouldHandover: true,
          reason: 'complaint',
          note: `Possible complaint or escalation (${label}).`,
          notifyCustomer: true,
        };
      }
    }
  }

  // --- 4. Tenant-configured keywords. ----------------------------------------
  const keywordHit = matchKeyword(text, settings.handover_keywords);
  if (keywordHit) {
    return {
      shouldHandover: true,
      reason: 'keyword',
      note: `Matched the business's escalation keyword "${keywordHit}".`,
      notifyCustomer: true,
    };
  }

  // --- 5. Repeated confusion. -----------------------------------------------
  if (isConfused(text)) {
    const nextCount = memory.confusion_count + 1;
    if (nextCount >= settings.handover_confusion_threshold) {
      return {
        shouldHandover: true,
        reason: 'repeated_confusion',
        note: `The customer has signalled confusion ${nextCount} times; the assistant is not getting through.`,
        notifyCustomer: true,
      };
    }
    // Below threshold: not a handover, but the caller should still increment the
    // counter (see `shouldIncrementConfusion`).
  }

  // --- 6. Turn budget exhausted. --------------------------------------------
  // A conversation that has gone this long without resolving is not going to be
  // resolved by another AI turn.
  if (memory.ai_turn_count >= settings.ai_max_turns) {
    return {
      shouldHandover: true,
      reason: 'out_of_scope',
      note: `Reached the ${settings.ai_max_turns}-turn limit for AI handling without resolution.`,
      notifyCustomer: true,
    };
  }

  return NO_HANDOVER;
}

/** Whether this inbound message should bump `confusion_count`. */
export function shouldIncrementConfusion(inboundText: string): boolean {
  return isConfused(inboundText);
}

function isConfused(text: string): boolean {
  return CONFUSION_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Match a tenant keyword.
 *
 * Whole-word matching, not substring: a tenant adding "urgent" should not have
 * every message about a "surgent" (or, more realistically, "insurgent") escalate.
 * The keyword is regex-escaped because it is tenant input and would otherwise be
 * a regex injection.
 */
function matchKeyword(text: string, keywords: string[]): string | null {
  const haystack = text.toLowerCase();

  for (const keyword of keywords) {
    const needle = keyword.trim().toLowerCase();
    if (needle === '') continue;

    // Multi-word keywords ("speak to a human") are matched as a phrase.
    if (needle.includes(' ')) {
      if (haystack.includes(needle)) return keyword;
      continue;
    }

    const pattern = new RegExp(`\\b${escapeRegExp(needle)}\\b`, 'i');
    if (pattern.test(haystack)) return keyword;
  }

  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A short label for the source pattern, for the audit note. The raw regex is
 * unhelpful in a UI, so this trims it to something a person can read.
 */
function describePattern(pattern: RegExp): string {
  return pattern.source
    .replace(/\\b/g, '')
    .replace(/\(\?:/g, '(')
    .slice(0, 60);
}

/**
 * The message sent to the customer when we hand over.
 *
 * Templated, not generated: at this point the AI has been judged unfit to handle
 * the conversation, so asking it to write one more message is the wrong instinct.
 * It also needs to be reliably calm and non-committal, which a template guarantees.
 */
export function renderHandoverMessage(
  context: BusinessContext,
  reason: HandoverReason,
): string {
  const businessName = context.profile.trading_name ?? context.name;

  switch (reason) {
    case 'emergency':
      return `Thanks for letting us know — that sounds like it needs attention straight away. I'm passing this to the ${businessName} team right now and someone will contact you as soon as possible. If anyone is in danger, please call the emergency services first.`;
    case 'complaint':
      return `Thank you for telling us. I'd rather a colleague at ${businessName} picked this up with you directly than have me handle it — I'm passing it on now and someone will be in touch.`;
    case 'customer_request':
      return `Of course — I'm passing you to a colleague at ${businessName} now. Someone will be in touch shortly.`;
    case 'repeated_confusion':
      return `I'm sorry, I don't think I'm being much help here. I'm handing this to a colleague at ${businessName} who can sort it out properly. They'll be in touch shortly.`;
    default:
      return `Thanks — I'm passing this to a colleague at ${businessName} who'll pick it up with you shortly.`;
  }
}
