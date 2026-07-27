import type React from 'react';

/**
 * Full-bleed per-project home background (`.flow/customization/home.png`) with a
 * scrim so foreground text stays legible. Renders behind the home content —
 * drop it as the first child of a `relative` home container. Null url → nothing,
 * so the default home look is unchanged. Shared by every home surface.
 */
export function HomeCustomBackground({ url }: { url: string | null }) {
  if (!url) return null;
  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-0 bg-cover bg-center"
        style={{ backgroundImage: `url("${url}")` }}
        data-testid="home-custom-background"
      />
      <div aria-hidden className="pointer-events-none absolute inset-0 z-0 bg-background/60" />
    </>
  );
}

/**
 * The home greeting: the `.flow/customization` `home_title` override when set,
 * else the surface's default greeting. Keeps the "override vs default" decision
 * in one place across every home hero.
 */
export function HomeGreeting({
  override,
  className,
  fallback,
}: {
  override: string | null;
  className: string;
  fallback: React.ReactNode;
}) {
  return override ? <span className={className}>{override}</span> : <>{fallback}</>;
}
