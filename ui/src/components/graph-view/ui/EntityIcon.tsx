import { useLingui } from '@lingui/react/macro';
import type { APIEntity, AnyEntity } from '@sdk';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { glyphActionClassName } from '@src/components/entity-actions/action-button-styles';
import { WikiTip } from '@src/components/wiki-tip';
import { openExternal } from '@src/lib/open-external';
import { cn } from '@src/lib/utils';
import { Cloud, GitBranch, HardDrive, type LucideProps } from 'lucide-react';
import type { ComponentType, MouseEvent, ReactElement, ReactNode } from 'react';
import { iconForType } from '../icons/iconRegistry';
import { IconWithBadge } from '../icons/IconWithBadge';
import { subIconForEntity } from '../icons/subIconRegistry';

export type EntityIconDensity = 'default' | 'compact';

/**
 * Makes the location glyphs go to the location they name: cloud → the hub page,
 * local → the OS file browser, git → the repo. Git is simply the third location
 * an asset can live in, which is why it belongs here and not in an action bar.
 *
 * All opt-in per call site — a glyph without its prop stays the inert indicator
 * it has always been. Resolving an asset's repo costs a backend round-trip (see
 * `useAssetGitLink`), so lists must NOT pass `gitUrl`.
 */
export type EntityLocationLinkProps = {
  /** Browsable repo URL for this entity. Absent/null ⇒ no git glyph at all. */
  gitUrl?: string | null;
  /** Repo name for the tooltip, e.g. `owner/repo`. */
  gitLabel?: string | null;
  /** Hub page URL — makes the cloud glyph open the entity on the cloud. */
  cloudUrl?: string | null;
  /**
   * Reveals the asset in the OS file browser — makes the local glyph a button.
   * A callback, not a path: the reveal must go through the entity's OWN compute
   * node (`FSRef.open({select:true})`), which this shared icon has no way to know.
   */
  onRevealLocal?: () => void;
};

export type EntityIconProps = Omit<LucideProps, 'ref' | 'type' | 'size'> &
  EntityLocationLinkProps & {
    type: string;
    remote?: boolean;
    size?: number;
    density?: EntityIconDensity;
    containerClassName?: string;
    showLocationTooltip?: boolean;
  };

