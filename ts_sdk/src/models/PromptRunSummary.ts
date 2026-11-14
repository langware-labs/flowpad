/**
 * What the host's machine did to answer a prompt request — the TS mirror of
 * `flow_sdk/schema/data_spec/prompt_run_summary_spec.py`. Rides the reply as a
 * `prompt_run_summary-<completion id>` attachment, a value in its `prompt_preview`:
 * the tools the run used and the files it touched, never their input, output or content.
 */
export const PROMPT_RUN_SUMMARY_TYPE = 'prompt_run_summary';

export interface PromptRunStep {
  tool: string;
  /** Relative to the folder the run ran in. */
  path?: string | null;
}

export interface PromptRunSummary {
  steps?: PromptRunStep[];
  /** Files the run wrote or edited, each once. */
  files_touched?: string[];
  /** Steps that are not listed. */
  more?: number;
}
