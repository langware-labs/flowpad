import { WikiIcon } from '@src/components/icons/WikiIcon';
import { cn } from '@src/lib/utils';
import { openWikiModal } from './wiki-modal';

interface WikiButtonProps {
  /** The wiki page this button opens (resolved by title/name). */
  wikiword: string;
  /** Optional heading slug to deep-link into a section of the page. */
  fragment?: string;
  /** Accessible label / hover title. Defaults to the wiki word. */
  label?: string;
  className?: string;
}

/**
 * A compact W-square icon button that peeks a wiki page in a modal (via
 * {@link openWikiModal}) without leaving the current view — the "open the docs"
 * affordance paired with {@link WikiTip}. Uses the shared {@link WikiIcon} so it
 * inherits the surrounding text color.
 */
export function WikiButton({ wikiword, fragment, label, className }: WikiButtonProps) {
  const title = label ?? wikiword;
  return (
    <button
      type="button"
      onClick={() => openWikiModal(wikiword, undefined, fragment)}
      className={cn(
        'flex shrink-0 items-center text-muted-foreground/70 transition-colors hover:text-primary',
        className,
      )}
      aria-label={title}
      title={title}
    >
      <WikiIcon className="h-4 w-4" />
    </button>
  );
}
