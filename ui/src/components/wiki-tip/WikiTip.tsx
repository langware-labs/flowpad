import type { ReactNode } from 'react';
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@src/components/ui/hover-card';
import { WikiButton } from './WikiButton';

interface WikiTipProps {
  /** The wiki page the tip's W-button opens (resolved by title/name). */
  wikiword: string;
  /** The always-visible element the tip hangs off (e.g. a project name). */
  children: ReactNode;
  /** One-line content shown beside the W-button (e.g. a path). Optional. */
  label?: ReactNode;
  /** Accessible label / hover title for the W-button. Defaults to the wiki word. */
  buttonLabel?: string;
  /** Hover dwell before the tip opens. Raise it on dense surfaces (a grid of
   *  tipped tiles pops a card under every tile the pointer crosses). */
  openDelay?: number;
  /** Which side of the trigger the card opens on. Defaults to "top"; rail
   *  buttons pass "right" to match the rail's regular tooltips. */
  side?: 'top' | 'right' | 'bottom' | 'left';
}

/**
 * A one-line hover tip attached to `children`: an optional `label` next to a
 * {@link WikiButton} that peeks the wiki page in a modal. The tip is a HoverCard
 * (not a plain tooltip) so the W-button stays reachable to click. Wraps the
 * label-plus-wiki-button pattern used e.g. by the footer project name.
 *
 * `children` must forward its ref and spread props onto a DOM node — the
 * trigger is `asChild`, so a component that swallows them leaves the tip inert.
 */
export function WikiTip({ wikiword, children, label, buttonLabel, openDelay = 200, side = 'top' }: WikiTipProps) {
  return (
    <HoverCard openDelay={openDelay} closeDelay={100}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent
        side={side}
        align={side === 'right' || side === 'left' ? 'center' : 'start'}
        // pointer-events-auto: the card portals to <body>, which a modal Radix
        // Dialog marks pointer-events:none — without this the W-button renders
        // but can't be clicked when the tip is used inside a dialog.
        className="pointer-events-auto flex w-auto max-w-md items-center gap-2 px-3 py-1.5"
      >
        {label != null && (
          <span className="truncate text-xs text-muted-foreground">{label}</span>
        )}
        <WikiButton wikiword={wikiword} label={buttonLabel} />
      </HoverCardContent>
    </HoverCard>
  );
}
