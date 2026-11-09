import { AgenticProcess, ProcessKind } from '@sdk';
import { useLingui } from '@lingui/react/macro';
import { useMemo, useState, type ReactNode } from 'react';
import { ProjectSelector } from '@src/components/project-selector';
import { projectEntitiesToSelectorItems } from '@src/components/project-selector/project-items';
import { workerLabel } from '@src/components/lens-viewer/shared/transcript-features/transcript-utils';
import { VibeWorkerSelect } from '@src/pages/flow-page/vibe-worker-select';
import type { WorkerType } from '@src/components/workers/worker-types';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { useDefaultWorkerType } from '@src/contexts/HarnessCapabilitiesContext';
import { useProjects } from '@src/hooks/use-projects';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';

/** The first turn of a chained session: review the session it was chained from. */
export function chainPrompt(process: Pick<AgenticProcess, 'worker_type' | 'session_id'>): string {
  return `Review the ${workerLabel(process.worker_type ?? undefined)} session ${process.session_id}`;
}

/**
 * Chain session: pick a project (this one by default), launch a context worker there whose
 * first turn reviews this session, and open it.
 */
export function useChainSession(process: AgenticProcess): { start: () => void; picker: ReactNode } {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const defaultWorkerType = useDefaultWorkerType();
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [workerType, setWorkerType] = useState<WorkerType>(defaultWorkerType);
  const { projects, isLoading } = useProjects({ enabled: open });
  const items = useMemo(() => projectEntitiesToSelectorItems(projects).filter((p) => !!p.path), [projects]);

  const launch = async () => {
    const project = items.find((p) => p.id === projectId);
    if (!project) return;
    try {
      const chained = await AgenticProcess.launch({
        workerType,
        workdir: project.path,
        projectId,
        launchPrompt: chainPrompt(process),
        enableAssistant: true,
        processType: ProcessKind.Analysis,
        sharedContextEntities: [process.typeId.toString()],
      });
      setOpen(false);
      void navigation.openShellProcess(chained.id);
    } catch (err) {
      console.error('[chain-session] launch failed', err);
      notify.error({ title: t`Failed to start session` });
    }
  };

  const picker = (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
      }}
    >
      <DialogContent className="sm:max-w-md" data-testid="chain-session-picker">
        <DialogHeader>
          <DialogTitle>{t`Chain session`}</DialogTitle>
          <p className="text-sm text-muted-foreground">
            {t`Choose where this review runs and which worker handles it.`}
          </p>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <div className="text-sm font-medium">{t`Project`}</div>
            <div className="h-52 rounded-md border p-2">
              <ProjectSelector
                projects={items}
                selectedId={projectId}
                onSelect={setProjectId}
                isLoading={isLoading}
              />
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium">{t`Worker`}</span>
            <VibeWorkerSelect value={workerType} onChange={setWorkerType} testId="chain-session-worker-select" />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {t`Cancel`}
            </Button>
            <Button type="button" disabled={!projectId} onClick={() => void launch()}>
              {t`Start review`}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );

  return {
    start: () => {
      setProjectId(process.project_id ?? null);
      setWorkerType((process.worker_type as WorkerType | null | undefined) ?? defaultWorkerType);
      setOpen(true);
    },
    picker,
  };
}
