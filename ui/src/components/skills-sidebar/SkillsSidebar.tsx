import { type SkillItem } from '@sdk';
import { Badge } from '@src/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { Folder, Loader2, Pin, PinOff, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import './SkillsSidebar.css';

type SkillLocation = 'User' | 'Project' | 'Plugin' | 'Draft';

export interface SkillsSidebarProps {
  skills: SkillItem[] | undefined;
  isLoading: boolean;
  onSkillClick?: (skill: SkillItem) => void;
}

const locationFilters: SkillLocation[] = ['User', 'Project', 'Plugin', 'Draft'];

function getSkillLocation(skill: SkillItem): SkillLocation {
  const rawPath = (skill.path || skill.source_file || '').replace(/\\/g, '/');
  const scope = (skill.scope || '').toLowerCase();

  if (!rawPath && scope) return 'Draft';
  if (!rawPath && !scope) return 'Draft';
  if (rawPath.toLowerCase().includes('/.flow/system_skills/')) return 'Plugin';
  if (scope === 'project') return 'Project';
  if (scope === 'plugin' || scope === 'system') return 'Plugin';
  if (scope === 'user') return 'User';
  if (scope === 'local' || scope === 'draft' || scope === 'unpublished') return 'Draft';
  return 'User';
}

function getSkillTimestamp(skill: SkillItem): number {
  const value = skill.modified_at ?? skill.created_at ?? '';
  const timestamp = value ? new Date(value).getTime() : 0;
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

export function SkillsSidebar({ skills, isLoading, onSkillClick }: SkillsSidebarProps) {
  const { t } = useLingui();
  const favoriteGap = 1000;
  const storageKey = 'flowpad.skills.favoriteIndex';
  const [activeFilters, setActiveFilters] = useState<Set<SkillLocation>>(() => new Set<SkillLocation>(locationFilters));
  const [query, setQuery] = useState('');
  const [favoriteIndexMap, setFavoriteIndexMap] = useState<Record<string, number>>(() => {
    if (typeof window === 'undefined') return {};
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as Record<string, number>;
      if (!parsed || typeof parsed !== 'object') return {};
      return parsed;
    } catch {
      return {};
    }
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(favoriteIndexMap));
    } catch {
      // Ignore storage failures (private mode, quota exceeded)
    }
  }, [favoriteIndexMap]);

  const toggleFilter = (filter: SkillLocation) => {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(filter)) {
        next.delete(filter);
      } else {
        next.add(filter);
      }
      return next;
    });
  };

  const filteredSkills = useMemo(() => {
    if (!skills) return [];
    return skills
      .slice()
      .filter((skill) => activeFilters.has(getSkillLocation(skill)))
      .filter((skill) => {
        if (!query.trim()) return true;
        const haystack = `${skill.name} ${skill.path ?? ''} ${skill.source_file ?? ''}`.toLowerCase();
        return haystack.includes(query.trim().toLowerCase());
      });
  }, [skills, activeFilters, query]);

  const getFavoriteIndex = (skill: SkillItem) => {
    const stored = favoriteIndexMap[skill.id];
    if (stored !== undefined) return stored;
    return skill.favorite_index ?? null;
  };

  const getNextFavoriteIndex = (items: SkillItem[]) => {
    let max = 0;
    for (const skill of items) {
      const value = getFavoriteIndex(skill);
      if (value !== null && value !== undefined) {
        max = Math.max(max, value);
      }
    }
    return max + favoriteGap;
  };

  const handleTogglePin = (skill: SkillItem) => {
    const currentIndex = getFavoriteIndex(skill);
    setFavoriteIndexMap((prev) => {
      const next = { ...prev };
      if (currentIndex !== null && currentIndex !== undefined) {
        delete next[skill.id];
        return next;
      }
      next[skill.id] = getNextFavoriteIndex(filteredSkills);
      return next;
    });
  };

  const [pinnedSkills, unpinnedSkills] = useMemo(() => {
    const withFavorite = filteredSkills.map((skill) => ({
      skill,
      favorite_index: getFavoriteIndex(skill),
    }));
    const pinned = withFavorite
      .filter((item) => item.favorite_index !== null && item.favorite_index !== undefined)
      .sort((a, b) => (a.favorite_index ?? 0) - (b.favorite_index ?? 0))
      .map((item) => item.skill);
    const unpinned = withFavorite
      .filter((item) => item.favorite_index === null || item.favorite_index === undefined)
      .map((item) => item.skill)
      .sort((a, b) => getSkillTimestamp(b) - getSkillTimestamp(a));
    return [pinned, unpinned];
  }, [filteredSkills, favoriteIndexMap]);

  return (
    <div className="skills-sidebar">
      <div className="skills-sidebar-header">
        <div className="skills-sidebar-header-row">
          <Sparkles className="h-3.5 w-3.5 text-muted-foreground" />
          <h3><Trans>Skills</Trans></h3>
          <span className="skills-sidebar-count">{filteredSkills.length}</span>
        </div>
      </div>

      <div className="skills-sidebar-filters">
        {locationFilters.map((filter) => {
          const isActive = activeFilters.has(filter);
          return (
            <button
              key={filter}
              type="button"
              onClick={() => toggleFilter(filter)}
              className={`skills-filter-chip ${isActive ? 'active' : ''}`}
            >
              {filter}
            </button>
          );
        })}
      </div>

      <div className="skills-sidebar-search">
        <input
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t`Search skills...`}
          className="skills-sidebar-search-input"
        />
      </div>

      <div className="skills-sidebar-content">
        {isLoading ? (
          <div className="skills-sidebar-loading">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span><Trans>Loading...</Trans></span>
          </div>
        ) : !skills || skills.length === 0 ? (
          <div className="skills-sidebar-empty">
            <Folder className="h-8 w-8 opacity-30" />
            <span><Trans>No skills yet</Trans></span>
          </div>
        ) : filteredSkills.length === 0 ? (
          <div className="skills-sidebar-empty">
            <span><Trans>No skills match those filters</Trans></span>
          </div>
        ) : (
          <ul className="skills-sidebar-list">
            <TooltipProvider delayDuration={300}>
              {pinnedSkills.map((skill) => {
                const location = getSkillLocation(skill);
                const tooltip = skill.path || skill.source_file || skill.name;
                return (
                  <li key={skill.id} className="skills-sidebar-list-item">
                    <Tooltip>
                      <div className="skills-sidebar-item">
                        <TooltipTrigger asChild>
                          <button className="skills-sidebar-item-main" onClick={() => onSkillClick?.(skill)}>
                            <span className="skills-sidebar-name">{skill.name}</span>
                            <Badge variant="outline" className="skills-sidebar-chip">
                              {location}
                            </Badge>
                          </button>
                        </TooltipTrigger>
                        <button
                          type="button"
                          className="skills-sidebar-pin pinned"
                          onClick={(event) => {
                            event.stopPropagation();
                            handleTogglePin(skill);
                          }}
                          aria-label={t`Unpin skill`}
                          aria-pressed
                        >
                          <Pin className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <TooltipContent side="right" className="max-w-xs break-all text-xs">
                        {tooltip}
                      </TooltipContent>
                    </Tooltip>
                  </li>
                );
              })}
              {pinnedSkills.length > 0 && unpinnedSkills.length > 0 ? (
                <li className="skills-sidebar-divider" aria-hidden="true" />
              ) : null}
              {unpinnedSkills.map((skill) => {
                const location = getSkillLocation(skill);
                const tooltip = skill.path || skill.source_file || skill.name;
                return (
                  <li key={skill.id} className="skills-sidebar-list-item">
                    <Tooltip>
                      <div className="skills-sidebar-item">
                        <TooltipTrigger asChild>
                          <button className="skills-sidebar-item-main" onClick={() => onSkillClick?.(skill)}>
                            <span className="skills-sidebar-name">{skill.name}</span>
                            <Badge variant="outline" className="skills-sidebar-chip">
                              {location}
                            </Badge>
                          </button>
                        </TooltipTrigger>
                        <button
                          type="button"
                          className="skills-sidebar-pin"
                          onClick={(event) => {
                            event.stopPropagation();
                            handleTogglePin(skill);
                          }}
                          aria-label={t`Pin skill`}
                          aria-pressed={false}
                        >
                          <PinOff className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <TooltipContent side="right" className="max-w-xs break-all text-xs">
                        {tooltip}
                      </TooltipContent>
                    </Tooltip>
                  </li>
                );
              })}
            </TooltipProvider>
          </ul>
        )}
      </div>
    </div>
  );
}

export default SkillsSidebar;
