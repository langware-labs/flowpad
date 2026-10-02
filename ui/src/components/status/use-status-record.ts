import { LazyAsset } from '@sdk/lazy';
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
