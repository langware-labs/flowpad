/**
 * The eval contract — a mirror of `flow_sdk/schema/data_spec/eval_spec.py` (`eval.run`,
 * `eval.example`), kept in step by `tests/unit/test_eval_ts_parity.py`.
 *
 * A dataset is evaluated by its own eval; every run is an `EvalRun` with one `ExampleEval` per
 * example. Same shapes for every dataset, so one browser reads them all.
 */

export type Verdict = 'correct' | 'wrong' | 'abstained' | 'error';
export const VERDICTS: readonly Verdict[] = ['correct', 'abstained', 'wrong', 'error'];

/** One example, evaluated. */
export interface ExampleEval {
  example_id: string;
  /** What the inference answered, as the dataset's output kind. */
  prediction: unknown;
  golds: unknown[];
  verdict: Verdict;
  score: number | null;
  latency_ms: number;
  error: string | null;
  /** Eval-defined tags (`feasible=no`, `did=/dock/x`). */
  labels: Record<string, string>;
  /** The example's value at each of the eval's slice paths. */
  slice: Record<string, string>;
  title: string;
}

/** An `ExampleEval` joined to its example (what `GET dataset/<id>/eval/<run>` answers). */
export interface EvalExampleRow extends ExampleEval {
  row_input?: unknown;
  row_context?: unknown;
  row_data?: Record<string, unknown>;
  row_kind?: string;
}

/** Per-value stats of one slice: verdict counts + the eval's metrics. */
export type EvalSliceStats = { examples: number } & Partial<Record<Verdict, number>> & Record<string, number | null>;

/** One run of an eval over a dataset. `slices` is absent in a run LIST (summaries). */
export interface EvalRun {
  run_id: string;
  dataset_id: string;
  dataset_title: string;
  dataset_spec: string;
  eval_name: string;
  eval_digest: string;
  versions: Record<string, string>;
  started_at: string;
  finished_at: string;
  examples: number;
  counts: Partial<Record<Verdict | 'unlabelled', number>>;
  /** A count is an integer, a ratio a fraction (0..1). */
  metrics: Record<string, number | null>;
  slices?: Record<string, Record<string, EvalSliceStats>>;
}
