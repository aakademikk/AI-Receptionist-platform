/**
 * How a phone call ends.
 *
 * Before this, the assistant never closed a call on her own: a caller who said goodbye
 * heard a model-written goodbye back, and then the line stayed open until they hung up
 * on silence. These rules decide, from what the **caller** said, when to ask whether
 * there is anything else and when to say goodbye and hang up; and, from what the
 * **assistant** said, when she has signed off, which is what arms the relay's silence
 * backstop.
 *
 * Code rather than a model signal, for the reasons `handover.ts` gives: it sits in
 * front of the reply, it has to be fast, and "matched `bye`" is an answer when someone
 * asks why a call ended.
 *
 * The two directions are tuned opposite ways on purpose:
 *
 *  * **The caller's goodbye errs towards not matching.** A false positive asks a caller
 *    who was not leaving whether there is anything else, or, once that has been asked,
 *    hangs up on them. So an utterance counts only when it is made *entirely* of closing
 *    words and filler; anything left over ("bye, actually can you...") is a request, and
 *    the conversation carries on.
 *  * **The assistant's sign-off errs towards matching.** A false positive costs one
 *    "are you still there?", and nothing hangs up without two stretches of caller
 *    silence after it.
 *
 * Everything here is pure, so it is tested without a model, a database or a socket.
 * `voice.ts` wires it into the turn and the relay keeps the one piece of state it needs.
 */

/** Asked once per call, when the caller first says goodbye. */
export const ANYTHING_ELSE_LINE = 'Is there anything else I can help you with?';

/** Said when the caller has nothing else. The call ends straight after it. */
export const GOODBYE_LINE = 'No problem. Thanks for calling, bye for now.';

/** Said by the relay when the caller has gone quiet after the assistant signed off. */
export const STILL_THERE_LINE = 'Are you still there?';

/**
 * Said after a handover, when the caller answers the details the handover asked for. The
 * line stays open for one more answer, because recognition ends a turn at the caller's
 * first pause and "my name is Jim, and my house" is not everything Jim meant to say.
 */
export const PASSED_ON_LINE =
  "Thank you, I've passed that on and someone will ring you back as soon as they can. Is there anything else they should know?";

/** Said after a handover once the caller has had that one more answer. The call ends. */
export const PASSED_ON_GOODBYE_LINE = 'Thank you. Someone will be in touch as soon as they can. Bye for now.';

/**
 * Words that say the caller is leaving. At least one must be present: "thanks" or "okay"
 * on their own are how people acknowledge an answer, not how they end a call.
 */
const CLOSING_MARKERS: string[] = [
  'good ?bye',
  'bye(?: bye)*',
  'byebye',
  'cheerio',
  'ta ?ra',
  'see (?:you|ya)(?: later| soon)?',
  '(?:speak|talk) (?:to you )?soon',
  'take care',
  'have a (?:good|great|nice|lovely) (?:day|evening|night|afternoon|morning|weekend|one)',
  "that(?:'?s| is) (?:all|everything|it)",
  "that(?:'?ll| will) be (?:all|everything|it)",
  "that(?:'?s| is) me(?: done)?",
  'nothing else',
];

/**
 * Words that say the caller wants nothing more, as an answer to "anything else?".
 * A bare "no" counts here and only here: it answers that question, and nothing else.
 */
const DECLINING_MARKERS: string[] = [
  'no',
  'nope',
  'nah',
  'not really',
  'nothing(?: more| else)?',
  "i'?m (?:good|fine|all set|all good|sorted)",
  "we'?re (?:good|fine|all set|sorted)",
  'all good',
  "that(?:'?s| is) (?:all|everything|it)",
  'no more',
];

/**
 * Words that may sit around a closing without changing what it means. Anything not in
 * this list, or in the markers above, is content — and content means the caller is not
 * done.
 */
const FILLER: string[] = [
  'no thanks',
  'no thank you',
  'thank you(?: very much| so much)?',
  'thanks(?: very much| so much| a lot| again)?',
  'many thanks',
  'cheers',
  'ta',
  'much appreciated',
  'appreciate it',
  'ok(?:ay)?',
  'alright',
  'all right',
  'right',
  'great',
  'lovely',
  'perfect',
  'brilliant',
  'cool',
  'fine',
  'grand',
  'sound',
  'nice one',
  'yes',
  'yeah',
  'yep',
  'oh',
  'well',
  'so',
  'and',
  'then',
  'now',
  'for now',
  'for today',
  'i think',
  'you too',
  'mate',
  'love',
  "that(?:'?s| is) (?:great|lovely|fine|brilliant|perfect|grand|good)",
  "that(?:'?s| is) all i (?:need|needed|wanted)",
  'for me',
];

function alternation(phrases: string[]): string {
  // Longest first, so "no thanks" is consumed whole rather than as "no" and a stray "thanks".
  return [...phrases].sort((a, b) => b.length - a.length).join('|');
}

const CLOSING_RE = new RegExp(`\\b(?:${alternation(CLOSING_MARKERS)})\\b`, 'i');
const DECLINING_RE = new RegExp(`\\b(?:${alternation(DECLINING_MARKERS)})\\b`, 'i');
const ALLOWED_RE = new RegExp(
  `\\b(?:${alternation([...CLOSING_MARKERS, ...DECLINING_MARKERS, ...FILLER])})\\b`,
  'gi',
);

