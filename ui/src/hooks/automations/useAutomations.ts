/**
 * The Automations screen's data — every read and write goes through the TS SDK's
 * `Trigger` methods; nothing here builds a request of its own.
 *
 * Polled, not pushed: `trigger.*` is deliberately not forwarded to the app (the
 * pin test in tests/unit/test_trigger_tags.py says why and what would change it),
 * and the history lives on disk, not on the bus. Polling stops while the browser
 * tab is hidden (react-query's default `refetchIntervalInBackground: false`).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useDebounced } from '@src/hooks/useDebounced';
import {
  Trigger,
  type AutomationCheck,
  type AutomationRun,
  type AutomationSample,
  type AutomationSummary,
  type BusMap,
  type AutomationTestEvent,
  type ITrigger,
  type NextRuns,
  type RunOnceStarted,
  type RunsQuery,
} from '@sdk';

/** How often the list and the runs refresh while the screen is open. */
const AUTOMATIONS_POLL_MS = 5000;

const automationKeys = {
  all: ['automations'] as const,
  overview: () => ['automations', 'overview'] as const,
  runs: (q: RunsQuery) =>
    ['automations', 'runs', q.triggerId ?? null, q.status ?? null, q.includeTests ?? true, q.includeBuiltin ?? true, q.limit ?? null] as const,
  run: (id: string | null) => ['automations', 'run', id] as const,
  nextRuns: (expr: string, kind: string, tz: string, n: number) => ['automations', 'next', expr, kind, tz, n] as const,
};

/** Every automation as a sentence with its health. `poll: false` for a screen that
 *  only needs the names (a filter list) — it shares the cache without adding a poll. */
export function useAutomations(options: { enabled?: boolean; poll?: boolean } = {}) {
  return useQuery<AutomationSummary[]>({
    queryKey: automationKeys.overview(),
    queryFn: () => Trigger.overview(),
    refetchInterval: options.poll === false ? false : AUTOMATIONS_POLL_MS,
    enabled: options.enabled ?? true,
  });
}

/** One automation's summary, from the same list (no second request). */
export function useAutomation(triggerId: string | null | undefined) {
  const query = useAutomations({ enabled: !!triggerId });
  const automation = triggerId ? ((query.data ?? []).find((a) => a.id === triggerId) ?? null) : null;
  return { ...query, automation };
}

export function useAutomationRuns(query: RunsQuery = {}, options: { enabled?: boolean } = {}) {
  return useQuery<AutomationRun[]>({
    queryKey: automationKeys.runs(query),
    queryFn: () => Trigger.runs(query),
    refetchInterval: AUTOMATIONS_POLL_MS,
    enabled: options.enabled ?? true,
  });
}

/** One run. Pass `enabled: false` when a polling list already holds it. */
export function useAutomationRun(runId: string | null | undefined, options: { enabled?: boolean } = {}) {
  return useQuery<AutomationRun>({
    queryKey: automationKeys.run(runId ?? null),
    queryFn: () => Trigger.run(runId as string),
    enabled: !!runId && (options.enabled ?? true),
    // A running run keeps changing; a finished one does not.
    refetchInterval: (q) =>
      q.state.data && ['running', 'launched'].includes(q.state.data.status) ? AUTOMATIONS_POLL_MS : false,
  });
}

/** When a schedule (saved or still being edited) fires next. Empty while the expression is blank. */
export function useNextRuns(
  schedule: { expr?: string | null; sched_trigger_type?: string | null; timezone?: string | null },
  n = 5,
) {
  const expr = useDebounced((schedule.expr ?? '').trim());
  const kind = schedule.sched_trigger_type || 'cron';
  const tz = schedule.timezone || '';
  return useQuery<NextRuns>({
    queryKey: automationKeys.nextRuns(expr, kind, tz, n),
    queryFn: () => Trigger.nextRuns({ expr, sched_trigger_type: kind, timezone: tz }, n),
    enabled: !!expr,
    retry: false,
    staleTime: 30_000,
  });
}

/** Refresh what a write changes: the list, the runs, and the automation itself —
 *  not the bus map, the rule code or the schedule previews. */
function useInvalidateAutomations() {
  const client = useQueryClient();
  return () =>
    Promise.all(
      [automationKeys.overview(), ['automations', 'runs'], ['automations', 'run'], ['automations', 'trigger']].map(
        (queryKey) => client.invalidateQueries({ queryKey }),
      ),
    );
}

