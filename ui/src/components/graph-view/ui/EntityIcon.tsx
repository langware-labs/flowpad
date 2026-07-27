import { useLingui } from '@lingui/react/macro';
import type { APIEntity } from '@sdk';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { cn } from '@src/lib/utils';
import { Cloud, HardDrive, type LucideProps } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import { iconForType } from '../icons/iconRegistry';
import { IconWithBadge } from '../icons/IconWithBadge';
import { subIconForEntity } from '../icons/subIconRegistry';

export type EntityIconDensity = 'default' | 'compact';

export type EntityIconProps = Omit<LucideProps, 'ref' | 'type' | 'size'> & {
  type: string;
  remote?: boolean;
  size?: number;
  density?: EntityIconDensity;
  containerClassName?: string;
  showLocationTooltip?: boolean;
};

export type EntityIconWithSubProps = {
  entity: APIEntity<any>;
  density?: EntityIconDensity;
  containerClassName?: string;
  typeStackClassName?: string;
  showLocationTooltip?: boolean;
  'aria-label'?: string;
};

type EntityLocation = 'cloud' | 'local' | 'unknown';

function entityLocation(remote: boolean | undefined): EntityLocation {
  if (remote === true) return 'cloud';
  if (remote === false) return 'local';
  return 'unknown';
}

export function useEntityLocationLabel(remote: boolean | undefined): string | undefined {
  const { t } = useLingui();
  if (remote === true) return t`Available on cloud`;
  if (remote === false) return t`Local only`;
  return undefined;
}

function isAriaHidden(value: LucideProps['aria-hidden']): boolean {
  return value === true || value === 'true';
}

function EntityIconFrame({
  remote,
  density,
  typeSize,
  containerClassName,
  showLocationTooltip,
  ariaLabel,
  ariaHidden,
  children,
}: {
  remote: boolean | undefined;
  density: EntityIconDensity;
  typeSize: number;
  containerClassName?: string;
  showLocationTooltip: boolean;
  ariaLabel?: string;
  ariaHidden: boolean;
  children: ReactNode;
}): ReactElement {
  const location = entityLocation(remote);
  const locationSize = Math.max(8, typeSize - 4);
  const locationLabel = useEntityLocationLabel(remote);
  const compositeLabel = [ariaLabel, locationLabel].filter(Boolean).join(', ') || undefined;

  const locationGlyph =
    location === 'unknown' ? null : location === 'cloud' ? (
      <Cloud
        size={locationSize}
        className="shrink-0 text-cloud"
        data-location-glyph="cloud"
        aria-hidden="true"
      />
    ) : (
      <HardDrive
        size={locationSize}
        className="shrink-0 text-muted-foreground"
        data-location-glyph="local"
        aria-hidden="true"
      />
    );

  const locationNode =
    locationGlyph && showLocationTooltip ? (
      <Tooltip>
        <TooltipTrigger asChild>{locationGlyph}</TooltipTrigger>
        <TooltipContent>{locationLabel}</TooltipContent>
      </Tooltip>
    ) : (
      locationGlyph
    );

  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center',
        density === 'compact' ? 'gap-0.5' : 'gap-1',
        containerClassName,
      )}
      data-entity-location={location}
      role={ariaHidden ? undefined : 'img'}
      aria-label={ariaHidden ? undefined : compositeLabel}
      aria-hidden={ariaHidden || undefined}
    >
      {locationNode}
      {children}
    </span>
  );
}

export function EntityIcon({
  type,
  remote,
  size,
  density = 'default',
  containerClassName,
  showLocationTooltip = true,
  className,
  color,
  'aria-label': ariaLabel,
  'aria-hidden': ariaHiddenValue,
  ...iconProps
}: EntityIconProps): ReactElement {
  const Icon = iconForType(type);
  const typeSize = size ?? (density === 'compact' ? 14 : 16);
  const ariaHidden = isAriaHidden(ariaHiddenValue);

  return (
    <EntityIconFrame
      remote={remote}
      density={density}
      typeSize={typeSize}
      containerClassName={containerClassName}
      showLocationTooltip={showLocationTooltip}
      ariaLabel={ariaLabel}
      ariaHidden={ariaHidden}
    >
      <Icon
        {...iconProps}
        size={typeSize}
        color={remote === true ? 'currentColor' : color}
        className={cn(className, remote === true && 'text-cloud')}
        data-entity-type-icon
        aria-hidden="true"
      />
    </EntityIconFrame>
  );
}

/**
 * Entity icon with its per-instance sub-icon badge (when the type has a selector
 * — see {@link subIconForEntity}). Requires the entity INSTANCE (not just a type
 * string). Degrades to a plain base icon when there's no sub-icon.
 */
export function EntityIconWithSub({
  entity,
  density = 'default',
  containerClassName,
  typeStackClassName,
  showLocationTooltip = true,
  'aria-label': ariaLabel,
}: EntityIconWithSubProps): ReactElement {
  const typeSize = density === 'compact' ? 14 : 16;

  return (
    <EntityIconFrame
      remote={entity.remote}
      density={density}
      typeSize={typeSize}
      containerClassName={containerClassName}
      showLocationTooltip={showLocationTooltip}
      ariaLabel={ariaLabel}
      ariaHidden={false}
    >
      <span data-entity-type-icon aria-hidden="true">
        <IconWithBadge
          Base={iconForType(entity.getType())}
          Badge={subIconForEntity(entity)}
          className={cn(density === 'compact' ? 'h-3.5 w-3.5' : 'h-4 w-4', typeStackClassName)}
          baseClassName={entity.remote === true ? 'text-cloud' : undefined}
        />
      </span>
    </EntityIconFrame>
  );
}
