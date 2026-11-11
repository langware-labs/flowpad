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

/**
 * The hourly machines' display text — `ComputeNodeSizeLabels` plus an
 * indicative hourly price, shown by the Deploy tab and the New sandbox dialog.
 * Owned HERE, not in the shared SDK entity: that label is mirrored verbatim
 * into the hub's own SDK copy and read by an unrelated hub surface, so a price
 * baked in there would ship stale with no build step to catch it.
 *
 * Prices are E2B usage rates ($0.0504/vCPU-hr, $0.0162/GiB-hr) x1.7 over the
 * hub's E2B sizes (sm 2 vCPU/2 GiB, md 2/4, lg 4/8) — change both together.
 */
const MACHINE_SIZE_HOURLY_PRICE: Record<ComputeNodeSize, string> = {
  [ComputeNodeSize.SMALL]: '$0.226/hr',
  [ComputeNodeSize.MEDIUM]: '$0.282/hr',
  [ComputeNodeSize.LARGE]: '$0.563/hr',
};

export const AGENT_MACHINE_SIZE_LABELS: Record<ComputeNodeSize, string> = Object.fromEntries(
  AGENT_MACHINE_SIZES.map((size) => [size, `${ComputeNodeSizeLabels[size]} · ${MACHINE_SIZE_HOURLY_PRICE[size]}`]),
) as Record<ComputeNodeSize, string>;

/** How a cloud machine bills: by the hour while it runs, or by the month, always on. */
export type MachineBilling = 'hourly' | 'monthly';

/** The price of one size, on its own, for the New deployment wizard. Same sources as the labels above. */
export const MACHINE_SIZE_PRICE: Record<MachineBilling, Record<ComputeNodeSize, string>> = {
  hourly: {
    [ComputeNodeSize.SMALL]: '$0.23 / hour',
    [ComputeNodeSize.MEDIUM]: '$0.28 / hour',
    [ComputeNodeSize.LARGE]: '$0.56 / hour',
  },
  monthly: {
    [ComputeNodeSize.SMALL]: '$21 / month',
    [ComputeNodeSize.MEDIUM]: '$42 / month',
    [ComputeNodeSize.LARGE]: '$336 / month',
  },
};

/** A size's strength, for its tooltip: what the hub creates per billing (change with the hub). */
export const MACHINE_SIZE_SPECS: Record<MachineBilling, Record<ComputeNodeSize, string>> = {
  hourly: {
    [ComputeNodeSize.SMALL]: '2 CPU · 2 GB',
    [ComputeNodeSize.MEDIUM]: '2 CPU · 4 GB',
    [ComputeNodeSize.LARGE]: '4 CPU · 8 GB',
  },
  monthly: {
    [ComputeNodeSize.SMALL]: '2 CPU · 2 GB',
    [ComputeNodeSize.MEDIUM]: '2 CPU · 4 GB',
    [ComputeNodeSize.LARGE]: '8 CPU · 32 GB',
  },
};
