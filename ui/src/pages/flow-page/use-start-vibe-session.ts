import {
  SubAgent,
  AgentKind,
  AgenticProcess,
  apiClient,
  CapabilityKinds,
  ComputeNode,
  dataContext,
  ProcessKind,
  Project,
  QueryFilter,
  QueryRequest,
  TypeId,
} from '@sdk';
import { useProject } from '@sdk/react/hooks';
import { HARNESS_CAPABILITY_BY_WORKER } from '@src/components/workers/worker-types';
import { useHarnessInstallPrompt } from '@src/components/terminal/openers/use-harness-install-prompt';
import { errorDetail } from '@src/lib/error-message';
import { ViewMode } from '@src/contexts/view-mode-context';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';
import { appendUploadedFileRefs } from '@src/utils/upload-to-input-dir';
import { useLingui } from '@lingui/react/macro';
import { useCallback, type ReactNode } from 'react';
import { systemSubagentRef, systemVibeKindSubagentRefs } from './vibe-personas';
import { chatTargetForProject } from '@src/lib/chat-target';
import { VIBE_MODEL_DEFAULT, type VibeModelChoice } from './vibe-model-select';
import type { WorkerType } from '@src/components/workers/worker-types';

// The vibe sub-agent's asset_ref is stable for the app's lifetime — resolve
// once, reuse across builds. Raw graph route (not useEntitiesQuery) because
// system (SDK-shipped) sub-agents only surface with include_system=true. Failed
// lookups are NOT cached so a late-indexed sub-agent is picked up on the next
// submit.
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
// what the seam expects: `load_embedded_subagent_action` parses the file with
// `extract_subagent_from_path`, and the Agent asset has no subagent `name`, so
// it materialized as a nameless "you are the 'agent' agent".
/** Minimal navigation surface the launcher needs (from useDockNavigation). */
type OpenShell = { openShellProcess: (procId: string, opts?: { viewMode?: ViewMode }) => void };

/**
 * Ride the SDK-shipped `vibe` persona on a process so the driver's directive
 * (creator routing + the `flow show` presentation contract) is active. Shared
 * by BOTH vibe process-creation paths — the vibe-home launcher here and the
 * in-workspace `New` control (EntityExecutionPanel's onProcessCreated hook) —
 * so a process born either way carries the same persona. An un-indexed sub-agent
 * degrades to a plain assistant session (logged, never thrown).
 */
export async function embedVibeSubagent(proc: AgenticProcess): Promise<void> {
  try {
    const vibeRef = await systemSubagentRef('vibe');
    if (vibeRef) await proc.loadEmbeddedSubagent(vibeRef);
    else console.warn('[Vibe] vibe sub-agent not indexed; continuing without persona');
  } catch (e) {
    console.warn('[Vibe] failed to embed vibe sub-agent; continuing without persona', e);
  }
  // Layer the project's kind==vibe sub-agents ON TOP of the standard vibe
  // sub-agent. Embedding after it, in created-date order, makes them render
  // after it in the instructions (embed order == render order, see backend
  // _load_materialized_agents_json). Best-effort — a failed extra embed degrades.
  try {
    await embedVibeKindSubagents(proc);
  } catch (e) {
    console.warn('[Vibe] failed to embed kind==vibe sub-agents', e);
  }
}

/**
 * Embed the "relevant ones only" — the project's `kind==vibe` sub-agent assets,
 * in created-date order — as extra personas after the standard vibe sub-agent. Part of
 * the generic vibe process start; a plain query (not the process's special-asset
 * list), scoped to the process's project.
 */
async function embedVibeKindSubagents(proc: AgenticProcess): Promise<void> {
  // SDK-shipped personas first (e.g. `data-integrations`): they ride every vibe
  // session, and only surface with include_system=true — the same raw route
  // the standard vibe persona is resolved through.
  await Promise.all((await systemVibeKindSubagentRefs()).map((ref) => proc.loadEmbeddedSubagent(ref)));
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
    if (agent.asset_ref) await proc.loadEmbeddedSubagent(agent.asset_ref);
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
  model?: VibeModelChoice;
  workerType?: WorkerType;
}): Promise<AgenticProcess> {
  const { projectId, workdir, targetVfsPath, navigation, open = true, model = VIBE_MODEL_DEFAULT, workerType } = opts;
  const target = targetVfsPath ?? chatTargetForProject(projectId);

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
  await embedVibeSubagent(proc);
  return proc;
}

/**
 * Start a Vibe session bound to a SPECIFIC project (not necessarily the active
 * one): lazily create a headless Chat process, embed the SDK-shipped `vibe`
 * persona (a SubAgent), open its workspace in Vibe mode, then fire the first prompt.
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
  model?: VibeModelChoice;
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
  model: VibeModelChoice;
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
export interface StartVibeSession {
  /** Submit the first prompt and open the session. */
  start: (message: string, files?: File[], model?: VibeModelChoice, workerType?: WorkerType) => void;
  /**
   * The "install a harness" dialog, which a failed start may raise. Render it
   * — a caller that drops it silently loses the only recovery this failure has.
   */
  installDialog: ReactNode;
}

export function useStartVibeSession(): StartVibeSession {
  const { project } = useProject();
  const { navigation } = useDockNavigation();
  const { t } = useLingui();
  const { confirmMissingThen, dialog: installDialog } = useHarnessInstallPrompt();

  const start = useCallback(
    (message: string, files?: File[], model?: VibeModelChoice, workerType?: WorkerType) => {
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
      }).catch((error: unknown) => {
        console.error('[Vibe] Failed to start vibe session:', error);
        // The backend explains itself here — `createProcess` refuses a missing
        // harness with "<name> is not installed on this machine."
        // (flow_sdk/builtin/faas/scan_actions.py). That sentence used to be
        // replaced by a fixed "Failed to start the build session", so the one
        // thing the user could act on reached the console and nowhere else.
        //
        // A missing harness is not a message problem though — it is a thing to
        // FIX, so it raises the install dialog (with its "Try auto install")
        // exactly as the terminal strip's openers do. `confirmMissingThen`
        // re-probes rather than trusting the stale capability row, so anything
        // that failed for another reason falls through to its real message
        // instead of being mislabelled as an uninstalled harness.
        const kind = workerType ? HARNESS_CAPABILITY_BY_WORKER[workerType] : CapabilityKinds.Harness;
        confirmMissingThen(kind ?? CapabilityKinds.Harness, () =>
          notify.error({
            title: t`Could not start`,
            // `errorDetail`, NOT `errorMessage`: an AxiosError is also an Error
            // whose own message is the boilerplate "Request failed with status
            // code 4xx". Taking the envelope ONLY means a failure the server did
            // not explain falls back to our wording instead of putting a status
            // line in front of the user as if it were an explanation.
            message: errorDetail(error) || t`Failed to start the build session.`,
          }),
        );
      });
    },
    [project?.id, project?.fs_storage_mount_path, project?.name, navigation, t, confirmMissingThen],
  );

  return { start, installDialog };
}
