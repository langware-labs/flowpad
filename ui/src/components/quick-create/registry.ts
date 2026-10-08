import {
  Agent,
  Credential,
  DiagnosisRequest,
  credentialsService,
  SubAgent,
  dataManager,
  DynamicWorkflow,
  Layout,
  Markdown,
  Mcp,
  Project,
  Prompt,
  Skill,
  Task,
  TypeId,
  Whiteboard,
} from '@sdk';
import { msg } from '@lingui/core/macro';
import { McpCreateDialog } from './McpCreateDialog';
import { DiagnosisRequestCreateDialog } from '@src/components/assets/editor/diagnosis-request/DiagnosisRequestCreateDialog';
import { openRequest } from '@src/components/assets/editor/diagnosis-request/diagnosis-request-api';
import { CredentialQuickCreateDialog } from '@src/components/credentials/CredentialQuickCreateDialog';
import { slugify, toEnvVarName } from '@src/components/credentials/credential-draft';
import type { MessageDescriptor } from '@lingui/core';
import { PromptEditDialog } from '@src/components/prompt-library/PromptEditDialog';
import { DockPointer } from '@src/navigation/DockPointer';
import type { ComponentType } from 'react';
import type { ScopeKind } from './ScopeSelection';

/**
 * Result returned by a QuickCreateDescriptor's `create` function.
 *
 * `pointer` — optional DockPointer to navigate to after creation (e.g. open the new
 * skill's editor). `toastTitle` — short success message shown to the user.
 */
export interface QuickCreateResult {
  pointer?: DockPointer;
  toastTitle: MessageDescriptor;
}

/**
 * Only `project` and `name` are universal. The chip-derived fields come from the
 * quick-create panel, which is the surface that HAS scope/harness/path chips; the
 * plain "New <type>" name dialog on the assets page (`AssetsPage.handleNewConfirm`,
 * `useAssetsModel`) has no chips to read and passes neither. They are optional
 * because that is the real contract — a `create` that needs one must handle its
 * absence rather than assume the panel called it.
 */
export interface QuickCreateCreateArgs {
  /** The selected owning project, or null for a user/custom folder. */
  project: Project | null;
  name: string;
  destination?: import('@sdk').FSRefJson;
  scope?: ScopeKind;
}

/**
 * A creatable-type entry for the quick-create menu / panel.
 *
 * Deliberately carries NO icon: every per-type glyph comes from the backend
 * registry (`TypeInfo.icon`) via `iconForType(descriptor.type)` at render time.
 * A hardcoded `Icon` here is how the skill tile showed a Sparkles while the rest
 * of the app drew the registry's FileBadge.
 */
/** Which "Create new" group a type's tile sits in. */
export type QuickCreateGroup = 'build' | 'write' | 'connect';

