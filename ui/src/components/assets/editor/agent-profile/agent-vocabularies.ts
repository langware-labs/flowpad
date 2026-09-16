import { ComputeNodeSize, ComputeNodeSizeLabels, WorkerModelTier } from '@sdk';
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
 * Fold either worker vocabulary onto the DRIVER short-id so both spellings
 * compare equal. `claude` alone differs (`worker_type` is `claude_code`), and
 * comparing raw silently matches nothing for it. Mirrors `VENDORS` (vendors.py).
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

/** Cloud box sizes the hub deploys onto. CLOSED, unlike the lists above: the
 *  hub's `Agent.machine_size` is the `ComputeNodeSize` enum, so free text
 *  cannot be deployed. */
export const AGENT_MACHINE_SIZES = Object.values(ComputeNodeSize);

/** What an agent with no `machine_size` deploys onto — the hub's
 *  `DEFAULT_NODE_SIZE`. Shown as the selection so absent never reads as a
 *  different state from `sm`. */
export const AGENT_DEFAULT_MACHINE_SIZE = ComputeNodeSize.SMALL;

/**
 * The Deploy tab's own display text — `ComputeNodeSizeLabels` plus an
 * indicative hourly price. Owned HERE, not in the shared SDK entity: that
 * label is mirrored verbatim into the hub's own vendored SDK copy
 * (`flowpad/ui/sdk/src/entities/compute-node/machine-status.ts`) and read by
 * an unrelated hub surface, so a price baked in there ships stale the moment
 * E2B's rate changes, with no build step to catch it. This component is the
 * only place that wants a price at all.
 *
 * Prices are E2B usage rates ($0.000014/vCPU-s, $0.0000045/GiB-s —
 * $0.0504/vCPU-hr, $0.0162/GiB-hr) x1.7, precomputed: sm $0.1332 -> $0.2264,
 * md $0.2340 -> $0.3978, lg $0.4680 -> $0.7956 per hour.
 */
const MACHINE_SIZE_HOURLY_PRICE: Record<ComputeNodeSize, string> = {
  [ComputeNodeSize.SMALL]: '$0.226/hr',
  [ComputeNodeSize.MEDIUM]: '$0.398/hr',
  [ComputeNodeSize.LARGE]: '$0.796/hr',
};

export const AGENT_MACHINE_SIZE_LABELS: Record<ComputeNodeSize, string> = Object.fromEntries(
  AGENT_MACHINE_SIZES.map((size) => [size, `${ComputeNodeSizeLabels[size]} · ${MACHINE_SIZE_HOURLY_PRICE[size]}`]),
) as Record<ComputeNodeSize, string>;
