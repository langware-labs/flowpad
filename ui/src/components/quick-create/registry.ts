import {
  Agent,
  SubAgent,
  dataManager,
  DynamicWorkflow,
  Layout,
  Markdown,
  Project,
  Prompt,
  Skill,
  Task,
  Whiteboard,
} from '@sdk';
import { PromptEditDialog } from '@src/components/prompt-library/PromptEditDialog';
import { DockPointer } from '@src/navigation/DockPointer';
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

/**
 * A creatable-type entry for the quick-create menu / panel.
 *
 * Deliberately carries NO icon: every per-type glyph comes from the backend
 * registry (`TypeInfo.icon`) via `iconForType(descriptor.type)` at render time.
 * A hardcoded `Icon` here is how the skill tile showed a Sparkles while the rest
 * of the app drew the registry's FileBadge.
 */
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
  /**
   * Last-resort sub-folder, used ONLY when the backend registry has not loaded
   * (an isolated unit test, or the dialog opening before bootstrap resolves).
   * The real answer comes from `TypeInfo` — see {@link subFolderFor}. Do not add
   * per-harness variants here: that table is what drifted out of sync with the
   * backend and told users their task went to `.claude/tasks` for months after
   * it had moved to `agentic-assets/task`.
   */
  fallbackSubFolder: string;
  /** Scope chips this type supports. Omitted means all scopes. */
  allowedScopes?: readonly ScopeKind[];
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

/**
 * Harness → dot-directory. The ONE thing the client still has to know, because
 * it is an external standard rather than a flowpad decision: Claude Code reads
 * `.claude/`, the AGENTS.md standard `.agents/`, Copilot `.github/`. Mirrors
 * `WORKER_PREFIX` in `flow_sdk/fs_store/placement.py` — note codex maps onto
 * `.agents` (the standard it speaks), NOT `.codex`.
 */
const HARNESS_DIR: Partial<Record<HarnessKind, string>> = {
  claude: '.claude',
  codex: '.agents',
  copilot: '.github',
};

/**
 * True when the harness chips mean anything for this type.
 *
 * Only SHARED assets (skill, agent) exist in a per-harness location, so only
 * they get a choice. HARNESS types are pinned to the one harness that reads
 * them; REPO types mount under `agentic-assets/` with no dot-dir at all; and
 * INTERNAL types are bare at the scope root. Offering a harness chip for those
 * would let the UI promise a destination the backend will not honour.
 */
export function harnessAppliesTo(type: string): boolean {
  return dataManager?.getTypeInfo?.(type)?.asset_class === 'shared';
}

/**
 * Resolve the sub-folder for a (descriptor, harness, scope) tuple.
 *
 * The backend owns placement: `TypeInfo.main_subdir` is the resolved mount for
 * the default (claude) harness, derived server-side from the type's
 * asset_class/harness/family. This function only swaps the dot-dir prefix when
 * the user picks a non-default harness for a SHARED type — the single case
 * where more than one destination legitimately exists.
 */
export function subFolderFor(descriptor: QuickCreateDescriptor, harness: HarnessKind): string {
  if (harness === 'none') return '';
  const info = dataManager?.getTypeInfo?.(descriptor.type);
  const mount = info?.main_subdir ?? descriptor.fallbackSubFolder;
  if (!info?.family || info.asset_class !== 'shared') return mount;
  if (harness === 'all' || harness === 'claude') return mount;
  return `${HARNESS_DIR[harness] ?? '.claude'}/${info.family}`;
}

export const QUICK_CREATE_REGISTRY: QuickCreateDescriptor[] = [
  {
    type: Agent.type,
    label: 'Agent',
    wikiword: 'Agent Management',
    fallbackSubFolder: 'agentic-assets/agent',
    allowedScopes: ['user', 'project'],
    create: async ({ project, name, scope, folderVfsPath }) => {
      if (scope === 'folder') {
        throw new Error('Agents can only be created in User or Project scope');
      }
      const saved = await Agent.createInProject(project, name, folderVfsPath);
      return {
        pointer: DockPointer.forAssetEditorByTypeId(Agent.type, saved.typeId),
        toastTitle: 'Agent created',
      };
    },
  },
  {
    type: 'skill',
    label: 'Skill',
    wikiword: 'Skill assets',
    fallbackSubFolder: '.claude/skills',
    create: async ({ project, name, folderVfsPath }) => {
      const saved = await Skill.createInProject(project, name, folderVfsPath);
      return {
        // Open a freshly-created skill ready to type into: edit mode, caret on the
        // line right after the auto-inserted `# <name>` headline (body line 2).
        pointer: saved.asset_ref
          ? DockPointer.forAssetEditor('skill', saved.asset_ref, Layout.DOCK, {
              editorMode: 'editor',
              initialLine: '2',
            })
          : undefined,
        toastTitle: 'Skill created',
      };
    },
  },
  {
    type: 'subagent',
    label: 'Sub agent',
    wikiword: 'Sub agents',
    fallbackSubFolder: '.claude/agents',
    create: async ({ project, name, folderVfsPath }) => {
      const saved = await SubAgent.createInProject(project, name, folderVfsPath);
      return {
        // Open a freshly-created agent ready to type into: edit mode, caret at the
        // start of the (empty) system-prompt body, right after the headline.
        pointer: saved.asset_ref
          ? DockPointer.forAssetEditor('subagent', saved.asset_ref, Layout.DOCK, {
              editorMode: 'editor',
              initialLine: '2',
            })
          : undefined,
        toastTitle: 'SubAgent created',
      };
    },
  },
  {
    type: 'dynamic_workflow',
    label: 'Dynamic Workflow',
    wikiword: 'Dynamic workflows',
    fallbackSubFolder: '.claude/workflows',
    create: async ({ project, name }) => {
      const saved = await DynamicWorkflow.createInProject(project, name);
      return {
        pointer: saved.asset_ref ? DockPointer.forAssetEditor('dynamic_workflow', saved.asset_ref) : undefined,
        toastTitle: 'Dynamic workflow created',
      };
    },
  },
  {
    type: 'task',
    label: 'Task',
    wikiword: 'Task assets',
    fallbackSubFolder: 'agentic-assets/task',
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
    fallbackSubFolder: 'docs',
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
    fallbackSubFolder: 'agentic-assets/whiteboard',
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
    // `prompts/` is Flowpad's own convention, not a harness one — no variants.
    fallbackSubFolder: 'agentic-assets/prompt',
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
