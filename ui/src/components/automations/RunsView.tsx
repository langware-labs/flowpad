/**
 * Runs — every time an automation fired, with what happened. The list on the
 * left, the open run on the right; filters ride the URL (`?status=failed`,
 * `?trigger=<id>`), so "1 automation failing → see what went wrong" is a link.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import type { RunStatus } from '@sdk';
import { useState } from 'react';
import { useAutomations, useAutomationRuns } from '@src/hooks/automations/useAutomations';
import { errorMessage } from '@src/lib/error-message';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import type { AutomationsRoute } from './automations-pointer';
import { Pills } from './Pills';
import { RunDetail } from './RunDetail';
import { RunsList } from './RunsList';

const STATUSES: Array<RunStatus | null> = [null, 'failed', 'skipped', 'running', 'succeeded'];

export function RunsView({ route }: { route: AutomationsRoute }) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const [hideTests, setHideTests] = useState(false);
  const {
    data: runs = [],
    error,
    isLoading,
  } = useAutomationRuns({
    triggerId: route.trigger,
    status: route.status,
    includeTests: !hideTests,
    limit: 300,
  });
  // Names for the filter only: shares the list's cache without polling it again.
  const { data: automations = [] } = useAutomations({ poll: false });
  const go = (patch: Partial<AutomationsRoute>) =>
    navigation.openDock(DockPointer.forAutomations({ ...route, place: 'runs', ...patch }));
  const statusLabel: Record<string, string> = {
    all: t`Any result`,
    failed: t`Failed`,
    skipped: t`Skipped`,
    running: t`Running`,
    succeeded: t`Succeeded`,
  };
  const selected = runs.find((r) => r.id === route.run) ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="automations-runs">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-6 py-3">
        <h2 className="mr-2 text-lg font-semibold">
          <Trans>Runs</Trans>
        </h2>
        <select
          className="h-8 rounded-md border border-input bg-background px-2 text-xs"
          value={route.trigger ?? ''}
          onChange={(e) => go({ trigger: e.target.value || null, run: null })}
          data-testid="runs-filter-automation"
          aria-label={t`Automation`}
        >
          <option value="">{t`All automations`}</option>
          {automations.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <Pills
          testId="runs-filter"
          label={t`Result`}
          value={route.status ?? 'all'}
          options={STATUSES.map((s) => ({ value: s ?? 'all', label: statusLabel[s ?? 'all'] }))}
          onChange={(v) => go({ status: v === 'all' ? null : (v as RunStatus), run: null })}
        />
        <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={hideTests}
            onChange={(e) => setHideTests(e.target.checked)}
            data-testid="runs-hide-tests"
          />
          <Trans>Hide test runs</Trans>
        </label>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(18rem,2fr)_3fr]">
        <div className="min-h-0 overflow-auto border-r border-border">
          {error ? (
            <p className="m-4 rounded border border-red-500/60 bg-red-500/10 px-3 py-2 text-sm">
              {errorMessage(error, t`Could not load runs`)}
            </p>
          ) : isLoading ? (
            <p className="p-6 text-sm text-muted-foreground">
              <Trans>Loading…</Trans>
            </p>
          ) : (
            <RunsList
              runs={runs}
              selectedId={route.run}
              onSelect={(run) => go({ run: run.id })}
              emptyText={
                route.status === 'failed' ? (
                  <Trans>Nothing failed. Good.</Trans>
                ) : (
                  <Trans>No runs yet. An automation's runs appear here the moment it fires, including test runs.</Trans>
                )
              }
            />
          )}
        </div>
        <div className="min-h-0 overflow-auto">
          {route.run ? (
            <RunDetail runId={route.run} fallback={selected} />
          ) : (
            <p className="p-6 text-sm text-muted-foreground">
              <Trans>Pick a run to see why it ran, what it did, and what went wrong.</Trans>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
