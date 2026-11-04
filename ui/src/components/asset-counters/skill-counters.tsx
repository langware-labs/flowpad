import { QueryRequest, Skill } from '@sdk';
import { useEntitiesQuery, useProject } from '@sdk/react/hooks';
import { Trans } from '@lingui/react/macro';
import { useMemo } from 'react';
import { crossCounters, useScopes } from './axes';
import type { AssetColumn, AssetCounterGroup } from './types';

// Same request as `useSkillsByName` (type + scope + query), so both share one fetch.
const ALL_SKILLS = new QueryRequest({ type: Skill.type, scope: [], name: 'assetCounters:skills' });
const EMPTY: Skill[] = [];

/** The checkout a skill comes from: the folder above `.claude/skills/`. */
export function skillSource(skill: Skill): string {
  const parts = (skill.asset_ref ?? '').split(/[\\/]/).filter(Boolean);
  const claude = parts.lastIndexOf('.claude');
  return claude > 0 ? parts[claude - 1] : '';
}

/** Skills whose folder sits under one of the project's roots. */
export function skillsUnder(skills: Skill[], roots: string[]): Skill[] {
  const prefixes = roots.map((root) => `${root.replace(/\\/g, '/').replace(/\/$/, '')}/`);
  return skills.filter((skill) => {
    const ref = (skill.asset_ref ?? '').replace(/\\/g, '/');
    return prefixes.some((prefix) => ref.startsWith(prefix));
  });
}

const sorted = (skills: Skill[]) => [...skills].sort((a, b) => a.name.localeCompare(b.name));
const skillCreator = (skill: Skill) => skill.created_by;

function useAllSkills() {
  const { data = EMPTY, isLoading } = useEntitiesQuery<Skill>(ALL_SKILLS);
  return { items: useMemo(() => sorted(data), [data]), isLoading };
}

const columns: AssetColumn<Skill>[] = [
  {
    key: 'skill',
    header: <Trans>Skill</Trans>,
    cell: (skill) => (
      <div className="min-w-0">
        <div className="truncate font-medium text-foreground">{skill.name}</div>
        {skill.description && <div className="truncate text-xs text-muted-foreground">{skill.description}</div>}
      </div>
    ),
    className: 'w-[60%] max-w-0',
  },
  {
    key: 'source',
    header: <Trans>Source</Trans>,
    cell: (skill) => (
      <span className="text-muted-foreground" title={skill.asset_ref}>
        {skillSource(skill)}
      </span>
    ),
  },
];

const common = {
  type: Skill.type,
  itemKey: (skill: Skill) => skill.id,
  searchText: (skill: Skill) => [skill.name, skill.description, skillSource(skill)].filter(Boolean).join(' '),
  itemPointer: (skill: Skill) => skill.dockPointer,
  columns,
};

/** Desktop home: skills have no running state, so Scope is their only axis. */
export const skillCounterGroup: AssetCounterGroup<Skill> = {
  id: 'skills',
  ...common,
  useCounters: () => {
    const { project } = useProject(null);
    const all = useAllSkills();
    const rootsKey = (project?.context_roots ?? []).join('|');
    const projectItems = useMemo(
      () => skillsUnder(all.items, rootsKey ? rootsKey.split('|') : []),
      [all.items, rootsKey],
    );
    const scopes = useScopes(all, { items: projectItems, isLoading: all.isLoading }, skillCreator);
    return useMemo(() => crossCounters({ label: <Trans>Skills</Trans>, scopes }), [scopes]);
  },
};

/** Hub home: every skill the caller can reach, as one list. */
export const hubSkillCounterGroup: AssetCounterGroup<Skill> = {
  id: 'hub-skills',
  ...common,
  useCounters: () => {
    const { items, isLoading } = useAllSkills();
    return useMemo(() => crossCounters({ label: <Trans>Skills</Trans>, items, isLoading }), [items, isLoading]);
  },
  card: (skill) => ({ title: skill.name, description: skill.description, footer: skillSource(skill) || undefined }),
};
