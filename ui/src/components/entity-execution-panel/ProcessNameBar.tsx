import { AgenticProcess } from '@sdk';
import { useInlineRename } from '@src/components/browseable-tree/use-inline-rename';
import { InlineRenameInput } from '@src/components/browseable-tree/InlineRenameInput';
import { resolveProcessDisplayName } from '@src/components/terminal/process-display-name';

/**
 * A thin one-liner below the execution panel's top bar showing the active
 * process's name, editable in place. Reuses the same primitives as the tab
 * strip / footer worker list: {@link useInlineRename} + {@link InlineRenameInput}
 * for the edit UX and `AgenticProcess.renameById` for the save (which mirrors
 * onto the open Tab chip + pins `auto_rename`, so this stays in lockstep with
 * the tab name). The name reflects live because the caller passes a watched
 * `useEntity` process — no local name state. The caller only mounts this once a
 * process exists, so `process` is always present.
 */
export function ProcessNameBar({ process }: { process: AgenticProcess }) {
  const label = resolveProcessDisplayName(process);
  const rename = useInlineRename(label, async (next) => {
    await AgenticProcess.renameById(process.id, next);
    process.markEdit();
  });

  return (
    <div
      className="flex flex-shrink-0 items-center border-b px-2 py-1"
      data-testid="entity-execution-process-name-bar"
    >
      {rename.editing ? (
        <InlineRenameInput
          rename={rename}
          className="min-w-0 flex-1 rounded border border-border bg-background px-1 py-0.5 text-xs font-medium text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          testId="process-name-input"
          ariaLabel="Rename session"
        />
      ) : (
        <button
          type="button"
          onClick={() => rename.startEditing()}
          title={label}
          className="min-w-0 flex-1 truncate text-left text-xs font-medium text-foreground/90 hover:text-foreground"
          data-testid="vibe-process-name"
        >
          {label}
        </button>
      )}
    </div>
  );
}
