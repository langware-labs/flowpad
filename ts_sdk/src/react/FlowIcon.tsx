import { createElement, useEffect, useMemo, useRef, useState, type ComponentType, type ReactElement } from 'react';
import { bundleIcon } from '../icons/bundle';
import { ensureIconStyles, resolveForRender, withRole } from '../icons/element';
import { getIconPacks, onIconPacksChanged } from '../icons/registry';
import { resolveIcon } from '../icons/resolve';
import type { IconResolution } from '../icons/types';

/**
 * `FlowIcon` — the icon, as a React element.
 *
 * The app's icon currency is a COMPONENT VALUE: `lucideByName(name): LucideIcon`,
 * and tables store the result (`{ id: 'tasks', icon: iconForType('task') }`,
 * `RailIcon = ComponentType<{className?}>`). So the load-bearing export here is
 * `flowIconComponent(tag)`, whose signature and return type match `lucideByName`
 * exactly — that is what lets the app migrate by rewiring one function instead of
 * editing 81 files. `<FlowIcon>` is one line over it, for render sites.
 *
 * Three render strategies, picked by the resolution, all behind one component:
 *
 *  - **bundle** — the app's registered renderer draws it from its own geometry
 *    (see `icons/bundle.ts`), so a lucide glyph stays tree-shaken and costs no
 *    request. Falls back to the served file when no renderer is installed.
 *  - **tintable asset** — a CSS mask over `currentColor`; inherits colour like text.
 *  - **opaque asset** — an `<img>`; a four-colour brand mark cannot be tinted.
 *
 * `className` is passed straight through on every strategy. That is not a
 * convenience: the app sizes and colours icons with Tailwind classes
 * (`h-4 w-4`, `text-muted-foreground`) across ~1,600 call sites, and a component
 * that swallowed `className` could not be dropped in anywhere.
 */

/** What the app stores in its icon tables. Same shape as `lucideByName`'s return. */
export type FlowIconComponent = ComponentType<FlowIconRenderProps>;

export interface FlowIconRenderProps {
  className?: string;
  /** Accessible name. Absent ⇒ decorative (`aria-hidden`), matching the rule
   *  every call site already follows: the label lives beside the glyph. */
  title?: string;
  /** Override the spec's declared colour — for a surface-scoped tint. */
  color?: string;
  [key: string]: unknown;
}

export interface FlowIconProps extends FlowIconRenderProps {
  /** The icon's tag — `brands.slack`, `Rss`, or a path. */
  icon: string | null | undefined;
  /** A role appended as one more segment: `restore`. */
  role?: string;
  /** An ad-hoc sub-icon tag to badge on. Declared ones come from `IconSpec.sub`. */
  badge?: string;
  /** Named size over the app's real distribution. `className` still wins. */
  size?: FlowIconSize;
}

/**
 * The size scale, mapped to what the app actually uses: `h-3.5 w-3.5` (654
 * sites), `h-4 w-4` (519), `h-3 w-3` (436), then h-5/h-6. Not invented — these
 * ARE the sizes, so a caller can name one instead of repeating the classes.
 */
export type FlowIconSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

export const FLOW_ICON_SIZES: Record<FlowIconSize, string> = {
  xs: 'h-3 w-3',
  sm: 'h-3.5 w-3.5',
  md: 'h-4 w-4',
  lg: 'h-5 w-5',
  xl: 'h-6 w-6',
};

function classes(...parts: (string | undefined | false)[]): string | undefined {
  const joined = parts.filter(Boolean).join(' ').trim();
  return joined || undefined;
}

/** A11y: a named icon is an image, an unnamed one is decoration. */
function a11y(title: string | undefined): Record<string, unknown> {
  return title ? { role: 'img', 'aria-label': title, title } : { 'aria-hidden': 'true' };
}

