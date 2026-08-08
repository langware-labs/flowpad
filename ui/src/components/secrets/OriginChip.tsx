import { useLingui } from '@lingui/react/macro';
import { Badge } from '@src/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { cn } from '@src/lib/utils';
import { KeyRound } from 'lucide-react';
import React from 'react';

import { OAUTH_ORIGIN_KIND } from '@src/components/secrets/secret-origin-kinds';

/**
 * Origin kind → label. A hook rather than a `Record<string,string>` because a
 * module-level string map is invisible to lingui extraction (same reason the
 * credentials tab labels live inside their component).
 *
 * The fallthrough returns the raw kind. That is what lets a kind the backend
 * grows after this build shipped render as itself instead of as a blank.
 */
export function useSecretOriginLabel(): (kind: string) => string {
  const { t } = useLingui();
  return (kind: string): string => {
    switch (kind) {
      case 'local':
        return t`Encrypted keychain`;
      case 'env-local':
        return t`Project .env.local`;
      case 'flowpad-hub':
        return t`Flowpad Hub`;
      case 'gcp':
        return t`Google Secret Manager`;
      case '1password':
        return t`1Password`;
      case OAUTH_ORIGIN_KIND:
        return t`OAuth connection`;
      default:
        return kind;
    }
  };
}

interface OriginChipProps {
  kind: string;
  /** The locator's primary coordinate, when there is one worth showing. */
  coordinate?: string;
  /** Extra note appended in muted text, e.g. "user-set" for an undeclared var. */
  qualifier?: string;
  /** Full locator, shown in the tooltip. Never carries a value. */
  locator?: Record<string, unknown>;
  className?: string;
}

/**
 * The Origin column's chip. One fixed glyph for every kind: origin kinds are not
 * entity types, so `iconForType()` does not apply here and a per-kind icon table
 * would be exactly the hardcoding that rule exists to prevent.
 */
export const OriginChip: React.FC<OriginChipProps> = ({
  kind,
  coordinate,
  qualifier,
  locator,
  className,
}) => {
  const label = useSecretOriginLabel()(kind);
  const hasLocator = !!locator && Object.keys(locator).length > 0;

  const chip = (
    <Badge
      variant="secondary"
      className={cn('max-w-full gap-1 whitespace-nowrap font-normal', className)}
      // Only when there is no Radix tooltip below — two hover affordances on one
      // element show two different texts at once.
      title={hasLocator ? undefined : coordinate ? `${label} · ${coordinate}` : label}
      data-testid={`origin-chip-${kind}`}
    >
      <KeyRound className="h-3 w-3 shrink-0 opacity-70" />
      <span className="truncate">{label}</span>
      {coordinate && <span className="truncate font-mono text-[10px] opacity-70">{coordinate}</span>}
      {qualifier && <span className="shrink-0 text-[10px] opacity-70">{qualifier}</span>}
    </Badge>
  );

  if (!hasLocator) return chip;

  return (
    <TooltipProvider>
      <Tooltip>
        {/* A span, not `asChild` on the Badge: Badge is a plain function
            component, so Radix cannot attach its trigger ref to it. */}
        <TooltipTrigger asChild>
          <span className="inline-flex">{chip}</span>
        </TooltipTrigger>
        <TooltipContent side="top">
          <pre className="max-w-xs whitespace-pre-wrap font-mono text-[11px]">
            {JSON.stringify(locator, null, 2)}
          </pre>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};
