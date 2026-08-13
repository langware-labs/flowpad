import {
  SubAgent,
  AgentKind,
  AgenticProcess,
  apiClient,
  ComputeNode,
  dataContext,
  ProcessKind,
  Project,
  QueryFilter,
  QueryRequest,
  TypeId,
} from '@sdk';
import { useProject } from '@sdk/react/hooks';
import { ViewMode } from '@src/contexts/view-mode-context';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';
import { appendUploadedFileRefs } from '@src/utils/upload-to-input-dir';
import { useLingui } from '@lingui/react/macro';
import { useCallback } from 'react';
import { VIBE_MODEL_DEFAULT, type VibeModelTier } from './vibe-model-select';
import type { WorkerType } from '@src/components/workers/worker-types';

// The vibe agent's asset_ref is stable for the app's lifetime — resolve once,
// reuse across builds. Raw graph route (not useEntitiesQuery) because system
// (SDK-shipped) agents only surface with include_system=true. Failed lookups
// are NOT cached so a late-indexed agent is picked up on the next submit.
//
// The SUBAGENT named `vibe` (`.claude/agents/vibe.md`) — the persona carrying
// the `flow show` presentation contract — NOT the `agent` of the same name.
// Both exist and the old `/graph/agent` lookup matched on the bare name, so the
// moment the internal-agents family shipped a launchable `vibe` Agent (a ~20
// line haiku front for the same subagent), every vibe session silently started
// riding THAT: a generic "you are the project assistant" prompt with no
// presentation rules. The visible symptom was the agent presenting its
// deliverable by shelling `open <file>` — straight into the user's browser —
// instead of `flow show`. `scope: 'system'` pins it to the SDK-shipped asset so
// a project subagent someone names `vibe` can't shadow it. This also matches
// what the seam expects: `load_embedded_agent_action` parses the file with
// `extract_subagent_from_path`, and the Agent asset has no subagent `name`, so
// it materialized as a nameless "you are the 'agent' agent".
let vibeAgentRefCache: string | null = null;
async function resolveVibeAgentRef(): Promise<string | null> {
  if (vibeAgentRefCache) return vibeAgentRefCache;
  const rows = await apiClient.get<{ name?: string; scope?: string; asset_ref?: string }[]>(
    '/graph/subagent?include_system=true',
  );
  vibeAgentRefCache = (rows ?? []).find((r) => r.name === 'vibe' && r.scope === 'system')?.asset_ref ?? null;
  return vibeAgentRefCache;
}

/** Minimal navigation surface the launcher needs (from useDockNavigation). */
type OpenShell = { openShellProcess: (procId: string, opts?: { viewMode?: ViewMode }) => void };

/**
 * The `target_typeid_str` every project-scoped vibe chat session is keyed to.
 *
 * The project's id-based TypeId — NOT `project.typeId`, which is the uname form
 * `project-@local`. Every producer AND consumer of a vibe chat target must go
 * through here: the string has to match exactly, or two surfaces that mean the
 * same session key it differently and each sees an empty history.
 */
export function vibeChatTargetForProject(projectId: string): string {
  return new TypeId(Project.type, projectId).toString();
}

/**
 * Ride the SDK-shipped `vibe` persona on a process so the driver's directive
 * (creator routing + the `flow show` presentation contract) is active. Shared
 * by BOTH vibe process-creation paths — the vibe-home launcher here and the
 * in-workspace `New` control (EntityExecutionPanel's onProcessCreated hook) —
 * so a process born either way carries the same persona. An un-indexed agent
 * degrades to a plain assistant session (logged, never thrown).
 */
export async function embedVibeAgent(proc: AgenticProcess): Promise<void> {
  try {
    const vibeRef = await resolveVibeAgentRef();
    if (vibeRef) await proc.loadEmbeddedAgent(vibeRef);
    else console.warn('[Vibe] vibe agent not indexed; continuing without persona');
  } catch (e) {
    console.warn('[Vibe] failed to embed vibe agent; continuing without persona', e);
  }
  // Layer the project's kind==vibe agents ON TOP of the standard vibe agent.
  // Embedding after the vibe agent, in created-date order, makes them render
  // after it in the instructions (embed order == render order, see backend
  // _load_materialized_agents_json). Best-effort — a failed extra embed degrades.
  try {
    await embedVibeKindAgents(proc);
  } catch (e) {
    console.warn('[Vibe] failed to embed kind==vibe agents', e);
  }
}

