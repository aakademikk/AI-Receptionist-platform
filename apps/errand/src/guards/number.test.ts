import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normaliseUkNumber } from './number.ts';

/**
 * Done-means 3: a table of numbers, each in local and E.164 forms where both exist.
 * Allowed numbers are from Ofcom's drama ranges where one exists for the kind.
 */
const REFUSED: Array<[string, string]> = [
  ['999', 'emergency number'],
  [' 9 9 9 ', 'emergency number'],
  ['112', 'emergency number'],
  ['+44 999', 'emergency number'],
  ['0909 879 0000', 'premium or chargeable'],
  ['+44 909 879 0000', 'premium or chargeable'],
  ['0871 234 5678', '084/087 refused in the first release'],
  ['+44 871 234 5678', '084/087 refused in the first release'],
  ['0845 123 4567', '084/087 refused in the first release'],
  ['+448451234567', '084/087 refused in the first release'],
  ['118 118', 'premium or chargeable'],
  ['118500', 'premium or chargeable'],
  ['070 1234 5678', 'personal number'],
  ['+44 70 1234 5678', 'personal number'],
  ['076 2412 3456', 'pager'],
  ['+44 7624 123456', 'pager'],
  ['+33 1 23 45 67 89', 'outside the UK'],
  ['0033 1 23 45 67 89', 'outside the UK'],
  ['+1 212 555 0123', 'outside the UK'],
  ['020 7946 012', 'not a UK number shape'],
  ['020 7946 01234', 'not a UK number shape'],
  ['0500 123456', 'not a UK number shape'],
  ['ring luigi', 'not a UK number shape'],
  ['7946 0123', 'not a UK number shape'],
];

const ALLOWED: Array<[string, string]> = [
  ['0113 496 0123', '+441134960123'],
  ['+44 113 496 0123', '+441134960123'],
  ['0118 496 0123', '+441184960123'],
  ['020 7946 0123', '+442079460123'],
  ['(020) 7946-0123', '+442079460123'],
  ['+44 (0)20 7946 0123', '+442079460123'],
  ['0044 20 7946 0123', '+442079460123'],
  ['0306 999 0123', '+443069990123'],
  ['+44 306 999 0123', '+443069990123'],
  ['07700 900123', '+447700900123'],
  ['+447700900123', '+447700900123'],
  ['07123 456789', '+447123456789'],
  ['07912 345678', '+447912345678'],
  ['0808 157 0123', '+448081570123'],
  ['+44 808 157 0123', '+448081570123'],
  ['0800 123 456', '+44800123456'],
];

describe('normaliseUkNumber', () => {
  for (const [input, reason] of REFUSED) {
    it(`refuses ${JSON.stringify(input)}: ${reason}`, () => {
      assert.deepEqual(normaliseUkNumber(input), { ok: false, reason });
    });
  }
  for (const [input, e164] of ALLOWED) {
    it(`allows ${JSON.stringify(input)} as ${e164}`, () => {
      assert.deepEqual(normaliseUkNumber(input), { ok: true, e164 });
    });
  }
});
