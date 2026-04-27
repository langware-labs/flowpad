import { Agent, Markdown, Project, Skill, Task, Workflow } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { Bot, CheckSquare, FileText, Sparkles, Workflow as WorkflowIcon, type LucideIcon } from 'lucide-react';

/**
 * Result returned by a QuickCreateDescriptor's `create` function.
 *
 * `pointer` — optional DockPointer to navigate to after creation (e.g. open the new
 * skill's editor). `toastTitle` — short success message shown to the user.
 */
export interface QuickCreateResult {
  pointer?: DockPointer;
  toastTitle: string;
}

export interface QuickCreateCreateArgs {
  project: Project | null;
  name: string;
  folderVfsPath?: string;
}

export interface QuickCreateDescriptor {
  /** Matches server `AssetTypeInfo.type_name` so labels can be joined at render time. */
  type: string;
  /** Fallback label when no server label is available (also used for display consistency). */
  label: string;
  /** React icon component, rendered in the quick-create menu and dialog header. */
  Icon: LucideIcon;
  /** When true, the create dialog renders a directory tree for folder placement. */
  allowFolderSelection: boolean;
  /** VFS-relative default folder under the project mount (e.g. `.claude/skills`). */
  defaultFolder?: string;
  /** Creation function — shared between the quick-create dialog and AssetsPage. */
  create: (args: QuickCreateCreateArgs) => Promise<QuickCreateResult>;
}

export const QUICK_CREATE_REGISTRY: QuickCreateDescriptor[] = [
  {
    type: 'skill',
    label: 'Skill',
    Icon: Sparkles,
    allowFolderSelection: true,
    defaultFolder: '.claude/skills',
    create: async ({ project, name, folderVfsPath }) => {
      const saved = await Skill.createInProject(project, name, folderVfsPath);
      return {
        pointer: saved.asset_ref ? DockPointer.forAssetEditor('skill', saved.asset_ref) : undefined,
        toastTitle: 'Skill created',
      };
    },
  },
  {
    type: 'agent',
    label: 'Agent',
    Icon: Bot,
    allowFolderSelection: true,
    defaultFolder: '.claude/agents',
    create: async ({ project, name, folderVfsPath }) => {
      const saved = await Agent.createInProject(project, name, folderVfsPath);
      return {
        pointer: saved.asset_ref ? DockPointer.forAssetEditor('agent', saved.asset_ref) : undefined,
        toastTitle: 'Agent created',
      };
    },
  },
  {
    type: 'workflow',
    label: 'Workflow',
    Icon: WorkflowIcon,
    allowFolderSelection: false,
    create: async ({ project, name, folderVfsPath }) => {
      const saved = await Workflow.createInProject(project, name, folderVfsPath);
      return {
        pointer: saved.asset_ref ? DockPointer.forAssetEditor('workflow', saved.asset_ref) : undefined,
        toastTitle: 'Workflow created',
      };
    },
  },
  {
    type: 'task',
    label: 'Task',
    Icon: CheckSquare,
    allowFolderSelection: false,
    create: async ({ project, name }) => {
      const task = await Task.createInProject(project, name);
      return {
        pointer: DockPointer.forTasks(task.id),
        toastTitle: 'Task created',
      };
    },
  },
  {
    type: 'markdown',
    label: 'Markdown',
    Icon: FileText,
    allowFolderSelection: true,
    defaultFolder: '.claude/docs',
    create: async ({ project, name }) => {
      const md = await Markdown.createInProject(project, name);
      return {
        pointer: md.asset_ref ? DockPointer.forAssetEditor('markdown', md.asset_ref) : undefined,
        toastTitle: 'Markdown created',
      };
    },
  },
];

export function getDescriptor(type: string): QuickCreateDescriptor | undefined {
  return QUICK_CREATE_REGISTRY.find((d) => d.type === type);
}

export function creatableTypeSet(): Set<string> {
  return new Set(QUICK_CREATE_REGISTRY.map((d) => d.type));
}
