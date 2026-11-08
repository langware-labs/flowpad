import { useAuth, useProject } from '@sdk/react/hooks';
import { Trans } from '@lingui/react/macro';
import { type ReactNode, useMemo } from 'react';
import type { AssetCounter } from './types';

/**
 * Counters on two axes: a SCOPE (whose items — mine, this project, all) and a STATUS (running,
 * paused, all). A group offers only the options it has; a group with neither has one counter.
 * The counter key is `<scope>.<status>`, so the URL still names exactly one list.
 */
export interface AxisOption {
  key: string;
  label: ReactNode;
  /** `live` lights the count green while it is above zero. */
  tone?: 'live';
}

/** One scope's list. */
export interface ScopeSource<T> extends AxisOption {
  items: T[];
  isLoading: boolean;
}

/** One status: which of a scope's items it keeps (absent → all of them). */
export interface StatusRule<T> extends AxisOption {
  keep?: (item: T) => boolean;
  isLoading?: boolean;
}

export function counterKey(scope?: string, status?: string): string {
  return [scope, status].filter(Boolean).join('.') || 'all';
}

/** Every scope × status counter. `scopes` absent → the one list `items`; `statuses` absent → no status axis. */
export function crossCounters<T>({
  label,
  items = [],
  isLoading = false,
  scopes,
  statuses,
}: {
  label: ReactNode;
  items?: T[];
  isLoading?: boolean;
  scopes?: ScopeSource<T>[];
  statuses?: StatusRule<T>[];
}): AssetCounter<T>[] {
  const sources: (ScopeSource<T> | undefined)[] = scopes ?? [undefined];
  const rules: (StatusRule<T> | undefined)[] = statuses ?? [undefined];
  return sources.flatMap((scope) =>
    rules.map((status) => {
      const base = scope?.items ?? items;
      return {
        key: counterKey(scope?.key, status?.key),
        label,
        description: (
          <>
            {status?.label ?? label}
            {scope && <> · {scope.label}</>}
          </>
        ),
        items: status?.keep ? base.filter(status.keep) : base,
        isLoading: (scope?.isLoading ?? isLoading) || !!status?.isLoading,
        scope: scope && { key: scope.key, label: scope.label },
        status: status && { key: status.key, label: status.label, tone: status.tone },
      };
    }),
  );
}

function unique(options: (AxisOption | undefined)[]): AxisOption[] {
  const seen = new Map<string, AxisOption>();
  for (const option of options) if (option && !seen.has(option.key)) seen.set(option.key, option);
  return [...seen.values()];
}

/** The scope and status options the counters carry, in order. */
export function axesOf<T>(counters: AssetCounter<T>[]) {
  return { scopes: unique(counters.map((c) => c.scope)), statuses: unique(counters.map((c) => c.status)) };
}

export interface AxisSelection {
  scope?: string;
  status?: string;
}

/** The selection a key names; an unknown key → project scope (else the first) and All (else the first). */
export function selectionOf<T>(counters: AssetCounter<T>[], key?: string): AxisSelection {
  const hit = counters.find((c) => c.key === key);
  if (hit) return { scope: hit.scope?.key, status: hit.status?.key };
  const { scopes, statuses } = axesOf(counters);
  const prefer = (options: AxisOption[], want: string) => (options.find((o) => o.key === want) ?? options[0])?.key;
  return { scope: prefer(scopes, 'project'), status: prefer(statuses, 'all') };
}

export function counterAt<T>(counters: AssetCounter<T>[], selection: AxisSelection): AssetCounter<T> | undefined {
  return counters.find((c) => c.key === counterKey(selection.scope, selection.status)) ?? counters[0];
}

/** Mine / <project> / All, where Mine is what the signed-in user created, anywhere. */
export function useScopes<R>(
  all: { items: R[]; isLoading: boolean },
  project: { items: R[]; isLoading: boolean },
  createdBy: (row: R) => string | null | undefined,
): ScopeSource<R>[] {
  const { project: current } = useProject(null);
  const { currentUser } = useAuth();
  const me = currentUser?.id;
  const mine = useMemo(() => (me ? all.items.filter((row) => createdBy(row) === me) : []), [all.items, me, createdBy]);
  const name = current?.name;
  return useMemo(
    () => [
      { key: 'mine', label: <Trans>Mine</Trans>, items: mine, isLoading: all.isLoading },
      { key: 'project', label: name || <Trans>Project</Trans>, items: project.items, isLoading: project.isLoading },
      { key: 'all', label: <Trans>All</Trans>, items: all.items, isLoading: all.isLoading },
    ],
    [mine, name, all.items, all.isLoading, project.items, project.isLoading],
  );
}
