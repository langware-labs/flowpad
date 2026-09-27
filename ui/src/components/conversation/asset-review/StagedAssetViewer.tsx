import { dataManager, MessageAttachment, type StagedFilesResponse } from '@sdk';
import { isFolderShape } from '@sdk/FlowSync/schema';
import { Trans } from '@lingui/react/macro';
import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AssetEditorRouter } from '@src/components/assets/editor/AssetEditorRouter';
import { AssetReadOnlyProvider } from '@src/components/assets/editor/read-only';
import { workerForSessionType } from '@src/components/lens-viewer/shared/transcript-features/transcript-utils';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import { editorForPath, editorForType } from '@src/navigation/asset-doc-types';
import { StagedTranscriptPreview } from './StagedTranscriptPreview';

/** The deepest directory every staged path shares ('' when they share none). */
function commonDir(paths: string[]): string {
  const dirs = paths.map((p) => p.split('/').slice(0, -1));
  const first = dirs[0] ?? [];
  let depth = first.length;
  for (const dir of dirs) {
    let i = 0;
    while (i < depth && dir[i] === first[i]) i++;
    depth = i;
  }
  return first.slice(0, depth).join('/');
}

/** The staged file a review opens first: the type's declared main, else the first
 *  file outside a dot-folder (a `.flow/` capsule is identity, not content). */
function mainStagedFile(listing: StagedFilesResponse): string | null {
  const paths = listing.files.map((f) => f.path);
  return listing.main_file ?? paths.find((p) => !p.split('/').some((seg) => seg.startsWith('.'))) ?? paths[0] ?? null;
}

/**
 * Review of a received, not-yet-installed attachment. Review is always BY PATH:
 * the staged copy under the message's record data, opened in the same viewer the
 * dock uses — the one the asset's type declares (a deck folder, a skill, a
 * markdown doc), or for a raw file the one its extension picks (pdf, image, video,
 * audio, html, code). The staged copy has no record until install, so nothing
 * here resolves by TypeId; "Open" after install is the by-record path.
 *
 * Forced read-only: the copy is the sender's, and a save would write into staging.
 */
export function StagedAssetViewer({ attachment }: { attachment: MessageAttachment }) {
  const [listing, setListing] = useState<StagedFilesResponse | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setListing(null);
    setError(false);
    attachment
      .listStagedFiles()
      .then((res) => {
        if (!cancelled) setListing(res);
      })
      .catch((err) => {
        console.error('[asset-review] staged file listing failed', err);
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
    // Keyed on the id, not the instance: the parent re-resolves the live MA on
    // every WS update (install/uninstall), but the staged tree never changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachment.id]);

  if (error) {
    return (
      <div className="py-6 text-center text-sm text-muted-foreground">
        <Trans>Staged content is unavailable — re-download the message attachments.</Trans>
      </div>
    );
  }
  if (!listing) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );
  }
  const main = mainStagedFile(listing);
  if (!main) {
    return (
      <div className="py-6 text-center text-sm text-muted-foreground">
        <Trans>Nothing to review — the attachment has no files.</Trans>
      </div>
    );
  }

  // A worker transcript renders from its staged file directly (server-side parse by path).
  const transcriptWorker = workerForSessionType(attachment.asset_type);
  if (transcriptWorker && main.endsWith('.jsonl')) {
    return (
      <div className="max-h-[50vh] overflow-y-auto pe-1">
        <StagedTranscriptPreview workerType={transcriptWorker} path={`${listing.abs_root}/${main}`} />
      </div>
    );
  }

  const assetType = attachment.asset_type ?? '';
  const paths = listing.files.map((f) => f.path);
  const shape = dataManager.getTypeInfo(assetType)?.shape;
  const typeEditor = editorForType(assetType);
  // A folder-shaped type opens at its folder (its viewer owns the layout) — but
  // only when the staged copy HAS that layout. A copy without the declared main
  // (a header-only task row) opens its file by extension instead.
  let editor = typeEditor ?? editorForPath(main);
  let rel = main;
  if (typeEditor && isFolderShape(shape)) {
    const declaredMain = shape.main ? paths.find((p) => p.split('/').pop() === shape.main) : undefined;
    if (declaredMain) rel = declaredMain.split('/').slice(0, -1).join('/');
    else if (!shape.main) rel = commonDir(paths);
    else editor = editorForPath(main);
  }
  const pointer = AssetDocPointer.forVfs(editor, rel ? `${listing.abs_root}/${rel}` : listing.abs_root).toPointer();

  return (
    <div className="h-[55vh] overflow-hidden rounded border border-border" data-testid="staged-review">
      <AssetReadOnlyProvider value>
        <AssetEditorRouter key={pointer} pointer={pointer} />
      </AssetReadOnlyProvider>
    </div>
  );
}
