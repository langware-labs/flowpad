import { expect, test } from 'vitest';

import { parseOwnCodes } from '@src/components/assets/editor/agent-profile/InviteCodesDialog';

test('own codes: one per line, names paired by index, blank lines skipped', () => {
  expect(parseOwnCodes('bcdf-2345, Spare1\nMNPQ RSTV\n\nBCDF-2346, Cohen, Dana')).toEqual({
    codes: ['bcdf-2345', 'MNPQ RSTV', 'BCDF-2346'],
    names: ['Spare1', '', 'Cohen, Dana'],
  });
});
