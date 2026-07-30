import type { JsonSchemaLike } from '../types/domain.ts';

/**
 * Onboarding extraction: website markdown in, draft business profile out.
 *
 * This runs once per tenant, is never on a latency path, and its output is
 * reviewed by a human before it goes live — so it is the one place in the system
 * where a higher-effort model call is unambiguously worth it. Getting this right
 * is the difference between an owner correcting three fields and an owner
 * re-typing their whole business.
 *
 * The output is a draft, not the truth. It lands in `onboarding_jobs.extracted`,
 * the owner edits it, and only then is it written to the live profile — which is
 * also why scraped knowledge items are created with `needs_review = true` and are
 * excluded from `business_ai_context` until approved.
 */

export const ONBOARDING_SCHEMA_NAME = 'business_profile_extraction';

export const ONBOARDING_SCHEMA: JsonSchemaLike = {
  type: 'object',
  properties: {
    business_name: { type: 'string', description: 'Trading name as presented on the site.' },
    legal_name: {
      type: 'string',
      description: 'Registered company name if stated (e.g. in the footer). Empty string otherwise.',
    },
    tagline: { type: 'string', description: 'Short positioning line. Empty string if none.' },
    description: {
      type: 'string',
      description:
        'Two or three sentences describing what the business does, drawn from the site. Empty string if the site does not say.',
    },
    industry: { type: 'string', description: 'Short industry label, e.g. "Plumbing", "Dental".' },
    founded_year: {
      type: 'string',
      description: 'Four-digit year if stated. Empty string otherwise. Do not estimate.',
    },
    email: { type: 'string', description: 'Primary contact email. Empty string if none published.' },
    phone: { type: 'string', description: 'Primary phone number as published.' },
    address_line1: { type: 'string' },
    address_line2: { type: 'string' },
    city: { type: 'string' },
    region: { type: 'string' },
    postcode: { type: 'string' },
    country: { type: 'string' },
    tone_of_voice: {
      type: 'string',
      description:
        'Describe the voice the site is written in, in a few words, so an assistant can match it (e.g. "friendly and direct, slightly informal").',
    },
    services: {
      type: 'array',
      description:
        'Services the site actually offers. Only include a price when the site states one.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          category: { type: 'string' },
          price_text: {
            type: 'string',
            description:
              'Exactly as written on the site, including any "from". Empty string if no price is published.',
          },
          duration_minutes: {
            type: 'string',
            description: 'Digits only if stated. Empty string otherwise.',
          },
        },
        required: ['name', 'description', 'category', 'price_text', 'duration_minutes'],
        additionalProperties: false,
      },
    },
    service_areas: {
      type: 'array',
      description: 'Places the business says it covers.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          postcode_prefixes: {
            type: 'array',
            description: 'Outward-code prefixes if the site lists them, e.g. ["LS1","LS2"].',
            items: { type: 'string' },
          },
          notes: { type: 'string' },
        },
        required: ['name', 'postcode_prefixes', 'notes'],
        additionalProperties: false,
      },
    },
    opening_hours: {
      type: 'array',
      description:
        'One entry per weekday the site states. Omit days it does not mention rather than guessing.',
      items: {
        type: 'object',
        properties: {
          day_of_week: {
            type: 'string',
            description: '0 = Sunday through 6 = Saturday.',
          },
          opens_at: { type: 'string', description: '24h HH:MM. Empty string if closed.' },
          closes_at: { type: 'string', description: '24h HH:MM. Empty string if closed.' },
          is_closed: { type: 'string', description: '"true" or "false".' },
        },
        required: ['day_of_week', 'opens_at', 'closes_at', 'is_closed'],
        additionalProperties: false,
      },
    },
    faqs: {
      type: 'array',
      description: 'Question and answer pairs, from an FAQ page or clearly Q&A-shaped content.',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          answer: { type: 'string' },
        },
        required: ['question', 'answer'],
        additionalProperties: false,
      },
    },
    policies: {
      type: 'array',
      description:
        'Stated policies worth an assistant knowing: cancellation, callout, emergency cover, guarantees, complaints.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['title', 'content'],
        additionalProperties: false,
      },
    },
    social_links: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          platform: { type: 'string' },
          url: { type: 'string' },
        },
        required: ['platform', 'url'],
        additionalProperties: false,
      },
    },
    confidence_notes: {
      type: 'string',
      description:
        'Anything you were unsure about or could not find, written for the owner reviewing this draft. This is the most useful field on the form — be specific.',
    },
  },
  required: [
    'business_name',
    'legal_name',
    'tagline',
    'description',
    'industry',
    'founded_year',
    'email',
    'phone',
    'address_line1',
    'address_line2',
    'city',
    'region',
    'postcode',
    'country',
    'tone_of_voice',
    'services',
    'service_areas',
    'opening_hours',
    'faqs',
    'policies',
    'social_links',
    'confidence_notes',
  ],
  additionalProperties: false,
};

export function buildOnboardingSystemPrompt(): string {
  return [
    'You build a structured business profile from the text of a company website.',
    '',
    'The output seeds an AI receptionist that will speak to that company\'s customers. Anything you get wrong will be said out loud to a member of the public in the company\'s name — a service they do not offer, a price they never set, an area they do not cover. So the standard is not "plausible", it is "actually on the site".',
    '',
    '## Rules',
    '',
    '1. **Only record what the site states.** Empty string, or an omitted array entry, is the correct answer when the site is silent. Never fill a gap with an industry norm.',
    '2. **Prices are quoted, never derived.** Copy price text exactly as published, including "from", "+VAT", or "POA". If a page shows no price, `price_text` is an empty string. Do not convert, round, or estimate.',
    '3. **Services are what they sell, not what they mention.** A plumber\'s blog post about boiler brands is not a service. A list on a "What we do" page is.',
    '4. **Do not merge or tidy.** If the site lists eleven services, return eleven. Do not group them into three neat categories.',
    '5. **Opening hours**: only days the site actually states. A site that says "Mon–Fri 9–5" gives you five entries, not seven.',
    '6. **Marketing copy is not a policy.** "We pride ourselves on fast response" is not a response-time policy. "We attend emergencies within 4 hours" is.',
    '7. **Use `confidence_notes` generously.** Say what was missing, ambiguous, or contradictory across pages. A reviewer who is told "the site lists two different phone numbers, I used the one in the header" can fix it in seconds. Silence there costs them a hunt.',
    '',
    'Return only the JSON object.',
  ].join('\n');
}

export function buildOnboardingUserMessage(pages: Array<{ url: string; markdown: string }>): string {
  // Bound the payload. A large site can produce far more markdown than is useful,
  // and the pages that matter (home, services, about, contact, FAQ) are almost
  // always the ones the crawler returns first.
  const MAX_TOTAL_CHARS = 180_000;
  const MAX_PER_PAGE = 30_000;

  const parts: string[] = [];
  let budget = MAX_TOTAL_CHARS;
  let omitted = 0;

  for (const page of pages) {
    if (budget <= 0) {
      omitted += 1;
      continue;
    }
    const body = page.markdown.slice(0, Math.min(MAX_PER_PAGE, budget));
    budget -= body.length;
    parts.push(`## Page: ${page.url}\n\n${body}`);
  }

  if (omitted > 0) {
    parts.push(
      `\n(${omitted} further page(s) were not included because the content limit was reached. Mention this in confidence_notes if the profile looks incomplete.)`,
    );
  }

  return [
    'Here is the scraped content of the company website.',
    '',
    parts.join('\n\n---\n\n'),
  ].join('\n');
}
