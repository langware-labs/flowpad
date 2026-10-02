import { LazyAsset } from '@sdk/lazy';
import { statusService } from '@sdk';
import { useEffect } from 'react';
import { useLazyAsset } from '@sdk/react/hooks/useLazyAsset';
import type { HarnessStatus, StatusRecord } from '@sdk';

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

/** One harness's status by capability kind (`harness.claude.cli`) or driver name (`claude`). */
export function harnessStatus(status: StatusRecord | null | undefined, key: string): HarnessStatus | undefined {
  return status?.harnesses.find((h) => h.kind === key || h.worker_type === key);
}

/**
 * Re-check every harness on arrival: re-discover the CLIs and re-probe their logins.
 *
 * A screen that answers "am I signed in" must be right about a login the user ended somewhere
 * else (signed out of the CLI in a terminal, then came here). That is the status layer's one
 * refresh verb — local vendor probes, no network, no money — and the backend's
 * `status_changed_msg` then re-reads status, funding and connections everywhere, so nothing
 * here invalidates a cache by hand.
 */
export function useRefreshStatusOnArrival(): void {
  useEffect(() => {
    void statusService.refresh().catch(() => undefined);
    // Mount only: an arrival check, not a poll.
  }, []);
}
