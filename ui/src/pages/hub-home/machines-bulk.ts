import { t } from '@lingui/core/macro';
import type { ComputeNode } from '@sdk';
import { isLaunched, type SandboxDetails } from '@src/hooks/use-sandboxes';
import { errorMessage } from '@src/lib/error-message';
import type { BulkResult } from '@src/lib/run-limited';
import { isOperable } from './machine-status';
import { isSignedInAsMe } from './signed-in-as-me';

export type BulkAction = 'upgrade' | 'signout' | 'delete';
export const BULK_ACTIONS: readonly BulkAction[] = ['upgrade', 'signout', 'delete'];

/** Can the card's Upgrade button run on this box? */
export function canUpgrade(node: ComputeNode, info?: SandboxDetails): boolean {
  return isLaunched(node) && isOperable(info);
}

/**
 * Which of the selected machines each bulk action applies to. Uses the same
 * rules as the card's own buttons, so a bulk run never sends a command the card
 * would not offer. `enabled` is the card-level gate (a disabled card offers nothing).
 */
export function bulkTargets(
  nodes: ComputeNode[],
  details: Record<string, SandboxDetails | undefined>,
  email: string | null | undefined,
  enabled: (node: ComputeNode) => boolean = () => true,
): Record<BulkAction, ComputeNode[]> {
  const usable = nodes.filter(enabled);
  return {
    upgrade: usable.filter((n) => canUpgrade(n, details[n.id])),
    signout: usable.filter((n) => isSignedInAsMe(n, email)),
    delete: usable,
  };
}

/** Every user-facing string for one bulk action, in one place. */
export function bulkActionCopy(action: BulkAction) {
  switch (action) {
    case 'upgrade':
      return {
        button: (n: number) => t`Upgrade (${n})`,
        title: (n: number) => t`Upgrade FlowPad on ${n} machines?`,
        intro: t`FlowPad stops, upgrades and starts again on each. Anyone working in them is interrupted, and paused machines are woken.`,
        skipped: (n: number) => t`${n} skipped: not started, unreachable or unavailable.`,
        will: t`Will upgrade`,
        confirm: t`Upgrade`,
        done: (ok: number, total: number) => t`Upgraded ${ok} of ${total} machines.`,
        failed: t`Some machines were not upgraded`,
      };
    case 'signout':
      return {
        button: (n: number) => t`Sign out (${n})`,
        title: (n: number) => t`Sign out ${n} machines?`,
        intro: t`Your session on each machine is cleared. You stay signed in here.`,
        skipped: (n: number) => t`${n} skipped: not signed in as you, or unavailable.`,
        will: t`Will sign out`,
        confirm: t`Sign out`,
        done: (ok: number, total: number) => t`Signed out ${ok} of ${total} machines.`,
        failed: t`Some machines were not signed out`,
      };
    case 'delete':
      return {
        button: (n: number) => t`Delete (${n})`,
        title: (n: number) => t`Delete ${n} machines?`,
        intro: t`Each machine is shut down and removed. This cannot be undone.`,
        skipped: (n: number) => t`${n} skipped: unavailable.`,
        will: t`Will delete`,
        confirm: t`Delete`,
        done: (ok: number, total: number) => t`Deleted ${ok} of ${total} machines.`,
        failed: t`Some machines were not deleted`,
      };
  }
}

/** "Upgraded 5 of 6 machines. Failed: box-3 (timeout)." */
export function bulkSummary(done: string, result: BulkResult<{ id: string; name?: string | null }>): string {
  if (!result.failed.length) return done;
  const names = result.failed
    .map(({ item, error }) => `${item.name || item.id} (${errorMessage(error, 'failed')})`)
    .join(', ');
  return `${done} ${t`Failed:`} ${names}`;
}