export type EntityIconWithSubProps = EntityLocationLinkProps & {
  entity: AnyEntity;
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

/** One location this entity can be reached at, and how to get there. */
type LocationSpec = {
  key: 'cloud' | 'local' | 'git';
  Icon: ComponentType<LucideProps>;
  className: string;
  label: string | undefined;
  showTooltip: boolean;
  onActivate?: () => void;
};

/** The wiki page that explains what these three glyphs mean. */
const LOCATION_WIKI_PAGE = 'Where your assets live';

/**
 * Heading slugs on that page, one per glyph. Deliberately NOT the bare glyph key:
 * the deep-link scroll matches a heading by slug across the whole document, so a
 * one-word slug like `git` would collide with any heading in the doc already open
 * behind the modal.
 */
const LOCATION_WIKI_FRAGMENT: Record<LocationSpec['key'], string> = {
  cloud: 'the-cloud-badge',
  local: 'the-local-badge',
  git: 'the-git-badge',
};

/**
 * Render one location glyph, with the tip it always has and the activation it
 * only sometimes has. `onActivate` absent ⇒ a plain, inert glyph under a plain
 * tooltip (what every list renders); present ⇒ a button that goes to that
 * location, under a WikiTip whose Learn-more explains the location itself. The
 * frame sits inside clickable rows, so activation must never also select the
 * entity.
 *
 * The tooltip/hover-card split is not cosmetic: a tooltip is `pointer-events:
 * none`, so a Learn-more inside one could never be clicked. It also keeps lists
 * cheap — they pass no link props, so they never build a hover card.
 *
 * A plain function, not a component: it holds no hooks, and every list row would
 * otherwise pay for an extra fiber per glyph.
 */
function locationGlyph(spec: LocationSpec, size: number): ReactElement {
  const { key, Icon, className, label, showTooltip, onActivate } = spec;
  const glyph = (
    <Icon key={key} size={size} className={cn('shrink-0', className)} data-location-glyph={key} aria-hidden="true" />
  );
  const body = onActivate ? (
    <button
      key={key}
      type="button"
      onClick={(e: MouseEvent<HTMLButtonElement>) => {
        e.preventDefault();
        e.stopPropagation();
        onActivate();
      }}
      aria-label={label}
      data-testid={`entity-icon-${key}-link`}
      className={glyphActionClassName}
    >
      {glyph}
    </button>
  ) : (
    glyph
  );
  if (!showTooltip || !label) return body;
  return onActivate ?
      <WikiTip
        key={key}
        wikiword={LOCATION_WIKI_PAGE}
        fragment={LOCATION_WIKI_FRAGMENT[key]}
        label={label}
        learnMore
      >
        {body}
      </WikiTip>
    : <Tooltip key={key}>
        <TooltipTrigger asChild>{body}</TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>;
}

function EntityIconFrame({
  remote,
  density,
  typeSize,
  containerClassName,
  showLocationTooltip,
  gitUrl,
  gitLabel,
  cloudUrl,
  onRevealLocal,
  ariaLabel,
  ariaHidden,
  children,
}: EntityLocationLinkProps & {
  remote: boolean | undefined;
  density: EntityIconDensity;
  typeSize: number;
  containerClassName?: string;
  showLocationTooltip: boolean;
  ariaLabel?: string;
  ariaHidden: boolean;
  children: ReactNode;
}): ReactElement {
  const { t } = useLingui();
  const location = entityLocation(remote);
  const locationSize = Math.max(8, typeSize - 4);
  const locationLabel = useEntityLocationLabel(remote);
  const compositeLabel = [ariaLabel, locationLabel].filter(Boolean).join(', ') || undefined;

  // One entry per location this entity can be reached at, listed in glyph order
  // so the order is the code's shape rather than an emergent property of
  // statement order. Cloud and local are two branches of the one `remote`
  // tri-state; git is an independent axis, hence the separate condition. The
  // `unknown` case contributes nothing, and "is anything activatable" falls out
  // of the list instead of being restated.
  const specs = [
    location === 'cloud' && {
      key: 'cloud',
      Icon: Cloud,
      className: 'text-cloud',
      label: cloudUrl ? t`On the cloud, click to open.` : locationLabel,
      showTooltip: showLocationTooltip,
      onActivate: cloudUrl ? () => openExternal(cloudUrl) : undefined,
    },
    location === 'local' && {
      key: 'local',
      Icon: HardDrive,
      className: 'text-muted-foreground',
      label: onRevealLocal ? t`Local file, click to reveal.` : locationLabel,
      showTooltip: showLocationTooltip,
      onActivate: onRevealLocal,
    },
    !!gitUrl && {
      key: 'git',
      Icon: GitBranch,
      className: 'text-muted-foreground',
      label: gitLabel ? t`In git (${gitLabel}), click to open.` : t`In git, click to open.`,
      showTooltip: showLocationTooltip,
      onActivate: () => openExternal(gitUrl),
    },
  ].filter(Boolean) as LocationSpec[];
  const interactive = specs.some((s) => s.onActivate);

  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center',
        density === 'compact' ? 'gap-0.5' : 'gap-1',
        containerClassName,
      )}
      data-entity-location={location}
      // `role="img"` would swallow the glyph buttons from the a11y tree, but the
      // frame still has to carry the entity's name — so it becomes a labelled
      // group instead of dropping its role (and its label) entirely.
      role={ariaHidden ? undefined : interactive ? 'group' : 'img'}
      aria-label={ariaHidden ? undefined : compositeLabel}
      aria-hidden={ariaHidden || undefined}
    >
      {specs.map((spec) => locationGlyph(spec, locationSize))}
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
  gitUrl,
  gitLabel,
  cloudUrl,
  onRevealLocal,
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
      gitUrl={gitUrl}
      gitLabel={gitLabel}
      cloudUrl={cloudUrl}
      onRevealLocal={onRevealLocal}
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
  gitUrl,
  gitLabel,
  cloudUrl,
  onRevealLocal,
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
      gitUrl={gitUrl}
      gitLabel={gitLabel}
      cloudUrl={cloudUrl}
      onRevealLocal={onRevealLocal}
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
