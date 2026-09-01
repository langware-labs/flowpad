import { WorkerModelTier } from '@sdk';
import { WORKER_TYPES } from '@src/hooks/useWorkerHistory';

/**
 * Option vocabularies for the agent profile editor.
 *
 * These live here rather than being read from the schema because the backend
 * fields are plain `Optional[str]` with no `Literal`/`Enum`
 * (`flow_sdk/builtin/agent.py`), so the bootstrap `TypeInfo.schema` carries no
 * `enum` to drive a form. Curated here, deliberately, until the backend types
 * are tightened.
 *
 * Every list is ADVISORY: the fields also accept free text, because `model` in
 * particular may be a concrete id rather than a tier.
 */

/**
 * The DRIVER short-ids an `agent.md` declares.
 *
 * NOT `AgentConfig.WorkerType` (`claude_code`, `pydantic_ai`, …) — that is the
 * vocabulary `AgenticProcess.worker_type` stores. The two are mapped by
 * `driver_key()` / `worker_type_value()` in `flow_sdk/builtin/agent.py`, and
 * feeding one where the other belongs is a bug that has already shipped once.
 */
export const AGENT_WORKER_TYPES = WORKER_TYPES;

/**
 * Fold either worker vocabulary onto the DRIVER short-id, so two spellings of
 * the same vendor compare equal.
 *
 * `claude` is the only vendor whose two names differ (`worker_type` is
 * `claude_code`); the other three spell both the same. Anything that compares a
 * value from `agent.md` against a value from a capability kind, an
 * `AgenticProcess` row, or a `--worker` flag has to fold first — comparing them
 * raw silently matches nothing for Claude, which is the failure the note above
 * calls "a bug that has already shipped once".
 *
 * Mirrors `VENDORS` in `flow_sdk/flowpad_types/vendors.py` (`key` vs
 * `worker_type`) and the same normalization in `ts_sdk` `cli_workers/factory`.
 */
export function toDriverKey(worker: string | null | undefined): string {
  const value = (worker ?? '').trim();
  return value === 'claude_code' ? 'claude' : value;
}

/** Size tiers. `Agent.model` also accepts a concrete model id, so this is a
 *  suggestion list, not a constraint. */
export const AGENT_MODEL_TIERS = Object.values(WorkerModelTier);

/** The two modes the terminal toolbar already exposes. */
export const AGENT_PERMISSION_MODES = ['bypassPermissions', 'askUser'] as const;

export const AGENT_EFFORTS = ['low', 'medium', 'high'] as const;
