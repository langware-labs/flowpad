import { Trans, useLingui } from '@lingui/react/macro';
import type { AgenticProcess } from '@sdk';
import { memo } from 'react';

import { FILE_OPS } from '@src/components/floating-chat/toolEventDescriptor';
import { partitionByKind, type TurnFile } from '@src/components/floating-chat/turnFiles';
import { useOpenTurnFile, type TurnFileOpener } from '@src/components/floating-chat/useOpenTurnFile';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';

/** Chips shown inline, per group, before the rest fold into a "+N" popover. */
const INLINE_LIMIT = 4;

const CHIP_BASE = 'inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-[13px] transition-colors';
// Created reads as the louder event, so it keeps the blue affordance colour
// (MetaMessageChip's clickable variant). An edit is a quieter fact about a file
// that already existed, so it stays neutral — the row shouldn't shout twice.
const CHIP_CREATE =
  'border-blue-500/40 bg-blue-500/10 text-blue-600 hover:bg-blue-500/20 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300';
const CHIP_EDIT =
  'border-border/60 bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground';
const CHIP_INERT = 'border-border/60 bg-muted/40 text-muted-foreground disabled:cursor-default disabled:opacity-70';

/**
 * The "files this turn touched" row, rendered under an ended turn in the
 * Standard-mode chat.
 *
 * The point is reachability: Standard hides tool calls by default, so without
 * this the only trace of a written or edited file is prose. Each chip opens
 * that file in its own tab.
 *
 * Created and edited are separate, labelled groups rather than one mixed list —
 * "what did this turn add?" and "what did it change?" are different questions,
 * and a turn that rewrites twenty files shouldn't bury the one it created.
 */
export const TurnFilesChips = memo(function TurnFilesChips({
  files,
  process,
}: {
  files: readonly TurnFile[];
  process?: AgenticProcess | null;
}) {
  const opener = useOpenTurnFile(process);
  if (files.length === 0) return null;

  const { created, edited } = partitionByKind(files);

  return (
    <div className="my-1 flex flex-wrap items-center gap-1.5" data-testid="turn-files">
      {created.length > 0 && (
        <FileGroup files={created} opener={opener} label={<Trans>Created</Trans>} testId="turn-files-more-created" />
      )}
      {edited.length > 0 && (
        <FileGroup files={edited} opener={opener} label={<Trans>Edited</Trans>} testId="turn-files-more-edited" />
      )}
    </div>
  );
});

function FileGroup({
  files,
  opener,
  label,
  testId,
}: {
  files: readonly TurnFile[];
  opener: TurnFileOpener;
  label: React.ReactNode;
  testId: string;
}) {
  const inline = files.slice(0, INLINE_LIMIT);
  const overflow = files.slice(INLINE_LIMIT);
  return (
    <>
      <span className="text-[12px] text-muted-foreground">{label}</span>
      {inline.map((file) => (
        <FileChip key={file.path} file={file} opener={opener} />
      ))}
      {overflow.length > 0 && <OverflowChip files={overflow} opener={opener} testId={testId} />}
    </>
  );
}

function FileChip({ file, opener }: { file: TurnFile; opener: TurnFileOpener }) {
  const { t } = useLingui();
  const openable = opener.resolve(file.path) !== null;
  // The glyph the tool-call row already uses for this kind. These are
  // filesystem files, not entity types, so the "icons come from the backend
  // type registry" rule does not apply here.
  const [Icon] = FILE_OPS[file.kind];
  return (
    <button
      type="button"
      data-testid="turn-file-chip"
      data-path={file.path}
      data-kind={file.kind}
      disabled={!openable}
      onClick={() => opener.open(file.path)}
      title={openable ? t`Open ${file.path}` : file.path}
      className={`${CHIP_BASE} ${!openable ? CHIP_INERT : file.kind === 'file_write' ? CHIP_CREATE : CHIP_EDIT}`}
    >
      <Icon className="h-3.5 w-3.5 flex-shrink-0" />
      <span className="truncate font-medium">{file.name}</span>
    </button>
  );
}

/**
 * The tail of a long turn. A refactor that touches thirty files must not paper
 * the transcript with thirty chips, so everything past the inline limit lives
 * one click away — the same popover shape the live turn-event chip uses.
 */
function OverflowChip({
  files,
  opener,
  testId,
}: {
  files: readonly TurnFile[];
  opener: TurnFileOpener;
  testId: string;
}) {
  const { t } = useLingui();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid={testId}
          aria-label={t`Show the other files this turn touched`}
          className={`${CHIP_BASE} ${CHIP_EDIT} tabular-nums`}
        >
          +{files.length}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="max-h-72 w-72 overflow-y-auto p-1">
        <div className="flex flex-col gap-0.5">
          {files.map((file) => {
            const [Icon] = FILE_OPS[file.kind];
            return (
              <button
                key={file.path}
                type="button"
                data-testid="turn-file-chip"
                data-path={file.path}
                data-kind={file.kind}
                disabled={opener.resolve(file.path) === null}
                onClick={() => opener.open(file.path)}
                title={file.path}
                className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-start hover:bg-accent disabled:cursor-default disabled:opacity-70"
              >
                <Icon
                  className={`h-3.5 w-3.5 flex-shrink-0 ${file.kind === 'file_write' ? 'text-blue-500' : 'text-muted-foreground'}`}
                />
                <span className="min-w-0 flex-1 truncate text-xs text-foreground">{file.name}</span>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
