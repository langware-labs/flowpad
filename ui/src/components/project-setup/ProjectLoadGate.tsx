import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Trans } from '@lingui/react/macro';
import { Project, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { Button } from '@src/components/ui/button';
import { AskForm } from '@src/components/ask/AskForm';
import { SetupTreeView } from './SetupTreeView';
import { useProjectLoad } from './use-project-load';
import { openProjectLoad, useProjectLoadStore } from './project-load-store';

/** The route has already selected identity. Operational work starts after the tab mounts. */
export function ProjectLoadGate({
  projectId,
  display = '',
  children,
}: {
  projectId: string;
  display?: string;
  children: ReactNode;
}) {
  const location = useLocation();
  const client = useQueryClient();
  const dialogActive = useProjectLoadStore((state) => state.open && state.payload?.projectId === projectId);
  const lifecycle = useProjectLoad(projectId, undefined, display, !dialogActive);
  const { data: project } = useEntity<Project>(new TypeId(Project.type, projectId));
  const { load } = lifecycle;
  const [loadedLocation, setLoadedLocation] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void load().then(() => {
      if (live) setLoadedLocation(location.key);
    });
    return () => {
      live = false;
    };
  }, [load, location.key]);
  const result = lifecycle.result;
  // Joining a provider-only run does not verify this consumer's saved display.
  // Continue with that check once the shared run completes; never retry a failed load.
  const displayChecked = !display || result?.display === display;
  useEffect(() => {
    if (result?.state === 'ready' && !displayChecked && !lifecycle.starting && loadedLocation === location.key) {
      void load();
    }
  }, [result?.state, displayChecked, lifecycle.starting, loadedLocation, location.key, load]);
  // A load that failed gets its setup once per open, unasked: opening an app means "make it work".
  // The backend offers it once per failure, so a setup that does not help ends here with its reason.
  const repaired = useRef<string | null>(null);
  useEffect(() => {
    if (result?.state !== 'failed' || !result.setup_available || lifecycle.starting) return;
    if (loadedLocation !== location.key || repaired.current === location.key) return;
    repaired.current = location.key;
    void load(true);
  }, [result, lifecycle.starting, loadedLocation, location.key, load]);
  const name = project?.displayName || projectId;
  useEffect(() => {
    if (result?.state === 'setup_required') openProjectLoad({ projectId, projectName: name, initial: result });
    if (result?.state === 'ready') void client.invalidateQueries({ queryKey: ['service_endpoint'] });
  }, [client, projectId, name, result]);
  if (result?.state === 'ready' && displayChecked && !lifecycle.starting && loadedLocation === location.key)
    return children;
  if (lifecycle.missing)
    return (
      <div className="flex h-full justify-center overflow-auto p-8" data-testid="project-load-missing">
        <p role="alert" className="max-w-xl">
          <Trans>This project is no longer on this computer. Open it again from the project that uses it.</Trans>
        </p>
      </div>
    );
  return (
    <div className="flex h-full justify-center overflow-auto p-8" data-testid="project-load-gate">
      <div className="flex w-full max-w-xl flex-col gap-4">
        <h2 className="text-lg font-semibold">{name}</h2>
        <p role="status">{result?.detail || <Trans>Preparing…</Trans>}</p>
        {lifecycle.error && (
          <p role="alert" className="text-destructive">
            {lifecycle.error}
          </p>
        )}
        {lifecycle.questionId && (
          <AskForm questionId={lifecycle.questionId} showOp={false} onSettled={lifecycle.settleQuestion} />
        )}
        {result?.state !== 'setup_required' && <SetupTreeView tree={lifecycle.tree} />}
        {result?.state === 'setup_required' && (
          <Button
            className="self-start"
            onClick={() => openProjectLoad({ projectId, projectName: name, initial: result })}
          >
            <Trans>Setup required</Trans>
          </Button>
        )}
        {(result?.state === 'failed' || lifecycle.error) && (
          <Button className="self-start" disabled={lifecycle.starting} onClick={() => void load()}>
            <Trans>Try again</Trans>
          </Button>
        )}
      </div>
    </div>
  );
}
