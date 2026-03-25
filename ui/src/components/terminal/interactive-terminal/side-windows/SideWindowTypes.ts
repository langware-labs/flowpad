import type { LucideIcon } from 'lucide-react';
import { FolderGit2, GitBranch, ListOrdered, MessageSquare, Paperclip, SquareTerminal } from 'lucide-react';

export const SideTabId = {
  Shell:    'shell',
  Git:      'git',
  Worktree: 'worktree',
  Prompts:  'prompts',
  Queue:    'queue',
  Files:    'files',
} as const;
export type SideTabId = (typeof SideTabId)[keyof typeof SideTabId];

export interface SideTabDescriptor {
  id: SideTabId;
  label: string;
  icon: LucideIcon;
  description: string;
}

export const SIDE_TABS: Record<SideTabId, SideTabDescriptor> = {
  shell:    { id: 'shell',    label: 'Shell',    icon: SquareTerminal, description: 'Sidecar plain shell alongside Claude Code' },
  git:      { id: 'git',     label: 'Git',      icon: GitBranch,      description: 'Git status of the working directory' },
  worktree: { id: 'worktree',label: 'Worktree', icon: FolderGit2,     description: 'Isolated git worktree for the next session' },
  prompts:  { id: 'prompts', label: 'Prompts',  icon: MessageSquare,  description: 'Index of prompts sent in this session' },
  queue:    { id: 'queue',   label: 'Queue',    icon: ListOrdered,    description: 'Queued prompts to send when the session becomes idle' },
  files:    { id: 'files',   label: 'Files',    icon: Paperclip,      description: 'Input files attached to this session' },
};
