import { Artifact } from '@sdk';
import { buildDockPointer } from '@src/navigation/entity-pointer';
import type { NavigationActions } from '@src/navigation';

interface OpenArtifactOptions {
  navigation: NavigationActions;
  /** Retained for callers compiled against the old signature; WorldView is project-neutral. */
  currentProjectId?: string | null;
}

/** Open an artifact where `buildDockPointer` says it opens: a shared file as that file, any other
 *  in WorldView. */
export function openArtifact(artifact: Artifact, { navigation }: OpenArtifactOptions): void {
  const pointer = buildDockPointer(artifact as Artifact & { type: string; id: string }, undefined);
  if (pointer) navigation.openDock(pointer);
}
