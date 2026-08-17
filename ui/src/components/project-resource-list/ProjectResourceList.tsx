import { msg } from '@lingui/core/macro';
import { i18n } from '@lingui/core';
import type { ClaudeSessionStatus } from '@sdk/resource_management/fs_records/claude/claude-session';
import { FusionSpinner } from '@src/components/icons/FusionSpinner';
import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@src/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import {
  Bot,
  CheckSquare,
  Command,
  FileText,
  Folder,
  FolderOpen,
  Plug,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Terminal,
} from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMemo, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import './ProjectResourceList.css';

export type ProjectResourceType =
  | 'skill'
  | 'mcp_server'
  | 'plugin'
  | 'hook'
  | 'command'
  | 'agent'
  | 'claude_session'
  | 'collaboration_room'
  | 'todo'
  | 'claude_md';

export interface ProjectResourceListItem {
  id: string;
  name: string;
  type: ProjectResourceType;
  subtitle?: string;
  path?: string;
  /** Session ID (for lens navigation) */
  sessionId?: string;
  /** Machine path to session directory (for transcript lens) */
  sessionPath?: string;
  /** Machine path to tasks directory (for task lens) */
  taskPath?: string;
  /** Number of messages in the session */
  messageCount?: number;
  /** Session status derived from transcript */
  status?: ClaudeSessionStatus;
  modifiedAt?: string | null;
  itemId?: string;
  skillDockPath?: string;
}

export interface ProjectSelectOption {
  id: string;
  label: string;
}

export interface ProjectResourceListProps {
  projects: ProjectSelectOption[];
  selectedProjectId?: string;
  onProjectSelect: (projectId: string) => void;
  onManageProjectClick?: () => void;
  resources: ProjectResourceListItem[] | undefined;
  isLoading: boolean;
  onResourceClick?: (resource: ProjectResourceListItem) => void;
  onSessionResume?: (resource: ProjectResourceListItem) => void;
}

interface ResourceTypeMeta {
  label: string;
  icon: LucideIcon;
}

const RESOURCE_TYPE_META: Record<ProjectResourceType, ResourceTypeMeta> = {
  skill: { label: msg`Skill`, icon: Sparkles },
  mcp_server: { label: msg`MCP`, icon: Plug },
  plugin: { label: msg`Plugin`, icon: Settings },
  hook: { label: msg`Hook`, icon: Terminal },
  command: { label: msg`Command`, icon: Command },
  agent: { label: msg`SubAgent`, icon: Bot },
  session: { label: msg`Session`, icon: FolderOpen },
  todo: { label: msg`Todo`, icon: CheckSquare },
  claude_md: { label: msg`CLAUDE.md`, icon: FileText },
};

const ALL_RESOURCE_TYPES = Object.keys(RESOURCE_TYPE_META) as ProjectResourceType[];
const NON_SESSION_TYPES = ALL_RESOURCE_TYPES.filter((type) => type !== 'claude_session');

const DEFAULT_FILTERS = new Set<ProjectResourceType>(NON_SESSION_TYPES);

const getTimestamp = (value?: string | null): number => {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
};

const setsEqual = (a: Set<ProjectResourceType>, b: Set<ProjectResourceType>): boolean => {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
};

