import type { Brief } from './brief.ts';
import { OUTCOME_REPORT_MS, errandHome } from './config.ts';
import { renderDay } from './readback.ts';
import { type Outcome, appendEvent, claimReport, readBrief, readEvents, readOutcome } from './store.ts';

/**
 * The outcome report: one message to Colin per errand (must-do 16).
 *
 * Every errand ends in exactly one message, failures included: booked (date, time, name
 * booked under, any reference), not booked (why, and any times offered), voicemail left, not
 * reached (no answer, busy or failed), ended early (which limit), or failed.
 *
 * **Once, enforced by the filesystem.** `reported.json` is created exclusively *before* the
 * notifier runs, so two status posts racing (or Twilio retrying one) cannot both send. If the
 * notifier then fails, that is recorded in the event log and the outcome stays on disk;
 * `notify-colin.sh` itself falls back from Telegram to the phone push.
 *
 * The target is the message within `OUTCOME_REPORT_MS` (2 minutes) of the call ending. The
 * report runs as soon as the terminal status arrives, and the `reported` event records how
 * long after the call's end it went, so a slow notifier shows up in the record.
 */

const KIND_LABEL: Record<Outcome['kind'], string> = {
  booked: 'booked',
  not_booked: 'not booked',
  voicemail_left: 'voicemail left',
  not_reached: 'not reached',
  ended_early: 'ended early',
  failed: 'failed',
};

export function renderOutcome(outcome: Outcome, brief: Brief, errandId?: string): { title: string; body: string } {
  const title = `Errand: ${brief.business}: ${KIND_LABEL[outcome.kind]}`;
  const offered = outcome.offeredTimes?.length ? ` Times offered: ${outcome.offeredTimes.join(', ')}.` : '';
  let body: string;
  switch (outcome.kind) {
    case 'booked': {
      body = `Booked for ${renderDay(outcome.date ?? brief.window.date)} at ${outcome.agreedTime ?? '(time not recorded)'}, under ${outcome.nameBookedUnder ?? brief.contact.name}.`;
      if (outcome.reference) body += ` Reference ${outcome.reference}.`;
      break;
    }
    case 'not_booked':
      body = `Not booked: ${outcome.reason ?? 'no reason given'}.${offered}`;
      break;
    case 'voicemail_left':
      body = `Voicemail left, asking them to call Colin back on ${brief.contact.mobile}.`;
      break;
    case 'not_reached':
      body = `Not reached: ${outcome.reason ?? 'unknown'}.`;
      break;
    case 'ended_early':
      body = `Ended early: ${outcome.limit ?? outcome.reason ?? 'limit not recorded'}.${offered}`;
      break;
    case 'failed':
      body = `Failed: ${outcome.reason ?? 'unknown'}.`;
      break;
  }
  return { title, body: errandId ? `${body}\nErrand ${errandId}` : body };
}

export interface ReportDeps {
  notify: (args: string[]) => Promise<number>;
  now?: () => Date;
  home?: string;
}

/** Send the outcome once. False when there is no outcome yet or it was already reported. */
export async function reportOnce(errandId: string, deps: ReportDeps): Promise<boolean> {
  const home = deps.home ?? errandHome();
  const now = deps.now ?? (() => new Date());
  const outcome = readOutcome(errandId, home);
  const brief = readBrief(errandId, home);
  if (!outcome || !brief) return false;
  if (!claimReport(errandId, now(), home)) return false;

  const { title, body } = renderOutcome(outcome, brief, errandId);
  const code = await deps.notify([title, body, '--full', `${title}\n${body}`]).catch(() => -1);
  const sentAt = now();
  const callEnd = readEvents(errandId, home)
    .filter((event) => event.kind === 'status' && ['completed', 'no-answer', 'busy', 'failed', 'canceled'].includes(String(event.status)))
    .map((event) => Date.parse(event.time))
    .at(0);
  const sinceCallEndMs = callEnd === undefined ? null : sentAt.getTime() - callEnd;
  appendEvent(
    errandId,
    { kind: 'reported', notifyExit: code, sinceCallEndMs, late: sinceCallEndMs !== null && sinceCallEndMs > OUTCOME_REPORT_MS },
    sentAt,
    home,
  );
  return true;
}