/**
 * Lower-cased, apostrophes straightened, punctuation other than the apostrophe turned
 * to spaces. Recognition punctuates freely ("Cheers, bye."), and none of it matters
 * here except a question mark, which is checked before this runs.
 */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when nothing but closing words, declining words and filler is left. */
function isOnlyAllowedWords(normalised: string): boolean {
  return normalised.replace(ALLOWED_RE, ' ').trim() === '';
}

/**
 * The caller is saying goodbye: "bye", "cheers, bye", "that's all", "no thanks, bye",
 * "thanks, that's it".
 *
 * False when the utterance carries anything else — a question mark, or any word that is
 * not a closing word or filler — because "bye, actually can you..." and "what time do you
 * close, bye" are questions from someone who is still on the line.
 */
export function isCallerClosing(heard: string): boolean {
  if (heard.includes('?')) return false;
  const text = normalise(heard);
  if (text === '') return false;
  return CLOSING_RE.test(text) && isOnlyAllowedWords(text);
}

/**
 * The caller's answer to "anything else?" is no: "no", "no thanks", "nope", "that's it",
 * "no, that's everything", or another goodbye.
 *
 * False for "no, but..." and for anything with a question in it: the caller has
 * something else, and hanging up on it is the failure this whole module is tuned against.
 */
export function isDecliningMore(heard: string): boolean {
  if (heard.includes('?')) return false;
  const text = normalise(heard);
  if (text === '') return false;
  if (!isOnlyAllowedWords(text)) return false;
  return DECLINING_RE.test(text) || CLOSING_RE.test(text);
}

export type CallerClosingDecision = 'ask_anything_else' | 'goodbye' | 'none';

/**
 * What the caller's words mean for the end of the call.
 *
 *  * Not yet asked, and the caller is closing: ask "anything else?".
 *  * Asked on the turn just gone, and the caller declines or says goodbye: say goodbye and
 *    hang up. A bare "no" counts only here, because only here is it an answer to "anything
 *    else?".
 *  * Asked earlier in the call, the caller raised something new, and now says goodbye:
 *    say goodbye and hang up. Never a second "anything else?" — it is asked at most once.
 *    A bare "no" at this point is an answer to whatever she asked last ("is it urgent?"),
 *    so it is an ordinary turn.
 *  * Anything else: an ordinary turn.
 */
export function decideCallerClosing(input: {
  heard: string;
  /** "Anything else?" has been asked at some point on this call. */
  anythingElseAsked: boolean;
  /** The reply the caller is answering was "anything else?" itself. */
  anythingElseJustAsked: boolean;
}): CallerClosingDecision {
  if (input.anythingElseAsked && input.anythingElseJustAsked) {
    return isDecliningMore(input.heard) ? 'goodbye' : 'none';
  }
  if (input.anythingElseAsked) {
    return isCallerClosing(input.heard) ? 'goodbye' : 'none';
  }
  return isCallerClosing(input.heard) ? 'ask_anything_else' : 'none';
}

/**
 * What to say on a call whose assistant is muted, which on voice only happens after a
 * handover earlier in the same call (a caller ringing back is answered; see
 * `isMuteFromEarlierCall` in `handover.ts`).
 *
 *  * First answer after the handover: thank them, say it has been passed on, and ask if
 *    there is anything else. The relay's silence backstop closes the line if they have
 *    nothing to add.
 *  * The answer to that question, whatever it is: it has been recorded, so say goodbye and
 *    hang up. Asked at most once, so a caller cannot be kept on a muted line.
 */
export function decideMutedTurn(input: {
  /** The reply the caller is answering was an "anything else?" question. */
  anythingElseJustAsked: boolean;
}): { speak: string; endCall: boolean; closing: 'asked_anything_else' | 'none' } {
  if (input.anythingElseJustAsked) {
    return { speak: PASSED_ON_GOODBYE_LINE, endCall: true, closing: 'none' };
  }
  return { speak: PASSED_ON_LINE, endCall: false, closing: 'asked_anything_else' };
}

/** Ways the assistant signs off. Broad on purpose: see the module header. */
const WRAP_UP_PATTERNS: RegExp[] = [
  /\bhave a (?:good|great|nice|lovely|wonderful|brilliant) (?:day|evening|night|afternoon|morning|weekend|one|rest of (?:the|your) (?:day|evening|week))\b/i,
  /\benjoy (?:the )?rest of (?:the|your) (?:day|evening|week|weekend)\b/i,
  /\bgood ?bye\b/i,
  /\bbye\b/i,
  /\btake care\b/i,
  /\b(?:thanks|thank you|cheers) (?:so much |very much )?for (?:calling|ringing|getting in touch|your call)\b/i,
  /\b(?:speak|talk) (?:to you )?soon\b/i,
  /\ball the best\b/i,
];

/**
 * The assistant's reply signs off — "have a good evening", "bye for now", "thanks for
 * calling" — and does not end on a question.
 *
 * "Have a good evening, what's the address?" is false: she has asked something and is
 * waiting for the answer, and a caller thinking about their address is not a caller who
 * has gone.
 */
export function isWrapUpLine(speak: string): boolean {
  const text = speak.trim();
  if (text === '' || text.endsWith('?')) return false;
  return WRAP_UP_PATTERNS.some((pattern) => pattern.test(text));
}
