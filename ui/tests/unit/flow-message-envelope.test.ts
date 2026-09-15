import { describe, expect, it } from 'vitest';
import { profileLabel } from '@sdk/models/MessageEnvelope';

const origin = { kind: 'gmail', namespace: 'me@x.test', key: 'ada@x.test', url: null };

describe('profileLabel', () => {
  it('prints name and address when both are known and differ', () => {
    expect(profileLabel({ origin, name: 'Ada', address: 'ada@x.test' })).toBe('Ada <ada@x.test>');
  });

  it('falls back to whichever part exists', () => {
    expect(profileLabel({ origin, name: null, address: null })).toBe('ada@x.test');
    expect(profileLabel({ origin, name: 'ada@x.test', address: 'ada@x.test' })).toBe('ada@x.test');
    expect(profileLabel(null)).toBe('');
  });
});
