import { Artifact, WorldViewProjection } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import type { NavigationActions } from '@src/navigation';

interface OpenArtifactOptions {
  navigation: NavigationActions;
  /** Retained for callers compiled against the old signature; WorldView is project-neutral. */
  currentProjectId?: string | null;
}

/** The kind of an artifact that stands for one shared file (backend `SHARED_FILE_KIND`). */
const SHARED_FILE_KIND = 'content.file.text';

/** Artifact identity opens in WorldView; the loader owns active context. A
 *  shared FILE (an .html page received by git) opens as that file instead. */
export function openArtifact(artifact: Artifact, { navigation }: OpenArtifactOptions): void {
  const assetRef = (artifact as { asset_ref?: string }).asset_ref;
  if (artifact.kind === SHARED_FILE_KIND && assetRef) {
    navigation.openDock(DockPointer.forAssetEditor('file', assetRef));
    return;
  }
  navigation.openDock(
    DockPointer.forWorldView(WorldViewProjection.DEPLOYMENT, {
      focus: artifact.typeId,
      selected: artifact.typeId.toString(),
    }),
  );
}
