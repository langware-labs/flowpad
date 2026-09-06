/**
 * An org's or team's name, editable in place, with a delete icon beside it.
 *
 * Reuses `useInlineRename`/`InlineRenameInput` — the same rename mechanics the browseable tree's
 * tiles already use — rather than a second implementation: focus-and-select-all on entry, trim +
 * no-op guard on commit, Enter commits, Escape cancels.
 *
 * **`manage` decides whether this is a control at all.** Renaming and deleting are the same right,
 * so they are one flag: without it the name renders as plain text and the delete button is absent.
 *
 * That flag is READ from the hub, never inferred here. The distinction matters and is the reason
 * this component used to show the controls unconditionally and let the attempt fail with a toast:
 * guessing client-side at who may delete an organization (owner) versus a team (admin) meant a
 * second copy of an authorization rule, and a second copy drifts. It is not a guess any more —
 * `OrgScopeBudget.can_manage_org` is the hub answering the `update` policy question on the
 * organization itself, so the button is hidden exactly when the request would have been refused.
 * A failed attempt still surfaces as an error toast; this only stops offering a dead control.
 */
import { Loader2, Trash2 } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';

import { InlineRenameInput } from '@src/components/browseable-tree/InlineRenameInput';
import { useInlineRename } from '@src/components/browseable-tree/use-inline-rename';
import { Button } from '@src/components/ui/button';
import { CopyButton } from '@src/components/ui/copy-button';

export interface EditableTitleProps {
  name: string;
  onRename: (next: string) => void | Promise<void>;
  onDelete?: () => void;
  deleting?: boolean;
  /** May the caller rename and delete this thing? The hub's own answer; required, so a new call
   *  site cannot silently default itself into showing controls that do not work. */
  manage: boolean;
  /** The entity's id, offered as a copy icon beside the name — never rendered as text.
   *  A raw uuid on the row is noise to the person reading it, but the id is what support and
   *  every `flow`/API call ask for, so it is one click away and no glance away. */
  copyId?: string;
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
  manage,
  copyId,
  headingClassName,
  testIdPrefix,
}: EditableTitleProps) {
  const { t } = useLingui();
  const rename = useInlineRename(name, onRename);

  // Beside the name in BOTH branches: the id is not a permission, so a member who may not rename
  // this thing still gets it.
  const copy = copyId ? (
    <CopyButton
      value={copyId}
      title={t`Copy id`}
      testId={`${testIdPrefix}-copy-id`}
      className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
    />
  ) : null;

  // Plain text, not a disabled button: a control that cannot ever do anything for this person is
  // noise, and a greyed-out name reads as "broken" rather than as "not yours to change".
  if (!manage) {
    return (
      <div className="flex min-w-0 items-center gap-2">
        {/* Truncated, so it carries the whole name in a tooltip -- the same rule every trimmed
            thing on this page follows. */}
        <span className={`truncate px-1 py-0.5 ${headingClassName}`} title={name} data-testid={`${testIdPrefix}-name`}>
          {name}
        </span>
        {copy}
      </div>
    );
  }

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
          title={name}
          data-testid={`${testIdPrefix}-name`}
          onClick={rename.startEditing}
        >
          {name}
        </button>
      )}
      {copy}
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
