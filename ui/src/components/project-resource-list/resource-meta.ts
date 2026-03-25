import type { LucideIcon } from 'lucide-react';
import { Bot, CheckSquare, Command, FileText, FolderOpen, Plug, Settings, Sparkles, Terminal } from 'lucide-react';
import type { ProjectResourceType } from './ProjectResourceList';

export interface ResourceMeta {
  label: string;
  icon: LucideIcon;
}

export const RESOURCE_META: Record<ProjectResourceType, ResourceMeta> = {
  session: { label: 'Session', icon: FolderOpen },
  skill: { label: 'Skill', icon: Sparkles },
  mcp_server: { label: 'MCP Server', icon: Plug },
  plugin: { label: 'Plugin', icon: Settings },
  hook: { label: 'Hook', icon: Terminal },
  command: { label: 'Command', icon: Command },
  agent: { label: 'Agent', icon: Bot },
  claude_md: { label: 'CLAUDE.md', icon: FileText },
  todo: { label: 'Todo', icon: CheckSquare },
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
