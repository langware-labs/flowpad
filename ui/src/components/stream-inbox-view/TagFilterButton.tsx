import { Filter, Tag as TagIcon } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { TagTreeList, useTagTreeRows } from '@src/components/tags/MessageTags';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { cn } from '@src/lib/utils';
import { MARK, MARK_BADGE, MARK_DIVIDER, MARK_SELECTED, MARK_TOOL } from './marks';

/**
 * The Stream Inbox's tag filter: a mark in the channel row that opens the tag tree. A conversation shows
 * when it carries any ticked tag, or a tag under one. Both the ticked tags (`tags=a,b`) and the open tree
 * (`tag_filter=open`) live in the URL, so a tick — a navigation — leaves the tree open.
 */
export function TagFilterButton({ tags, matches }: { tags: string[]; matches: number }) {
  const { t } = useLingui();
  const { navigation, currentDock } = useDockNavigation();
  const rows = useTagTreeRows();
  const open = currentDock?.options?.tag_filter === 'open';
  const setOpen = (next: boolean) => {
    if (currentDock && next !== open) navigation.openDock(currentDock.withOption('tag_filter', next ? 'open' : null));
  };
  const setTags = (next: string[]) => {
    if (currentDock) navigation.openDock(currentDock.withStreamInboxTags(next));
  };
  const on = tags.length > 0;
  const short = tags.map((name) => name.split('.').at(-1)).join(', ');
  const label = on ? t`Tags: ${short}` : t`Filter by tag`;
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(MARK, MARK_TOOL, 'bg-background', on ? MARK_SELECTED : 'border-border')}
            aria-pressed={on}
            aria-label={label}
            title={label}
            data-testid="stream-inbox-tag-filter-button"
          >
            <TagIcon className="size-4" />
            <span
              className={cn(
                MARK_BADGE,
                'grid size-3.5 place-items-center',
                on ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground',
              )}
            >
              <Filter className="size-2" strokeWidth={3} />
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-3" data-testid="stream-inbox-tag-filter-tree">
          <p className="mb-2 text-xs text-muted-foreground" role="status">
            {on ? <Trans>{matches} conversations</Trans> : <Trans>Only conversations with a ticked tag show</Trans>}
          </p>
          <TagTreeList
            rows={rows}
            optionTestId="tag-filter-option"
            isOn={(name) => tags.includes(name)}
            onToggle={(name, was) => setTags(was ? tags.filter((tag) => tag !== name) : [...tags, name])}
          />
          <div className="mt-2 flex items-center gap-2 border-t border-border pt-2">
            {on && (
              <button
                type="button"
                className="text-xs underline"
                data-testid="tag-filter-clear"
                onClick={() => setTags([])}
              >
                <Trans>Clear</Trans>
              </button>
            )}
            <span className="flex-1" />
            <button
              type="button"
              className="text-xs underline"
              data-testid="tag-filter-manage"
              onClick={() => navigation.openDock(DockPointer.forTagGraph(null, { carry: { manage: 'stream_inbox' } }))}
            >
              <Trans>Edit tags…</Trans>
            </button>
            <button
              type="button"
              className="rounded px-2 py-1 text-xs hover:bg-muted"
              data-testid="tag-filter-close"
              onClick={() => setOpen(false)}
            >
              <Trans>Done</Trans>
            </button>
          </div>
        </PopoverContent>
      </Popover>
      {/* The row's tools end here; its channels follow. */}
      <span className={MARK_DIVIDER} aria-hidden="true" />
    </>
  );
}
