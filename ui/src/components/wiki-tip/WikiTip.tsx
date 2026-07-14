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
}

/**
 * A one-line hover tip attached to `children`: an optional `label` next to a
 * {@link WikiButton} that peeks the wiki page in a modal. The tip is a HoverCard
 * (not a plain tooltip) so the W-button stays reachable to click. Wraps the
 * label-plus-wiki-button pattern used e.g. by the footer project name.
 */
export function WikiTip({ wikiword, children, label, buttonLabel }: WikiTipProps) {
  return (
    <HoverCard openDelay={200} closeDelay={100}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent
        side="top"
        align="start"
        className="flex w-auto max-w-md items-center gap-2 px-3 py-1.5"
      >
        {label != null && (
          <span className="truncate text-xs text-muted-foreground">{label}</span>
        )}
        <WikiButton wikiword={wikiword} label={buttonLabel} />
      </HoverCardContent>
    </HoverCard>
  );
}
