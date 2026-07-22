import { Artifact, WorldViewProjection } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import type { NavigationActions } from '@src/navigation';

interface OpenArtifactOptions {
  navigation: NavigationActions;
  /** Retained for callers compiled against the old signature; WorldView is project-neutral. */
  currentProjectId?: string | null;
}

/** Artifact identity opens in WorldView; the loader owns active context. */
export function openArtifact(artifact: Artifact, { navigation }: OpenArtifactOptions): void {
  navigation.openDock(
    DockPointer.forWorldView(WorldViewProjection.DEPLOYMENT, {
      focus: artifact.typeId,
      selected: artifact.typeId.toString(),
    }),
  );
}
