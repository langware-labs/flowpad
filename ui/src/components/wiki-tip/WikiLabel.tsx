import { useCallback } from 'react';
import { ExternalLink, Eye } from 'lucide-react';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@src/components/ui/hover-card';
import { Button } from '@src/components/ui/button';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { openWikiModal } from './wiki-modal';

interface WikiLabelProps {
  /** The wiki page name this label points at (e.g. "Welcome"). */
  wikiword: string;
  /** Display text for the button. Defaults to the wiki word. */
  label?: string;
}

/**
 * A wiki word rendered as a clickable label with a *wikitip*: clicking opens
 * the wiki page (full view); hovering reveals a tip whose "Preview" pops the
 * same page in a modal via `openWikiModal`. Both directions resolve the page
 * by name. See docs/wikitip.md.
 */
export function WikiLabel({ wikiword, label }: WikiLabelProps) {
  const { navigation } = useDockNavigation();
  const openWiki = useCallback(
    () => navigation.openDock(DockPointer.forWiki(wikiword)),
    [navigation, wikiword],
  );

  return (
    <HoverCard openDelay={150}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          onClick={openWiki}
          className="font-medium text-primary underline underline-offset-4 hover:text-primary/80"
        >
          {label ?? wikiword}
        </button>
      </HoverCardTrigger>
      <HoverCardContent className="w-72" align="start">
        <div className="flex flex-col gap-2">
          <div className="text-sm font-semibold">[[{wikiword}]]</div>
          <div className="text-xs text-muted-foreground">
            Wiki page. Open it inline, or peek at it without leaving this view.
          </div>
          <div className="flex gap-2 pt-1">
            <Button size="sm" variant="secondary" onClick={() => openWikiModal(wikiword)}>
              <Eye className="mr-1 h-3.5 w-3.5" /> Preview
            </Button>
            <Button size="sm" variant="ghost" onClick={openWiki}>
              <ExternalLink className="mr-1 h-3.5 w-3.5" /> Open
            </Button>
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
