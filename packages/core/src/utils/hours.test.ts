import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeOpeningHours, isOpenNow, isWithinQuietHours } from './hours.ts';
import type { OpeningHoursContext } from '../types/domain.ts';

const hours = (
  overrides: Partial<Record<number, Partial<OpeningHoursContext>>> = {},
): OpeningHoursContext[] =>
  [0, 1, 2, 3, 4, 5, 6].map((day) => ({
    day_of_week: day,
    // Mon–Fri 09:00–17:30, Saturday morning only, closed Sunday. Saturday differs
    // deliberately so the day-collapsing tests exercise a real boundary.
    opens_at: day === 0 ? null : day === 6 ? '09:30' : '09:00',
    closes_at: day === 0 ? null : day === 6 ? '12:30' : '17:30',
    is_closed: day === 0,
    ...overrides[day],
  }));

describe('isOpenNow', () => {
  it('is open during a weekday shift in the business timezone', () => {
    // 2026-07-30 is a Thursday. 12:00 UTC = 13:00 in London (BST).
    const at = new Date('2026-07-30T12:00:00Z');
    assert.equal(isOpenNow(hours(), at, 'Europe/London'), true);
  });

  it('is closed on a day flagged closed', () => {
    // 2026-08-02 is a Sunday.
    const at = new Date('2026-08-02T12:00:00Z');
    assert.equal(isOpenNow(hours(), at, 'Europe/London'), false);
  });

  it('respects the business timezone rather than the server clock', () => {
    // 23:30 UTC on Thursday is 00:30 Friday in London (closed) but 09:30 Friday in
    // Sydney (open). A naive implementation using the server's clock would return
    // the same answer for both, which is the bug this guards against.
    const at = new Date('2026-07-30T23:30:00Z');
    assert.equal(isOpenNow(hours(), at, 'Europe/London'), false);
    assert.equal(isOpenNow(hours(), at, 'Australia/Sydney'), true);
  });

  it('handles British Summer Time', () => {
    // 08:30 UTC in July is 09:30 BST — open. The same instant in January would be
    // 08:30 GMT — closed. Same wall-clock rule, different UTC offset.
    assert.equal(isOpenNow(hours(), new Date('2026-07-30T08:30:00Z'), 'Europe/London'), true);
    assert.equal(isOpenNow(hours(), new Date('2026-01-29T08:30:00Z'), 'Europe/London'), false);
  });

  it('handles a shift that runs past midnight', () => {
    const lateNight = hours({
      5: { day_of_week: 5, opens_at: '20:00', closes_at: '02:00', is_closed: false },
    });
    // Friday 22:00 London.
    assert.equal(isOpenNow(lateNight, new Date('2026-07-31T21:00:00Z'), 'Europe/London'), true);
  });

  it('is closed when no hours are published', () => {
    assert.equal(isOpenNow([], new Date(), 'Europe/London'), false);
  });

  it('degrades to UTC rather than throwing on a bad timezone', () => {
    assert.doesNotThrow(() => isOpenNow(hours(), new Date('2026-07-30T12:00:00Z'), 'Not/AZone'));
  });
});

describe('describeOpeningHours', () => {
  it('collapses consecutive identical days', () => {
    const description = describeOpeningHours(hours());
    assert.match(description, /Monday to Friday: 09:00–17:30/);
    assert.match(description, /Sunday: Closed/);
  });

  it('does not collapse days with different hours', () => {
    const withSaturday = hours({
      6: { day_of_week: 6, opens_at: '09:30', closes_at: '12:30', is_closed: false },
    });
    const description = describeOpeningHours(withSaturday);
    assert.match(description, /Saturday: 09:30–12:30/);
  });

  it('says so when nothing is published', () => {
    assert.match(describeOpeningHours([]), /have not been published/);
  });
});

describe('isWithinQuietHours', () => {
  it('handles a window that wraps midnight', () => {
    // 23:00 London on a July night = 22:00 UTC.
    assert.equal(isWithinQuietHours('21:00', '08:00', new Date('2026-07-30T22:00:00Z'), 'Europe/London'), true);
    // 14:00 London is well outside it.
    assert.equal(isWithinQuietHours('21:00', '08:00', new Date('2026-07-30T13:00:00Z'), 'Europe/London'), false);
  });

  it('is false when quiet hours are unset', () => {
    assert.equal(isWithinQuietHours(null, null, new Date(), 'Europe/London'), false);
  });
});
