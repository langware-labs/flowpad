/**
 * useMembershipAvailability — the single gate every members surface reads to
 * decide "can this client do membership?". Membership is 100% hub-driven, so:
 *  - Local (privacy) mode        → unavailable, reason 'local'
 *  - Signed out                  → unavailable, reason 'unauthenticated'
 *  - Signed in (desktop or web)  → available
 */
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

let auth: { user: unknown; cloudUser: unknown } = { user: null, cloudUser: null };
let ctx: { cloudLoginAvailable: boolean; isDesktop: boolean } = {
  cloudLoginAvailable: false,
  isDesktop: true,
};
let privacy: { isLocal: boolean } = { isLocal: false };

vi.mock('@sdk/react/hooks', () => ({
  useAuth: () => auth,
  useContext: () => ctx,
}));
vi.mock('@src/hooks/use-privacy-mode', () => ({
  usePrivacyMode: () => privacy,
}));

import { useMembershipAvailability } from '@src/hooks/use-membership-availability';

describe('useMembershipAvailability', () => {
  beforeEach(() => {
    auth = { user: null, cloudUser: null };
    ctx = { cloudLoginAvailable: false, isDesktop: true };
    privacy = { isLocal: false };
  });

  it('Local mode → unavailable, reason "local" (even if otherwise signed in)', () => {
    privacy = { isLocal: true };
    ctx = { cloudLoginAvailable: true, isDesktop: true };
    const { result } = renderHook(() => useMembershipAvailability());
    expect(result.current).toEqual({ available: false, reason: 'local' });
  });

  it('desktop + no cloud login → unavailable, reason "unauthenticated"', () => {
    ctx = { cloudLoginAvailable: false, isDesktop: true };
    auth = { user: { id: 'local' }, cloudUser: null };
    const { result } = renderHook(() => useMembershipAvailability());
    expect(result.current).toEqual({ available: false, reason: 'unauthenticated' });
  });

  it('desktop + cloudLoginAvailable → available', () => {
    ctx = { cloudLoginAvailable: true, isDesktop: true };
    const { result } = renderHook(() => useMembershipAvailability());
    expect(result.current).toEqual({ available: true, reason: 'available' });
  });

  it('desktop + a resolved cloudUser → available', () => {
    ctx = { cloudLoginAvailable: false, isDesktop: true };
    auth = { user: { id: 'local' }, cloudUser: { id: 'cloud' } };
    const { result } = renderHook(() => useMembershipAvailability());
    expect(result.current).toEqual({ available: true, reason: 'available' });
  });

  it('web (not desktop): a local user is enough → available', () => {
    ctx = { cloudLoginAvailable: false, isDesktop: false };
    auth = { user: { id: 'web-user' }, cloudUser: null };
    const { result } = renderHook(() => useMembershipAvailability());
    expect(result.current).toEqual({ available: true, reason: 'available' });
  });

  it('web (not desktop): no user → unauthenticated', () => {
    ctx = { cloudLoginAvailable: false, isDesktop: false };
    auth = { user: null, cloudUser: null };
    const { result } = renderHook(() => useMembershipAvailability());
    expect(result.current).toEqual({ available: false, reason: 'unauthenticated' });
  });
});
