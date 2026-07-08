import { ComputeNode, dataContext, dataManager, MessageAttachment, ProcessKind, Project, TypeId } from '@sdk';
import { useLingui } from '@lingui/react/macro';
import { useCallback } from 'react';
import { ViewMode } from '@src/contexts/view-mode-context';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';
import { buildSkillTestPrompt } from './test-prompt';

/**
 * "Test it" for a received skill: create a headless Chat process, open it in
 * Vibe mode, and fire the skill-test prompt (buildSkillTestPrompt) as the
 * first turn. Mirrors useStartVibeSession step-for-step MINUS the vibe persona
 * embed — the test session is a plain assistant so the skill runs without the
 * builder persona's instructions interfering.
 *
 * Skill path: the installed entity's asset_ref when installed, else the staged
 * abs_root (from the staged-files action) — a skill folder is usable by path
 * either way. Project/workdir: installed project → conversation's attachment
 * project → workspace fallback.
 */
export function useTestStagedAsset(): (args: {
  attachment: MessageAttachment;
  prompt: string;
  installedAssetRef?: string | null;
  projectId?: string | null;
}) => void {
  const { navigation } = useDockNavigation();
  const { t } = useLingui();

  return useCallback(
    ({ attachment, prompt, installedAssetRef, projectId }) => {
      void (async () => {
        try {
          // Resolve the skill path first — fail fast before spawning anything.
          let skillPath = (installedAssetRef ?? '').trim();
          if (!skillPath) {
            const staged = await attachment.listStagedFiles();
            skillPath = staged.abs_root;
          }
          if (!skillPath) throw new Error('no local path for the skill');

          // `||`, not `??`: the backend clears project_id with '' (see
          // MessageAttachment.effectiveScope) — fall through to the caller's.
          const effectiveProjectId = attachment.project_id || projectId || null;
          let workdir: string | undefined;
          if (effectiveProjectId) {
            const project = await dataManager.getByTypeId<Project>(
              new TypeId(Project.type, effectiveProjectId),
            );
            workdir = project?.fs_storage_mount_path || project?.name || undefined;
          }
          workdir = workdir || dataContext.bootstrapInfo?.desktop_info?.paths?.workspace || undefined;

          const computeNode = await ComputeNode.getById('@local');
          if (!computeNode) throw new Error('No local compute node');
          const proc = await computeNode.createProcess(
            {
              workdir,
              projectId: effectiveProjectId ?? undefined,
              processType: ProcessKind.Chat,
              outputFormat: 'stream-json',
            },
            // Headless JSON-stream transport (a PTY would pre-fill, not run,
            // the first prompt).
            { pty_mode: false },
          );
          // Open the workspace FIRST (headless prompt() resolves only when the
          // whole turn finishes; the display must be mounted to catch `flow show`).
          void navigation.openShellProcess(proc.id, { viewMode: ViewMode.Vibe });
          const text = buildSkillTestPrompt(skillPath, prompt);
          proc.prompt(text).catch((e) => console.error('[skill-test] prompt failed', e));
        } catch (error) {
          console.error('[skill-test] failed to start test session', error);
          notify.error({ title: t`Could not start`, message: t`Failed to start the skill test session.` });
        }
      })();
    },
    [navigation, t],
  );
}
