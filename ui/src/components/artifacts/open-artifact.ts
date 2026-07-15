import { Artifact, dataContext } from '@sdk';
import type { NavigationActions } from '@src/navigation';
import { openDisplayTarget } from '@src/navigation/open-display-target';

interface OpenArtifactOptions {
  navigation: NavigationActions;
  currentProjectId?: string | null;
}

/**
 * Open an already-materialized artifact.
 *
 * The what-to-do decision is backend-owned: the `setup` action
 * (`Entity.setup_on_receive`, overridden per `artifact_type` on `Artifact`)
 * returns a DisplayTarget — a WEBAPP artifact is set up + shown in a spawned Vibe
 * session via the `artifact-setup` skill; any other kind resolves to its file. The
 * FE just routes the returned target through `openDisplayTarget`; it never branches
 * on the artifact kind.
 */
export async function openArtifact(artifact: Artifact, opts: OpenArtifactOptions): Promise<void> {
  const { navigation, currentProjectId } = opts;
  const projectId = currentProjectId ?? artifact.project_id ?? dataContext.project?.id ?? null;
  const show = await artifact.setup(projectId);
  openDisplayTarget(show, navigation);
}
