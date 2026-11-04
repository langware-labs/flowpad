/**
 * A project's status on this machine (`project.local_status`), live.
 *
 * The status rides the project row (a computed field), so watching the row brings every change the
 * backend pushes. On mount the hook asks for `parts` once: the backend answers at once with what is
 * stored and refreshes whatever is missing, old or stale behind it — that answer then arrives as a
 * push. Nothing here polls.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { Project, type ProjectStatus, type ProjectStatusPart } from '../../entities/project';
import { TypeId } from '../../models/TypeId';
import { useEntity } from './entity-hooks';

/** A project's TypeId, or null for an id that is not one (nothing to read then). */
export function projectTypeId(projectId: string | null | undefined): TypeId | null {
  if (!projectId) return null;
  try {
    return new TypeId(Project.type, projectId);
  } catch {
    return null;
  }
}

/** The latest answer among a status's parts — how two copies of the same status are told apart. */
function age(status: ProjectStatus | null | undefined): number {
  let latest = -1;
  for (const part of Object.values(status?.parts ?? {})) {
    if (!part) continue;
    // A part being checked is newer than the same part not being checked yet.
    latest = Math.max(latest, (part.checked_at ?? 0) + (part.checking ? 0.5 : 0));
  }
  return latest;
}

export interface UseProjectStatus {
  status: ProjectStatus | null;
  /** One part, or undefined while the project has none stored yet. */
  part: <T = unknown>(name: string) => ProjectStatusPart<T> | undefined;
}

export function useProjectStatus(projectId: string | null | undefined, parts: string[] = ['setup']): UseProjectStatus {
  const typeId = useMemo(() => projectTypeId(projectId), [projectId]);
  const { data: project } = useEntity<Project>(typeId, { watch: true });
  const [answered, setAnswered] = useState<ProjectStatus | null>(null);
  const partsKey = parts.join(',');

  useEffect(() => {
    setAnswered(null);
    if (!projectId) return;
    let live = true;
    void Project.status(projectId, partsKey ? partsKey.split(',') : [])
      .then((status) => {
        if (live) setAnswered(status);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [projectId, partsKey]);

  const pushed = project?.local_status ?? null;
  const status = useMemo(() => {
    const own = (s: ProjectStatus | null) => (s && String(s.project_id) === String(projectId) ? s : null);
    const a = own(pushed);
    const b = own(answered);
    if (!a) return b;
    if (!b) return a;
    return age(b) > age(a) ? b : a;
  }, [pushed, answered, projectId]);

  const part = useCallback(
    <T = unknown>(name: string) => status?.parts[name] as ProjectStatusPart<T> | undefined,
    [status],
  );

  return { status, part };
}
