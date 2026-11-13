import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  FolderTree,
  GitBranch,
  ListOrdered,
  MessageSquare,
  Paperclip,
  Sparkles,
  SquareTerminal,
} from 'lucide-react';
import { lucideByName } from '@src/lib/lucide-by-name';

export const SideTabId = {
  Shell: 'shell',
  Git: 'git',
  Prompts: 'prompts',
  Queue: 'queue',
  Files: 'files',
  Dir: 'dir',
  Context: 'context',
  Analysis: 'analysis',
  SkillsAgents: 'skills-agents',
} as const;
export type SideTabId = (typeof SideTabId)[keyof typeof SideTabId];

export interface SideTabDescriptor {
  id: SideTabId;
  label: MessageDescriptor;
  icon: LucideIcon;
  description: MessageDescriptor;
  /** Skin layer: power-user tab — its ribbon button only appears in Advanced/Dev. See docs/viewmodes.md. */
  advancedOnly?: boolean;
  /** Where its launcher lives: the terminal ribbon, the session menu's
   *  "Session context" section, or nowhere (URL only). Default: nowhere. */
  placement?: 'ribbon' | 'session-menu';
}

export const SIDE_TABS: Record<SideTabId, SideTabDescriptor> = {
  shell: {
    id: 'shell',
    label: msg`Shell`,
    icon: SquareTerminal,
    description: msg`Sidecar plain shell alongside Claude Code`,
  },
  git: {
    id: 'git',
    label: msg`Git`,
    icon: GitBranch,
    description: msg`Git status of the working directory`,
    advancedOnly: true,
  },
  prompts: {
    id: 'prompts',
    label: msg`Prompts`,
    icon: MessageSquare,
    description: msg`Index of prompts sent in this session`,
    placement: 'ribbon',
  },
  files: {
    id: 'files',
    label: msg`Files`,
    icon: Paperclip,
    description: msg`Input files attached to this session`,
    placement: 'ribbon',
  },
  dir: {
    id: 'dir',
    label: msg`Dir`,
    icon: FolderTree,
    description: msg`Browse the working directory`,
    advancedOnly: true,
    placement: 'ribbon',
  },
  queue: {
    id: 'queue',
    label: msg`Queue`,
    icon: ListOrdered,
    description: msg`Prompts queued for this agent; the backend injects each when the worker is ready`,
    advancedOnly: true,
    placement: 'ribbon',
  },
  context: {
    id: 'context',
    label: msg`Context`,
    // The Context type's own glyph, by tag: this table is built before the type registry loads.
    icon: lucideByName('flowpad.context'),
    description: msg`Context entities attached to this process — plans, skills, project, …`,
    advancedOnly: true,
    placement: 'session-menu',
  },
  analysis: {
    id: 'analysis',
    label: msg`Analysis`,
    icon: Activity,
    description: msg`Analyses (AgentTrace) of this session — run, list and open`,
    placement: 'session-menu',
  },
  'skills-agents': {
    id: 'skills-agents',
    label: msg`Skills`,
    icon: Sparkles,
    description: msg`Skills and sub-agents invoked in this session`,
    advancedOnly: true,
    placement: 'session-menu',
  },
};

/** The side tabs launched from `placement`, in SIDE_TABS order; advanced-only ones only in Advanced view. */
export function sideTabsAt(placement: SideTabDescriptor['placement'], isAdvanced: boolean): SideTabDescriptor[] {
  return Object.values(SIDE_TABS).filter((d) => d.placement === placement && (isAdvanced || !d.advancedOnly));
}

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
