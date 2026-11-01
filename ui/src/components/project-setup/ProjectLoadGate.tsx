import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Trans } from '@lingui/react/macro';
import { Loader2 } from 'lucide-react';
import { Project, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { Button } from '@src/components/ui/button';
import { AskForm } from '@src/components/ask/AskForm';
import { SetupFailureActions } from './SetupFailureActions';
import { useSetupFix } from './use-setup-fix';
import { SetupTreeView } from './SetupTreeView';
import { useProjectLoad } from './use-project-load';
import { useProjectLoadStore } from './project-load-store';

/** The route has already selected identity. Operational work starts after the tab mounts. */
export function ProjectLoadGate({
  projectId,
  asset = '',
  display = '',
  children,
}: {
  projectId: string;
  /** The app this gate shows, as a TypeId: the load is judged on it, not on the bare project. */
  asset?: string;
  display?: string;
  children: ReactNode;
}) {
  const location = useLocation();
  const client = useQueryClient();
  const dialogActive = useProjectLoadStore((state) => state.open && state.payload?.projectId === projectId);
  const lifecycle = useProjectLoad(projectId, undefined, display, !dialogActive, asset);
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
  const fix = useSetupFix(projectId, result, lifecycle.error, (approved) => load(approved));
  const navigate = useNavigate();
  // Joining a provider-only run does not verify this consumer's saved display.
  // Continue with that check once the shared run completes; never retry a failed load.
  const displayChecked = !display || result?.display === display;
  useEffect(() => {
    if (result?.state === 'ready' && !displayChecked && !lifecycle.starting && loadedLocation === location.key) {
      void load();
    }
  }, [result?.state, displayChecked, lifecycle.starting, loadedLocation, location.key, load]);
  // Opening an APP means "make it work": its owed setup (or one repair per failure) runs here, unasked,
  // in the view the app will fill. A gate for the project alone offers Set up instead.
  const setUp = useRef<string | null>(null);
  useEffect(() => {
    const owed =
      (result?.state === 'setup_required' && !!asset) || (result?.state === 'failed' && result.setup_available);
    if (!owed || lifecycle.starting) return;
    if (loadedLocation !== location.key || setUp.current === location.key) return;
    setUp.current = location.key;
    void load(true);
  }, [result, asset, lifecycle.starting, loadedLocation, location.key, load]);
  const name = project?.displayName || projectId;
  // A question on screen means the run waits on the person: no spinner, and say so.
  // Otherwise working = a load in flight or a setup run going.
  const waiting = !!lifecycle.questionId;
  const busy = !waiting && (lifecycle.starting || !result || result.state === 'running');
  const status = waiting ? (
    <Trans>Waiting for your answer</Trans>
  ) : busy ? (
    result?.state === 'running' ? (
      result.phase === 'load' ? (
        <Trans>Starting…</Trans>
      ) : (
        <Trans>Setting up…</Trans>
      )
    ) : (
      <Trans>Checking what this needs…</Trans>
    )
  ) : (
    result?.detail || <Trans>Preparing…</Trans>
  );
  useEffect(() => {
    // A load that just brought something up moved its address.
    if (result?.state === 'ready' && loadedLocation === location.key) {
      void client.invalidateQueries({ queryKey: ['service_endpoint'] });
    }
  }, [client, result, loadedLocation, location.key]);
  // Up, but its setup owes something (a sign-in that expired under it): the app stays, a bar says what is
  // needed, and Set up leaves the fast path for the setup flow the gate already runs.
  const shown = result?.state === 'ready' && displayChecked && !lifecycle.starting && loadedLocation === location.key;
  const owed = shown ? (result?.setup_owed ?? null) : null;
  if (owed)
    return (
      <div className="flex h-full flex-col">
        <div
          role="alert"
          className="flex items-center gap-3 border-b border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-sm"
          data-testid="project-load-setup-owed"
        >
          <span className="min-w-0 flex-1 truncate" title={owed}>
            <Trans>Needs setup: {owed}</Trans>
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void load(true)}
          >
            <Trans>Set up</Trans>
          </Button>
        </div>
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    );
  if (shown) return children;
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
        {/* Never a still sentence while something is happening: a check or a setup can take a while,
            and a page that does not move reads as stuck (a grey Set up and "waiting on Google Cloud"). */}
        <p role="status" className="flex items-center gap-2" data-testid="project-load-status">
          {busy ? <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" /> : null}
          {status}
        </p>
        {lifecycle.error && (
          <p role="alert" className="text-destructive">
            {lifecycle.error}
          </p>
        )}
        {lifecycle.questionId && (
          <AskForm questionId={lifecycle.questionId} showOp={false} onSettled={lifecycle.settleQuestion} />
        )}
        {/* The steps are for watching a run; while a question is open the question is the screen. */}
        {/* Phase two, load, only starts what is set up: a status line, not the setup tree. */}
        {result?.state !== 'setup_required' && result?.phase !== 'load' && !lifecycle.questionId && (
          <SetupTreeView tree={lifecycle.tree} />
        )}
        {result?.state === 'setup_required' && !asset && (
          <Button className="self-start" disabled={lifecycle.starting} onClick={() => void load(true)}>
            <Trans>Set up</Trans>
          </Button>
        )}
        {fix.show && <SetupFailureActions fix={fix} busy={lifecycle.starting} onCancel={() => void navigate(-1)} />}
      </div>
    </div>
  );
}
