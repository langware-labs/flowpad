import { Agent, DynamicWorkflow, Layout, Markdown, Project, Prompt, Skill, Task, Whiteboard } from '@sdk';
import { PromptEditDialog } from '@src/components/prompt-library/PromptEditDialog';
import { DockPointer } from '@src/navigation/DockPointer';
import { BookMarked, Bot, Boxes, CheckSquare, FileText, Palette, Sparkles, type LucideIcon } from 'lucide-react';
import type { ComponentType } from 'react';
import type { HarnessKind, ScopeKind } from './ScopeSelection';

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
  /** Currently-active project context (legacy create paths still rely on this). */
  project: Project | null;
  name: string;
  /** Final destination as edited by the user in the path input. */
  absolutePath: string;
  /** Which scope chip was active when Create was pressed. */
  scope: ScopeKind;
  /** Which harness chip was active (affects which on-disk convention the path follows). */
  harness: HarnessKind;
  /** Project-relative folder when scope === 'project' (e.g. ".claude/skills"). */
  folderVfsPath?: string;
}

export interface QuickCreateDescriptor {
  /** Matches server `AssetTypeInfo.type_name` so labels can be joined at render time. */
  type: string;
  /** Fallback label when no server label is available (also used for display consistency). */
  label: string;
  /** Title of the wiki page explaining this type, for the tile's WikiTip.
   *  Required: a wikiword resolves by page title at runtime, so a missing or
   *  wrong one silently shows a "create this page" prompt instead of help —
   *  making this optional is how a new type ships an untipped tile. */
  wikiword: string;
  /** React icon component, rendered in the quick-create menu and dialog header. */
  Icon: LucideIcon;
  /** Sub-folder under the scope root for Claude / All (e.g. ".claude/skills"). */
  defaultSubFolder: string;
  /** Codex project-scope sub-folder. Falls back to defaultSubFolder when omitted. */
  codexProjectSubFolder?: string;
  /** Codex user-scope sub-folder. Falls back to codexProjectSubFolder, then defaultSubFolder. */
  codexUserSubFolder?: string;
  /** Copilot project-scope sub-folder. Falls back to defaultSubFolder when omitted. */
  copilotProjectSubFolder?: string;
  /** Copilot user-scope sub-folder. Falls back to copilotProjectSubFolder, then defaultSubFolder. */
  copilotUserSubFolder?: string;
  /** Creation function — shared between the quick-create dialog and AssetsPage. */
  create: (args: QuickCreateCreateArgs) => Promise<QuickCreateResult>;
  /**
   * Bespoke create dialog, replacing the generic name+path form for a type whose
   * `main_subdir` already fixes its on-disk location. `create` stays required —
   * the AssetsPage "+" is name-only and still uses it.
   */
  Dialog?: ComponentType<{
    open: boolean;
    onOpenChange: (open: boolean) => void;
    projectId?: string | null;
  }>;
}

function leafOf(subFolder: string): string {
  const idx = subFolder.lastIndexOf('/');
  return idx >= 0 ? subFolder.slice(idx + 1) : subFolder;
}

/** Resolve the sub-folder for a (descriptor, harness, scope) tuple. */
export function subFolderFor(descriptor: QuickCreateDescriptor, harness: HarnessKind, scope: ScopeKind): string {
  if (harness === 'none') return '';
  if (harness === 'all') return `assets/${leafOf(descriptor.defaultSubFolder)}`;
  if (harness === 'codex') {
    if (scope === 'user') return descriptor.codexUserSubFolder ?? descriptor.codexProjectSubFolder ?? descriptor.defaultSubFolder;
    return descriptor.codexProjectSubFolder ?? descriptor.defaultSubFolder;
  }
  if (harness === 'copilot') {
    if (scope === 'user') return descriptor.copilotUserSubFolder ?? descriptor.copilotProjectSubFolder ?? descriptor.defaultSubFolder;
    return descriptor.copilotProjectSubFolder ?? descriptor.defaultSubFolder;
  }
  return descriptor.defaultSubFolder;
}

