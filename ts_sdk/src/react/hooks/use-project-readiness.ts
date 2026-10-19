/** React binding for the framework-free project readiness store. */
import { useSyncExternalStore } from 'react';

import type { ProjectReadiness } from '../../entities/project';
import { getProjectReadiness, subscribeToProjectReadiness } from '../../stores/project-readiness-store';

export function useProjectReadiness(): ProjectReadiness | null {
  return useSyncExternalStore(subscribeToProjectReadiness, getProjectReadiness, getProjectReadiness);
}

/** How many things `projectId` still needs set up here — 0 when ready, unknown, or the answer is
 *  another project's. The one reading of "setup required": the footer warning and the nav bar's
 *  button both ask this. */
export function useProjectSetupLeft(projectId: string | null | undefined): number {
  const readiness = useProjectReadiness();
  return readiness && projectId && readiness.project_id === String(projectId) && !readiness.ready
    ? readiness.to_do.length
    : 0;
}
