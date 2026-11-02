import { Trans } from '@lingui/react/macro';
import { Loader2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Project, type WebAppLifecycle } from '@sdk';
import { AskForm } from '@src/components/ask/AskForm';
import { Button } from '@src/components/ui/button';
import { SetupTreeView } from '@src/components/project-setup/SetupTreeView';
import { Step } from '@src/components/project-setup/Step';
import { webappAsset } from '@src/components/project-setup/use-project-load';
import type { AppLifecycle } from './useAppLifecycle';

/**
 * The one screen over a web app that is not on screen yet — one switch over its lifecycle record. `up` draws
 * nothing; `degraded` a thin banner over the live frame (never hiding it); every other state the screen that
 * says what is being done, and — only when the backend gave up — ONE Fix it.
 */
export function AppLifecyclePanel({ lifecycle }: { lifecycle: AppLifecycle }) {
  const { record } = lifecycle;
  if (!record) return <Checking />;
  switch (record.state) {
    case 'up':
      // Up, and what it stands on still owes something (a credential expired under it): said over the live app.
      return record.setup_owed ? (
        <div
          role="status"
          data-testid="app-lifecycle-owed"
          className="flex items-center gap-3 border-b border-amber-500/40 bg-amber-500/10 px-3 py-1 text-xs"
        >
          <span className="min-w-0 flex-1 truncate" title={record.setup_owed}>
            <Trans>Needs setup: {record.setup_owed}</Trans>
          </span>
          <Button size="sm" variant="outline" className="h-6" data-testid="app-lifecycle-setup"
            onClick={() => void lifecycle.fixIt()}>
            <Trans>Set up</Trans>
          </Button>
        </div>
      ) : null;
    case 'degraded':
      return (
        <div
          role="status"
          data-testid="app-lifecycle-degraded"
          className="truncate border-b border-amber-500/40 bg-amber-500/10 px-3 py-1 text-xs"
          title={record.detail}
        >
          <Trans>Up, with problems: {record.failure?.text || record.detail}</Trans>
        </div>
      );
    case 'installing':
    case 'building':
    case 'starting':
      return (
        <Screen state={record.state}>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
            <Trans>Setting up — {record.detail || record.state}</Trans>
          </h2>
          <SetupTree record={record} />
        </Screen>
      );
    case 'recovering':
      return (
        <Screen state={record.state}>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
            <Trans>Recovering: {record.recovery || record.detail}</Trans>
          </h2>
          <ul className="flex flex-col divide-y rounded-md border">
            {record.failure && (
              <Step mark="failed" title={record.failure.text || record.failure.code} detail={record.failure.phase} />
            )}
            <Step
              mark="running"
              title={record.agent_call ? <Trans>An agent is repairing the app</Trans> : <Trans>Applying a known fix</Trans>}
              detail={record.recovery}
            />
            <Step mark="next" title={<Trans>Next: check again</Trans>} />
          </ul>
          <Question lifecycle={lifecycle} />
        </Screen>
      );
    case 'needs_person':
    case 'failed':
      return (
        <Screen state={record.state}>
          <h2 className="text-lg font-semibold">
            <Trans>Needs you: {record.failure?.text || record.detail}</Trans>
          </h2>
          {record.detail && record.failure?.text && record.detail !== record.failure.text ? (
            <p className="text-sm text-muted-foreground">{record.detail}</p>
          ) : null}
          <Question lifecycle={lifecycle} />
          <div className="flex gap-2">
            <Button data-testid="app-lifecycle-fix" onClick={() => void lifecycle.fixIt()}>
              <Trans>Fix it</Trans>
            </Button>
            <Button variant="outline" data-testid="app-lifecycle-cancel" onClick={() => void lifecycle.stop()}>
              <Trans>Cancel</Trans>
            </Button>
          </div>
        </Screen>
      );
    case 'down':
    default:
      return <Checking />;
  }
}

function Screen({ state, children }: { state: string; children: React.ReactNode }) {
  return (
    <div
      className="flex h-full justify-center overflow-auto bg-background p-8"
      data-testid="app-lifecycle-panel"
      data-state={state}
    >
      <div className="flex w-full max-w-xl flex-col gap-4">{children}</div>
    </div>
  );
}

function Checking() {
  return (
    <div className="flex h-full items-center justify-center" data-testid="app-lifecycle-panel" data-state="checking">
      <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        <Trans>Checking the app…</Trans>
      </p>
    </div>
  );
}

function Question({ lifecycle }: { lifecycle: AppLifecycle }) {
  return lifecycle.questionId ? (
    <AskForm questionId={lifecycle.questionId} showOp={false} onSettled={lifecycle.settleQuestion} />
  ) : null;
}

/** The app's node of its project's setup tree — re-read on every record change (pushed), never polled. */
function SetupTree({ record }: { record: WebAppLifecycle }) {
  const asset = webappAsset((record.webapp_id ?? '').replace(/^micro_app-/, ''));
  const projectId = record.project_id ?? '';
  const { data } = useQuery({
    queryKey: ['webapp-setup-tree', projectId, asset, record.state, record.detail],
    queryFn: () => Project.setupRun(projectId, asset),
    enabled: !!projectId && !!asset,
  });
  return <SetupTreeView tree={data?.tree ?? null} />;
}
