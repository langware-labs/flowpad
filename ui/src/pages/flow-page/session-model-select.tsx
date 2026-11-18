import { useMemo } from 'react';
import type { AgenticProcess } from '@sdk';

import { useLaunchingAgent } from '@src/hooks/use-launching-agent';
import { endpointOf, useLlmSources, workerOf } from '@src/components/llm-sources/use-llm-sources';
import { VibeModelSelect, normalizeVibeModelTier, type VibeModelChoice } from './vibe-model-select';

const SIZES = ['sm', 'md', 'lg'] as const;

/**
 * The sizes the budget funding `worker` offers, or `null` when that is not known.
 *
 * Only a hub budget declares sizes, and only down its chain: an empty map means the answer did not
 * reach this box (an older hub, no listing yet), not "offers nothing" -- so it holds nothing back, the
 * same fail-open rule the rest of the picker follows. The backend still refuses a size nobody declares.
 */
export function useAvailableSizes(worker: string | null | undefined): readonly string[] | null {
  const { status } = useLlmSources();
  return useMemo(() => {
    if (!status || !worker) return null;
    const kind = Object.keys(status.resolved ?? {}).find((k) => workerOf(k) === worker);
    const pick = kind ? status.resolved[kind] : null;
    const endpoint = pick ? endpointOf(status, pick) : null;
    // A device login's sizes refine the vendor CLI's own (claude names all three natively): the
    // backend settles an unset one, so the picker holds nothing back for it.
    if (endpoint?.kind === 'device') return null;
    const tiers = endpoint?.tiers ?? {};
    const offered = SIZES.filter((size) => !!tiers[size]);
    return offered.length ? offered : null;
  }, [status, worker]);
}

/**
 * The custom named models (`coding`, …) the endpoint funding `worker` declares beside its sizes —
 * any `tiers` key that is not a size (nor the embedding slot). A device login is an endpoint row
 * of its own, so its custom names come from the same place.
 */
export function useCustomModelNames(worker: string | null | undefined): string[] {
  const { status } = useLlmSources();
  return useMemo(() => {
    if (!status || !worker) return [];
    const kind = Object.keys(status.resolved ?? {}).find((k) => workerOf(k) === worker);
    const pick = kind ? status.resolved[kind] : null;
    const tiers: Record<string, string | null | undefined> = pick ? (endpointOf(status, pick)?.tiers ?? {}) : {};
    return Object.keys(tiers).filter(
      (name) => !!tiers[name] && !(SIZES as readonly string[]).includes(name) && name !== 'embedding',
    );
  }, [status, worker]);
}

/**
 * The model picker of a running session: what the agent that started it requires, and what the budget
 * it runs on offers. An agent that names a size pins it (the picker shows it and does not offer to
 * leave it, since another size would not be the agent); a size the budget does not offer is shown
 * but not pickable. An agent with no size, and a session with no agent, pick freely.
 */
export function SessionModelSelect({
  value,
  disabled,
  onChange,
  activeProcess,
  workerType,
}: {
  value: unknown;
  disabled?: boolean;
  onChange: (value: VibeModelChoice) => void | Promise<void>;
  activeProcess: AgenticProcess | null;
  workerType?: string | null;
}) {
  const agent = useLaunchingAgent(activeProcess);
  const worker = workerType ?? activeProcess?.worker_type ?? 'claude';
  const availableSizes = useAvailableSizes(worker);
  const customNames = useCustomModelNames(worker);
  const pinned = agent?.model ? normalizeVibeModelTier(agent.model) : null;
  return (
    <VibeModelSelect
      value={value}
      onChange={onChange}
      disabled={disabled}
      availableSizes={availableSizes}
      pinnedSize={pinned}
      customNames={customNames}
    />
  );
}
