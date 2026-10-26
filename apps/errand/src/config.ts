import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Errand caller configuration: every tunable in one place.
 *
 * Each value below is a decision Colin locked on 2026-10-26 (the spec's "Locked decisions"
 * and the tickets' "Locked values" table). They are named constants rather than inline
 * numbers so a reader can find the one place a limit lives, and so a test can name the
 * limit it proves rather than repeating a magic number that could drift from the code.
 *
 * Nothing here is a secret. The Twilio credentials and the model key arrive in the process
 * environment through `with-secrets --as errand-caller` and are read where they are used,
 * never logged and never stored here.
 *
 * Paths under `~/.sam` are the live locations and are only defaults: each can be pointed
 * somewhere else by an environment variable, which is how every test runs against a temp
 * folder and never touches the live box. They are functions rather than constants so the
 * value is read at call time — a module-level constant would freeze whatever the
 * environment held when the module was first imported, and a test that sets the variable
 * afterwards would silently write to the real folder.
 */

/** The robot number. Errands ring from here, never from VOLTA's number (must-do 7). */
export const ROBOT_NUMBER = '+447861926390';

/** A Go older than this is refused (OPEN 2). Measured from the Go question's creation. */
export const GO_EXPIRY_MS = 30 * 60 * 1000;

/**
 * Most turns one call may take (OPEN 3). Menu steps count towards it (must-do 13), so a
 * phone tree that loops cannot run the call on for ever.
 */
export const TURN_CAP = 20;

/** Seconds the business's phone rings before Twilio gives up (OPEN 3). Twilio's default is 60. */
export const RING_TIMEOUT_S = 30;

/** Hard maximum call length in seconds, sent as `TimeLimit` on every create (OPEN 3). */
export const MAX_CALL_S = 8 * 60;

/** Turns in a row Amy cannot place before she rings off politely (must-do 12). */
export const CONFUSED_LIMIT = 2;

/** Each model turn is abandoned after this; Amy says a fixed line and rings off (Robustness). */
export const MODEL_TIMEOUT_MS = 8000;

/** The Twilio call create is abandoned after this and never retried (Robustness, must-do 18). */
export const CALL_CREATE_TIMEOUT_MS = 15_000;

/** Colin hears the outcome within this long of the call ending (must-do 16). */
export const OUTCOME_REPORT_MS = 2 * 60 * 1000;

/** A dialled errand with no outcome this long after dialling raises one alert (must-do 19). */
export const NO_OUTCOME_ALERT_MS = 20 * 60 * 1000;

/** Errand folders are kept this many days, then pruned (OPEN 12). */
export const RETENTION_DAYS = 90;

/**
 * No dialling outside these hours, UK time (OPEN 14). `startHour` is allowed, `endHour` is
 * not: 08:00 dials, 21:00 does not. The zone, not a fixed offset, so BST and GMT both hold.
 */
export const CALLING_HOURS = { startHour: 8, endHour: 21, timeZone: 'Europe/London' } as const;

/** Amy's first words on every person call, and the start of every voicemail (OPEN 17). */
export const OPENING_LINE = 'Hi, this is Amy, an automated assistant calling on behalf of Colin Wood.';

/**
 * Amy's voice: the same ElevenLabs voice VOLTA uses, so Amy sounds like Amy (locked
 * decision; facts B5). A bare ElevenLabs id, no provider prefix, exactly as VOLTA sends it.
 */
export const VOICE_ID = '6fZce9LFNG3iEITDfqZZ';

/** The voice settings copied from VOLTA's `today` variant (facts B5). Copied, never imported. */
export const VOICE_LANGUAGE = 'en-GB';
export const TTS_PROVIDER = 'ElevenLabs' as const;
export const TRANSCRIPTION_PROVIDER = 'Deepgram' as const;
export const SPEECH_TIMEOUT_MS = 1200;

/** Amy's model and thinking effort, the same Gemini flash as VOLTA's voice line (OPEN 10; facts B6). */
export const ERRAND_MODEL = 'gemini-3.8-flash';
export const ERRAND_EFFORT = 'low' as const;

/** Visible-answer allowance for one turn's JSON decision. Thinking headroom is added by core. */
export const ERRAND_MAX_OUTPUT_TOKENS = 400;

/**
 * Synchronous answering-machine detection that waits for the end of a greeting, so a
 * message can be left (OPEN 4; facts B1, B2). Synchronous means `AsyncAmd` is never sent.
 */
export const MACHINE_DETECTION = 'DetectMessageEnd';

/** The errand process's port on 127.0.0.1 (free on 2026-10-26; facts C7). */
export const ERRAND_PORT = 3003;

/** The public origin Twilio reaches the errand endpoints on, through the tunnel. */
export const PUBLIC_ORIGIN = 'https://receptionist.atwoodsystems.co.uk';

/** The errand endpoints. The tunnel rule (deploy/tunnel-rule.yml) routes the first three here. */
export const TWIML_PATH = '/errand/twiml';
export const STATUS_PATH = '/errand/status';
export const SOCKET_PATH = '/errand/ws';
export const HEALTH_PATH = '/errand/health';

/** How long the dial step waits for the errand service's health answer. */
export const HEALTH_TIMEOUT_MS = 2000;

/**
 * Seconds a call may still be live after dialling before the live-errand guard stops
 * counting it: `MAX_CALL_S` plus this margin. Older ones belong to the watchdog.
 */
export const LIVE_MARGIN_MS = 5 * 60 * 1000;

/** The session ends a call this long before `MAX_CALL_S`, politely, ahead of Twilio's hard stop. */
export const MAX_LENGTH_LEAD_MS = 10_000;

/**
 * How long Amy's last line is allowed to play before the session sends `end`. Twilio gives
 * no "finished speaking" signal for a text token, so the allowance is per word, with a floor.
 */
export const PLAY_MS_PER_WORD = 400;
export const PLAY_MS_MIN = 1500;

/** The errand id's shape: date, time, short slug (spec Robustness "Data model"; T5). */
export const ERRAND_ID_PATTERN = /^\d{4}-\d{2}-\d{2}-\d{4}-[a-z0-9-]{1,40}$/;

function samHome(): string {
  return join(homedir(), '.sam');
}

/** One folder per errand lives here. Override: `ERRAND_HOME`. */
export function errandHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.ERRAND_HOME?.trim() || join(samHome(), 'work', 'errand-caller', 'calls');
}

