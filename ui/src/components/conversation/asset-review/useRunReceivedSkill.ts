import { dataContext, dataManager, MessageAttachment, Project, TypeId } from '@sdk';
import { useProject } from '@sdk/react/hooks';
import { useLingui } from '@lingui/react/macro';
import { useCallback } from 'react';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';
import { launchVibeSessionForProject } from '@src/pages/flow-page/use-start-vibe-session';
import { buildSkillTestPrompt } from './test-prompt';

/**
 * Run a received skill: install it (if not already), then open a Vibe session
 * in the conversation's project and fire `run the skill <name>` as the first
 * turn.
 *
 * Why install first + address by NAME (not the staged path): the Claude worker
 * resolves a skill by its frontmatter `name` from `.claude/skills/<name>/`
 * under any mounted root — so the skill must be COPIED into the run project
 * (`<project>/.claude/skills/`) before the prompt can name it. This is the
 * "download + index took care of that" the user described. One-click run =
 * consent to install+execute; the review modal remains the deliberate path.
 *
 * Why a Vibe session (not a plain Chat): the embedded `vibe` persona carries
 * the mcp-ui + `flow show` presentation contract, so the skill's questions
 * render as an MCP-UI form on the display and its report is shown there ("open
 * in browser" → `flow show`). See launchVibeSessionForProject.
 */
export function useRunReceivedSkill(): (args: {
  attachment: MessageAttachment;
  userPrompt?: string | null;
  /** The conversation's mapped project — the default install + run target. */
  conversationProjectId?: string | null;
}) => void {
  const { navigation } = useDockNavigation();
  const { project: activeProject } = useProject();
  const { t } = useLingui();

  return useCallback(
    ({ attachment, userPrompt, conversationProjectId }) => {
      void (async () => {
        try {
          // The project to install into + run the session in: an already-installed
          // project scope wins; else the conversation's project; else the active
          // one. (`||`, not `??`: the backend clears project_id with '' — fall
          // through to the next candidate.)
          const runProjectId =
            attachment.project_id || conversationProjectId || activeProject?.id || null;
          if (!runProjectId) throw new Error('no project to run the skill in');

          // Install-if-needed so `run the skill <name>` resolves. Already-installed
          // (either scope) is respected — a user-scope install resolves anywhere.
          if (!attachment.installed) {
            await attachment.install('project', runProjectId);
          }
          const name = attachment.name;
          if (!name) throw new Error('skill has no name to run');

          const project = await dataManager.getByTypeId<Project>(
            new TypeId(Project.type, runProjectId),
          );
          const workdir =
            project?.fs_storage_mount_path ||
            project?.name ||
            dataContext.bootstrapInfo?.desktop_info?.paths?.workspace ||
            undefined;

          await launchVibeSessionForProject({
            projectId: runProjectId,
            workdir,
            message: buildSkillTestPrompt(name, userPrompt),
            navigation,
          });
        } catch (error) {
          console.error('[skill-run] failed to start run session', error);
          notify.error({
            title: t`Could not start`,
            message: t`Failed to start the skill run session.`,
          });
        }
      })();
    },
    [navigation, activeProject?.id, t],
  );
}
