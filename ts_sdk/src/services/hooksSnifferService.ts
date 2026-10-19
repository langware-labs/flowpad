/**
 * The hooks-sniffer wire contract.
 *
 * The calls themselves live on `snifferManager`, which owns the watch lifecycle
 * around them; this module carries only what both the manager and its consumers
 * need to name.
 */

export interface HooksSnifferStatus {
  enabled: boolean;
  hook_id?: string | null;
  hook_scope?: string | null;
  /** Sniffer commands are present in the harness settings file — it is really running. */
  installed?: boolean;
}

export const HOOKS_SNIFFER_ACTION = 'hooks-sniffer';
