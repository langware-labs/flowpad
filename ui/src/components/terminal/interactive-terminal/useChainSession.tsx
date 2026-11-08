import { AgenticProcess, ProcessKind } from '@sdk';
import { useLingui } from '@lingui/react/macro';
import { useMemo, useState, type ReactNode } from 'react';
import { ProjectSelectorModal } from '@src/components/project-selector';
import { projectEntitiesToSelectorItems } from '@src/components/project-selector/project-items';
import { workerLabel } from '@src/components/lens-viewer/shared/transcript-features/transcript-utils';
import { ContextWorkerToolbar } from '@src/components/workers/ContextWorkerToolbar';
import type { WorkerType } from '@src/components/workers/worker-types';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { useProjects } from '@src/hooks/use-projects';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';

/** The first turn of a chained session: review the session it was chained from. */
export function chainPrompt(process: Pick<AgenticProcess, 'worker_type' | 'session_id'>): string {
  return `Review the ${workerLabel(process.worker_type ?? undefined)} session ${process.session_id}`;
}

/**
 * Chain session: pick another project, launch a context worker there whose
 * first turn reviews this session, and open it.
 */
export function useChainSession(process: AgenticProcess): { start: () => void; picker: ReactNode } {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(null);
  const { projects, isLoading } = useProjects({ enabled: open });
  const items = useMemo(() => projectEntitiesToSelectorItems(projects).filter((p) => !!p.path), [projects]);

  const launch = async (worker: WorkerType) => {
    setProjectId(null);
    const project = items.find((p) => p.id === projectId);
    if (!project) return;
    try {
      const chained = await AgenticProcess.launch({
        workerType: worker,
        workdir: project.path,
        projectId,
        launchPrompt: chainPrompt(process),
        enableAssistant: true,
        processType: ProcessKind.Analysis,
        sharedContextEntities: [process.typeId.toString()],
      });
      void navigation.openShellProcess(chained.id);
    } catch (err) {
      console.error('[chain-session] launch failed', err);
      notify.error({ title: t`Failed to start session` });
    }
  };

  const picker = (
    <>
      <ProjectSelectorModal
        open={open}
        onOpenChange={setOpen}
        projects={items}
        selectedId={null}
        excludeIds={process.project_id ? [process.project_id] : undefined}
        onSelect={setProjectId}
        isLoading={isLoading}
        title={t`Chain this session into which project?`}
      />
      <Dialog open={!!projectId} onOpenChange={(o) => !o && setProjectId(null)}>
        <DialogContent className="sm:max-w-sm" data-testid="chain-session-worker-picker">
          <DialogHeader>
            <DialogTitle>{t`Which worker reviews it?`}</DialogTitle>
          </DialogHeader>
          <ContextWorkerToolbar mode="all" onLaunch={launch} testIdPrefix="chain-session" />
        </DialogContent>
      </Dialog>
    </>
  );

  return { start: () => setOpen(true), picker };
}
