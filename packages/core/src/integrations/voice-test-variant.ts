/**
 * The voice test variant: one setting, `VOICE_TEST_VARIANT`, that names which speech
 * settings a phone call gets during the Amy speed test. Parsing lives here, apart from
 * the TwiML builder, so the web app can switch and revert a variant by changing one
 * value rather than by a code change per variant.
 *
 * Grammar: `today` | `flux-0.7` | `flux-0.8`, optionally followed by `+<gemini model>`
 * for the combined variant, for example `flux-0.8+gemini-3.5-flash`.
 *
 * The rule that matters is the fail-safe. Unset, empty or anything unparseable means
 * `today`, and the result says so (`valid: false`) so the caller can log it. A typo in
 * a systemd drop-in must never put live callers on Flux; it puts them on what they
 * have today.
 */

/** The name of the variant that changes nothing: no new TwiML attributes, no model override. */
export const TODAY_VARIANT = 'today';

/**
 * Twilio's value for Deepgram Flux in the ConversationRelay `speechModel` attribute.
 * Only meaningful alongside `transcriptionProvider="Deepgram"`, which the web app
 * already sets.
 */
const FLUX_SPEECH_MODEL = 'flux';

/**
 * The Flux variants and the end-of-turn threshold each one sends. 0.8 is Twilio's own
 * default; 0.7 ends the caller's turn sooner at the risk of cutting them off. Both sit
 * inside Twilio's documented 0.5 to 0.9 range, which `buildConversationRelayTwiml`
 * enforces.
 */
const FLUX_THRESHOLDS: Readonly<Record<string, number>> = {
  'flux-0.7': 0.7,
  'flux-0.8': 0.8,
};

/**
 * The transcription language a Flux variant asks for. Deliberately `undefined`, meaning
 * the variant adds no language of its own and the call keeps the `en-GB` it sends today.
 *
 * Twilio's docs say Flux supports English but do not say whether the `en-GB` locale is
 * accepted (T2, twilio-facts.md). Rather than guess a value, the first Flux call tries
 * `en-GB` as it stands. T28 checks that on Colin's accent: if Twilio rejects it, or the
 * transcript is worse, falling back to plain `en` is the documented option, and it is a
 * one-line change to this constant.
 */
const FLUX_TRANSCRIPTION_LANGUAGE: string | undefined = undefined;

/**
 * Flux uses `speechTimeout` as a maximum silence cap, not as the end-of-turn wait, so
 * every variant keeps today's 1200 and this module does not touch it. It is not a
 * field of `turn` for that reason.
 */

/**
 * The only shape a model override may take. The provider stays Google, so the name must
 * start `gemini-`; the character set also keeps anything shell- or XML-shaped out.
 */
const VOICE_MODEL_PATTERN = /^gemini-[a-z0-9.-]+$/;

/**
 * True when `value` is an acceptable voice model override. Exported so the relay checks
 * the `voiceModel` it receives against the very pattern the web app used to emit it,
 * rather than holding a second copy that could drift.
 */
export function isValidVoiceModel(value: string): boolean {
  return VOICE_MODEL_PATTERN.test(value);
}

/** The ConversationRelay attributes a variant adds. Empty for `today`. */
export interface VoiceTestTurnSettings {
  speechModel?: string;
  /** Maps to the `eotThreshold` option of `buildConversationRelayTwiml`. */
  threshold?: number;
  /** Flux variants always have partial prompts on: the relay needs the eager end-of-turn events. */
  partialPrompts?: boolean;
  language?: string;
}

export interface VoiceTestVariant {
  /** `today` whenever the input was unset, empty or invalid; otherwise the trimmed input. */
  name: string;
  /** False only when a non-empty input could not be parsed and fell back to `today`. */
  valid: boolean;
  turn: VoiceTestTurnSettings;
  /** Replaces the voice model for this call only. Absent means the configured model. */
  voiceModel?: string;
}

const TODAY: VoiceTestVariant = { name: TODAY_VARIANT, valid: true, turn: {} };
const INVALID: VoiceTestVariant = { name: TODAY_VARIANT, valid: false, turn: {} };

export function parseVoiceTestVariant(raw: string | undefined): VoiceTestVariant {
  const value = raw?.trim() ?? '';
  if (value === '' || value === TODAY_VARIANT) {
    return { ...TODAY, turn: {} };
  }

  const plus = value.indexOf('+');
  const base = plus === -1 ? value : value.slice(0, plus);
  const model = plus === -1 ? undefined : value.slice(plus + 1);

  const threshold = Object.hasOwn(FLUX_THRESHOLDS, base) ? FLUX_THRESHOLDS[base] : undefined;
  if (threshold === undefined) {
    // Includes `today+<model>`: the model override belongs to the Flux combined variant only.
    return { ...INVALID, turn: {} };
  }
  if (model !== undefined && !isValidVoiceModel(model)) {
    return { ...INVALID, turn: {} };
  }

  const turn: VoiceTestTurnSettings = {
    speechModel: FLUX_SPEECH_MODEL,
    threshold,
    partialPrompts: true,
  };
  if (FLUX_TRANSCRIPTION_LANGUAGE !== undefined) {
    turn.language = FLUX_TRANSCRIPTION_LANGUAGE;
  }
  return model === undefined
    ? { name: value, valid: true, turn }
    : { name: value, valid: true, turn, voiceModel: model };
}
