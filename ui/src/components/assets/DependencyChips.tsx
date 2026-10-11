import React from 'react';
import { Cloud, Folder, GitBranch } from 'lucide-react';
import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { DependencyState, DependencyStateName } from '@sdk';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';

const STATE_LABEL: Record<DependencyStateName, MessageDescriptor> = {
  ready: msg`ready`,
  missing: msg`missing`,
  unreachable: msg`unreachable`,
  not_installed: msg`not installed`,
  invalid: msg`invalid`,
  not_found: msg`not found`,
};

/** The translated word for a dependency's state. */
export function dependencyStateLabel(state: DependencyStateName): string {
  return i18n._(STATE_LABEL[state] ?? msg`unknown`);
}

/** The icon for where a dependency comes from — git, the hub, or a folder. */
export function dependencySourceIcon(source: string): React.ComponentType<{ className?: string }> {
  if (source.startsWith('git+')) return GitBranch;
  if (source.startsWith('hub:')) return Cloud;
  return Folder;
}

const STATE_TONE: Record<DependencyStateName, string> = {
  ready: 'border-border text-muted-foreground',
  not_installed: 'border-border text-muted-foreground',
  // Problems are a tinted chip with a coloured border; the text stays foreground.
  missing: 'border-amber-500/60 bg-amber-500/10 text-foreground',
  unreachable: 'border-amber-500/60 bg-amber-500/10 text-foreground',
  invalid: 'border-destructive/60 bg-destructive/10 text-foreground',
  not_found: 'border-destructive/60 bg-destructive/10 text-foreground',
};

const CHIP = 'inline-flex shrink-0 items-center rounded-full border px-1.5 py-px text-[10px] leading-tight';

/** The dependency's state as a small chip; the reason (when the backend gave
 *  one) shows on hover. */
export function DependencyStateChip({ dependency }: { dependency: Pick<DependencyState, 'state' | 'reason'> }) {
  const chip = (
    <span className={`${CHIP} ${STATE_TONE[dependency.state] ?? ''}`} data-testid="dependency-state" data-state={dependency.state}>
      {dependencyStateLabel(dependency.state)}
    </span>
  );
  if (!dependency.reason) return chip;
  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      <TooltipContent side="top" className="max-w-[280px] text-xs">
        {dependency.reason}
      </TooltipContent>
    </Tooltip>
  );
}

/** Required / Optional, as a small chip. */
export function DependencyKindChip({ required }: { required: boolean }) {
  return (
    <span className={`${CHIP} border-border text-muted-foreground`} data-testid="dependency-kind">
      {required ? i18n._(msg`required`) : i18n._(msg`optional`)}
    </span>
  );
}

const DOT_TONE: Record<DependencyStateName, string> = {
  ready: 'bg-emerald-500',
  not_installed: 'bg-muted-foreground/50',
  missing: 'bg-amber-500',
  unreachable: 'bg-amber-500',
  invalid: 'bg-destructive',
  not_found: 'bg-destructive',
};

/** The state as a small coloured dot, for rows too narrow for chips (the Assets
 *  tree). It carries no tooltip of its own: the row's tooltip says the state,
 *  the kind and the reason, so the dot never races it. */
export function DependencyStateDot({ dependency }: { dependency: Pick<DependencyState, 'state' | 'required'> }) {
  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${DOT_TONE[dependency.state] ?? 'bg-muted-foreground/50'}`}
      aria-label={dependencyStateLabel(dependency.state)}
      role="img"
      data-testid="dependency-state"
      data-state={dependency.state}
      data-required={dependency.required ? 'true' : 'false'}
    />
  );
}
