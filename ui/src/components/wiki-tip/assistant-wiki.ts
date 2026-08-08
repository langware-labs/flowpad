import { useEffect, useState } from 'react';
import { dataManager, FLOWPAD_ASSISTANT_PROJECT_UNAME, Project, TypeId } from '@sdk';
import { isHubOnly } from '@src/navigation/hub-runtime';

let pending: Promise<string | null> | undefined;

async function resolve(): Promise<string | null> {
  try {
    const project = await dataManager.getByTypeId<Project>(
      new TypeId(Project.type, `@${FLOWPAD_ASSISTANT_PROJECT_UNAME}`),
    );
    if (!project) return null;
    const wiki = await project.getDefaultWiki();
    return wiki?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * The Flowpad Assistant system project's default wiki id — the space every
 * SHIPPED doc page lives in.
 *
 * Any link to a system doc has to name this space explicitly. The `@local`
 * alias resolves against the *active* project, and page lookup is
 * project-scoped (`wiki/service.py: resolve` falls back to assets filtered by
 * `project_id`), so `@local` finds a shipped page only when the user happens to
 * be inside the assistant project — and renders "no page exists with this name"
 * everywhere else, which is exactly where a help link is most needed.
 *
 * The answer is a session constant, so the in-flight promise is shared: two
 * round-trips on first use, none after, and concurrent callers don't race
 * duplicate lookups. A failed resolve is not cached, so a later call retries.
 */
export function assistantWikiRef(): Promise<string | null> {
  pending ??= resolve().then((ref) => {
    if (ref === null) pending = undefined;
    return ref;
  });
  return pending;
}

/**
 * Hook form for surfaces that render a system-doc link declaratively.
 * Returns `undefined` until resolved, which callers pass straight through as
 * "no explicit space" — the link then behaves as it did before, rather than
 * disappearing while the lookup is in flight.
 */
export function useAssistantWikiSpace(): string | undefined {
  const [space, setSpace] = useState<string | undefined>(undefined);
  useEffect(() => {
    // The hub backend has no assistant project, so the lookup can only 404
    // there — and every hub wiki surface opens in the modal anyway.
    if (isHubOnly()) return;
    let cancelled = false;
    void assistantWikiRef().then((ref) => {
      if (!cancelled && ref) setSpace(ref);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return space;
}
