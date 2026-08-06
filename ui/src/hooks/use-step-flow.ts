import { useCallback, useMemo, useRef, useState } from 'react';

/**
 * Generic "checked steps" progress model — the checklist a long, multi-call
 * flow renders while it works (desktop launch, help-desk load, …).
 *
 * Lifted from the bespoke copy that grew inside `use-sandboxes.ts` and was then
 * duplicated between `HubHome` and `LaunchLanding`. Pair it with `<StepList>`
 * (`@src/components/ui/step-list`) for the rendering half.
 *
 * The engine is {@link StepFlow.run}: it flips one step to `loading`, awaits the
 * work, then marks `success` — or marks `error` (carrying the message as
 * `detail`) and RETHROWS. Rethrowing is what aborts the remaining steps, which
 * stay `idle` and render as never-reached rather than as failures.
 */

export type StepStatus = 'idle' | 'loading' | 'success' | 'error';

export interface Step<TId extends string = string> {
  id: TId;
  label: string;
  status: StepStatus;
  /** Sub-line under the label: progress hints while running, the error on failure. */
  detail?: string;
}

export interface StepFlow<TId extends string> {
  steps: Step<TId>[];
  /** True between the first `run` of a pass and its settle. */
  busy: boolean;
  /** Run one step: `loading` → await → `success`, or `error` + rethrow. */
  run: <T>(id: TId, fn: () => Promise<T>) => Promise<T>;
  /** Merge a partial into one step — used for mid-step `detail` updates. */
  patch: (id: TId, next: Partial<Step<TId>>) => void;
  /** Return every step to `idle`. Call at the start of each pass. */
  reset: () => void;
  /** Wrap a whole pass so `busy` settles even when a step throws.
   *  Resolves `{ ok, value }` — `value` is whatever the pass returned, so a
   *  caller can distinguish *how* a clean pass ended without inventing a
   *  mutable flag that crosses the async boundary. */
  runAll: <T>(fn: () => Promise<T>) => Promise<{ ok: boolean; value?: T }>;
}

/**
 * @param ids    Ordered step ids. Identity is not required — the array is
 *               compared by value, so an inline literal is fine.
 * @param labels Human label per id. Read through a ref, so this need not be
 *               referentially stable either.
 */
export function useStepFlow<TId extends string>(
  ids: readonly TId[],
  labels: Record<TId, string>,
): StepFlow<TId> {
  // `ids` is keyed by value and `labels` is read through a ref, so neither has
  // to be referentially stable — callers build both inline, and `labels` holds
  // translated strings so it is a fresh object every render. Depending on it
  // directly (as this once did) rebuilt `initial` every render, churned
  // `reset`'s identity, and cascaded into the caller's `load` callback —
  // defeating the very stability the key was added for.
  const idsKey = ids.join(' ');
  const labelsRef = useRef(labels);
  labelsRef.current = labels;

  const initial = useMemo(
    () =>
      idsKey.split(' ').map((id) => ({
        id: id as TId,
        label: labelsRef.current[id as TId],
        status: 'idle' as StepStatus,
      })),
    [idsKey],
  );

  const [steps, setSteps] = useState<Step<TId>[]>(initial);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const patch = useCallback((id: TId, next: Partial<Step<TId>>) => {
    setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, ...next } : s)));
  }, []);

  const reset = useCallback(() => setSteps(initial), [initial]);

  const run = useCallback(
    async <T,>(id: TId, fn: () => Promise<T>): Promise<T> => {
      patch(id, { status: 'loading', detail: undefined });
      try {
        const result = await fn();
        patch(id, { status: 'success' });
        return result;
      } catch (e) {
        patch(id, { status: 'error', detail: e instanceof Error ? e.message : String(e) });
        throw e;
      }
    },
    [patch],
  );

  const runAll = useCallback(async <T,>(fn: () => Promise<T>): Promise<{ ok: boolean; value?: T }> => {
    // Ref guard, not `busy`: a double-click lands before the state update
    // commits, so the second call would otherwise start a parallel pass.
    if (busyRef.current) return { ok: false };
    busyRef.current = true;
    setBusy(true);
    try {
      return { ok: true, value: await fn() };
    } catch {
      // The failing step already carries the message; the caller reads `steps`.
      return { ok: false };
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  return { steps, busy, run, patch, reset, runAll };
}
