import { Trans, useLingui } from '@lingui/react/macro';
import type { AgenticProcess } from '@sdk';
import { FilePlus } from 'lucide-react';
import { memo } from 'react';

import type { CreatedFile } from '@src/components/floating-chat/createdFiles';
import { useOpenCreatedFile, type CreatedFileOpener } from '@src/components/floating-chat/useOpenCreatedFile';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';

/** Chips shown inline before the rest fold into a "+N" popover. */
const INLINE_LIMIT = 4;

const CHIP_BASE = 'inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-[13px] transition-colors';
// Blue = a real affordance (click opens the file), matching MetaMessageChip's
// clickable variant; muted = nothing to open (an unanchored relative path).
const CHIP_OPENABLE =
  'border-blue-500/40 bg-blue-500/10 text-blue-600 hover:bg-blue-500/20 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300';
const CHIP_INERT = 'border-border/60 bg-muted/40 text-muted-foreground disabled:cursor-default disabled:opacity-70';

/**
 * The "files this turn created" row, rendered under an ended turn in the
 * Standard-mode chat.
 *
 * The point is reachability: Standard hides tool calls by default, so without
 * this the only trace of a written file is prose. Each chip opens that file in
 * its own tab.
 *
 * `FilePlus` is the same glyph the tool-call descriptor already assigns to
 * `file_write`. It is a filesystem file, not an entity type, so the
 * "icons come from the backend type registry" rule does not apply here.
 */
export const TurnCreatedFilesChips = memo(function TurnCreatedFilesChips({
  files,
  process,
}: {
  files: readonly CreatedFile[];
  process?: AgenticProcess | null;
}) {
  const opener = useOpenCreatedFile(process);
  if (files.length === 0) return null;

  const inline = files.slice(0, INLINE_LIMIT);
  const overflow = files.slice(INLINE_LIMIT);

  return (
    <div className="my-1 flex flex-wrap items-center gap-1.5" data-testid="turn-created-files">
      <span className="text-[12px] text-muted-foreground">
        <Trans>Created</Trans>
      </span>
      {inline.map((file) => (
        <FileChip key={file.path} file={file} opener={opener} />
      ))}
      {overflow.length > 0 && <OverflowChip files={overflow} opener={opener} />}
    </div>
  );
});

function FileChip({ file, opener }: { file: CreatedFile; opener: CreatedFileOpener }) {
  const { t } = useLingui();
  const openable = opener.resolve(file.path) !== null;
  return (
    <button
      type="button"
      data-testid="turn-created-file-chip"
      data-path={file.path}
      disabled={!openable}
      onClick={() => opener.open(file.path)}
      title={openable ? t`Open ${file.path}` : file.path}
      className={`${CHIP_BASE} ${openable ? CHIP_OPENABLE : CHIP_INERT}`}
    >
      <FilePlus className="h-3.5 w-3.5 flex-shrink-0" />
      <span className="truncate font-medium">{file.name}</span>
    </button>
  );
}

/**
 * The tail of a long turn. A refactor that writes thirty files must not paper
 * the transcript with thirty chips, so everything past the inline limit lives
 * one click away — the same popover shape the live turn-event chip uses.
 */
function OverflowChip({ files, opener }: { files: readonly CreatedFile[]; opener: CreatedFileOpener }) {
  const { t } = useLingui();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="turn-created-files-more"
          aria-label={t`Show the other files this turn created`}
          className={`${CHIP_BASE} ${CHIP_INERT} tabular-nums hover:bg-muted hover:text-foreground`}
        >
          +{files.length}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="max-h-72 w-72 overflow-y-auto p-1">
        <div className="flex flex-col gap-0.5">
          {files.map((file) => (
            <button
              key={file.path}
              type="button"
              data-testid="turn-created-file-chip"
              data-path={file.path}
              disabled={opener.resolve(file.path) === null}
              onClick={() => opener.open(file.path)}
              title={file.path}
              className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-start hover:bg-accent disabled:cursor-default disabled:opacity-70"
            >
              <FilePlus className="h-3.5 w-3.5 flex-shrink-0 text-blue-500" />
              <span className="min-w-0 flex-1 truncate text-xs text-foreground">{file.name}</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
