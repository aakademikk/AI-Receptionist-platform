/**
 * Spoken-output handling.
 *
 * The sibling of `sms.ts`, and it exists for the same reason: the prompt asks for the
 * right shape and this enforces it regardless of what the model actually produced.
 *
 * It is a separate module rather than a branch inside `sms.ts` because the two channels
 * want opposite treatment almost everywhere. A text message is read, at the reader's own
 * pace, and can be scrolled back to. A phone call is heard, once, at the speed the
 * listener's ear can follow, with no way to re-read a sentence. That difference changes
 * nearly every decision below:
 *
 *  * **Markdown has to go.** `**£120**` is emphasis to a reader and at best the
 *    synthesiser dropping the asterisks, at worst a voice saying them. Either way what
 *    the caller hears is not what the model wrote, so the markers are removed rather
 *    than left to a TTS engine's judgement.
 *  * **A list is not a list out loud.** "First… second… third" needs words, and a bullet
 *    character is a pause at best. The prompt asks for prose; this flattens anything
 *    that arrives anyway into sentences, which reads as a run-on — the lesser evil next
 *    to a caller hearing "hyphen".
 *  * **A URL cannot be written down by the caller.** Read aloud it costs several seconds
 *    and nobody retains it, so it is removed and the assistant is told to offer a
 *    message instead. That instruction lives in the prompt; this is the backstop.
 *  * **Length is measured in patience, not septets.** See `MAX_SPOKEN_CHARS`.
 *  * **A cut is not marked.** `trimToSegments` ends a truncated SMS with an ellipsis
 *    because a text that simply stops mid-sentence leaves the customer no way to know
 *    it was cut. A caller has a recourse a reader does not: they can say "sorry?" and
 *    the conversation continues. So this cuts at a boundary and says nothing about it.
 *
 * The angle-bracket strip is shared with the relay's `sanitiseForSpeech` and is not
 * redundant with it. That one guards the transport, on the way into a `text` token this
 * module has never seen. This one guards the content. A caller can never put SSML into
 * our outbound audio; nor can a model.
 */

/**
 * Roughly how many characters a caller will listen to in one turn.
 *
 * ElevenLabs at a natural pace is about fourteen characters a second, so 400 is around
 * twenty-eight seconds — already longer than any turn should be. That is the point: this
 * is a backstop for a model that ignored the prompt, not a target for it to aim at. The
 * prompt asks for one or two sentences, which lands nearer 150.
 */
export const MAX_SPOKEN_CHARS = 400;

/**
 * Substitutions applied in order. Order matters: a fenced block has to go before the
 * inline-backtick rule, or the fence markers survive as stray backticks and a link's
 * label has to be kept before bare URLs are removed, or the label goes with it.
 */
const MARKDOWN_RULES: Array<[RegExp, string]> = [
  // Fenced code — never useful aloud, and the contents would be read verbatim.
  [/```[\s\S]*?```/g, ' '],
  // Inline code keeps its contents, which are usually a word or a figure.
  [/`([^`]*)`/g, '$1'],
  // Links and images keep their label: "our price list" survives, the URL does not.
  [/!?\[([^\]]*)\]\([^)]*\)/g, '$1'],
  // Bare URLs. Nothing useful can be done with one out loud.
  [/https?:\/\/\S+|www\.\S+/gi, ' '],
  [/^\s{0,3}#{1,6}\s+/gm, ''],
  [/^\s{0,3}>\s?/gm, ''],
  [/^\s{0,3}(?:[-*+]|\d{1,2}[.)])\s+/gm, ''],
  // Emphasis markers last, so the paired forms above have already been handled.
  [/\*\*|__/g, ''],
  [/[*_]/g, ''],
  // Emoji: a synthesiser either skips them or reads their name aloud, and "smiling face
  // with smiling eyes" is not something to say to a customer. The zero-width joiner and
  // variation selector are stripped with them, or they survive as invisible characters.
  [/\p{Extended_Pictographic}/gu, ' '],
  [/[‍️]/g, ''],
  // Any escaped XML-ish markup. See the module header on why this is duplicated in the
  // relay rather than relied upon there.
  [/[<>]/g, ' '],
];

/**
 * Turn model output into something worth hearing.
 *
 * Idempotent, so it is safe to apply at the domain boundary and again at the transport
 * one — which is deliberate, because those are two different guards against two
 * different things.
 */
export function cleanForSpeech(raw: string): string {
  let body = raw;

  for (const [pattern, replacement] of MARKDOWN_RULES) {
    body = body.replace(pattern, replacement);
  }

  return (
    body
      // Speech has no line breaks. A newline is at best a pause and at worst a glitch,
      // so every one becomes a space before the whitespace collapse below.
      .replace(/\s*\n+\s*/g, ' ')
      // A URL removed from mid-sentence leaves "at ." behind.
      .replace(/\s+([.,!?;:])/g, '$1')
      .replace(/\s{2,}/g, ' ')
      .trim()
  );
}

/**
 * Deliberately the same field names as `TrimResult`, so a caller can treat the two
 * channels' results interchangeably and pick between them on one line.
 */
export interface SpeechTrimResult {
  body: string;
  wasTrimmed: boolean;
}

/**
 * Hold a spoken reply to `maxChars`, cutting at a sentence boundary where possible.
 *
 * No ellipsis, unlike its SMS counterpart — see the module header.
 */
export function limitForSpeech(text: string, maxChars = MAX_SPOKEN_CHARS): SpeechTrimResult {
  const body = cleanForSpeech(text);
  if (body.length <= maxChars) return { body, wasTrimmed: false };

  // Code-point-safe, so a character outside the basic plane cannot be sliced in half
  // into two lone surrogates. Emoji are already gone by here, but the guard costs
  // nothing and the alternative is a mojibake at the end of a spoken sentence.
  const candidate = [...body].slice(0, maxChars).join('');

  // Prefer the last sentence end, but only where it keeps most of the turn — dropping
  // from 400 characters to 30 reads as the assistant changing the subject mid-thought.
  const lastSentenceEnd = Math.max(
    candidate.lastIndexOf('. '),
    candidate.lastIndexOf('? '),
    candidate.lastIndexOf('! '),
  );

  if (lastSentenceEnd > maxChars * 0.5) {
    return { body: candidate.slice(0, lastSentenceEnd + 1).trim(), wasTrimmed: true };
  }

  const lastSpace = candidate.lastIndexOf(' ');
  if (lastSpace > 0) {
    return { body: candidate.slice(0, lastSpace).trim(), wasTrimmed: true };
  }

  // One unbroken run with nowhere to break — a reference number, or a model that
  // ignored every rule at once.
  return { body: candidate.trim(), wasTrimmed: true };
}