export function ProjectResourceList({
  projects,
  selectedProjectId,
  onProjectSelect,
  onManageProjectClick,
  resources,
  isLoading,
  onResourceClick,
  onSessionResume,
}: ProjectResourceListProps) {
  const { t } = useLingui();
  const [activeFilters, setActiveFilters] = useState<Set<ProjectResourceType>>(() => new Set(DEFAULT_FILTERS));
  const [query, setQuery] = useState('');

  const showSessions = activeFilters.has('claude_session');
  const isNonDefaultFilters = !setsEqual(activeFilters, DEFAULT_FILTERS);

  const availableResourceTypes = useMemo(() => {
    const available = new Set((resources ?? []).map((r) => r.type));
    available.delete('claude_session');
    if (available.size === 0) return NON_SESSION_TYPES;
    return NON_SESSION_TYPES.filter((type) => available.has(type));
  }, [resources]);

  const filteredItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return (resources ?? [])
      .filter((resource) => activeFilters.has(resource.type))
      .filter((resource) => {
        if (!normalizedQuery) return true;
        const haystack = `${resource.name} ${resource.subtitle ?? ''} ${resource.path ?? ''}`.toLowerCase();
        return haystack.includes(normalizedQuery);
      })
      .sort((a, b) => {
        const timestampDiff = getTimestamp(b.modifiedAt) - getTimestamp(a.modifiedAt);
        if (timestampDiff !== 0) return timestampDiff;
        return a.name.localeCompare(b.name);
      });
  }, [resources, activeFilters, query]);

  const totalItems = useMemo(
    () => (resources ?? []).filter((r) => activeFilters.has(r.type)).length,
    [resources, activeFilters],
  );

  const toggleFilter = (type: ProjectResourceType) => {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  };

  const toggleSessions = () => {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has('claude_session')) {
        next.delete('claude_session');
      } else {
        next.add('claude_session');
      }
      return next;
    });
  };

  return (
    <div className="project-resource-list">
      <div className="project-resource-list-header">
        <div className="project-resource-list-header-row">
          <Select value={selectedProjectId || ''} onValueChange={onProjectSelect}>
            <SelectTrigger className="project-resource-list-project-trigger">
              <SelectValue placeholder={t`Select a project`} />
            </SelectTrigger>
            <SelectContent>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="project-resource-list-manage-button"
                onClick={onManageProjectClick}
                aria-label={t`Open or create project`}
              >
                <FolderOpen className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <Trans>Open or create project</Trans>
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className="project-resource-list-search">
        <div className="project-resource-list-search-field">
          <Search className="project-resource-list-search-icon" />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t`Search...`}
            className="project-resource-list-search-input"
          />
        </div>
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={`project-resource-filter-button ${isNonDefaultFilters ? 'project-resource-filter-active' : ''}`}
              aria-label={t`Filter resources`}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="project-resource-filter-popover">
            <label className="project-resource-filter-option">
              <input type="checkbox" checked={showSessions} onChange={toggleSessions} />
              <FolderOpen className="h-3 w-3" />
              <span>
                <Trans>Show Sessions</Trans>
              </span>
            </label>
            <div className="project-resource-filter-separator" />
            {availableResourceTypes.map((type) => {
              const meta = RESOURCE_TYPE_META[type];
              const TypeIcon = meta.icon;
              return (
                <label key={type} className="project-resource-filter-option">
                  <input type="checkbox" checked={activeFilters.has(type)} onChange={() => toggleFilter(type)} />
                  <TypeIcon className="h-3 w-3" />
                  <span>{i18n._(meta.label)}</span>
                </label>
              );
            })}
          </PopoverContent>
        </Popover>
      </div>

      <div className="project-resource-list-content">
        {isLoading ? (
          <div className="project-resource-list-loading">
            <FusionSpinner size="xs" />
            <span>
              <Trans>Loading resources...</Trans>
            </span>
          </div>
        ) : !selectedProjectId ? (
          <div className="project-resource-list-empty">
            <Folder className="h-8 w-8 opacity-30" />
            <span>
              <Trans>Select a project to view resources</Trans>
            </span>
          </div>
        ) : totalItems === 0 ? (
          <div className="project-resource-list-empty">
            <Folder className="h-8 w-8 opacity-30" />
            <span>
              <Trans>No resources found in this project</Trans>
            </span>
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="project-resource-list-empty">
            <span>
              <Trans>No resources match those filters</Trans>
            </span>
          </div>
        ) : (
          <ul className="project-resource-list-items">
            <TooltipProvider delayDuration={250}>
              {filteredItems.map((resource) => {
                const meta = RESOURCE_TYPE_META[resource.type];
                const TypeIcon = meta.icon;
                const tooltipText = resource.path || resource.subtitle || resource.name;
                return (
                  <li key={resource.id} className="project-resource-list-item">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className="project-resource-item"
                          onClick={() => onResourceClick?.(resource)}
                          title={resource.name}
                        >
                          <div className="project-resource-item-main">
                            <span className="project-resource-name">{resource.name}</span>
                            <Badge variant="outline" className="project-resource-chip">
                              <TypeIcon className="h-2.5 w-2.5" />
                              <span>{i18n._(meta.label)}</span>
                            </Badge>
                            {onSessionResume && resource.type === 'claude_session' && (
                              <button
                                type="button"
                                className="project-resource-resume-button"
                                title={t`Resume session in terminal`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onSessionResume(resource);
                                }}
                              >
                                <Terminal className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </div>
                          {resource.subtitle ? (
                            <span className="project-resource-subtitle">{resource.subtitle}</span>
                          ) : null}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="right" className="max-w-xs break-all text-xs">
                        {tooltipText}
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

export default ProjectResourceList;
