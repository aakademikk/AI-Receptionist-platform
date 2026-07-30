import type {
  BusinessContext,
  ConversationMemory,
  JsonSchemaLike,
} from '../types/domain.ts';

/**
 * Lead extraction.
 *
 * Run as a **separate** model call from the reply, not folded into it. Three
 * reasons that separation is worth the extra call:
 *
 *  1. The reply is prose for a human; the extraction is JSON for a database. A
 *     single call that produces both does each worse, and a malformed JSON block
 *     would take the customer's reply down with it.
 *  2. It can run on a cheaper, faster model than the reply.
 *  3. It can be re-run over a finished conversation to backfill or to test a new
 *     schema, without re-sending anything to the customer.
 *
 * Every field is a string and required. Providers' strict JSON modes dislike
 * optional or nullable fields, and "" is unambiguous where `null` invites the
 * model to omit the key. The SQL upsert converts "" to NULL and merges rather
 * than overwrites, so a field the model fails to restate is never lost.
 */

export const LEAD_EXTRACTION_SCHEMA_NAME = 'lead_extraction';

export const LEAD_EXTRACTION_SCHEMA: JsonSchemaLike = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      description:
        "The customer's full name as they gave it. Empty string if they have not said.",
    },
    phone: {
      type: 'string',
      description:
        'Best contact number in E.164 if determinable, otherwise as written. Empty string if unknown.',
    },
    email: {
      type: 'string',
      description: 'Email address if given. Empty string otherwise. Never invent one.',
    },
    postcode: {
      type: 'string',
      description:
        'Postcode of the property or job, uppercase. Empty string if not given. Do not infer from a town name.',
    },
    service: {
      type: 'string',
      description:
        'Which of the listed services this enquiry is for. Use the exact service name from the list where it clearly matches; empty string if unclear.',
    },
    summary: {
      type: 'string',
      description:
        'Two sentences at most, written for a colleague picking this up cold: what they want and anything that affects how to handle it.',
    },
    enquiry: {
      type: 'string',
      description:
        'The specifics of what they need doing, in their own terms. Empty string if they have not said yet.',
    },
    urgency: {
      type: 'string',
      enum: ['low', 'normal', 'high', 'emergency'],
      description:
        'emergency = risk to safety or property right now. high = they asked for it quickly or are blocked. normal = no time pressure stated. low = browsing or planning ahead.',
    },
    lead_status: {
      type: 'string',
      enum: [
        'new',
        'qualifying',
        'qualified',
        'booked',
        'nurture',
        'unqualified',
        'lost',
        'won',
      ],
      description:
        'qualified = a real prospect with a contactable detail and a clear need. qualifying = engaged but details still missing. unqualified = out of area, wrong business, or spam. nurture = genuine but not now. new = nothing yet.',
    },
    callback_time: {
      type: 'string',
      description:
        'When they said they want to be contacted, in their own words ("after 5pm", "Tuesday morning"). Empty string if not stated. Do not convert to a timestamp.',
    },
  },
  required: [
    'name',
    'phone',
    'email',
    'postcode',
    'service',
    'summary',
    'enquiry',
    'urgency',
    'lead_status',
    'callback_time',
  ],
  additionalProperties: false,
};

