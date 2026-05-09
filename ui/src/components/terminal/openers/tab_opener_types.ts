import type { ComputeNode } from '@sdk';
import type { LucideIcon } from 'lucide-react';
import type { ComponentType, SVGProps } from 'react';

export type OpenerId =
  | 'claude'
  | 'codex'
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
  pendingInline?: boolean;
  disabled?: boolean;
  dockerNodes?: ComputeNode[];
  onDockerNodeSelect?: (node: ComputeNode) => void;
}
