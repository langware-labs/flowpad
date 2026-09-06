import { createElement, useEffect, useMemo, useState, type ComponentType, type ReactElement, type ReactNode } from 'react';
import { useIconPacks } from './hooks/useIconPacks';
import { bundleIcon } from '../icons/bundle';
import { ensureIconStyles, resolveForRender, withRole } from '../icons/element';
import { getIconFallback, getIconPacks } from '../icons/registry';
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

/**
 * What every icon accepts. The index signature IS the escape hatch — `style`
 * and four distinct `data-*` attributes are passed at real call sites, and
 * neither can be enumerated.
 *
 * Note it is a shared base rather than something `FlowIconProps` `Omit`s from:
 * `Omit` over a type with an index signature collapses the explicit members
 * into that signature, and every prop silently becomes `unknown`.
 */
interface FlowIconCommonProps {
  className?: string;
  /** Accessible name. Absent ⇒ decorative (`aria-hidden`), matching the rule
   *  every call site already follows: the label lives beside the glyph. */
  title?: string;
  /** Override the spec's declared colour — for a surface-scoped tint. */
  color?: string;
  [key: string]: unknown;
}

/** What a STORED component accepts — the `lucideByName` return shape. */
export interface FlowIconRenderProps extends FlowIconCommonProps {
  /** A pixel size, as ~35 call sites and `EntityIcon`'s density already pass. */
  size?: number;
}

