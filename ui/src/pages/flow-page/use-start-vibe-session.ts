import { apiClient, ComputeNode, dataContext, ProcessKind, Project, TypeId } from '@sdk';
import { useProject } from '@sdk/react/hooks';
import { ViewMode } from '@src/contexts/view-mode-context';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';
import { uploadFilesToProcessInputDir } from '@src/utils/upload-to-input-dir';
import { useLingui } from '@lingui/react/macro';
import { useCallback } from 'react';

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

/**
 * Start a fresh Vibe build session for the active project: lazily create a
 * headless Chat process, embed the SDK-shipped `vibe` persona agent, open its
 * workspace in Vibe mode, then fire the first prompt. The session is bound to
 * the `vibe` agent so the driver's persona directive (creator routing + the
 * `flow show` presentation contract) rides every turn; an un-indexed agent
 * degrades to a plain assistant session.
 *
 * Shared start flow so the `/` VibeHome hero prompt and the in-app "New chat"
 * starter (flow-page's Vibe fallback when no session is active) go through one
 * proven path — create, open the workspace FIRST (a headless prompt() resolves
 * only when the whole turn finishes, and the display must be mounted to catch
 * the agent's live `flow show`), then prompt.
 */
export function useStartVibeSession(): (message: string, files?: File[]) => void {
  const { project } = useProject();
  const { navigation } = useDockNavigation();
  const { t } = useLingui();

  return useCallback(
    (message: string, files?: File[]) => {
      if (!project?.id) {
        notify.error({ title: t`Project Required`, message: t`Please select or create a project first.` });
        return;
      }
      const projectId = project.id;
      // Key the build session to the project's id-based TypeId (NOT project.typeId,
      // which is the uname form `project-@local`) — VibeWorkspace's chat target
      // must match this exact string to attach to the same process.
      const target = new TypeId(Project.type, projectId).toString();
      const paths = dataContext.bootstrapInfo?.desktop_info?.paths;
      const workdir = project.fs_storage_mount_path || project.name || paths?.workspace || undefined;

      void (async () => {
        try {
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
            },
            // Headless JSON-stream transport — the vibe chat is a side panel, not
            // a terminal; PTY transport would pre-fill (not run) the first prompt.
            { pty_mode: false },
          );
          try {
            const vibeRef = await resolveVibeAgentRef();
            if (vibeRef) await proc.loadEmbeddedAgent(vibeRef);
            else console.warn('[Vibe] vibe agent not indexed; continuing without persona');
          } catch (e) {
            console.warn('[Vibe] failed to embed vibe agent; continuing without persona', e);
          }
          void navigation.openShellProcess(proc.id, { viewMode: ViewMode.Vibe });
          // Attachments (if any) must land in the process input dir BEFORE the
          // first turn starts — the agent reads the referenced paths immediately.
          // Upload failure degrades to a text-only prompt rather than losing
          // the user's message after the workspace already opened.
          let refLines: string[] = [];
          if (files?.length) {
            try {
              refLines = await uploadFilesToProcessInputDir(proc.id, files);
            } catch (e) {
              console.error('[Vibe] attachment upload failed', e);
              notify.error({ title: t`Attachment upload failed`, message: t`Starting the session without the attached files.` });
            }
          }
          const fullMessage = refLines.length ? `${message}\n${refLines.join('\n')}` : message;
          proc.prompt(fullMessage).catch((e) => console.error('[Vibe] prompt failed', e));
        } catch (error) {
          console.error('[Vibe] Failed to start vibe session:', error);
          notify.error({ title: t`Could not start`, message: t`Failed to start the build session.` });
        }
      })();
    },
    [project?.id, project?.fs_storage_mount_path, project?.name, navigation, t],
  );
}