/**
 * Embed the "relevant ones only" — the project's `kind==vibe` agent assets, in
 * created-date order — as extra personas after the standard vibe agent. Part of
 * the generic vibe process start; a plain query (not the process's special-asset
 * list), scoped to the process's project.
 */
async function embedVibeKindAgents(proc: AgenticProcess): Promise<void> {
  const projectId = proc.project_id;
  if (!projectId) return;
  const req = new QueryRequest({
    type: SubAgent.type,
    scope: [new TypeId(Project.type, projectId)],
    name: `vibeAgents:${projectId}`,
    query: new QueryFilter({ match: { kind: AgentKind.Vibe }, order_by: { created_date: 'asc' } }),
  });
  const agents = await SubAgent.query<SubAgent>(req);
  for (const agent of agents) {
    if (agent.asset_ref) await proc.loadEmbeddedAgent(agent.asset_ref);
  }
}

/**
 * Create a fresh headless Vibe process for a project without sending a prompt,
 * and (by default) open its workspace in Vibe mode. Pass `open: false` to only
 * mint the process — e.g. to host a cold-opened asset tab as a child without
 * navigating away from it (see `tabs/vibe-parent.ts`). Used by the no-process
 * Vibe workspace's "Start new chat" button; callers with an initial message
 * layer prompt/upload behavior on top.
 */
export async function createVibeProcessForProject(opts: {
  projectId: string;
  workdir?: string;
  /** Stable entity TypeId or compute-node VFS path used for process reuse. */
  targetVfsPath?: string;
  navigation?: OpenShell;
  /** Open the process's workspace after creating it (default true). */
  open?: boolean;
  model?: VibeModelTier;
  workerType?: WorkerType;
}): Promise<AgenticProcess> {
  const { projectId, workdir, targetVfsPath, navigation, open = true, model = VIBE_MODEL_DEFAULT, workerType } = opts;
  const target = targetVfsPath ?? vibeChatTargetForProject(projectId);

  const computeNode = await ComputeNode.getById('@local');
  if (!computeNode) throw new Error('No local compute node');
  const proc = await computeNode.createProcess(
    {
      workdir: workdir ?? undefined,
      projectId,
      targetVfsPath: target,
      processType: ProcessKind.Chat,
      loadFlowpadAssistant: true,
      outputFormat: 'stream-json',
      model,
      ...(workerType ? { workerType } : {}),
    },
    // Headless JSON-stream transport — the vibe chat is a side panel, not a
    // terminal; PTY transport would pre-fill (not run) the first prompt.
    // `watchProcess: false` = don't AWAIT the watch inside createProcess (a
    // second round trip that gated navigation); it is established below.
    { pty_mode: false, watchProcess: false },
  );
  void proc.watch().catch((e) => console.warn('[Vibe] watch failed; live updates degraded', e));
  // The URL only needs the id, and the persona only has to be embedded before
  // the first prompt — which every caller awaits — so neither belongs ahead of
  // the navigation.
  if (open) navigation?.openShellProcess(proc.id, { viewMode: ViewMode.Vibe });
  await embedVibeAgent(proc);
  return proc;
}

/**
 * Start a Vibe session bound to a SPECIFIC project (not necessarily the active
 * one): lazily create a headless Chat process, embed the SDK-shipped `vibe`
 * persona agent, open its workspace in Vibe mode, then fire the first prompt.
 * The `vibe` persona rides every turn so the driver's directive (creator
 * routing + the mcp-ui / `flow show` presentation contract) is active; an
 * un-indexed agent degrades to a plain assistant session.
 *
 * The single proven start path shared by: the `/` VibeHome hero prompt, the
 * in-app "New chat" starter, AND running a received skill (useRunReceivedSkill)
 * in the conversation's project. Open the workspace FIRST (a headless prompt()
 * resolves only when the whole turn finishes, and the display must be mounted
 * to catch the agent's live `flow show` — the report and any mcp-ui form).
 * Returns the process id. Throws only on pre-open setup failure; a failed
 * persona embed or first-turn prompt degrades in place (logged).
 */