export interface QuickCreateDescriptor {
  /** Matches server `AssetTypeInfo.type_name` so labels can be joined at render time. */
  type: string;
  /** The launcher group its tile belongs to. Required, so a new type picks one
   *  rather than silently landing in none. */
  group: QuickCreateGroup;
  /**
   * The type's SINGULAR name, as the thing you are about to create one of.
   *
   * A lazy `MessageDescriptor` rather than a plain string because this table is
   * module-level: an eager `t` here would be evaluated once at import, before
   * the real locale is activated, and would then never re-render on a language
   * switch. Callers translate it at render time.
   *
   * Deliberately NOT `labelForType`: the type registry names a COLLECTION
   * ("Skills", "Documents"), which is the wrong number for a "New …" affordance.
   */
  label: MessageDescriptor;
  /** Title of the wiki page explaining this type, for the tile's WikiTip.
   *  Required: a wikiword resolves by page title at runtime, so a missing or
   *  wrong one silently shows a "create this page" prompt instead of help —
   *  making this optional is how a new type ships an untipped tile. */
  wikiword: string;
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

/** Placement options are backend registry data, never a vendor directory table. */
export function creationMounts(type: string): string[] {
  const info = dataManager?.getTypeInfo?.(type);
  return info?.scan_mounts?.filter((mount) => !mount.includes('*')) ?? (info?.main_subdir ? [info.main_subdir] : []);
}

export const QUICK_CREATE_REGISTRY: QuickCreateDescriptor[] = [
  {
    type: Agent.type,
    group: 'build',
    label: msg`Agent`,
    wikiword: 'Agent Management',
    create: async ({ project, name, destination }) => {
      const saved = await Agent.createInProject(project, name, destination);
      return {
        pointer: DockPointer.forAssetEditorByTypeId(Agent.type, saved.typeId),
        toastTitle: msg`Agent created`,
      };
    },
  },
  {
    type: 'skill',
    group: 'build',
    label: msg`Skill`,
    wikiword: 'Skill assets',
    create: async ({ project, name, destination }) => {
      const saved = await Skill.createInProject(project, name, destination);
      return {
        // Open a freshly-created skill ready to type into: edit mode, caret on the
        // line right after the auto-inserted `# <name>` headline (body line 2).
        pointer: saved.asset_ref
          ? DockPointer.forAssetEditor('skill', saved.asset_ref, Layout.DOCK, {
              editorMode: 'editor',
              initialLine: '2',
            })
          : undefined,
        toastTitle: msg`Skill created`,
      };
    },
  },
  {
    type: 'subagent',
    group: 'build',
    label: msg`Sub agent`,
    wikiword: 'Sub agents',
    create: async ({ project, name, destination }) => {
      const saved = await SubAgent.createInProject(project, name, destination);
      return {
        // Open a freshly-created agent ready to type into: edit mode, caret at the
        // start of the (empty) system-prompt body, right after the headline.
        pointer: saved.asset_ref
          ? DockPointer.forAssetEditor('subagent', saved.asset_ref, Layout.DOCK, {
              editorMode: 'editor',
              initialLine: '2',
            })
          : undefined,
        toastTitle: msg`SubAgent created`,
      };
    },
  },
  {
    type: 'dynamic_workflow',
    group: 'build',
    label: msg`Dynamic Workflow`,
    wikiword: 'Dynamic workflows',
    create: async ({ project, name, destination }) => {
      const saved = await DynamicWorkflow.createInProject(project, name, destination);
      return {
        pointer: saved.asset_ref ? DockPointer.forAssetEditor('dynamic_workflow', saved.asset_ref) : undefined,
        toastTitle: msg`Dynamic workflow created`,
      };
    },
  },
  {
    type: 'task',
    group: 'write',
    label: msg`Task`,
    wikiword: 'Task assets',
    create: async ({ project, name, destination }) => {
      const task = await Task.createInProject(project, name, destination);
      return {
        pointer: DockPointer.forTasks(task.id),
        toastTitle: msg`Task created`,
      };
    },
  },
  {
    type: 'markdown',
    group: 'write',
    label: msg`Markdown`,
    wikiword: 'Markdown documents',
    create: async ({ project, name, destination }) => {
      const md = await Markdown.createInProject(project, name, destination);
      return {
        pointer: md.asset_ref ? DockPointer.forAssetEditor('markdown', md.asset_ref) : undefined,
        toastTitle: msg`Markdown created`,
      };
    },
  },
  {
    type: 'whiteboard',
    group: 'write',
    label: msg`Whiteboard`,
    wikiword: 'Whiteboard assets',
    create: async ({ project, name, destination }) => {
      const saved = await Whiteboard.createInProject(project, name, destination);
      return {
        pointer: saved.asset_ref ? DockPointer.forAssetEditor('whiteboard', saved.asset_ref) : undefined,
        toastTitle: msg`Whiteboard created`,
      };
    },
  },
  {
    type: 'mcp',
    group: 'connect',
    label: msg`MCP Server`,
    wikiword: 'MCP servers',
    Dialog: McpCreateDialog,
    // The assets-list `+` never opens a Dialog, so it needs a default that
    // still produces something runnable — hence `bundled` (the SDK default).
    create: async ({ project, name, destination }) => {
      const saved = await Mcp.createInProject(project, name, 'bundled', destination);
      return {
        pointer: saved.asset_ref ? DockPointer.forAssetEditor('mcp', saved.asset_ref) : undefined,
        toastTitle: msg`MCP server created`,
      };
    },
  },
  {
    type: Credential.type,
    group: 'connect',
    label: msg`Credentials`,
    wikiword: 'Credentials',
    allowedScopes: ['user', 'project'],
    Dialog: CredentialQuickCreateDialog,
    // The assets-list `+` is name-only: declare one variable named after it,
    // kept in .env.local, with no value yet — values are set from Connections.
    create: async ({ project, name, scope }) => {
      const title = name.trim();
      const projectId = scope !== 'user' ? (project?.id ?? null) : null;
      const row = await credentialsService.save({
        scope: projectId ? 'project' : 'user',
        project_id: projectId,
        manifest: {
          name: slugify(title),
          title,
          vars: { [toEnvVarName(title) || 'API_KEY']: { label: title } },
          setup: `Ask the person for their ${title} and store it: \`flow credentials set ${slugify(title)} ${toEnvVarName(title) || 'API_KEY'}=<value>\`.`,
        },
      });
      return {
        pointer: DockPointer.forCredentials(undefined, row.project_id ?? undefined),
        toastTitle: msg`Secret created`,
      };
    },
  },
  {
    type: 'prompt',
    group: 'build',
    label: msg`Prompt`,
    wikiword: 'Prompt library',
    // `prompts/` is Flowpad's own convention, not a harness one — no variants.
    // A prompt is its text, so the library dialog creates it in one step.
    Dialog: PromptEditDialog,
    create: async ({ project, name, destination }) => {
      await Prompt.createInProject(project, name, destination);
      return { toastTitle: msg`Prompt created` };
    },
  },
  {
    type: DiagnosisRequest.type,
    group: 'connect',
    label: msg`Diagnosis request`,
    wikiword: 'Diagnosis requests',
    allowedScopes: ['user', 'project'],
    Dialog: DiagnosisRequestCreateDialog,
    // The assets-list `+` is name-only: the name becomes the instructions, with the default
    // window and no budget or attachments -- all of which the request's screen can add to.
    create: async ({ project, name }) => {
      const { request } = await openRequest({
        instructions: name.trim(),
        ask_permission: false,
        project_id: project?.id ?? '',
        write_hours: 48,
        max_run_mb: 2,
        attachments: [],
      });
      return {
        pointer: DockPointer.forAssetEditorByTypeId(
          DiagnosisRequest.type,
          new TypeId(DiagnosisRequest.type, request.id),
        ),
        toastTitle: msg`Diagnosis request created`,
      };
    },
  },
];

export function getDescriptor(type: string): QuickCreateDescriptor | undefined {
  return QUICK_CREATE_REGISTRY.find((d) => d.type === type);
}
