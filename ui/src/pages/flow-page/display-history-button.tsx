import type { DisplayEntry } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { formatTimeAgo } from '@src/utils/format-time-ago';
import { FileText, Globe, History } from 'lucide-react';
import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

/** Human label for a display target — a file's basename, a webapp's port, or the
 *  entity's type/id. */
function entryLabel(entry: DisplayEntry): string {
  if (entry.kind === 'webapp' && entry.port != null) return `localhost:${entry.port}`;
  if (entry.path) return entry.path.split('/').pop() || entry.path;
  if (entry.type && entry.id) return `${entry.type} · ${entry.id.slice(0, 8)}`;
  return entry.typeid || entry.type || 'display';
}

/** Per-entry glyph: the backend TypeInfo icon for a shown entity, else a
 *  kind-based fallback (file / globe). */
function EntryIcon({ entry }: { entry: DisplayEntry }) {
  if (entry.kind === 'webapp') return <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
  if (entry.type) {
    const Icon = iconForType(entry.type);
    return <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
  }
  return <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
}

interface DisplayHistoryButtonProps {
  /** The process's display stack (oldest first, as stored). Read-only: the
   *  component reverses a copy, and `displayHistory` hands back a readonly view. */
  stack: readonly DisplayEntry[];
  /** Open a past display as its own standard tab. */
  onOpen: (entry: DisplayEntry) => void;
}

/**
 * The display-history popover — the reusable "time-ordered list that opens a
 * dockpointer" pattern, scoped to one process's `flow show` history. Newest
 * first, each row an "ago" label; clicking a row opens that target as its own
 * tab (`onOpen`). Rendered next to the open-in-window icon in the display toolbar.
 */
export function DisplayHistoryButton({ stack, onOpen }: DisplayHistoryButtonProps) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  // Stored oldest-first; show newest-first.
  const rows = [...stack].reverse();
  if (rows.length === 0) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                data-testid="display-history"
                aria-label={t`Display history`}
                title={t`Display history`}
              >
                <History className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="bg-popover text-popover-foreground">
            <p>
              <Trans>Display history</Trans>
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <PopoverContent
        align="end"
        side="bottom"
        sideOffset={6}
        className="w-72 p-1"
        data-testid="display-history-popover"
      >
        <ul className="flex max-h-80 flex-col overflow-y-auto">
          {rows.map((entry, i) => {
            const ago = formatTimeAgo(entry.shown_at);
            return (
              <li key={`${entry.shown_at ?? ''}:${i}`}>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onOpen(entry);
                  }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-sm hover:bg-muted"
                  data-testid="display-history-row"
                >
                  <EntryIcon entry={entry} />
                  <span className="min-w-0 flex-1 truncate">{entryLabel(entry)}</span>
                  {ago ? <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{ago}</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

export default DisplayHistoryButton;
