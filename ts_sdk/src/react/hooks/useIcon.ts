import { useCallback, useEffect, useMemo, useState } from 'react';
import { getIconPacks, onIconPacksChanged } from '../../icons/registry';
import { resolveIcon } from '../../icons/resolve';
import { ensureIconStyles, iconChip, iconElementFor, type IconChipOptions } from '../../icons/element';
import type { IconResolution } from '../../icons/types';

/**
 * The single React entry point for icons.
 *
 * It answers with the RESOLUTION, not a component, and that is deliberate:
 * different surfaces draw the same icon differently — a lucide bundle name
 * becomes a `<Lucide… />` element in the app, a `<span>` mask on a plain page —
 * and a hook that returned one fixed element would force every caller through
 * whichever choice it made. `kind` tells the caller which case it has; `mount`
 * is there for callers that just want the DOM.
 *
 * There is no `theme` option. Theme is CSS (see `ICON_CSS`), which is what lets
 * the same icon work in the un-stamped "system" state where JS has nothing to
 * read.
 */
export interface UseIconOptions extends IconChipOptions {
  /** The chip's text. Required only by `mountChip`. */
  label?: string;
  /**
   * A sub-icon to badge onto this one, as a ref — `lucide:history`.
   *
   * The declared way is `IconSpec.sub`, which every surface then gets for free;
   * this is the ad-hoc form, for a badge that belongs to one surface rather
   * than to the icon. Passing it overrides whatever the spec declares.
   */
  badge?: string;
}

export interface UseIconResult {
  /** The resolution — switch on `.kind`. */
  icon: IconResolution;
  /** True when nothing in the loaded packs claims the reference. */
  missing: boolean;
  /** Render into a container, for callers that want the DOM built for them. */
  mount: (el: HTMLElement | null) => void;
  /** Render as a labelled chip — the treatment a row is recognised by. Pass the
   *  text as the `label` option; a ref callback has to be stable, and one built
   *  per render tears the chip down and rebuilds it every time. */
  mountChip: (el: HTMLElement | null) => void;
}

export function useIcon(ref: string | null | undefined, opts: UseIconOptions = {}): UseIconResult {
  const [, bump] = useState(0);
  useEffect(() => onIconPacksChanged(() => bump((v) => v + 1)), []);

  const { variant, className, title, color, compact, badge, label } = opts;
  const full = ref && variant ? `${ref}@${variant}` : ref;

  const icon = useMemo(() => {
    const packs = getIconPacks();
    const base = resolveIcon(full, packs);
    if (!badge || (base.kind !== 'asset' && base.kind !== 'bundle')) return base;
    const sub = resolveIcon(badge, packs, false);
    return sub.kind === 'none' ? base : { ...base, badge: sub };
  }, [full, badge]);

  const mount = useCallback(
    (el: HTMLElement | null) => {
      if (!el) return;
      ensureIconStyles(el.ownerDocument);
      el.replaceChildren(iconElementFor(icon, { className, title, color, doc: el.ownerDocument }));
    },
    [icon, className, title, color],
  );

  const mountChip = useCallback(
    (el: HTMLElement | null) => {
      if (!el) return;
      el.replaceChildren(
        iconChip(full, label ?? '', getIconPacks(), { className, title, color, compact, doc: el.ownerDocument }),
      );
    },
    [full, label, className, title, color, compact],
  );

  return { icon, missing: icon.kind === 'none', mount, mountChip };
}

export default useIcon;
