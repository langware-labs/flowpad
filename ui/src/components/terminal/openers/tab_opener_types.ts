import type { LucideIcon } from 'lucide-react';
import type { ComponentType, SVGProps } from 'react';

export type OpenerId =
  | 'claude'
  | 'codex'
  | 'copilot'
  | 'claude-resume-by-id'
  | 'terminal'
  | 'sandbox'
  | 'history'
  | 'open-context';

/** Every valid opener id — the single allow-list for persisting/validating the
 *  last-opener + pinned-opener storage. Kept here (next to `OpenerId`) so the
 *  hooks that read those keys can't drift apart. */
export const VALID_OPENER_IDS: OpenerId[] = [
  'claude',
  'codex',
  'copilot',
  'claude-resume-by-id',
  'terminal',
  'sandbox',
  'history',
  'open-context',
];

export type OpenerIcon = LucideIcon | ComponentType<SVGProps<SVGSVGElement> & { className?: string }>;

export interface OpenerDescriptor {
  id: OpenerId;
  label: string;
  Icon: OpenerIcon;
  iconClassName?: string;
  onActivate: () => void;
  available: boolean;
  /**
   * Capability warning — set when the harness behind this opener failed its
   * backend capability check (e.g. `codex` not on the backend's PATH). The
   * toolbar renders a small "!" sub-icon on the opener and appends the
   * message to its tooltip. The opener stays clickable.
   */
  warning?: string | null;
  /**
   * The capability kind behind this opener (harness openers only). Carried to
   * the Capabilities view when a warned opener routes there, so that view
   * re-probes the capability the user actually asked for instead of showing
   * the last sweep's answer.
   */
  capabilityKind?: string;
  pendingInline?: boolean;
  disabled?: boolean;
}
