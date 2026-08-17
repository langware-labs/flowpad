/**
 * The overflow menu on a source card.
 *
 * Everything that is not `Pull changes` lives here: the card should read as
 * status at a glance, and seven buttons in a row read as a toolbar. Two kinds
 * of item, deliberately mixed — verbs that mutate this source, and links to the
 * two surfaces that answer "what did it do" (Events) and "what did it run"
 * (Runs). Both links are URL-first: they navigate, and the destination reads its
 * own scope off the URL.
 */
import type { DataSource } from '@sdk';
import { History, MoreHorizontal, Pencil, RadioTower, Rewind, Trash2 } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { Button } from '@src/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@src/components/ui/dropdown-menu';

interface Props {
  source: DataSource;
  onToggleEnabled: () => void;
  onEdit: (source: DataSource) => void;
  onReplay: (source: DataSource) => void;
  onDelete: (source: DataSource) => void;
}

export function SourceMenu({ source, onToggleEnabled, onEdit, onReplay, onDelete }: Props) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="-me-1 size-7 shrink-0 p-0"
          data-testid={`source-more-${source.id}`}
        >
          <MoreHorizontal className="size-4" />
          <span className="sr-only">{t`More actions`}</span>
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end">
        {/* "Pause" for anything that is not already paused, including a source
            still in `setup` — pausing an unfinished source is a real thing to
            want, and hiding the item would leave it with no way to stop. */}
        <DropdownMenuItem onSelect={onToggleEnabled}>
          {source.status === 'disabled' ? t`Resume` : t`Pause`}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onEdit(source)}>
          <Pencil className="size-3.5" /> {t`Edit`}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onReplay(source)}>
          <Rewind className="size-3.5" /> {t`Replay…`}
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        {/* Narrowed to this source. `target` is the FlowEvent's own key, and
            `ingest.*.sync.*` already targets `data_source:<id>` — so this is a
            filter on the envelope, not a search over its text. */}
        <DropdownMenuItem
          onSelect={() => navigation.openDock(DockPointer.forEvents(undefined, { target: `data_source:${source.id}` }))}
        >
          <RadioTower className="size-3.5" /> {t`Events`}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => navigation.openDock(DockPointer.forProcessRuns({ data_source_id: source.id }))}
        >
          <History className="size-3.5" /> {t`Runs`}
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          data-testid={`source-delete-${source.id}`}
          onSelect={() => onDelete(source)}
        >
          <Trash2 className="size-3.5" /> {t`Delete`}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