/** *Run once now*. The run keeps going in the background; the lists pick it up. */
export function useRunOnce() {
  const invalidate = useInvalidateAutomations();
  return useMutation<RunOnceStarted, Error, { triggerId: string; event?: AutomationTestEvent | null }>({
    mutationFn: ({ triggerId, event }) => Trigger.runOnce(triggerId, event),
    onSettled: () => void invalidate(),
  });
}

export function useSetAutomationEnabled() {
  const invalidate = useInvalidateAutomations();
  return useMutation<Trigger, Error, { triggerId: string; enabled: boolean }>({
    mutationFn: ({ triggerId, enabled }) => Trigger.setEnabled(triggerId, enabled),
    onSettled: () => void invalidate(),
  });
}

/** Create (no id) or update (id) an automation from its fields. */
export function useSaveAutomation() {
  const invalidate = useInvalidateAutomations();
  return useMutation<Trigger, Error, { triggerId?: string | null; fields: Partial<ITrigger> & { name: string } }>({
    mutationFn: ({ triggerId, fields }) =>
      triggerId ? Trigger.updateAutomation(triggerId, fields) : Trigger.createAutomation(fields),
    onSettled: () => void invalidate(),
  });
}

export function useDeleteAutomation() {
  const invalidate = useInvalidateAutomations();
  return useMutation<void, Error, string>({
    mutationFn: (triggerId) => Trigger.remove(triggerId),
    onSettled: () => void invalidate(),
  });
}

/** The full Trigger row behind an automation — what the builder edits. */
export function useAutomationTrigger(triggerId: string | null | undefined) {
  return useQuery<Trigger | null>({
    queryKey: ['automations', 'trigger', triggerId ?? null],
    queryFn: () => Trigger.getById<Trigger>(triggerId as string),
    enabled: !!triggerId,
  });
}

/** *Check* — a saved automation (by id) or the builder's unsaved fields. Run on demand. */
export function useAutomationCheck() {
  return useMutation<
    AutomationCheck,
    Error,
    { triggerId?: string | null; spec?: Partial<ITrigger>; event?: AutomationTestEvent | null }
  >({
    mutationFn: ({ triggerId, spec, event }) =>
      triggerId ? Trigger.check(triggerId, event) : Trigger.checkSpec(spec ?? {}, event),
  });
}

/** Recent real events to test an event automation with. Saved: its own; unsaved: by pattern. */
export function useAutomationSamples(source: {
  triggerId?: string | null;
  pattern?: string | null;
  target?: string | null;
}) {
  const pattern = useDebounced((source.pattern ?? '').trim());
  return useQuery<AutomationSample[]>({
    queryKey: ['automations', 'samples', source.triggerId ?? null, pattern, source.target ?? null],
    queryFn: () =>
      source.triggerId ? Trigger.samples(source.triggerId) : Trigger.recentEvents(pattern, source.target),
    enabled: !!source.triggerId || !!pattern,
    refetchInterval: AUTOMATIONS_POLL_MS,
  });
}

/** The event bus as a map — event types, counts, listeners. Also the event picker's catalog.
 *  Not polled: the live stream arrives over the socket, and the counts refresh on focus. */
export function useBusMap(options: { enabled?: boolean } = {}) {
  return useQuery<BusMap>({
    queryKey: ['automations', 'bus-map'],
    queryFn: () => Trigger.busMap(),
    enabled: options.enabled ?? true,
    staleTime: 10_000,
  });
}

/** An agent rule's `trigger.py` — read, and saved back. */
export function useRuleCode(triggerId: string | null | undefined, enabled = true) {
  const client = useQueryClient();
  const query = useQuery<string>({
    queryKey: ['automations', 'code', triggerId ?? null],
    queryFn: () => Trigger.getCode(triggerId as string),
    enabled: !!triggerId && enabled,
    retry: false,
  });
  const save = useMutation<void, Error, string>({
    mutationFn: (content) => Trigger.setCode(triggerId as string, content),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['automations', 'code', triggerId ?? null] }),
  });
  return { ...query, save };
}

/** Find agent rule folders on disk and list them as automations. */
export function useDiscoverRules() {
  const invalidate = useInvalidateAutomations();
  return useMutation<Trigger[], Error, void>({
    mutationFn: () => Trigger.discover(),
    onSettled: () => void invalidate(),
  });
}
