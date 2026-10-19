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
import { FIRST_RUN_BLOCKED, FirstRunWaiting, useFirstRunGate, useFirstRunResume } from './first-run-gate';
import { useProjectLoad, validLoad } from './use-project-load';
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
  // Phase one, validate: an app this session already saw up and that still answers opens at once — no
  // load, no spinner, nothing refetched under it. Held across opens, so a re-open shows the app on its
  // first frame and checks behind it; only a failed check falls through to load (and setup).
  const validKey = validLoad.key(projectId, asset, display);
  // true: show the app; null: no verdict held, its check in flight — a blank frame for its few
  // milliseconds, never a status that flashes; false: load.
  const [valid, setValid] = useState<boolean | null>(() => (!asset ? false : validLoad.has(validKey) || null));
  useEffect(() => {
    let live = true;
    void (async () => {
      if (asset) {
        const verdict = await Project.validateLoad(projectId, asset, display).catch(() => null);
        if (!live) return;
        const up = verdict?.state === 'ready';
        validLoad.set(validKey, up);
        setValid(up);
        if (up) return;
      }
      await load();
      if (live) setLoadedLocation(location.key);
    })();
    return () => {
      live = false;
    };
  }, [load, location.key, projectId, asset, display, validKey]);
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
  // Refused because the first-run wizard is not done: not an owed setup to retry, a wait with a way on --
  // and the setup begins again by itself the moment the wizard is done.
  const gate = useFirstRunGate();
  const blocked = result?.blocked === FIRST_RUN_BLOCKED;
  useFirstRunResume(blocked, gate, () => void load(true));
  useEffect(() => {
    const owed =
      (result?.state === 'setup_required' && !!asset) || (result?.state === 'failed' && result.setup_available);
    if (!owed || blocked || lifecycle.starting) return;
    if (loadedLocation !== location.key || setUp.current === location.key) return;
    setUp.current = location.key;
    void load(true);
  }, [result, asset, blocked, lifecycle.starting, loadedLocation, location.key, load]);
  const name = project?.displayName || projectId;
  // Working: a load in flight, or a setup run going that is not waiting on the person.
  const busy = lifecycle.starting || !result || result.state === 'running';
  const status =
    busy && !lifecycle.questionId ? (
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
    // A load that just brought the app up moved its address; a validated one moved nothing.
    if (result?.state === 'ready' && loadedLocation === location.key) {
      validLoad.set(validKey, true);
      void client.invalidateQueries({ queryKey: ['service_endpoint'] });
    }
  }, [client, result, loadedLocation, location.key, validKey]);
  if (valid) return children;
  if (valid === null) return null;
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
        {blocked && <FirstRunWaiting />}
        {result?.state === 'setup_required' && !asset && !blocked && (
          <Button className="self-start" disabled={lifecycle.starting} onClick={() => void load(true)}>
            <Trans>Set up</Trans>
          </Button>
        )}
        {fix.show && (
          <SetupFailureActions
            fix={fix}
            busy={lifecycle.starting}
            onCancel={() => void navigate(-1)}
          />
        )}
      </div>
    </div>
  );
}