/**
 * The closer's job store, where the bridge writes Colin's answer to the Go question
 * (facts A1, A5). Override: `SAM_JOB_STORE`, the same name the closer itself honours.
 */
export function jobStore(env: NodeJS.ProcessEnv = process.env): string {
  return env.SAM_JOB_STORE?.trim() || join(samHome(), 'jobs');
}

/** The one notifier: Telegram first, phone push as the fallback. Override: `ERRAND_NOTIFY_BIN`. */
export function notifyBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.ERRAND_NOTIFY_BIN?.trim() || join(samHome(), 'notify-colin.sh');
}

/** `sam-push`'s send log, the second trace of a Go question (facts A5). Override: `ERRAND_PUSH_LOG`. */
export function pushLog(env: NodeJS.ProcessEnv = process.env): string {
  return env.ERRAND_PUSH_LOG?.trim() || join(samHome(), 'push-log.jsonl');
}

/** The host every Twilio request must avoid. Auth is region-scoped; this host gives false answers. */
const GLOBAL_TWILIO_HOST = 'api.twilio.com';

/**
 * The account's own Twilio API base, refusing the global host.
 *
 * Core's `twilioApiBaseUrl` falls back to the global host when the variable is unset, which
 * is right for an account in the default region and wrong for this one: the account lives
 * on the Dublin edge, and the global host answers a region-scoped token with false results
 * (platform note gotcha 13). An errand must never be placed on a guess, so here an absent
 * value or the global host is an error before any request is built. The trailing slash is
 * stripped because callers append `/Accounts/...`.
 */
export function requireTwilioBase(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.TWILIO_API_BASE_URL?.trim();
  if (!raw) {
    throw new Error('TWILIO_API_BASE_URL is not set; errand calls go only through the account\'s own regional base.');
  }
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    throw new Error('TWILIO_API_BASE_URL is not a valid URL.');
  }
  if (host === GLOBAL_TWILIO_HOST) {
    throw new Error(`TWILIO_API_BASE_URL names ${GLOBAL_TWILIO_HOST}; errand calls must use the regional edge.`);
  }
  return raw.replace(/\/+$/, '');
}

/** First 4 and last 4 characters, the house way of showing a Twilio SID in any output. */
export function maskSid(sid: string | null | undefined): string {
  if (!sid) return '(none)';
  if (sid.length <= 8) return '****';
  return `${sid.slice(0, 4)}...${sid.slice(-4)}`;
}
