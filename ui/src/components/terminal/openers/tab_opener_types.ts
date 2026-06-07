import type { ComputeNode } from '@sdk';
import type { LucideIcon } from 'lucide-react';
import type { ComponentType, SVGProps } from 'react';

export type OpenerId =
  | 'claude'
  | 'codex'
  | 'copilot'
  | 'claude-resume-by-id'
  | 'terminal'
  | 'sandbox'
  | 'docker'
  | 'history';

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
  pendingInline?: boolean;
  disabled?: boolean;
  dockerNodes?: ComputeNode[];
  onDockerNodeSelect?: (node: ComputeNode) => void;
}
