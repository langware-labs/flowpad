/**
 * The wire shape of an activity — a hand-mirror of the Python `ActivityProgressSpec`
 * (`flow_sdk/schema/data_spec/activity_spec.py`).
 *
 * There is no JSON-Schema-to-TypeScript codegen in this repo, so the two halves are kept
 * in step by a test rather than by a build step: `ui/tests/api/activity_fe_contract.test.ts`
 * drives an activity through this client against a live backend and asserts every field
 * survives. If you add a field here, add it there, or the mirror drifts silently.
 */

/** Terminal states are sticky — the backend drops any mutation that arrives after one. */
export type ActivityState =
  | 'pending'
  | 'running'
  | 'paused'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled'
  /** Assigned by the system, never a producer: work that stopped rather than finished. */
  | 'interrupted';

export const TERMINAL_STATES: ReadonlySet<ActivityState> = new Set<ActivityState>([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

export interface ActivityError {
  message: string;
  /** What the error is ABOUT — a path, a TypeId. Not where it was raised. */
  ref?: string | null;
  code?: string | null;
  ts?: string | null;
}

export interface ActivityProgressSpec {
  activity_id: string;
  /** TypeId this activity belongs to; `null` means it belongs to the instance. */
  scope?: string | null;
  /** Address within the scope: `index`, `index/pdf`, `qa.cycle`. */
  path: string;
  name: string;
  label?: string | null;
  /** A lucide export name or a backend-served path — whatever `lucideByName` resolves. */
  icon?: string | null;

  state: ActivityState;
  /** What is in hand right now. */
  current?: string | null;
  message?: string | null;

  done: number;
  /** `null` means UNKNOWN, and unknown is not zero. Render a bare count, never 0%. */
  total?: number | null;
  /** A subset of `done`: work passed over rather than performed. */
  skipped: number;
  /** The truth. `errors` is only a capped sample of it. */
  errors_count: number;
  errors: ActivityError[];
  counters: Record<string, number>;
  children: ActivityProgressSpec[];

  started_at?: string | null;
  updated_at?: string | null;
  finished_at?: string | null;
  /** Monotonic per root. Drop any snapshot whose seq is not GREATER than the one held. */
  seq: number;
}

export function isTerminal(spec: ActivityProgressSpec): boolean {
  return TERMINAL_STATES.has(spec.state);
}

/**
 * Completed share in [0, 1], or `null` when genuinely unknowable.
 *
 * Own total wins; failing that, children that have totals are rolled up so a parent that
 * only orchestrates still shows a bar; failing that `null`, and the caller renders a
 * count. Never a fabricated 0 — that is the bug this whole shape exists to fix.
 */
export function fraction(spec: ActivityProgressSpec): number | null {
  if (spec.total) return Math.min(spec.done / spec.total, 1);
  const known = spec.children.filter((c) => c.total);
  if (known.length === 0) return null;
  const total = known.reduce((sum, c) => sum + (c.total ?? 0), 0);
  if (!total) return null;
  return Math.min(known.reduce((sum, c) => sum + c.done, 0) / total, 1);
}