export function buildExtractionSystemPrompt(context: BusinessContext): string {
  const businessName = context.profile.trading_name ?? context.name;

  const serviceList =
    context.services.length > 0
      ? context.services.map((s) => `- ${s.name}`).join('\n')
      : '(no services published)';

  const areaList =
    context.service_areas.length > 0
      ? context.service_areas
          .map((a) =>
            a.postcode_prefixes.length > 0
              ? `- ${a.name}: ${a.postcode_prefixes.join(', ')}`
              : `- ${a.name}`,
          )
          .join('\n')
      : '(no areas published)';

  return [
    `You extract structured lead data from a customer conversation for ${businessName}.`,
    '',
    'You are a data extractor, not an assistant. You are not talking to the customer and your output is never shown to them — it populates a CRM record a colleague will act on.',
    '',
    '## The single rule',
    '',
    'Record only what is actually present in the conversation. If something was not said, the field is an empty string. Never guess, never infer, never fill a gap with something plausible.',
    '',
    'Specifically:',
    '- Do not derive a postcode from a mentioned town or street.',
    '- Do not assume a service because it is the most common one.',
    '- Do not invent a name from an email address or a signature.',
    '- Do not upgrade urgency because the tone felt impatient — urgency is about stated facts.',
    '',
    'An empty field is correct and useful. A wrong field means someone calls the wrong person about the wrong job.',
    '',
    '## Services offered',
    '',
    serviceList,
    '',
    'Use the exact name above when the match is clear. If the customer describes something not on the list, put their own words in `service` and set `lead_status` to `unqualified` only if it is plainly not something this business does.',
    '',
    '## Areas covered',
    '',
    areaList,
    '',
    'If the postcode given is clearly outside these areas, that is a signal for `unqualified` — but only when you are confident.',
    '',
    '## Notes on particular fields',
    '',
    '- `summary` is the one field you compose rather than copy. Write it for a colleague who has not read the thread.',
    '- `urgency`: `emergency` is reserved for a live risk to safety or property (water coming in, gas, fire, electrical, someone hurt). Do not use it for commercial urgency.',
    '- `lead_status`: judge on what has been established, not on what you hope. Someone who has said "how much?" and nothing else is `qualifying`, not `qualified`.',
    '',
    'Return only the JSON object.',
  ].join('\n');
}

/**
 * The extraction turn.
 *
 * The transcript is passed as a single user message rather than as a replayed
 * multi-turn conversation: the model is analysing a document, not participating in
 * a chat, and flattening it stops the model from trying to continue the dialogue.
 * Anything already known is included so the model can confirm or correct it
 * instead of dropping it.
 */
export function buildExtractionUserMessage(memory: ConversationMemory): string {
  const transcript = memory.transcript
    .filter((m) => m.body && m.body.trim().length > 0)
    .map((m) => `${speakerLabel(m.sender)}: ${m.body!.trim()}`)
    .join('\n');

  const parts: string[] = [];

  if (memory.summary) {
    parts.push('## Earlier in this conversation (summarised)', '', memory.summary, '');
  }

  parts.push('## Conversation', '', transcript || '(no messages yet)');

  const knownEntries = Object.entries(memory.known).filter(([, value]) => Boolean(value));
  if (knownEntries.length > 0) {
    parts.push(
      '',
      '## Already recorded from earlier passes',
      '',
      ...knownEntries.map(([key, value]) => `- ${key}: ${String(value)}`),
      '',
      'Carry these forward unless the conversation contradicts them. If the conversation contradicts a recorded value, prefer what the customer actually said.',
    );
  }

  if (memory.customer_phone) {
    parts.push(
      '',
      `## Channel metadata`,
      '',
      `The number this conversation arrived from is ${memory.customer_phone}. Use it for \`phone\` unless the customer gave a different preferred number.`,
    );
  }

  return parts.join('\n');
}

function speakerLabel(sender: ConversationMemory['transcript'][number]['sender']): string {
  switch (sender) {
    case 'customer':
      return 'Customer';
    case 'ai':
    case 'human':
      return 'Business';
    default:
      return 'System';
  }
}

/**
 * Score a lead 0–100 for sorting the dashboard.
 *
 * Computed in code, not by the model: a model asked to score its own extraction
 * gives inconsistent numbers across runs, and the owner needs "higher is more
 * worth ringing" to mean the same thing on Tuesday as it did on Monday.
 */
export function scoreLead(extraction: {
  urgency: string;
  lead_status: string;
  name: string;
  phone: string;
  email: string;
  postcode: string;
  service: string;
  enquiry: string;
  callback_time: string;
}): number {
  let score = 0;

  // Contactability is worth the most — an unreachable lead is worth nothing.
  if (extraction.phone) score += 20;
  if (extraction.name) score += 10;
  if (extraction.email) score += 5;

  // Actionability.
  if (extraction.service) score += 15;
  if (extraction.enquiry) score += 15;
  if (extraction.postcode) score += 10;
  if (extraction.callback_time) score += 5;

  switch (extraction.urgency) {
    case 'emergency':
      score += 15;
      break;
    case 'high':
      score += 10;
      break;
    case 'normal':
      score += 4;
      break;
    default:
      break;
  }

  switch (extraction.lead_status) {
    case 'qualified':
    case 'booked':
      score += 5;
      break;
    case 'unqualified':
    case 'lost':
      score = Math.round(score * 0.25);
      break;
    default:
      break;
  }

  return Math.max(0, Math.min(100, score));
}
