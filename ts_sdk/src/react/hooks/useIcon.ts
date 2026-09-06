import { useMemo } from 'react';
import { useIconPacks } from './useIconPacks';
import { resolveIcon } from '../../icons/resolve';
import { withRole } from '../../icons/element';
import { flowIconComponent, type FlowIconComponent } from '../FlowIcon';
import type { IconResolution } from '../../icons/types';

/**
 * The resolution behind an icon tag.
 *
 * `FlowIcon` is what you render; this is for the callers that need to KNOW
 * something — a picker listing what resolved, a diagnostic showing which pack
 * answered, a surface that must behave differently when an icon is missing or
 * when best-match degraded the request. Returning the resolution is the hook's
 * whole reason to exist; rendering is the component's job.
 */
export interface UseIconOptions {
  /** A role appended as one more tag segment: `restore`. */
  role?: string;
  /** An ad-hoc sub-icon tag to badge on, overriding `IconSpec.sub`. */
  badge?: string;
}

export interface UseIconResult {
  /** The resolution — switch on `.kind`. */
  icon: IconResolution;
  /** True when nothing in the loaded packs claims the tag. */
  missing: boolean;
  /** True when best-match answered with an ancestor: the role does not exist. */
  degraded: boolean;
  /** The component for this tag, if you would rather render than inspect. */
  Icon: FlowIconComponent;
}

export function useIcon(ref: string | null | undefined, opts: UseIconOptions = {}): UseIconResult {
  const packs = useIconPacks();
  const { role, badge } = opts;
  const tag = withRole(ref, role) || '';

  const icon = useMemo(() => {
    const base = resolveIcon(tag, packs);
    if (!badge || (base.kind !== 'asset' && base.kind !== 'bundle')) return base;
    const sub = resolveIcon(badge, packs, false);
    return sub.kind === 'none' ? base : { ...base, badge: sub };
  }, [tag, badge, packs]);

  return {
    icon,
    missing: icon.kind === 'none',
    degraded: (icon.kind === 'asset' || icon.kind === 'bundle') && icon.degraded,
    Icon: flowIconComponent(tag),
  };
}

export default useIcon;
