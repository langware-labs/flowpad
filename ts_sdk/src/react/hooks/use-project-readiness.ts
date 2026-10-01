/** React binding for the framework-free project readiness store. */
import { useSyncExternalStore } from 'react';

import type { ProjectReadiness } from '../../entities/project';
import { getProjectReadiness, subscribeToProjectReadiness } from '../../stores/project-readiness-store';

export function useProjectReadiness(): ProjectReadiness | null {
  return useSyncExternalStore(subscribeToProjectReadiness, getProjectReadiness, getProjectReadiness);
}
