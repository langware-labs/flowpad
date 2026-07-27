import { dataContext, dataManager, MessageAttachment, Project, TypeId } from '@sdk';
import { useProject } from '@sdk/react/hooks';
import { useLingui } from '@lingui/react/macro';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';
import { launchVibeSessionForProject } from '@src/pages/flow-page/use-start-vibe-session';
import { ProjectSelectorModal, projectListToSelectorItems } from '@src/components/project-selector';
import { useEnsureProject } from '@src/components/project-selector/use-ensure-project';
import { useAllProjects } from '@src/hooks/use-all-projects';
import { buildSkillTestPrompt, resolveRunProjectId } from './test-prompt';

/**
 * Low level: run a received skill in a KNOWN project. Installs it (if not
 * already) into that project, then opens a Vibe session there and fires
 * `run the skill <name>` as the first turn.
 *
 * Why install first + address by NAME (not the staged path): the Claude worker
 * resolves a skill by its frontmatter `name` from `.claude/skills/<name>/`
 * under any mounted root — so the skill must be COPIED into the run project
 * (`<project>/.claude/skills/`) before the prompt can name it. Why a Vibe
 * session: the embedded `vibe` persona carries the mcp-ui + `flow show`
 * presentation contract, so the skill's questions render as an MCP-UI form on
 * the display and its report is shown there.
 */
export function useRunReceivedSkill(): (args: {
  attachment: MessageAttachment;
  projectId: string;
  userPrompt?: string | null;
}) => void {
  const { navigation } = useDockNavigation();
  const { t } = useLingui();

  return useCallback(
    ({ attachment, projectId, userPrompt }) => {
      void (async () => {
        try {
          if (!attachment.installed) {
            await attachment.install('project', projectId);
          }
          const name = attachment.name;
          if (!name) throw new Error('skill has no name to run');

          const project = await dataManager.getByTypeId<Project>(new TypeId(Project.type, projectId));
          const workdir =
            project?.fs_storage_mount_path ||
            project?.name ||
            dataContext.bootstrapInfo?.desktop_info?.paths?.workspace ||
            undefined;

          await launchVibeSessionForProject({
            projectId,
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
    [navigation, t],
  );
}

/**
 * High level: resolve the run project (conversation → active), and if none is
 * resolvable (a shared conversation is often projectless on the receiver),
 * PROMPT for one with the same ProjectSelectorModal the install picker uses,
 * then run in the picked project. Returns `start(...)` plus the picker element
 * the caller renders.
 */
export function useRunSkillWithProjectPrompt(): {
  start: (attachment: MessageAttachment, conversationProjectId?: string | null, userPrompt?: string | null) => void;
  picker: ReactNode;
} {
  const runInProject = useRunReceivedSkill();
  const { project: activeProject } = useProject();
  const { t } = useLingui();

  // Set while we prompt for a project; carries the attachment + prompt so the
  // pick can complete the run.
  const [pending, setPending] = useState<{ attachment: MessageAttachment; userPrompt?: string | null } | null>(null);
  const { projects, isLoading } = useAllProjects({ enabled: pending != null });
  const projectItems = useMemo(() => projectListToSelectorItems(projects), [projects]);
  const ensureProject = useEnsureProject();

  const start = useCallback(
    (attachment: MessageAttachment, conversationProjectId?: string | null, userPrompt?: string | null) => {
      const projectId = resolveRunProjectId(attachment, conversationProjectId, activeProject?.id ?? null);
      if (projectId) {
        runInProject({ attachment, projectId, userPrompt });
        return;
      }
      setPending({ attachment, userPrompt });
    },
    [runInProject, activeProject?.id],
  );

  const onPick = useCallback(
    async (id: string) => {
      const picked = projectItems.find((item) => item.id === id);
      if (!picked?.path || !pending) return;
      try {
        // Selector ids are canonical paths — materialize the Project so we have
        // a real id to install+run into.
        const project = await ensureProject(picked.path, { select: false });
        if (!project.id) throw new Error('picked project has no id');
        runInProject({ attachment: pending.attachment, projectId: project.id, userPrompt: pending.userPrompt });
      } catch (err) {
        console.error('[skill-run] project pick failed', err);
        notify.error({ title: t`Could not start` });
      } finally {
        setPending(null);
      }
    },
    [projectItems, pending, ensureProject, runInProject, t],
  );

  const picker = pending ? (
    <ProjectSelectorModal
      open
      onOpenChange={(o) => { if (!o) setPending(null); }}
      projects={projectItems}
      selectedId={null}
      onSelect={(id) => void onPick(id)}
      isLoading={isLoading}
      title={t`Run skill in project`}
    />
  ) : null;

  return { start, picker };
}
