import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import React from 'react';

// Mock PtySyncSession — snapshot must be referentially stable to avoid infinite re-renders
const stableSnapshot = {
  adapter: null,
  vt: null,
  version: 0,
};

const mockSession = {
  subscribe: vi.fn((cb: () => void) => {
    return () => {};
  }),
  getSnapshot: vi.fn(() => stableSnapshot),
};

// Mock the SDK module
vi.mock('@sdk/pty-sync/PtySyncSession.js', () => ({
  PtySyncSession: vi.fn(() => mockSession),
}));

import { PtySyncProvider, usePtySync } from '@src/components/terminal/interactive-terminal/PtySyncContext';

describe('usePtySync', () => {
  it('throws when called outside PtySyncProvider', () => {
    expect(() => {
      renderHook(() => usePtySync());
    }).toThrow('usePtySync must be used within PtySyncProvider');
  });

  it('returns snapshot when inside PtySyncProvider', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <PtySyncProvider session={mockSession as any}>{children}</PtySyncProvider>
    );

    const { result } = renderHook(() => usePtySync(), { wrapper });
    expect(result.current.version).toBe(0);
    expect(result.current.adapter).toBeNull();
  });
});
