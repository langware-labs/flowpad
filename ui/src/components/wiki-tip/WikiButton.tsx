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
  /**
   * Render as a text link with this wording (e.g. "Learn more") instead of the
   * W-square. For surfaces where the affordance has to read as prose — a tip
   * that already carries a sentence, or a popover with a learn-more line.
   */
  linkText?: string;
  className?: string;
}

const ICON_SKIN = 'flex shrink-0 items-center text-muted-foreground/70 transition-colors hover:text-primary';
const LINK_SKIN = 'shrink-0 text-xs text-primary underline-offset-2 hover:underline';

/**
 * Peeks a wiki page in a modal (via {@link openWikiModal}) without leaving the
 * current view — the "open the docs" affordance paired with {@link WikiTip}.
 *
 * Two skins, one behaviour: a compact W-square by default (inheriting the
 * surrounding text color via the shared {@link WikiIcon}), or a text link when
 * `linkText` is given.
 */
export function WikiButton({ wikiword, fragment, label, linkText, className }: WikiButtonProps) {
  // The link skin's visible wording IS its name — announcing the page title
  // instead would leave the accessible name without the label a user can see
  // (and would announce untranslated English against localized text).
  const title = label ?? linkText ?? wikiword;
  return (
    <button
      type="button"
      onClick={() => openWikiModal(wikiword, undefined, fragment)}
      className={cn(linkText ? LINK_SKIN : ICON_SKIN, className)}
      aria-label={title}
      title={title}
    >
      {linkText ?? <WikiIcon className="h-4 w-4" />}
    </button>
  );
}
