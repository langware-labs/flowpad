/**
 * An org's or team's name, editable in place, with a delete icon beside it.
 *
 * Reuses `useInlineRename`/`InlineRenameInput` — the same rename mechanics the browseable tree's
 * tiles already use — rather than a second implementation: focus-and-select-all on entry, trim +
 * no-op guard on commit, Enter commits, Escape cancels.
 *
 * Delete is deliberately never inferred as safe from being SHOWN: the button always renders when
 * `onDelete` is passed, and a wrong permission is surfaced as a plain error toast on the attempt
 * rather than guessed at client-side — the hub is the one source of truth for who may delete an
 * organization outright (owner) versus a team (admin), and duplicating that rule here would drift.
 */
import { Loader2, Trash2 } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';

import { InlineRenameInput } from '@src/components/browseable-tree/InlineRenameInput';
import { useInlineRename } from '@src/components/browseable-tree/use-inline-rename';
import { Button } from '@src/components/ui/button';

export interface EditableTitleProps {
  name: string;
  onRename: (next: string) => void | Promise<void>;
  onDelete?: () => void;
  deleting?: boolean;
  headingClassName: string;
  testIdPrefix: string;
}

const RENAME_INPUT_CLASS =
  'rounded-md border border-border bg-background px-1.5 py-0.5 text-sm font-semibold focus:outline-none focus:ring-1 focus:ring-ring';

export function EditableTitle({
  name,
  onRename,
  onDelete,
  deleting,
  headingClassName,
  testIdPrefix,
}: EditableTitleProps) {
  const { t } = useLingui();
  const rename = useInlineRename(name, onRename);

  return (
    <div className="flex min-w-0 items-center gap-2">
      {rename.editing ? (
        <InlineRenameInput
          rename={rename}
          className={`${RENAME_INPUT_CLASS} ${headingClassName}`}
          testId={`${testIdPrefix}-rename-input`}
          ariaLabel={t`Name`}
        />
      ) : (
        <button
          type="button"
          className={`truncate rounded px-1 py-0.5 text-left hover:bg-muted ${headingClassName}`}
          data-testid={`${testIdPrefix}-name`}
          onClick={rename.startEditing}
        >
          {name}
        </button>
      )}
      {onDelete && (
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
          aria-label={t`Delete`}
          data-testid={`${testIdPrefix}-delete`}
          disabled={deleting}
          onClick={onDelete}
        >
          {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
        </Button>
      )}
    </div>
  );
}
