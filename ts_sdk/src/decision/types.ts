/**
 * The wire shape of a decision — a hand-mirror of the Python specs in
 * `flow_sdk/schema/data_spec/decision_spec.py` (`decision.spec` / `decision.result`) and
 * `api_endpoint_spec.py` (`api_endpoint.offer`).
 *
 * No JSON-Schema-to-TypeScript codegen exists here, so `tests/unit/test_decision_ts_parity.py`
 * keeps the two halves in step: add a field there and here, or the mirror drifts.
 *
 * The words are ours, matched across Jev, OpenAI's announced Decisions API and plain English
 * (`state`, `choice` + `options`, `score` + `levels`, `yes_no`); a vendor's own words stop at
 * its backend dialect.
 */

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  /** option key -> what it means. The key is what comes back. At least 2. */
  options: Record<string, string>;
}

export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  /** An ordered scale, lowest first. 2–10 levels. */
  levels: string[];
}

export interface YesNoQuestion {
  type: 'yes_no';
  instructions: string;
}

export type Question = ChoiceQuestion | ScoreQuestion | YesNoQuestion;

/** What to decide: `state` plus 1–6 named questions (lower-case identifiers), in ONE request. */
export interface DecisionSpec {
  /** A string, object or list; questions refer to its fields by name in backticks. */
  state: unknown;
  questions: Record<string, Question>;
  /** Pin a model version when a tuned threshold must not drift. */
  model?: string | null;
}

export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface ScoreAnswer {
  type: 'score';
  /** Fractional position on the scale (0 = first level). */
  score: number;
  confidence: number;
  /** Keyed by the level's own text. */
  probabilities: Record<string, number>;
}

export interface YesNoAnswer {
  type: 'yes_no';
  /** Probability of yes. */
  probability: number;
}

export type Answer = ChoiceAnswer | ScoreAnswer | YesNoAnswer;

export interface DecisionUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface DecisionResult {
  answers: Record<string, Answer>;
  model: string;
  usage: DecisionUsage;
  latency_ms: number;
  /** The APIEndpoint that answered, as `api_endpoint-<id>`. */
  endpoint: string;
}

/** A hub APIEndpoint this user may call (`api_endpoint.offer`). */
export interface APIEndpointOffer {
  id: string;
  name: string;
  /** What the API is — `'decision'` marks a decision API. */
  kinds: string[];
  enabled: boolean;
  /** The vendor host it fronts (`api.typesafe.ai`). */
  host: string;
}

/** Why a decision could not be taken — one closed word to branch on. */
export type DecisionFailure = 'invalid_spec' | 'no_endpoint' | 'rate_limited' | 'unavailable' | 'auth' | 'bad_response';
