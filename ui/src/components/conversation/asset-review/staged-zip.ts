import { AssetEditor, editorForPath } from '@src/navigation/asset-doc-types';
import type { StagedFilesResponse } from '@sdk';

/** A received attachment the archive viewer opens — staged as the folder it extracts to. */
export function isArchiveName(name: string | null | undefined): boolean {
  return !!name && editorForPath(name) === AssetEditor.ARCHIVE;
}

/**
 * The folder a staged zip extracted to: `<abs_root>/<zip stem>` when every staged
 * file sits under it (the untyped layout), else the staged root itself.
 */
export function stagedZipRoot(listing: StagedFilesResponse, zipName: string): string {
  const stem = zipName.replace(/\.[^.]+$/, '');
  const under = listing.files.length > 0 && listing.files.every((f) => f.path.startsWith(`${stem}/`));
  return under ? `${listing.abs_root}/${stem}` : listing.abs_root;
}
