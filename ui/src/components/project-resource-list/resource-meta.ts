import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import type { LucideIcon } from 'lucide-react';
import { Bot, CheckSquare, Command, FileText, FolderOpen, Plug, Settings, Sparkles, Terminal } from 'lucide-react';
import type { ProjectResourceType } from './ProjectResourceList';

export interface ResourceMeta {
  label: string;
  icon: LucideIcon;
}

export const RESOURCE_META: Record<ProjectResourceType, ResourceMeta> = {
  session: { label: msg`Session`, icon: FolderOpen },
  skill: { label: msg`Skill`, icon: Sparkles },
  mcp_server: { label: msg`MCP Server`, icon: Plug },
  plugin: { label: msg`Plugin`, icon: Settings },
  hook: { label: msg`Hook`, icon: Terminal },
  command: { label: msg`Command`, icon: Command },
  agent: { label: msg`SubAgent`, icon: Bot },
  claude_md: { label: msg`CLAUDE.md`, icon: FileText },
  todo: { label: msg`Todo`, icon: CheckSquare },
};

/** Display order for grouped views (sessions first). */
export const RESOURCE_TYPE_ORDER: ProjectResourceType[] = [
  'claude_session',
  'skill',
  'mcp_server',
  'hook',
  'command',
  'agent',
  'claude_md',
  'todo',
  'plugin',
];