export async function launchVibeSessionForProject(opts: {
  projectId: string;
  workdir?: string;
  targetVfsPath?: string;
  message: string;
  files?: File[];
  navigation: OpenShell;
  model?: VibeModelTier;
  workerType?: WorkerType;
  /** Called when attachment upload fails (session still opens, text-only). */
  onAttachmentError?: () => void;
}): Promise<string> {
  const { projectId, workdir, targetVfsPath, message, files, navigation, model, workerType, onAttachmentError } = opts;
  const proc = await createVibeProcessForProject({
    projectId,
    workdir,
    targetVfsPath,
    navigation,
    model,
    workerType,
  });
  // Attachments (if any) must land in the process input dir BEFORE the first
  // turn starts — the agent reads the referenced paths immediately. Upload
  // failure degrades to a text-only prompt rather than losing the message.
  let fullMessage = message;
  try {
    fullMessage = await appendUploadedFileRefs(proc.id, message, files);
  } catch (e) {
    console.error('[Vibe] attachment upload failed', e);
    onAttachmentError?.();
  }
  proc.prompt(fullMessage).catch((e) => console.error('[Vibe] prompt failed', e));
  return proc.id;
}

/**
 * Continue a Vibe conversation with an explicitly selected worker.
 *
 * Transcript extraction and prompt composition belong to AgenticProcess; this
 * application service only forwards that durable handoff prompt through the
 * existing create/embed/open/first-prompt path.
 */
export async function continueVibeSessionForProject(opts: {
  sourceProcess: AgenticProcess;
  projectId: string;
  workdir?: string;
  targetVfsPath?: string;
  navigation: OpenShell;
  model: VibeModelTier;
  workerType: WorkerType;
}): Promise<string> {
  const { sourceProcess, projectId, workdir, targetVfsPath, navigation, model, workerType } = opts;
  const message = await sourceProcess.continuationPrompt();
  return launchVibeSessionForProject({
    projectId,
    workdir,
    targetVfsPath,
    navigation,
    model,
    workerType,
    message,
  });
}

/**
 * Start a fresh Vibe build session for the ACTIVE project. Thin wrapper over
 * {@link launchVibeSessionForProject} that resolves the active project + its
 * workdir and surfaces errors as toasts.
 */
export function useStartVibeSession(): (
  message: string,
  files?: File[],
  model?: VibeModelTier,
  workerType?: WorkerType,
) => void {
  const { project } = useProject();
  const { navigation } = useDockNavigation();
  const { t } = useLingui();

  return useCallback(
    (message: string, files?: File[], model?: VibeModelTier, workerType?: WorkerType) => {
      if (!project?.id) {
        // forceToast: this is the ONLY feedback the submit produces — without it
        // the prompt silently vanishes and the send button reads as broken.
        notify.error({
          title: t`Project Required`,
          message: t`Please select or create a project first.`,
          forceToast: true,
        });
        return;
      }
      const paths = dataContext.bootstrapInfo?.desktop_info?.paths;
      const workdir = project.fs_storage_mount_path || project.name || paths?.workspace || undefined;

      void launchVibeSessionForProject({
        projectId: project.id,
        workdir,
        message,
        files,
        model,
        workerType,
        navigation,
        onAttachmentError: () =>
          notify.error({
            title: t`Attachment upload failed`,
            message: t`Starting the session without the attached files.`,
          }),
      }).catch((error) => {
        console.error('[Vibe] Failed to start vibe session:', error);
        notify.error({ title: t`Could not start`, message: t`Failed to start the build session.` });
      });
    },
    [project?.id, project?.fs_storage_mount_path, project?.name, navigation, t],
  );
}
