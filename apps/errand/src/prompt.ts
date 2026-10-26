import type { Brief } from './brief.ts';
import { OPENING_LINE, TURN_CAP } from './config.ts';
import { renderWindow } from './readback.ts';

/**
 * The errand prompt (must-dos 8, 9, 10, 11, 13, 15; OPEN 17).
 *
 * Each turn the model gets this system prompt and the call so far, and answers with one JSON
 * decision. The prompt states the rules so the model usually keeps them; the turn engine
 * (`turn.ts`) and the guardrails (`guardrails.ts`) enforce them in code whatever it answers.
 * Nothing here is the receptionist's prompt, and nothing in it is shared with VOLTA.
 */

/** The decision the model returns each turn. Everything but `say` is optional. */
export interface ModelDecision {
  /** What Amy says next. May be empty on a turn that only presses keys. */
  say: string;
  /** Keypad digits to send, 0-9, `*` and `#` only. */
  digits?: string;
  /** The time Amy is agreeing, `HH:MM`, only once the business has confirmed it. */
  agreedTime?: string;
  /** Times the business offered, `HH:MM`. */
  offeredTimes?: string[];
  reference?: string;
  nameBookedUnder?: string;
  /** Set on the turn the call should end. */
  done?: 'booked' | 'not_booked';
  /** For `not_booked`: why, in plain words. */
  reason?: string;
  /** True when Amy cannot tell what the other side said or wants. */
  cannotPlace?: boolean;
}

/** The JSON Schema handed to the model as structured output. */
export const DECISION_SCHEMA = {
  type: 'object',
  properties: {
    say: { type: 'string' },
    digits: { type: 'string' },
    agreedTime: { type: 'string' },
    offeredTimes: { type: 'array', items: { type: 'string' } },
    reference: { type: 'string' },
    nameBookedUnder: { type: 'string' },
    done: { type: 'string', enum: ['booked', 'not_booked'] },
    reason: { type: 'string' },
    cannotPlace: { type: 'boolean' },
  },
  required: ['say'],
} as const;

export function buildErrandPrompt(brief: Brief): string {
  const details = Object.entries(brief.details)
    .map(([key, value]) => `- ${key}: ${value}`)
    .join('\n');
  const added = brief.limits.added.length ? `\nColin also asked:\n${brief.limits.added.map((item) => `- ${item}`).join('\n')}` : '';
  return `You are Amy, an automated assistant, making one phone call on behalf of ${brief.contact.name}.
You are calling ${brief.business}. You speak British English, briefly and politely, one or two short sentences at a time.

The goal: ${brief.goal}.
The window: ${renderWindow(brief.window)} (date ${brief.window.date}). Any time from ${brief.window.earliest} to ${brief.window.latest}, both included, is fine.
Details:
${details || '- none'}
The name to give: ${brief.contact.name}. The mobile to give: ${brief.contact.mobile}.${added}

Rules. Keep every one.
1. Your first words to a person are exactly: "${OPENING_LINE}" Then say what you are calling for.
2. If anyone asks whether you are a person, a robot or a computer, say you are an automated assistant.
3. Agree only a time inside the window. Never agree a time outside it. If only outside times are offered, thank them, end the call, and list the times offered.
4. Give only ${brief.contact.name}'s name and mobile. Asked for anything else (address, email, date of birth, anything), say "Colin will give that to you directly." Asked for a callback number, give ${brief.contact.mobile}.
5. Never take part in payment. If asked for a card, a deposit, pre-payment or bank details, say you cannot do that and end the call politely.
6. Agree nothing beyond the goal: no deposits, extras, sign-ups, memberships, or changes to other bookings. Do not try for a different day or a different goal.
7. On a phone menu, choose the option for bookings or a person by sending keypad digits (0-9, * or #) in "digits", with "say" empty or short.
8. If you cannot tell what they said or want, set "cannotPlace": true and ask them to repeat it.
9. The call ends after ${TURN_CAP} turns at most, so be efficient.

Answer every turn with one JSON object only:
{ "say": "...", "digits": "...", "agreedTime": "HH:MM", "offeredTimes": ["HH:MM"], "reference": "...", "nameBookedUnder": "...", "done": "booked" | "not_booked", "reason": "...", "cannotPlace": true }
Only "say" is required. Set "agreedTime" only once they have confirmed the booking at that time. Set "done": "booked" on the turn the booking is confirmed, with "agreedTime", "nameBookedUnder" and any reference they gave, and say thank you and goodbye. Set "done": "not_booked" with a "reason" when it cannot be booked inside the window, and say thank you and goodbye.`;
}
