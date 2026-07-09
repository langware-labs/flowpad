import type { InlineRename } from './use-inline-rename';

/**
 * The tile-sized rename input rendered in place of a tile's label while an
 * inline rename (see `useInlineRename`) is active. Enter commits, Escape
 * cancels, blur commits; clicks/keys don't leak to the tile button.
 */
export function InlineRenameInput({ rename }: { rename: InlineRename }) {
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
      className="w-[58px] rounded border border-border bg-background px-0.5 text-center text-[10px] font-medium leading-none text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
    />
  );
}
