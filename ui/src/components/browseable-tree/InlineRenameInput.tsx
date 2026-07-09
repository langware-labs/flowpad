import type { InlineRename } from './use-inline-rename';

const TILE_INPUT_CLASS =
  'w-[58px] rounded border border-border bg-background px-0.5 text-center text-[10px] font-medium leading-none text-foreground focus:outline-none focus:ring-1 focus:ring-ring';

/**
 * The rename input rendered in place of an entity's label while an inline rename
 * (see `useInlineRename`) is active. Enter commits, Escape cancels, blur commits;
 * clicks/keys don't leak to the enclosing button. Defaults to the compact tile
 * styling; pass `className` (e.g. for a full-width list row) to override, and
 * `testId`/`ariaLabel` to identify it.
 */
export function InlineRenameInput({
  rename,
  className = TILE_INPUT_CLASS,
  testId,
  ariaLabel,
}: {
  rename: InlineRename;
  className?: string;
  testId?: string;
  ariaLabel?: string;
}) {
  return (
    <input
      ref={rename.inputRef}
      value={rename.draft}
      onChange={(e) => rename.setDraft(e.target.value)}
      onBlur={() => void rename.commitRename()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          void rename.commitRename();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          rename.cancelEditing();
        }
      }}
      className={className}
      data-testid={testId}
      aria-label={ariaLabel}
    />
  );
}
