import { PrefDataType, PrefKey, PREF_REGISTRY } from '@sdk/preferences/prefRegistry';
import { describe, expect, it } from 'vitest';

describe('message-status preference', () => {
  it('is surfaced in notifications and defaults on', () => {
    const info = PREF_REGISTRY[PrefKey.SHARE_MESSAGE_STATUS];

    expect(info.surfaced).toBe(true);
    expect(info.category).toBe('notifications');
    expect(info.dataType).toBe(PrefDataType.BOOL);
    expect(info.defaultValue).toBe(true);
  });
});
