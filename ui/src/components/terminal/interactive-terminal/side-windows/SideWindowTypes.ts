import type { LucideIcon } from 'lucide-react';
import { GitBranch, ListOrdered, MessageSquare, Paperclip, SquareTerminal, Users } from 'lucide-react';

export const SideTabId = {
  Shell:   'shell',
  Git:     'git',
  Prompts: 'prompts',
  Queue:   'queue',
  Files:   'files',
  Team:    'team',
} as const;
export type SideTabId = (typeof SideTabId)[keyof typeof SideTabId];

export interface SideTabDescriptor {
  id: SideTabId;
  label: string;
  icon: LucideIcon;
  description: string;
}

export const SIDE_TABS: Record<SideTabId, SideTabDescriptor> = {
  shell:   { id: 'shell',   label: 'Shell',   icon: SquareTerminal, description: 'Sidecar plain shell alongside Claude Code' },
  git:     { id: 'git',     label: 'Git',     icon: GitBranch,      description: 'Git status of the working directory' },
  prompts: { id: 'prompts', label: 'Prompts', icon: MessageSquare,  description: 'Index of prompts sent in this session' },
  queue:   { id: 'queue',   label: 'Queue',   icon: ListOrdered,    description: 'Queued prompts to send when the session becomes idle' },
  files:   { id: 'files',   label: 'Files',   icon: Paperclip,      description: 'Input files attached to this session' },
  team:    { id: 'team',    label: 'Team',    icon: Users,          description: 'Collaborative session participants and invites' },
};

/** Narrow any string to a valid SideTabId, returning null if it's not one. */
export function parseSideTabId(value: string | null | undefined): SideTabId | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  return (Object.values(SideTabId) as string[]).includes(trimmed) ? (trimmed as SideTabId) : null;
}

/** Parse a csv string of side tab ids (e.g. "team,git") into a deduped list. */
export function parseSideTabIdList(csv: string | null | undefined): SideTabId[] {
  if (!csv) return [];
  const seen = new Set<SideTabId>();
  for (const piece of csv.split(',')) {
    const id = parseSideTabId(piece);
    if (id) seen.add(id);
  }
  return [...seen];
}
