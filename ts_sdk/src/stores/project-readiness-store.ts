/**
 * Is the current project ready here — every MUST credential value set, every needed connection
 * held? The footer's "Project setup required" warning reads this.
 *
 * Framework-free (a React binding lives in `react/hooks/use-project-readiness`), like the cleanup
 * store. Checked when the project changes, and again whenever something may have changed the
 * answer: a setup run ending, a credential saved. The last answer is kept per project, so switching
 * back shows it at once while the fresh check runs.
 */
import { Project, type ProjectReadiness } from '../entities/project';

let current: ProjectReadiness | null = null;
let currentProjectId: string | null = null;
const byProject = new Map<string, ProjectReadiness>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeToProjectReadiness(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getProjectReadiness(): ProjectReadiness | null {
  return current;
}

/** Check `projectId` now (background, never throws). A null id clears the answer. */
export async function refreshProjectReadiness(projectId: string | null | undefined): Promise<void> {
  currentProjectId = projectId ?? null;
  current = projectId ? (byProject.get(projectId) ?? null) : null;
  emit();
  if (!projectId) return;
  const readiness = await Project.setupRequirements(projectId).catch(() => null);
  if (!readiness) return;
  byProject.set(projectId, readiness);
  // A slower answer for a project the user already switched away from must not show.
  if (currentProjectId === projectId) {
    current = readiness;
    emit();
  }
}

/** Re-check the project last checked — after a setup run or a credential save. */
export function recheckProjectReadiness(): Promise<void> {
  return refreshProjectReadiness(currentProjectId);
}