export interface FlowIconProps extends FlowIconCommonProps {
  /** The icon's tag — `brands.slack`, `Rss`, or a path. */
  icon: string | null | undefined;
  /** A role appended as one more segment: `restore`. */
  role?: string;
  /** An ad-hoc sub-icon tag to badge on. Declared ones come from `IconSpec.sub`. */
  badge?: string;
  /**
   * A named step, or a pixel number.
   *
   * The number form is not a convenience: 35 call sites pass `size={14}`, and
   * `EntityIcon` computes one from its density (`size ?? (compact ? 14 : 16)`),
   * so a component that only took names would reject a live pattern.
   * `className` still wins over both.
   */
  size?: FlowIconSize | number;
  /** Classes for the base glyph only, when a badge is present. */
  baseClassName?: string;
  /** Classes for the badge only — a vendor colour, or different geometry. */
  badgeClassName?: string;
  /**
   * What to draw when nothing claims the tag, instead of the configured
   * fallback glyph.
   *
   * A tag can express "some other icon"; it cannot express `ProviderGlyph`'s
   * monogram, which is built from a SIBLING field (`name.slice(0,1)`) and so is
   * not an icon at all. Per-site because that is where the material lives.
   */
  fallback?: ReactNode;
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

/** The explicit pixel box, or nothing — spread into a style object. */
function box(px: number | undefined) {
  return px ? { width: px, height: px } : undefined;
}

function classes(...parts: (string | undefined | false)[]): string | undefined {
  const joined = parts.filter(Boolean).join(' ').trim();
  return joined || undefined;
}

/** Does a class string already size the element? */
const SIZES_IT = /(^|\s)!?(h-|w-|size-)/;

/**
 * The size class to emit, or nothing when the caller sized it themselves.
 *
 * Emitting BOTH and trusting `className` to win is not a rule the DOM has:
 * `h-3 w-3 h-8 w-8` resolves by stylesheet order, not attribute order, so
 * "className wins" would have been true only by Tailwind's generation
 * accident. Dropping the named size when the caller supplies one makes the
 * precedence real. The app has `cn()` (clsx + tailwind-merge) for exactly this,
 * but it lives in `ui/` and `ts_sdk` depends on `dotenv` alone.
 */
function sizeClass(size: FlowIconSize | number | undefined, className: string | undefined): string | undefined {
  if (typeof size !== 'string') return undefined;
  return className && SIZES_IT.test(className) ? undefined : FLOW_ICON_SIZES[size];
}

/** A11y: a named icon is an image, an unnamed one is decoration. */
function a11y(title: string | undefined): Record<string, unknown> {
  return title ? { role: 'img', 'aria-label': title, title } : { 'aria-hidden': 'true' };
}

/** A resolution worth drawing, or nothing. */
function orNothing(res: IconResolution): IconResolution | undefined {
  return res.kind === 'none' ? undefined : res;
}

/** One glyph, no badge — the shared half of the renderer. */
function Leaf({
  res,
  className,
  title,
  color,
  px,
  rest,
  onBroken,
}: {
  res: IconResolution;
  className?: string;
  title?: string;
  color?: string;
  px?: number;
  rest: Record<string, unknown>;
  /** What to draw when the artwork 404s. Absent ⇒ draw nothing. */
  onBroken?: IconResolution;
}): ReactElement | null {
  const [failed, setFailed] = useState(false);
  const tint = color || ((res.kind === 'asset' || res.kind === 'bundle') && res.color) || undefined;

  if (res.kind === 'none') return null;

  // The value IS the glyph — an emoji from the picker, or initials supplied as
  // a fallback. Sized by the caller's className like every other icon, and
  // decorative unless named, so it sits in a row exactly where a mark would.
  if (res.kind === 'text') {
    return (
      <span
        className={classes('fp-icon-text', className)}
        style={{ ...box(px), ...(rest.style as object) }}
        {...a11y(title)}
        {...rest}
      >
        {res.text}
      </span>
    );
  }

  if (res.kind === 'bundle') {
    const Bundled = bundleIcon(res.name);
    if (Bundled) {
      // The app's own geometry — tree-shaken, no request. `style` carries the
      // declared colour only when there is one, so `currentColor` still wins.
      // Lucide's own `size` sets width/height, so hand the number straight on.
      return createElement(Bundled, {
        className,
        ...(px ? { size: px } : {}),
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
          ...box(px),
          ...(rest.style as object),
        }}
        {...a11y(title)}
        {...rest}
      />
    );
  }

  // A broken asset lands where a TYPO lands. The browser's torn-page chrome
  // reads as a rendering bug rather than a missing file — but so does an icon
  // that silently vanishes, and `lucideByName` deliberately makes both cases
  // look alike. `onBroken` is absent only for the fallback itself, so a missing
  // fallback cannot recurse.
  if (failed) {
    return onBroken ? <Leaf res={onBroken} className={className} title={title} px={px} rest={rest} /> : null;
  }
  const darkUrl = res.kind === 'asset' ? res.darkUrl : undefined;

  // No dark variant ⇒ the image IS the icon, with the caller's className on it
  // rather than on a wrapper. That is what `imageIcon` did, and the difference
  // is not cosmetic: a class like `rounded-full` on an avatar has to reach the
  // element that draws the pixels, and a wrapper would need `overflow:hidden`
  // to clip anything. One less DOM level too.
  if (!darkUrl) {
    return (
      <img
        src={url}
        alt=""
        className={className}
        style={{ ...box(px), ...(rest.style as object) }}
        onError={() => setFailed(true)}
        {...a11y(title)}
        {...rest}
      />
    );
  }

  // A dark variant needs both artworks in the DOM for CSS to choose between, so
  // here the wrapper is unavoidable and the className sizes it.
  const img = (src: string, cls: string) => (
    <img key={cls} src={src} alt="" className={classes('fp-icon-img', cls)} onError={() => setFailed(true)} />
  );
  return (
    <span
      className={classes('fp-icon', 'fp-icon-themed', className)}
      style={{ ...box(px), ...(rest.style as object) }}
      {...a11y(title)}
      {...rest}
    >
      {[img(url, 'fp-icon-light'), img(darkUrl, 'fp-icon-dark')]}
    </span>
  );
}

/** Resolve + render, with a sub-icon stacked on the corner when there is one. */
function Rendered({
  res,
  className,
  title,
  color,
  px,
  rest,
  baseClassName,
  badgeClassName,
}: Parameters<typeof Leaf>[0] & { baseClassName?: string; badgeClassName?: string }): ReactElement | null {
  // Unconditionally, and NOT behind a ref: the ref was only ever attached on
  // the badge branch, so a plain icon never injected the stylesheet at all. A
  // page using only FlowIcon would then render every masked glyph invisible —
  // the mask paints with `background-color: currentColor`, which lives here.
  // Nothing caught it because the demo also renders through `iconElement`,
  // which injects on its own, and an inline mask-image URL keeps the assertions
  // passing either way.
  useEffect(() => {
    ensureIconStyles();
  }, []);

  // Resolved once here, not inside Leaf, so the fallback itself renders with
  // `onBroken` absent and a missing fallback cannot loop.
  const fallbackTag = getIconFallback();
  const broken =
    fallbackTag && !(('tag' in res) && res.tag === fallbackTag)
      ? orNothing(resolveIcon(fallbackTag, getIconPacks()))
      : undefined;

  const badge = (res.kind === 'asset' || res.kind === 'bundle') && res.badge ? res.badge : undefined;
  if (!badge) {
    return (
      <Leaf
        res={res}
        className={classes(className, baseClassName)}
        title={title}
        color={color}
        px={px}
        rest={rest}
        onBroken={broken}
      />
    );
  }

  // Base and badge are addressed separately, matching `IconWithBadge`, whose
  // call sites tint the badge on its own and (RagFolderIcon) replace the corner
  // geometry outright. One shared className could not express either.
  return (
    <span
      className={classes('fp-icon-stack', className)}
      style={{ ...box(px), ...(rest.style as object) }}
      {...a11y(title)}
      {...rest}
    >
      <Leaf res={res} className={classes('fp-icon-base', baseClassName)} color={color} rest={{}} onBroken={broken} />
      <span className={classes('fp-icon-sub', badgeClassName)} aria-hidden="true">
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

  // Literally `FlowIcon` with its tag bound — same props, same size handling.
  // Writing it out again was a second copy of the resolve-and-render path.
  const Component: FlowIconComponent = (props) => <FlowIcon icon={key} {...props} />;
  Component.displayName = `FlowIcon(${key})`;
  COMPONENTS.set(key, Component);
  return Component;
}

/** Resolve against the loaded packs, re-resolving if they arrive after mount. */
function useResolution(tag: string, badge?: string, ownFallback = false): IconResolution {
  // The packs are a dependency, not a side read: they arrive after mount on
  // any page that renders before the bootstrap lands.
  const packs = useIconPacks();
  return useMemo(() => {
    // `resolveForRender` applies the unknown-icon fallback, so a missing icon
    // renders the generic glyph rather than vanishing — the rule `lucideByName`
    // already follows. A caller with its OWN fallback needs the honest `none`
    // instead, so it can draw what it has.
    const base = ownFallback ? resolveIcon(tag, packs) : resolveForRender(tag, packs);
    if (!badge || (base.kind !== 'asset' && base.kind !== 'bundle')) return base;
    const sub = resolveIcon(badge, packs, false);
    return sub.kind === 'none' ? base : { ...base, badge: sub };
  }, [tag, badge, ownFallback, packs]);
}

export function FlowIcon({
  icon,
  role,
  badge,
  size,
  className,
  baseClassName,
  badgeClassName,
  title,
  color,
  fallback,
  ...rest
}: FlowIconProps) {
  const res = useResolution(withRole(icon, role) || '', badge, fallback !== undefined);
  // A caller-supplied fallback wins over the configured glyph — it is the more
  // specific answer, and the only one that can carry a monogram.
  if (fallback !== undefined && res.kind === 'none') return <>{fallback}</>;
  const named = sizeClass(size, className);
  const px = typeof size === 'number' ? size : undefined;
  return (
    <Rendered
      res={res}
      className={classes(named, className)}
      baseClassName={baseClassName}
      badgeClassName={badgeClassName}
      title={title}
      color={color}
      px={px}
      rest={rest}
    />
  );
}

export default FlowIcon;
