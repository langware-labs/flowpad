import { useCallback, useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { AgenticProcess, dataManager, FlowpadDiagnosis, ProcessKind, Project, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { Button } from '@src/components/ui/button';
import { diagnosisToText } from '@src/components/diagnose/diagnosis-details';
import { OpenProjectComponent } from '@src/components/open-project-component/open-project-component';
import { persistRemoteToLocalMapping } from '@src/components/conversation/apply-project-choice';
import { useProjectMapping } from '@src/components/conversation/useProjectMapping';
import { useProcessesForTarget } from '@src/components/entity-execution-panel/hooks/useProcessesForTarget';
import { mostRecentProcess } from '@src/utils/process-recency';
import { useProjects } from '@src/hooks/use-projects';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';
import { SquareTerminal } from 'lucide-react';

/**
 * "Open in terminal" for a diagnosis: spawns (or re-focuses) an agentic worker
 * session with the diagnosis injected as its first prompt, then holds — the
 * user drives from there.
 *
 * Reuses the app's existing seams end-to-end:
 *  - `AgenticProcess.launch()` — the entity-scoped opener (same as the
 *    transcript-analysis / conversation sessions): queues the prompt, attaches
 *    the diagnosis entity as shared context, and runs in a specific project.
 *  - `useProcessesForTarget` + `mostRecentProcess` — re-focus the SAME session
 *    on a second click instead of spawning a duplicate (keyed on the diagnosis).
 *  - `OpenProjectComponent` — the footer's project picker. Same machine (the
 *    diagnosis's origin project resolves locally) → open straight away; another
 *    machine (a shared diagnosis whose origin project is foreign) → pick a local
 *    project, remembered via the remote→local map, and the terminal opens right
 *    after the pick (no bounce back to the viewer).
 */
export function OpenInTerminalButton({
  diagnosisId,
  asIcon,
}: {
  diagnosisId: string;
  /** Render as a compact icon button (settings table) instead of a labelled one. */
  asIcon?: boolean;
}) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();

  const typeId = useMemo(() => new TypeId(FlowpadDiagnosis.type, diagnosisId), [diagnosisId]);
  const { data: diag } = useEntity<FlowpadDiagnosis>(typeId, { enabled: !!diagnosisId });

  const origin = diag?.origin_project_id ?? null;
  const originName = diag?.origin_project_name ?? '';

  const { mapping } = useProjectMapping();
  const { projects = [] } = useProjects();
  const [pickerOpen, setPickerOpen] = useState(false);

  // Same-machine detection: the origin project resolves to a LOCAL project —
  // either it IS a local project id, or the remote→local map points at one.
  const resolvedLocalId = useMemo(() => {
    if (origin && projects.some((p) => p.id === origin)) return origin;
    if (origin && mapping[origin]) return mapping[origin];
    return null;
  }, [origin, projects, mapping]);

  // Re-focus the same session on a second click instead of spawning a duplicate.
  const target = useMemo(() => `${FlowpadDiagnosis.type}-${diagnosisId}`, [diagnosisId]);
  const { processes } = useProcessesForTarget(target, { processType: ProcessKind.Analysis });
  const existing = useMemo(() => mostRecentProcess(processes), [processes]);

  const buildPrompt = useCallback(
    (projectName: string) => {
      if (!diag) return '';
      const text = diagnosisToText(diag);
      const proj = projectName ? `\n\nProject: ${projectName}` : '';
      return `${text}${proj}\n\nDon't do anything yet, wait for further instructions or questions.`;
    },
    [diag],
  );

  const doOpen = useCallback(
    async (projectId: string) => {
      if (existing?.id) {
        void navigation.openShellProcess(existing.id);
        return;
      }
      const project = await dataManager
        .getByTypeId<Project>(new TypeId(Project.type, projectId))
        .catch(() => null);
      const workdir = project?.fs_storage_mount_path ?? undefined;
      if (!workdir) {
        notify.error({
          title: t`Can't open terminal`,
          message: t`The selected project has no folder on this machine.`,
        });
        return;
      }
      try {
        await AgenticProcess.launch({
          workerType: 'claude_code',
          workdir,
          projectId,
          launchPrompt: buildPrompt(project?.name || originName),
          enableAssistant: true,
          sharedContextEntities: [typeId.toString()],
          processType: ProcessKind.Analysis,
          target,
        });
      } catch (e) {
        notify.error({
          title: t`Failed to open in terminal`,
          message: e instanceof Error ? e.message : undefined,
        });
      }
    },
    [existing, navigation, buildPrompt, originName, typeId, target, t],
  );

  const handleClick = useCallback(() => {
    // An existing session for this diagnosis just gets focused — no project needed.
    if (existing?.id) {
      void navigation.openShellProcess(existing.id);
      return;
    }
    // Same machine → open directly in the origin project. Otherwise pick one.
    if (resolvedLocalId) {
      void doOpen(resolvedLocalId);
      return;
    }
    setPickerOpen(true);
  }, [existing, navigation, resolvedLocalId, doOpen]);

  // Cross-machine pick: remember the choice (so next time it's silent) and open
  // the terminal right away — no return trip to the viewer.
  const handlePicked = useCallback(
    async (project: Project) => {
      setPickerOpen(false);
      if (origin && project.id) await persistRemoteToLocalMapping(origin, project.id);
      await doOpen(project.id);
    },
    [origin, doOpen],
  );

  const label = existing ? t`Open terminal` : t`Open in terminal`;

  return (
    <>
      {asIcon ? (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          aria-label={label}
          title={label}
          disabled={!diag}
          onClick={(e) => {
            e.stopPropagation();
            handleClick();
          }}
        >
          <SquareTerminal className="h-4 w-4" />
        </Button>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!diag}
          onClick={handleClick}
          className="h-6 gap-1 px-2 text-xs"
          data-testid="diagnosis-open-terminal"
        >
          <SquareTerminal className="h-3.5 w-3.5" />
          <Trans>Open in terminal</Trans>
        </Button>
      )}
      <OpenProjectComponent
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        trigger={origin ? 'map' : 'gate'}
        remoteProjectId={origin}
        remoteProjectName={originName}
        onPicked={handlePicked}
      />
    </>
  );
}