/** One glyph, no badge — the shared half of the renderer. */
function Leaf({
  res,
  className,
  title,
  color,
  rest,
}: {
  res: IconResolution;
  className?: string;
  title?: string;
  color?: string;
  rest: Record<string, unknown>;
}): ReactElement | null {
  const [failed, setFailed] = useState(false);
  const tint = color || ((res.kind === 'asset' || res.kind === 'bundle') && res.color) || undefined;

  if (res.kind === 'none') return null;

  if (res.kind === 'bundle') {
    const Bundled = bundleIcon(res.name);
    if (Bundled) {
      // The app's own geometry — tree-shaken, no request. `style` carries the
      // declared colour only when there is one, so `currentColor` still wins.
      return createElement(Bundled, {
        className,
        ...a11y(title),
        ...(tint ? { style: { color: tint, ...(rest.style as object) } } : {}),
        ...rest,
      });
    }
  }

  const url = res.kind === 'path' ? res.url : res.url;
  if (!url) return null;

  const tintable = res.kind === 'asset' || res.kind === 'bundle' ? res.tintable : false;
  if (tintable) {
    return (
      <span
        className={classes('fp-icon', 'fp-icon-mask', className)}
        style={{
          WebkitMaskImage: `url("${url}")`,
          maskImage: `url("${url}")`,
          ...(tint ? { backgroundColor: tint } : {}),
          ...(rest.style as object),
        }}
        {...a11y(title)}
        {...rest}
      />
    );
  }

  // A broken asset must land on nothing rather than the browser's torn-page
  // chrome, which reads as a rendering bug instead of a missing file.
  if (failed) return null;
  const darkUrl = res.kind === 'asset' ? res.darkUrl : undefined;
  const img = (src: string, cls: string) => (
    <img key={cls || 'only'} src={src} alt="" className={classes('fp-icon-img', cls)} onError={() => setFailed(true)} />
  );
  return (
    <span className={classes('fp-icon', darkUrl && 'fp-icon-themed', className)} {...a11y(title)} {...rest}>
      {darkUrl ? [img(url, 'fp-icon-light'), img(darkUrl, 'fp-icon-dark')] : img(url, '')}
    </span>
  );
}

/** Resolve + render, with a sub-icon stacked on the corner when there is one. */
function Rendered({ res, className, title, color, rest }: Parameters<typeof Leaf>[0]): ReactElement | null {
  const host = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (host.current) ensureIconStyles(host.current.ownerDocument);
  }, []);

  const badge = (res.kind === 'asset' || res.kind === 'bundle') && res.badge ? res.badge : undefined;
  if (!badge) return <Leaf res={res} className={className} title={title} color={color} rest={rest} />;

  return (
    <span className={classes('fp-icon-stack', className)} ref={host} {...a11y(title)} {...rest}>
      <Leaf res={res} className="fp-icon-base" color={color} rest={{}} />
      <span className="fp-icon-sub" aria-hidden="true">
        <Leaf res={badge} rest={{}} />
      </span>
    </span>
  );
}

/**
 * The stored-value form — a drop-in for `lucideByName`.
 *
 * Memoized per tag so a table built on every render does not mint a new
 * component type each time (React would unmount and remount the subtree).
 */
const COMPONENTS = new Map<string, FlowIconComponent>();

export function flowIconComponent(icon: string | null | undefined): FlowIconComponent {
  const key = icon || '';
  const cached = COMPONENTS.get(key);
  if (cached) return cached;

  const Component: FlowIconComponent = ({ className, title, color, ...rest }) => {
    const res = useResolution(key);
    return <Rendered res={res} className={className} title={title} color={color} rest={rest} />;
  };
  Component.displayName = `FlowIcon(${key})`;
  COMPONENTS.set(key, Component);
  return Component;
}

/** Resolve against the loaded packs, re-resolving if they arrive after mount. */
function useResolution(tag: string, badge?: string): IconResolution {
  const [, bump] = useState(0);
  useEffect(() => onIconPacksChanged(() => bump((v) => v + 1)), []);
  return useMemo(() => {
    const packs = getIconPacks();
    // `resolveForRender` applies the unknown-icon fallback, so a missing icon
    // renders the generic glyph rather than vanishing — the rule `lucideByName`
    // already follows.
    const base = resolveForRender(tag, packs);
    if (!badge || (base.kind !== 'asset' && base.kind !== 'bundle')) return base;
    const sub = resolveIcon(badge, packs, false);
    return sub.kind === 'none' ? base : { ...base, badge: sub };
  }, [tag, badge]);
}

export function FlowIcon({ icon, role, badge, size, className, title, color, ...rest }: FlowIconProps) {
  const res = useResolution(withRole(icon, role) || '', badge);
  return (
    <Rendered
      res={res}
      className={classes(size && FLOW_ICON_SIZES[size], className)}
      title={title}
      color={color}
      rest={rest}
    />
  );
}

export default FlowIcon;
