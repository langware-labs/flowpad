import type { AgentPlace } from '@sdk';
import { Trans } from '@lingui/react/macro';
import { useId } from 'react';

import { isMove, runsOnKey, type RunsOn } from './runs-on';
import { usePlaceBadge } from './use-place-display';

export { isMove, runsOnKey, runsOnOf, type RunsOn } from './runs-on';

const HUB = 'hub';
const LOCAL = 'local';

interface RunsOnPickerProps {
  value: RunsOn;
  onChange: (value: RunsOn) => void;
  /** The agent's places; each cloud machine is a choice. */
  places: AgentPlace[];
  /** Flowpad cloud runs only an agent with a prompt (what the hub validates). */
  cloudAllowed: boolean;
  /** The saved place, when editing — a change across stores is said to be a move. */
  saved?: RunsOn | null;
  disabled?: boolean;
}

export function RunsOnPicker({ value, onChange, places, cloudAllowed, saved, disabled }: RunsOnPickerProps) {
  const badge = usePlaceBadge(places);
  const id = useId();
  const local = places.find((p) => p.is_local);
  const machines = places.filter((p) => !p.is_local);
  const pick = (key: string) => {
    if (key === HUB) return onChange({ kind: 'hub' });
    if (key.startsWith('deployment:'))
      return onChange({ kind: 'cloud_machine', deploymentId: key.slice('deployment:'.length) });
    onChange({ kind: 'local', deploymentId: local?.deployment.id ?? null });
  };
  return (
    <div className="flex flex-col gap-1" data-testid="runs-on">
      <label className="text-[11px] font-medium text-muted-foreground" htmlFor={id}>
        <Trans>Runs on</Trans>
      </label>
      <select
        id={id}
        value={runsOnKey(value)}
        onChange={(e) => pick(e.target.value)}
        disabled={disabled}
        data-testid="runs-on-picker"
        className="h-7 rounded border bg-background px-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
      >
        <option value={LOCAL}>{badge({ kind: 'local' }).label}</option>
        {machines.map((p) => (
          <option key={p.deployment.id} value={`deployment:${p.deployment.id}`}>
            {badge({ kind: 'cloud_machine', deployment_id: p.deployment.id }).label}
          </option>
        ))}
        {(cloudAllowed || value.kind === 'hub') && <option value={HUB}>{badge({ kind: 'hub' }).label}</option>}
      </select>
      {!cloudAllowed && value.kind !== 'hub' && (
        <p className="text-[11px] text-muted-foreground" data-testid="runs-on-cloud-hint">
          <Trans>Flowpad cloud can run a schedule that runs an agent with a prompt.</Trans>
        </p>
      )}
      {saved && isMove(saved, value) && (
        <p className="text-[11px] text-amber-600 dark:text-amber-400" data-testid="runs-on-move">
          <Trans>Saving moves this schedule: it is deleted where it runs now and created on the new place.</Trans>
        </p>
      )}
    </div>
  );
}
