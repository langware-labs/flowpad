import { SystemResourceType, type SystemResourceTypeValue } from '@src/store/resource-manager';
import {
  Bot,
  CheckSquare,
  Command,
  FileText,
  FolderOpen,
  Plug,
  Settings,
  Sparkles,
  Webhook,
  type LucideIcon,
} from 'lucide-react';

export const ProjectResourceKind = {
  SKILL: 'skill',
  MCP_SERVER: 'mcp_server',
  PLUGIN: 'plugin',
  HOOK: 'hook',
  COMMAND: 'command',
  AGENT: 'agent',
  SESSION: 'claude_session',
  TODO: 'todo',
  CLAUDE_MD: 'claude_md',
} as const;

export type ProjectResourceType = (typeof ProjectResourceKind)[keyof typeof ProjectResourceKind];

export interface ProjectResourceDescriptor {
  type: ProjectResourceType;
  label: string;
  icon: LucideIcon;
  systemType: SystemResourceTypeValue;
}

export const PROJECT_RESOURCE_DESCRIPTORS: Record<ProjectResourceType, ProjectResourceDescriptor> = {
  [ProjectResourceKind.SKILL]: {
    type: ProjectResourceKind.SKILL,
    label: 'Skill',
    icon: Sparkles,
    systemType: SystemResourceType.SKILL,
  },
  [ProjectResourceKind.MCP_SERVER]: {
    type: ProjectResourceKind.MCP_SERVER,
    label: 'MCP',
    icon: Plug,
    systemType: SystemResourceType.MCP_SERVER,
  },
  [ProjectResourceKind.PLUGIN]: {
    type: ProjectResourceKind.PLUGIN,
    label: 'Plugin',
    icon: Settings,
    systemType: SystemResourceType.PLUGIN,
  },
  [ProjectResourceKind.HOOK]: {
    type: ProjectResourceKind.HOOK,
    label: 'Hook',
    icon: Webhook,
    systemType: SystemResourceType.HOOK,
  },
  [ProjectResourceKind.COMMAND]: {
    type: ProjectResourceKind.COMMAND,
    label: 'Command',
    icon: Command,
    systemType: SystemResourceType.COMMAND,
  },
  [ProjectResourceKind.AGENT]: {
    type: ProjectResourceKind.AGENT,
    label: 'Agent',
    icon: Bot,
    systemType: SystemResourceType.AGENT,
  },
  [ProjectResourceKind.SESSION]: {
    type: ProjectResourceKind.SESSION,
    label: 'Session',
    icon: FolderOpen,
    systemType: SystemResourceType.SESSION,
  },
  [ProjectResourceKind.TODO]: {
    type: ProjectResourceKind.TODO,
    label: 'Todo',
    icon: CheckSquare,
    systemType: SystemResourceType.TODO_FILE,
  },
  [ProjectResourceKind.CLAUDE_MD]: {
    type: ProjectResourceKind.CLAUDE_MD,
    label: 'CLAUDE.md',
    icon: FileText,
    systemType: SystemResourceType.CLAUDE_MD,
  },
};

export const PROJECT_RESOURCE_TYPES = Object.values(ProjectResourceKind) as ProjectResourceType[];

export const NON_SESSION_PROJECT_RESOURCE_TYPES = PROJECT_RESOURCE_TYPES.filter(
  (type) => type !== ProjectResourceKind.SESSION,
) as ProjectResourceType[];

export function getProjectResourceDescriptor(type: ProjectResourceType): ProjectResourceDescriptor {
  return PROJECT_RESOURCE_DESCRIPTORS[type];
}