export const QUICK_CREATE_REGISTRY: QuickCreateDescriptor[] = [
  {
    type: 'skill',
    label: 'Skill',
    wikiword: 'Skill assets',
    Icon: Sparkles,
    defaultSubFolder: '.claude/skills',
    codexProjectSubFolder: '.agents/skills',
    codexUserSubFolder: '.codex/skills',
    copilotProjectSubFolder: '.copilot/skills',
    copilotUserSubFolder: '.copilot/skills',
    create: async ({ project, name, folderVfsPath }) => {
      const saved = await Skill.createInProject(project, name, folderVfsPath);
      return {
        // Open a freshly-created skill ready to type into: edit mode, caret on the
        // line right after the auto-inserted `# <name>` headline (body line 2).
        pointer: saved.asset_ref
          ? DockPointer.forAssetEditor('skill', saved.asset_ref, Layout.DOCK, { editorMode: 'editor', initialLine: '2' })
          : undefined,
        toastTitle: 'Skill created',
      };
    },
  },
  {
    type: 'agent',
    label: 'Sub agent',
    wikiword: 'Sub agents',
    Icon: Bot,
    defaultSubFolder: '.claude/agents',
    codexProjectSubFolder: '.codex/agents',
    codexUserSubFolder: '.codex/agents',
    copilotProjectSubFolder: '.copilot/agents',
    copilotUserSubFolder: '.copilot/agents',
    create: async ({ project, name, folderVfsPath }) => {
      const saved = await Agent.createInProject(project, name, folderVfsPath);
      return {
        // Open a freshly-created agent ready to type into: edit mode, caret at the
        // start of the (empty) system-prompt body, right after the headline.
        pointer: saved.asset_ref
          ? DockPointer.forAssetEditor('agent', saved.asset_ref, Layout.DOCK, { editorMode: 'editor', initialLine: '2' })
          : undefined,
        toastTitle: 'Agent created',
      };
    },
  },
  {
    type: 'dynamic_workflow',
    label: 'Dynamic Workflow',
    wikiword: 'Dynamic workflows',
    Icon: Boxes,
    defaultSubFolder: '.claude/workflows',
    create: async ({ project, name }) => {
      const saved = await DynamicWorkflow.createInProject(project, name);
      return {
        pointer: saved.asset_ref
          ? DockPointer.forAssetEditor('dynamic_workflow', saved.asset_ref)
          : undefined,
        toastTitle: 'Dynamic workflow created',
      };
    },
  },
  {
    type: 'task',
    label: 'Task',
    wikiword: 'Task assets',
    Icon: CheckSquare,
    defaultSubFolder: '.claude/tasks',
    codexProjectSubFolder: '.codex/tasks',
    copilotProjectSubFolder: '.copilot/tasks',
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
    wikiword: 'Markdown documents',
    Icon: FileText,
    defaultSubFolder: '.claude/docs',
    codexProjectSubFolder: '.codex/docs',
    copilotProjectSubFolder: '.copilot/docs',
    create: async ({ project, name }) => {
      const md = await Markdown.createInProject(project, name);
      return {
        pointer: md.asset_ref ? DockPointer.forAssetEditor('markdown', md.asset_ref) : undefined,
        toastTitle: 'Markdown created',
      };
    },
  },
  {
    type: 'whiteboard',
    label: 'Whiteboard',
    wikiword: 'Whiteboard assets',
    Icon: Palette,
    defaultSubFolder: '.claude/whiteboards',
    codexProjectSubFolder: '.codex/whiteboards',
    copilotProjectSubFolder: '.copilot/whiteboards',
    create: async ({ project, name, folderVfsPath }) => {
      const saved = await Whiteboard.createInProject(project, name, folderVfsPath);
      return {
        pointer: saved.asset_ref ? DockPointer.forAssetEditor('whiteboard', saved.asset_ref) : undefined,
        toastTitle: 'Whiteboard created',
      };
    },
  },
  {
    type: 'prompt',
    label: 'Prompt',
    wikiword: 'Prompt library',
    Icon: BookMarked,
    // `prompts/` is Flowpad's own convention, not a harness one — no variants.
    defaultSubFolder: 'prompts',
    // A prompt is its text, so the library dialog creates it in one step.
    Dialog: PromptEditDialog,
    create: async ({ project, name }) => {
      await Prompt.createInProject(project, name);
      return { toastTitle: 'Prompt created' };
    },
  },
];

export function getDescriptor(type: string): QuickCreateDescriptor | undefined {
  return QUICK_CREATE_REGISTRY.find((d) => d.type === type);
}

export function creatableTypeSet(): Set<string> {
  return new Set(QUICK_CREATE_REGISTRY.map((d) => d.type));
}
