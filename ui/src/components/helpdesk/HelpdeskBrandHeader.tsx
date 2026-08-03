import { Trans } from '@lingui/react/macro';
import { LifeBuoy } from 'lucide-react';
import type { HelpdeskBrand } from './useHelpdeskBrand';
import { HelpdeskResetButton } from './HelpdeskResetButton';

/**
 * The desk's identity, at the top of its portal.
 *
 * Restrained by design, per the branding research: the mark sits in a corner at
 * roughly 5–10% of the width rather than centred and oversized, and the accent
 * is spent on the primary action and a hairline rule — not a full-bleed colour
 * band. A support portal's job is to answer a question; the brand should say
 * whose desk this is and then get out of the way.
 *
 * A desk that ships no brand still gets a clean header, so the portal never
 * looks broken before it is customised.
 */
export function HelpdeskBrandHeader({ brand }: { brand: HelpdeskBrand }) {
  return (
    <header
      className="shrink-0 border-b border-border/60 bg-background/80 px-6 py-4 backdrop-blur"
      data-testid="helpdesk-brand-header"
    >
      <div className="mx-auto flex w-full max-w-3xl items-center gap-3">
        {brand.logoUrl ? (
          <>
            {/* Two <img> rather than a JS theme check: the CSS swap has no
                flash on load and no dependency on when the theme resolves.
                A desk that ships only a light mark gets it in both themes. */}
            <img
              src={brand.logoUrl}
              alt=""
              className={`h-7 w-auto shrink-0 ${brand.logoDarkUrl ? 'dark:hidden' : ''}`}
            />
            {brand.logoDarkUrl && (
              <img src={brand.logoDarkUrl} alt="" className="hidden h-7 w-auto shrink-0 dark:block" />
            )}
          </>
        ) : (
          <LifeBuoy className="h-5 w-5 shrink-0 text-[hsl(var(--brand))]" />
        )}

        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold leading-tight">
            {brand.name ?? <Trans>Help desk</Trans>}
          </h1>
          {brand.tagline && (
            <p className="truncate text-xs text-muted-foreground">{brand.tagline}</p>
          )}
        </div>

        <HelpdeskResetButton />
      </div>
    </header>
  );
}
