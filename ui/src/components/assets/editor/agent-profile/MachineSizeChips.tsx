import { ComputeNodeSize, type Agent } from '@sdk';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';

import { cn } from '@src/lib/utils';

import { AGENT_MACHINE_SIZES, MACHINE_SIZE_PRICE, MACHINE_SIZE_SPECS } from './agent-vocabularies';

/** A size's plain name. */
export const machineSizeName: Record<ComputeNodeSize, MessageDescriptor> = {
  [ComputeNodeSize.SMALL]: msg`Small`,
  [ComputeNodeSize.MEDIUM]: msg`Medium`,
  [ComputeNodeSize.LARGE]: msg`Large`,
};

/** The size a new invite code starts at: the agent's own, else Small. */
export const defaultInviteSize = (agent: Agent): ComputeNodeSize =>
  (agent.machine_size as ComputeNodeSize | undefined) || ComputeNodeSize.SMALL;

/** "Small · 2 CPU · 2 GB · $0.23 / hour": what an invite machine of this size is and costs (hourly sandboxes). */
export function useMachineSizeLine() {
  const { t } = useLingui();
  return (size: ComputeNodeSize) =>
    `${t(machineSizeName[size])} · ${MACHINE_SIZE_SPECS.hourly[size]} · ${MACHINE_SIZE_PRICE.hourly[size]}`;
}

interface MachineSizeChipsProps {
  value: ComputeNodeSize;
  onChange: (size: ComputeNodeSize) => void;
  disabled?: boolean;
}

/** Small · Medium · Large for the machine an invite code opens, with the picked one's specs and price. */
export function MachineSizeChips({ value, onChange, disabled }: MachineSizeChipsProps) {
  const { t } = useLingui();
  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-1" role="radiogroup" aria-label={t`Machine size`}>
        {AGENT_MACHINE_SIZES.map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={value === s}
            disabled={disabled}
            title={MACHINE_SIZE_SPECS.hourly[s]}
            className={cn(
              'rounded-md border px-2 py-0.5 text-xs transition-colors',
              value === s ? 'border-primary bg-primary/5' : 'text-muted-foreground hover:bg-muted/60',
            )}
            onClick={() => onChange(s)}
            data-testid={`invite-size-${s}`}
          >
            {t(machineSizeName[s])}
          </button>
        ))}
      </div>
      <span className="text-xs text-muted-foreground" data-testid="invite-size-line">
        {MACHINE_SIZE_SPECS.hourly[value]} · {MACHINE_SIZE_PRICE.hourly[value]}
      </span>
    </div>
  );
}
