import { AgenticProcess, apiClient, ComputeNode, dataContext, ProcessKind, Project, TypeId } from '@sdk';
import { useProject } from '@sdk/react/hooks';
import { ViewMode } from '@src/contexts/view-mode-context';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';
import { uploadFilesToProcessInputDir } from '@src/utils/upload-to-input-dir';
import { useLingui } from '@lingui/react/macro';
import { useCallback } from 'react';
import { VIBE_MODEL_DEFAULT, type VibeModelTier } from './vibe-model-select';
import { DEFAULT_WORKER_TYPE, type WorkerType } from '@src/components/workers/worker-types';

// The vibe agent's asset_ref is stable for the app's lifetime — resolve once,
// reuse across builds. Raw graph route (not useEntitiesQuery) because system
// (SDK-shipped) agents only surface with include_system=true. Failed lookups
// are NOT cached so a late-indexed agent is picked up on the next submit.
let vibeAgentRefCache: string | null = null;
async function resolveVibeAgentRef(): Promise<string | null> {
  if (vibeAgentRefCache) return vibeAgentRefCache;
  const rows = await apiClient.get<{ name?: string; asset_ref?: string }[]>(
    '/graph/agent?include_system=true',
  );
  vibeAgentRefCache = (rows ?? []).find((r) => r.name === 'vibe')?.asset_ref ?? null;
  return vibeAgentRefCache;
}

/** Minimal navigation surface the launcher needs (from useDockNavigation). */
type OpenShell = { openShellProcess: (procId: string, opts?: { viewMode?: ViewMode }) => void };

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
}

/**
 * Create and open a fresh Vibe process for a project without sending a prompt.
 * Used by the no-process Vibe workspace's "Start new chat" button; callers that
 * also have an initial message layer prompt/upload behavior on top.
 */
export async function createVibeProcessForProject(opts: {
  projectId: string;
  workdir?: string;
  navigation: OpenShell;
  model?: VibeModelTier;
  workerType?: WorkerType;
}): Promise<AgenticProcess> {
  const { projectId, workdir, navigation, model = VIBE_MODEL_DEFAULT, workerType = DEFAULT_WORKER_TYPE } = opts;
  // Key the session to the project's id-based TypeId (NOT project.typeId, the
  // uname form `project-@local`) — VibeWorkspace's chat target must match this
  // exact string to attach to the same process.
  const target = new TypeId(Project.type, projectId).toString();

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
      workerType,
    },
    // Headless JSON-stream transport — the vibe chat is a side panel, not a
    // terminal; PTY transport would pre-fill (not run) the first prompt.
    { pty_mode: false },
  );
  await embedVibeAgent(proc);
  void navigation.openShellProcess(proc.id, { viewMode: ViewMode.Vibe });
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
  message: string;
  files?: File[];
  navigation: OpenShell;
  model?: VibeModelTier;
  workerType?: WorkerType;
  /** Called when attachment upload fails (session still opens, text-only). */
  onAttachmentError?: () => void;
}): Promise<string> {
  const { projectId, workdir, message, files, navigation, model, workerType, onAttachmentError } = opts;
  const proc = await createVibeProcessForProject({ projectId, workdir, navigation, model, workerType });
  // Attachments (if any) must land in the process input dir BEFORE the first
  // turn starts — the agent reads the referenced paths immediately. Upload
  // failure degrades to a text-only prompt rather than losing the message.
  let refLines: string[] = [];
  if (files?.length) {
    try {
      refLines = await uploadFilesToProcessInputDir(proc.id, files);
    } catch (e) {
      console.error('[Vibe] attachment upload failed', e);
      onAttachmentError?.();
    }
  }
  const fullMessage = refLines.length ? `${message}\n${refLines.join('\n')}` : message;
  proc.prompt(fullMessage).catch((e) => console.error('[Vibe] prompt failed', e));
  return proc.id;
}

/**
 * Start a fresh Vibe build session for the ACTIVE project. Thin wrapper over
 * {@link launchVibeSessionForProject} that resolves the active project + its
 * workdir and surfaces errors as toasts.
 */
export function useStartVibeSession(): (message: string, files?: File[], model?: VibeModelTier, workerType?: WorkerType) => void {
  const { project } = useProject();
  const { navigation } = useDockNavigation();
  const { t } = useLingui();

  return useCallback(
    (message: string, files?: File[], model?: VibeModelTier, workerType?: WorkerType) => {
      if (!project?.id) {
        notify.error({ title: t`Project Required`, message: t`Please select or create a project first.` });
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
          notify.error({ title: t`Attachment upload failed`, message: t`Starting the session without the attached files.` }),
      }).catch((error) => {
        console.error('[Vibe] Failed to start vibe session:', error);
        notify.error({ title: t`Could not start`, message: t`Failed to start the build session.` });
      });
    },
    [project?.id, project?.fs_storage_mount_path, project?.name, navigation, t],
  );
}
