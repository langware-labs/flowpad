import { HARNESS_CAPABILITY_KINDS, statusService, type StatusRecord } from '@sdk';
import { LazyAsset } from '@sdk/lazy';
import { useLazyAsset } from '@sdk/react/hooks/useLazyAsset';
import { useEffect } from 'react';

export { harnessStatus } from '@sdk';

/**
 * The status record — installed, login, account per harness; stored keys; the FlowPad login.
 *
 * Every fact is Python's (`flow_sdk/core/status`); this hook only reads it, and the backend's
 * `status_changed_msg` keeps it current. Surfaces render these values — they never derive one.
 */
export function useStatusRecord(): { status: StatusRecord | null; isLoading: boolean } {
  const { data, isLoading } = useLazyAsset(LazyAsset.Status, undefined);
  return { status: data ?? null, isLoading };
}

/**
 * Re-discover the harness CLIs and re-probe their logins — the status layer's one refresh verb,
 * narrowed to harnesses (not every capability). Local vendor probes, no network, no money; the
 * backend pushes `status_changed_msg` only if something changed, and every reader follows. A
 * failure leaves the record as it was, which is what is true.
 */
export function refreshHarnessStatus(): void {
  void statusService.refresh([...HARNESS_CAPABILITY_KINDS]).catch(() => undefined);
}

/**
 * Re-check every harness on arrival. A screen that answers "am I signed in" must be right about
 * a login the user ended somewhere else (signed out of the CLI in a terminal, then came here).
 */
export function useRefreshStatusOnArrival(): void {
  // Mount only: an arrival check, not a poll.
  useEffect(refreshHarnessStatus, []);
}
