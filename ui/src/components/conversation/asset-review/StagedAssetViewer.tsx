import { MessageAttachment, type StagedFilesResponse } from '@sdk';
import { Trans } from '@lingui/react/macro';
import { Loader2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { AssetEditorRouter } from '@src/components/assets/editor/AssetEditorRouter';
import { AssetReadOnlyProvider } from '@src/components/assets/editor/read-only';
import { workerForSessionType } from '@src/components/lens-viewer/shared/transcript-features/transcript-utils';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import { editorForPath, editorForType } from '@src/navigation/asset-doc-types';
import { StagedTranscriptPreview } from './StagedTranscriptPreview';

/**
 * What review opens for a staged copy. Where the backend located the asset by its
 * type's shape (`asset_root`), the type's own viewer opens it there, as that type; a
 * copy without that shape (a raw file, a header-only row) opens its main file in the
 * viewer the extension picks, as no type.
 */
function reviewTarget(listing: StagedFilesResponse, assetType: string): { pointer: string; assetType?: string } | null {
  const typeEditor = editorForType(assetType);
  if (listing.asset_root != null && typeEditor) {
    const root = listing.asset_root ? `${listing.abs_root}/${listing.asset_root}` : listing.abs_root;
    return { pointer: AssetDocPointer.forVfs(typeEditor, root).toPointer(), assetType };
  }
  if (!listing.main_file) return null;
  return { pointer: AssetDocPointer.forVfs(editorForPath(listing.main_file), `${listing.abs_root}/${listing.main_file}`).toPointer() };
}

/**
 * Review of a received, not-yet-installed attachment. Review is always BY PATH:
 * the staged copy under the message's record data, in the same viewer the dock
 * uses. The copy has no record until install, so nothing here resolves by TypeId;
 * "Open" after install is the by-record path.
 *
 * Forced read-only: the copy is the sender's, and a save would write into staging.
 */
export function StagedAssetViewer({ attachment }: { attachment: MessageAttachment }) {
  const [listing, setListing] = useState<StagedFilesResponse | null>(null);
  const [error, setError] = useState(false);
  const assetType = attachment.asset_type ?? '';

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

  const target = useMemo(() => (listing ? reviewTarget(listing, assetType) : null), [listing, assetType]);
  const occurrence = useMemo(() => ({ assetType: target?.assetType }), [target?.assetType]);

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
  if (!target || !listing.main_file) {
    return (
      <div className="py-6 text-center text-sm text-muted-foreground">
        <Trans>Nothing to review — the attachment has no files.</Trans>
      </div>
    );
  }

  // A worker transcript renders from its staged file directly (server-side parse by path).
  const transcriptWorker = workerForSessionType(assetType);
  if (transcriptWorker && listing.main_file.endsWith('.jsonl')) {
    return (
      <div className="max-h-[50vh] overflow-y-auto pe-1">
        <StagedTranscriptPreview workerType={transcriptWorker} path={`${listing.abs_root}/${listing.main_file}`} />
      </div>
    );
  }

  return (
    <div className="h-[55vh] overflow-hidden rounded border border-border" data-testid="staged-review">
      <AssetReadOnlyProvider value={occurrence}>
        <AssetEditorRouter key={target.pointer} pointer={target.pointer} />
      </AssetReadOnlyProvider>
    </div>
  );
}
