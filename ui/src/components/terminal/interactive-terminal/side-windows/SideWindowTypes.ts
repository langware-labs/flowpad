import type { LucideIcon } from 'lucide-react';
import { FolderTree, GitBranch, Layers, ListOrdered, MessageSquare, Paperclip, SquareTerminal } from 'lucide-react';

export const SideTabId = {
  Shell:   'shell',
  Git:     'git',
  Prompts: 'prompts',
  Queue:   'queue',
  Files:   'files',
  Dir:     'dir',
  Context: 'context',
} as const;
export type SideTabId = (typeof SideTabId)[keyof typeof SideTabId];

export interface SideTabDescriptor {
  id: SideTabId;
  label: string;
  icon: LucideIcon;
  description: string;
  /** Skin layer: power-user tab — its ribbon button only appears in Advanced/Dev. See docs/viewmodes.md. */
  advancedOnly?: boolean;
}

export const SIDE_TABS: Record<SideTabId, SideTabDescriptor> = {
  shell:   { id: 'shell',   label: 'Shell',   icon: SquareTerminal, description: 'Sidecar plain shell alongside Claude Code' },
  git:     { id: 'git',     label: 'Git',     icon: GitBranch,      description: 'Git status of the working directory', advancedOnly: true },
  prompts: { id: 'prompts', label: 'Prompts', icon: MessageSquare,  description: 'Index of prompts sent in this session' },
  queue:   { id: 'queue',   label: 'Queue',   icon: ListOrdered,    description: 'Prompts queued for this agent; the backend injects each when the worker is ready', advancedOnly: true },
  files:   { id: 'files',   label: 'Files',   icon: Paperclip,      description: 'Input files attached to this session' },
  dir:     { id: 'dir',     label: 'Dir',     icon: FolderTree,     description: 'Browse the working directory', advancedOnly: true },
  context: { id: 'context', label: 'Context', icon: Layers,         description: 'Context entities attached to this process — plans, skills, project, …', advancedOnly: true },
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
