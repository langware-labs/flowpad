import { FSRef, TypeId, type DisplayEntry } from '@sdk';
import { CopyButton } from '@src/components/ui/copy-button';
import { Button } from '@src/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import type { IconComp } from '@src/components/graph-view/icons/IconWithBadge';
import { isCustomIconName, lucideByName } from '@src/lib/lucide-by-name';
import { VIEWER_REGISTRY, type ViewType } from '@src/types/ViewType';
import { formatTimeAgo } from '@src/utils/format-time-ago';
import { displayFilePath, latestPerTarget } from './display-stack';
import { FileText, FolderOpen, Globe, History } from 'lucide-react';
import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

/** Human label for a display target — an app's name, a file's basename, or the
 *  entity's type/id. */
function entryLabel(entry: DisplayEntry): string {
  if (entry.kind === 'app' && entry.name) return entry.name;
  if (entry.path) return entry.path.split('/').pop() || entry.path;
  if (entry.type && entry.id) return `${entry.type} · ${entry.id.slice(0, 8)}`;
  return entry.typeid || entry.type || 'display';
}

/** The glyph for a shown target: a globe for an app, the backend TypeInfo icon
 *  for an entity, a screen's viewer icon, else a document. */
export function displayEntryIcon(entry: DisplayEntry): IconComp {
  if (entry.kind === 'app') return Globe;
  if (entry.type) return iconForType(entry.type);
  const viewIcon = entry.view_type && VIEWER_REGISTRY[entry.view_type as ViewType]?.iconName;
  return (viewIcon && isCustomIconName(viewIcon) && lucideByName(viewIcon)) || FileText;
}

function EntryIcon({ entry }: { entry: DisplayEntry }) {
  const Icon = displayEntryIcon(entry);
  return <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
}

/**
 * The rows of a process's `flow show` history — one per target, newest first,
 * each with the "ago" stamp of its latest show; clicking one calls `onOpen`.
 * Shared by the display toolbar's history popover and the terminal ribbon's
 * Shown stack, which differ only in their trigger.
 */
export function DisplayHistoryList({ stack, onOpen }: DisplayHistoryButtonProps) {
  const { t } = useLingui();
  const rows = latestPerTarget(stack);
  return (
    <ul className="flex max-h-80 flex-col overflow-y-auto">
      {rows.map((entry, i) => {
        const ago = formatTimeAgo(entry.shown_at);
        const filePath = displayFilePath(entry);
        const fsRef = filePath ? new FSRef(filePath, new TypeId('compute_node', '@local')) : null;
        return (
          <li key={`${entry.shown_at ?? ''}:${i}`}>
            <button
              type="button"
              onClick={() => onOpen(entry)}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-sm hover:bg-muted"
              data-testid="display-history-row"
            >
              <EntryIcon entry={entry} />
              <span className="min-w-0 flex-1 truncate">{entryLabel(entry)}</span>
              {ago ? <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{ago}</span> : null}
            </button>
            {filePath && (
              <div className="flex items-start gap-1 px-2 pb-2 text-muted-foreground">
                <span className="min-w-0 flex-1 break-all font-mono text-[11px] select-text">{filePath}</span>
                <CopyButton value={filePath} title={t`Copy path: ${filePath}`} className="shrink-0 rounded p-1 hover:bg-muted" />
                {fsRef?.localComputeNodeId && (
                  <button
                    type="button"
                    title={t`Reveal in Finder`}
                    aria-label={t`Reveal in Finder`}
                    onClick={() => void fsRef.open({ select: true })}
                    className="shrink-0 rounded p-1 hover:bg-muted"
                  >
                    <FolderOpen className="h-3 w-3" />
                  </button>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
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
  if (stack.length === 0) return null;

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
        <DisplayHistoryList
          stack={stack}
          onOpen={(entry) => {
            setOpen(false);
            onOpen(entry);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

export default DisplayHistoryButton;
