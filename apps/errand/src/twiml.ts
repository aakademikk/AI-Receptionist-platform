import { buildConversationRelayTwiml, buildHangupTwiml } from '@atwood/core/integrations/twilio';

import {
  PUBLIC_ORIGIN,
  SOCKET_PATH,
  SPEECH_TIMEOUT_MS,
  TRANSCRIPTION_PROVIDER,
  TTS_PROVIDER,
  VOICE_ID,
  VOICE_LANGUAGE,
  errandHome,
  maskSid,
} from './config.ts';
import { appendEvent, writeOutcome } from './store.ts';

/**
 * Call instructions for an answered errand call: person or machine (must-dos 8, 14; facts B2, B4, B5).
 *
 * With synchronous `DetectMessageEnd` detection, Twilio holds this request until it has
 * decided who answered, then posts `AnsweredBy`: `human` once a person has spoken, or a
 * `machine_end_*` value once a machine's greeting has finished (so a message can be left).
 * The value is recorded first, because it is part of the errand's record (must-do 17) and
 * the first live call is proved against it (Done-means 6).
 *
 *  * `human`, `unknown` or absent: a person. `unknown` is a person by decision (must-do 14),
 *    and so is any value Twilio may add later — reaching a person who is then politely told
 *    who is calling is the safer mistake than hanging up on one. The ConversationRelay has
 *    **no `welcomeGreeting`**: Amy waits for the person to speak first (must-do 8; OPEN 6,
 *    proven live by Done-means 7), and the socket session says the opening line on its first
 *    turn.
 *  * `machine_end_beep`, `machine_end_silence`, `machine_end_other`: the same TwiML with
 *    `mode=voicemail`. Amy's voice leaves one short message and the session ends the call (T16).
 *  * `fax`, or any `machine_start` value (only `Enable` detection gives one, so it means the
 *    end of the greeting was never found): hang up. There is nowhere to leave a message, and
 *    the outcome says so.
 *
 * The voice attributes are VOLTA's `today` variant, copied from facts B5 (never imported from
 * the web app), so Amy sounds like Amy. `dtmfDetection` is on so keypresses on the line are
 * logged; sending digits needs no attribute (fact F1). `AnsweredBy` travels to the socket as a
 * `<Parameter>` because the `setup` frame carries no such field (fact F2). The response ends
 * with an explicit `<Hangup/>` after `<Connect>`: what Twilio does when `<Connect>` ends with no
 * `action` is not documented (facts B4), so nothing is left to the default.
 */

export type CallMode = 'person' | 'voicemail' | 'hangup';

export const MACHINE_WITHOUT_MESSAGE_POINT = 'machine without a message point';

export function modeFor(answeredBy: string | undefined): CallMode {
  if (answeredBy === 'machine_end_beep' || answeredBy === 'machine_end_silence' || answeredBy === 'machine_end_other') return 'voicemail';
  if (answeredBy === 'fax' || answeredBy?.startsWith('machine_start')) return 'hangup';
  return 'person';
}

export function socketUrl(): string {
  return `wss://${new URL(PUBLIC_ORIGIN).host}${SOCKET_PATH}`;
}

export function relayTwiml(errandId: string, answeredBy: string, mode: 'person' | 'voicemail'): string {
  const twiml = buildConversationRelayTwiml({
    url: socketUrl(),
    language: VOICE_LANGUAGE,
    ttsLanguage: VOICE_LANGUAGE,
    ttsProvider: TTS_PROVIDER,
    voice: VOICE_ID,
    transcriptionProvider: TRANSCRIPTION_PROVIDER,
    speechTimeout: SPEECH_TIMEOUT_MS,
    dtmfDetection: true,
    parameters: { errandId, answeredBy, mode },
  });
  return twiml.replace(/\n<\/Response>$/, '\n  <Hangup/>\n</Response>');
}

export function errandTwiml(errandId: string, params: Record<string, string>, options: { home?: string; now?: () => Date } = {}): string {
  const home = options.home ?? errandHome();
  const now = options.now ?? (() => new Date());
  const answeredBy = params.AnsweredBy;
  const mode = modeFor(answeredBy);
  appendEvent(errandId, { kind: 'answered', answeredBy: answeredBy ?? null, mode, callSid: maskSid(params.CallSid) }, now(), home);

  if (mode === 'hangup') {
    writeOutcome(errandId, { kind: 'not_reached', reason: MACHINE_WITHOUT_MESSAGE_POINT, source: 'twiml', at: now().toISOString() }, home);
    return buildHangupTwiml();
  }
  return relayTwiml(errandId, answeredBy ?? 'absent', mode);
}
