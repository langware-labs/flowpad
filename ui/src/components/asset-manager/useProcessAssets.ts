import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AgenticProcess,
  Agent,
  Skill,
  QueryRequest,
  type AssetDescriptor,
} from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';

/**
 * Read-side hook over `process.getAssets()`.
 *
 * When a process exists: returns the unified descriptor list (EMBEDDED +
 * INLINE + USER_DIR + PROJECT_DIR + WORKDIR + ADDITIONAL_DIR).
 *
 * When `process === null` (pre-first-send staging): falls back to the global
 * Agent + Skill entity queries and synthesizes USER_DIR descriptors so the
 * UI can still show pickable items before the process exists.
 */
export interface UseProcessAssetsResult {
  descriptors: AssetDescriptor[];
  isLoading: boolean;
  refresh: () => Promise<void>;
}

export function useProcessAssets(
  process: AgenticProcess | null,
  options?: { enabled?: boolean },
): UseProcessAssetsResult {
  const enabled = options?.enabled !== false;

  // Pre-process fallback: list all globally-discoverable agents + skills.
  const agentQuery = useMemo(() => new QueryRequest({ type: Agent.type }), []);
  const skillQuery = useMemo(() => new QueryRequest({ type: Skill.type }), []);
  const { data: agents = [] } = useEntitiesQuery<Agent>(agentQuery, {
    enabled: enabled && !process,
  });
  const { data: skills = [] } = useEntitiesQuery<Skill>(skillQuery, {
    enabled: enabled && !process,
  });

  const [descriptors, setDescriptors] = useState<AssetDescriptor[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(enabled);
  const tickRef = useRef(0);

  // Stash the latest agents/skills in refs so refresh can read them without
  // appearing in its deps. ``useEntitiesQuery`` returns a fresh ``[]`` default
  // every render when disabled — including those arrays in ``refresh``'s deps
  // would invalidate ``refresh``'s identity on every parent re-render and
  // (paired with ``useEffect([refresh])``) stampede ``getAssets()`` at the
  // backend on a 30+ Hz loop.
  const agentsRef = useRef(agents);
  const skillsRef = useRef(skills);
  useEffect(() => {
    agentsRef.current = agents;
    skillsRef.current = skills;
  }, [agents, skills]);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const tick = ++tickRef.current;
    setIsLoading(true);

    try {
      if (process) {
        const result = await process.getAssets();
        if (tickRef.current === tick) setDescriptors(result);
      } else {
        const synthetic: AssetDescriptor[] = [
          ...agentsRef.current.map<AssetDescriptor>((a) => ({
            typeid: `agent-${a.id}`,
            source: 'user_dir',
            posix_path: (a as { asset_ref?: string }).asset_ref ?? null,
          })),
          ...skillsRef.current.map<AssetDescriptor>((s) => ({
            typeid: `skill-${s.id}`,
            source: 'user_dir',
            posix_path: (s as { asset_ref?: string }).asset_ref ?? null,
          })),
        ];
        if (tickRef.current === tick) setDescriptors(synthetic);
      }
    } catch (err) {
      console.error('[useProcessAssets] failed', err);
      if (tickRef.current === tick) setDescriptors([]);
    } finally {
      if (tickRef.current === tick) setIsLoading(false);
    }
  }, [process, enabled]);

  // Re-fetch when the process identity changes (or the hook becomes enabled).
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Synthetic-mode flush: when there's no process, the descriptor list is
  // derived from the agent + skill entity queries above. Those queries finish
  // *after* the initial refresh() runs, so without this effect the popover
  // would render "no assets" until the user toggled it. Re-flush whenever the
  // counts change so newly-loaded entities surface immediately.
  useEffect(() => {
    if (!enabled || process) return;
    void refresh();
  }, [enabled, process, agents.length, skills.length, refresh]);

  return { descriptors, isLoading, refresh };
}
