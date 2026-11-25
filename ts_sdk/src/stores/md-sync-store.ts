/**
 * The current project's markdown sync status (`syncmd`). The footer's MD chip and the
 * "syncmd is not installed" warning both read this.
 *
 * Framework-free (a React binding lives in `react/hooks/use-md-sync`), like the readiness store.
 * Read when the project changes and again whenever git status is checked; the last answer is kept
 * per project, so switching back shows it at once while the fresh read runs.
 */
import { mdSyncService, type MdSyncStatus } from '../services/md-sync-service';

let currentProjectId: string | null = null;
const byProject = new Map<string, MdSyncStatus>();
const reading = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeToMdSync(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getMdSync(): MdSyncStatus | null {
  return currentProjectId ? (byProject.get(currentProjectId) ?? null) : null;
}

function keep(projectId: string, status: MdSyncStatus | null): void {
  // The same answer again (most re-checks) changes nothing and re-renders nobody.
  if (!status || JSON.stringify(status) === JSON.stringify(byProject.get(projectId))) return;
  byProject.set(projectId, status);
  // A slower answer for a project the user already switched away from must not show.
  if (currentProjectId === projectId) emit();
}

/** Read `projectId`'s status now (background, never throws). A null id clears the answer. */
export function refreshMdSync(id: string | null): Promise<void> {
  if (id !== currentProjectId) {
    currentProjectId = id;
    emit();
  }
  if (!id) return Promise.resolve();
  // One read per project at a time: a burst of git status checks asks syncmd once.
  let read = reading.get(id);
  if (!read) {
    read = mdSyncService
      .status(id)
      .then((status) => keep(id, status))
      .catch(() => undefined)
      .finally(() => reading.delete(id));
    reading.set(id, read);
  }
  return read;
}

/** Re-read the project last read — called whenever git status is checked. */
export function recheckMdSync(): Promise<void> {
  return refreshMdSync(currentProjectId);
}

/** Sync the current project's files; the answer carries `written`. Throws when the call fails. */
export async function syncMd(): Promise<MdSyncStatus | null> {
  const id = currentProjectId;
  if (!id) return null;
  const status = await mdSyncService.sync(id);
  keep(id, status);
  return status;
}

/** Start syncing one more source in the current project. Throws when the call fails. */
export async function addMdSyncSource(name: string): Promise<void> {
  const id = currentProjectId;
  if (!id) return;
  keep(id, await mdSyncService.addSource(id, name));
}
