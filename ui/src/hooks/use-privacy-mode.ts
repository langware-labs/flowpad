import { useCallback, useSyncExternalStore } from 'react';
import { privacyManager, type PrivacyMode } from '@sdk';

/**
 * Reactive access to the instance data-privacy mode (Local/Connected).
 * Backed by privacyManager (the SSoT), which updates on toggle and on the WS
 * broadcast — so every consumer re-renders live.
 */
export function usePrivacyMode(): { mode: PrivacyMode; isLocal: boolean } {
  const subscribe = useCallback((cb: () => void) => {
    privacyManager.on('privacy_mode_changed', cb);
    return () => {
      privacyManager.off('privacy_mode_changed', cb);
    };
  }, []);
  const mode = useSyncExternalStore(
    subscribe,
    () => privacyManager.mode,
    () => privacyManager.mode,
  );
  return { mode, isLocal: mode === 'local' };
}
