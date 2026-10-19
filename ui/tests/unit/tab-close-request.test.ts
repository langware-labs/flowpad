import { describe, expect, it, vi } from 'vitest';
import { registerTabCloser, requestTabClose } from '@src/tabs/tab-close-request';

describe('requestTabClose', () => {
  it('closes through the strip that owns the key, and only that one', () => {
    const top = vi.fn((key: string) => key === 'top');
    const child = vi.fn((key: string) => key === 'child');
    const offTop = registerTabCloser(top);
    const offChild = registerTabCloser(child);

    expect(requestTabClose('child')).toBe(true);
    expect(requestTabClose('nobody')).toBe(false);
    expect(requestTabClose('')).toBe(false);

    offTop();
    offChild();
    expect(requestTabClose('top')).toBe(false);
  });
});
