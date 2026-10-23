import { ExecutionEnvironmentStatus } from '@sdk';
import type { SandboxDetails } from '@src/hooks/use-sandboxes';

/**
 * Did the status probe come back saying the machine cannot be reached?
 *
 * `ERROR` is the one status that means "there is a box and it did not answer" —
 * the same state the card labels "Unreachable". Absent details are NOT this: a
 * probe still in flight is unknown, not failed, and treating it as failed would
 * blank the card's actions on every render before the first poll lands.
 */
export function isUnreachable(info?: SandboxDetails): boolean {
  return info?.status === ExecutionEnvironmentStatus.ERROR;
}

/**
 * A connected machine with no live connection to the hub. Open, Terminal and
 * Upgrade can only fail — the hub cannot wake it — so the card offers Connect.
 */
export function isDisconnected(info?: SandboxDetails): boolean {
  return info?.status === ExecutionEnvironmentStatus.DISCONNECTED;
}

/** Can the box be acted on (opened, shelled into, upgraded)? Not while unreachable or disconnected. */
export function isOperable(info?: SandboxDetails): boolean {
  return !isUnreachable(info) && !isDisconnected(info);
}
