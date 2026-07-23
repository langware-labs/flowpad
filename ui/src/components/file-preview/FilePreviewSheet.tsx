/**
 * Peek at a file without leaving where you are: a sheet holding a header and
 * the REAL editor.
 *
 * Deliberately not a bespoke viewer. Monaco is the app's asset editor, so a
 * preview that hand-rolled its own line rendering would drift from the thing it
 * previews — different highlighting, different wrapping, a second place to fix
 * bugs. This mounts `EditorPane` read-only, which means content loading,
 * scroll-to-line and the deep-link line marker are all the same code path the
 * full editor uses.
 *
 * Presentation only — the sheet takes its target as a prop. `FilePreviewRoot`
 * is the global host that reads the store and mounts this once, per the
 * overlay convention in docs/wikitip.md; callers open it with
 * `openFilePreview()` and never mount it themselves.
 */

import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useMemo } from 'react';
import { detectLanguage, VFSPath } from '@sdk';
import { useFS } from '@sdk/react/hooks';
import { EditorPane, type EditorFileData } from '@src/components/code-editor/EditorPane';
import { Button } from '@src/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@src/components/ui/sheet';
import type { FilePreviewTarget } from './file-preview';

export function FilePreviewSheet({
  target,
  onClose,
  onOpen,
}: {
  target: FilePreviewTarget | null;
  onClose: () => void;
  /** "Open in editor" — hand the same target to the real dock. */
  onOpen: (target: FilePreviewTarget) => void;
}) {
  const { t } = useLingui();
  const fs = useFS(target?.typeId);

  /*
   * `EditorPane` reads its content from the FS cache keyed by the entity in
   * `file.path` — it takes NO content from props. So it must be handed a VFS
   * path (`compute_node-<id>/abs/path`), not the caller's machine path: with a
   * bare machine path it falls back to the ambient project entity, requests the
   * file from the wrong place, and renders empty.
   */
  const { file, entityPath } = useMemo(() => {
    if (!target) return { file: undefined, entityPath: null };
    const vfsPath = VFSPath.fromMachinePath(target.path, target.typeId).rawPath;
    const sub = VFSPath.parse(vfsPath).entitySubPath;
    return {
      file: { path: vfsPath, language: detectLanguage(target.path) } as EditorFileData,
      entityPath: sub.startsWith('/') ? sub : `/${sub}`,
    };
  }, [target]);

  /*
   * Warm the FS cache the pane reads from.
   *
   * `EditorPane` does auto-download when its cache entry is missing, but that
   * path did not settle for a freshly-mounted pane inside the sheet — it
   * rendered an empty model. `CodeEditor` has always primed the cache before
   * mounting the pane; doing the same here keeps the two hosts symmetric rather
   * than relying on a fallback that only one of them exercises.
   */
  /*
   * Keyed on the target's identity, NOT on `fs`: `useFS()` returns a fresh
   * object every render, and this sheet re-renders with its host editor on
   * every selection change. Listing `fs` in the deps re-fired this effect
   * throughout the load window, and `downloadFile` only dedupes against the
   * COMPLETED cache — so each re-fire issued another request for the same file.
   */
  useEffect(() => {
    if (!fs || !entityPath) return;
    void fs.download(entityPath, false).catch(() => {
      /* stays on the loading state; the header still names what was opened */
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [target?.typeId?.toString(), entityPath]);

  /*
   * Only mount the pane once the text is actually cached.
   *
   * Not cosmetic. `EditorPane` renders `<Editor value={fileContent}>`, and a
   * Monaco mounted with an empty value does NOT pick the text up when it
   * arrives — it keeps a 1-line model, so the reveal lands on line 1 and the
   * highlight marks an empty row. `CodeEditor` never hits this because it
   * primes the cache before mounting the pane; the sheet has to do the same by
   * waiting.
   */
  const contentReady = useMemo(() => {
    if (!fs || !entityPath) return false;
    return typeof fs.content(entityPath)?.content === 'string';
  }, [fs, entityPath]);

  if (!target || !file) return null;
  const filename = target.path.split('/').pop() || target.path;

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="flex w-full max-w-3xl flex-col gap-0 bg-card p-0 sm:max-w-3xl"
        data-testid="file-preview-sheet"
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0">
            <SheetTitle className="truncate font-mono text-sm font-semibold leading-tight">
              {filename}
              {target.line ? `:${target.line}` : ''}
            </SheetTitle>
            <SheetDescription className="truncate text-xs text-muted-foreground">
              {target.path}
            </SheetDescription>
          </div>
          <Button size="sm" onClick={() => onOpen(target)} title={t`Open in editor`}>
            <Trans>Open in editor</Trans>
          </Button>
        </div>

        {/* `min-h-0` matters: without it the flex child refuses to shrink and
            Monaco is handed a container it cannot measure. */}
        <div className="min-h-0 flex-1 overflow-hidden">
          {contentReady ? (
            <EditorPane file={file} readOnly revealLine={target.line ?? null} />
          ) : (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              <Trans>Loading…</Trans>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
