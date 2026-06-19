import { Skill } from '@sdk';
import { QueryRequest } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { useMemo } from 'react';

// Module-scope (stable identity): an inline `new QueryRequest(...)` per render
// makes `useEntitiesQuery` re-subscribe every render. Declare it once.
const skillsQuery = new QueryRequest({
  type: Skill.type,
  scope: [],
  name: 'useSkillsByName:all',
});

export interface SkillsByName {
  skills: Skill[];
  byName: Map<string, Skill>;
  /** True iff a skill of this name is flagged `eval: true`. */
  isEvalByName: (name: string) => boolean;
}

/**
 * All Skill entities, indexed by name. Skills are a small set, so one cached
 * query + a Map lookup beats N per-name queries (and avoids per-render
 * QueryRequest churn). Used to resolve a skill's eval flag from a call-stack
 * frame's `callable` (the skill name).
 */
export function useSkillsByName(): SkillsByName {
  const { data: skills = [] } = useEntitiesQuery<Skill>(skillsQuery);
  const byName = useMemo(() => new Map(skills.map((s) => [s.name, s])), [skills]);
  const isEvalByName = (name: string) => byName.get(name)?.isEval ?? false;
  return { skills, byName, isEvalByName };
}
