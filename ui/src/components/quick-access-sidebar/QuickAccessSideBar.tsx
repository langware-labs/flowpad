import { Trans, useLingui } from '@lingui/react/macro';
import {
  type ProjectResourceListItem,
  type ProjectResourceType,
  RESOURCE_META,
  RESOURCE_TYPE_ORDER,
  buildResourceItems,
} from '@src/components/project-resource-list';
import { useClaudeProjectResources } from '@src/hooks/use-claude-projects';
import { type ProjectListItem } from '@sdk';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { cn } from '@src/lib/utils';
import { ArrowLeft, Check, Folder, FolderOpen, FolderPlus, ListTree, Loader2, RefreshCw, Search, Terminal } from 'lucide-react';
import { useMemo, useState } from 'react';
import './QuickAccessSideBar.css';

/** Show last 2 path segments, e.g. "/Users/alice/Documents/dev/test" → "dev/test" */
function getShortName(project: ProjectListItem): string {
  const raw = project.cwd || project.name || project.encoded_name;
  const parts = raw.replace(/\/+$/, '').split('/').filter(Boolean);
  if (parts.length <= 2) return parts.join('/') || raw;
  return parts.slice(-2).join('/');
}

export interface QuickAccessSideBarProps {
  projects: ProjectListItem[];
  isLoading: boolean;
  onProjectClick?: (project: ProjectListItem) => void;
  onNewProject?: () => void;
  onOpenProject?: () => void;
  currentProjectEncodedName?: string | null;
  title?: string;
  onResourceClick?: (resource: ProjectResourceListItem) => void;
  /** Encoded name of the project whose resources are currently shown (URL-driven). */
  expandedProjectEncodedName?: string | null;
  /** Called when user clicks the expand chevron on a project row. */
  onExpandProject?: (project: ProjectListItem) => void;
  /** Called when user clicks the back arrow in the detail view. */
  onCollapseProject?: () => void;
  /** Called when user clicks the terminal button to start a new session in the project. */
  onNewSession?: (project: ProjectListItem) => void;
  /** Per-project flow data message counts from sniffer. */
  projectFlowDataCounts?: Map<string, number>;
}

interface GroupedResources {
  type: ProjectResourceType;
  label: string;
  icon: typeof Folder;
  items: ProjectResourceListItem[];
}

export function QuickAccessSideBar({
  projects,
  isLoading,
  onProjectClick,
  onNewProject,
  onOpenProject,
  currentProjectEncodedName,
  title = 'Projects',
  onResourceClick,
  expandedProjectEncodedName,
  onExpandProject,
  onCollapseProject,
  onNewSession,
  projectFlowDataCounts,
}: QuickAccessSideBarProps) {
  const [search, setSearch] = useState('');
  const { t } = useLingui();

  // Resolve expanded project from the encoded name (URL-driven)
  const expandedProject = useMemo(
    () =>
      expandedProjectEncodedName ? (projects.find((p) => p.encoded_name === expandedProjectEncodedName) ?? null) : null,
    [projects, expandedProjectEncodedName],
  );

  const { data: expandedProjectResources, isLoading: isLoadingResources, refetch: refetchResources } = useClaudeProjectResources(
    expandedProjectEncodedName ?? null,
    {
      includeSessions: true,
      enabled: !!expandedProjectEncodedName,
    },
  );

  const groupedResources = useMemo<GroupedResources[]>(() => {
    if (!expandedProjectResources) return [];

    const allItems = buildResourceItems(expandedProjectResources);

    // Group by type following RESOURCE_TYPE_ORDER (exclude sessions)
    const groups: GroupedResources[] = [];
    for (const type of RESOURCE_TYPE_ORDER) {
      if (type === 'claude_session') continue;
      const meta = RESOURCE_META[type];
      const items = allItems.filter((item) => item.type === type);
      if (items.length > 0) {
        groups.push({ type, label: meta.label, icon: meta.icon, items });
      }
    }
    return groups;
  }, [expandedProjectResources]);

  const filteredProjects = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return projects;
    return projects.filter((p) => {
      const name = (p.name || '').toLowerCase();
      const cwd = (p.cwd || '').toLowerCase();
      const encoded = p.encoded_name.toLowerCase();
      return name.includes(query) || cwd.includes(query) || encoded.includes(query);
    });
  }, [projects, search]);

  const showDetail = expandedProject !== null;

  return (
    <div className="quick-access-sidebar">
      <div
        className="quick-access-slider-track"
        style={{ transform: showDetail ? 'translateX(-50%)' : 'translateX(0)' }}
      >
        {/* Panel 1: Project list */}
        <div className="quick-access-panel">
          <div className="quick-access-sidebar-header">
            <h3>{title}</h3>
            <div className="quick-access-header-actions">
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button className="quick-access-header-btn" onClick={onOpenProject}>
                      <FolderOpen className="h-4 w-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom"><Trans>Open Project</Trans></TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button className="quick-access-header-btn" onClick={onNewProject}>
                      <FolderPlus className="h-4 w-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom"><Trans>New Project</Trans></TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          </div>

          <div className="quick-access-sidebar-search">
            <Search className="quick-access-search-icon" />
            <input
              className="quick-access-search-input"
              type="text"
              placeholder={t`Filter projects...`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <div className="quick-access-sidebar-content">
            {isLoading ? (
              <div className="quick-access-sidebar-loading">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span><Trans>Loading...</Trans></span>
              </div>
            ) : filteredProjects.length === 0 ? (
              <div className="quick-access-sidebar-empty">
                <Folder className="h-8 w-8 opacity-30" />
                <span>{search.trim() ? t`No matching projects` : t`No projects yet`}</span>
              </div>
            ) : (
              <ul className="quick-access-sidebar-list">
                <TooltipProvider delayDuration={300}>
                  {filteredProjects.map((project) => {
                    const isActive = currentProjectEncodedName === project.encoded_name;
                    const displayName = getShortName(project);
                    const eventCount = projectFlowDataCounts?.get(project.encoded_name) ?? 0;
                    return (
                      <li key={project.id} className="quick-access-sidebar-list-item">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              className={cn('quick-access-sidebar-item', isActive && 'active')}
                              onClick={() => onProjectClick?.(project)}
                            >
                              <Folder className="quick-access-icon" />
                              {isActive && <Check className="quick-access-check" />}
                              <span className="quick-access-name">{displayName}</span>
                              {eventCount > 0 && (
                                <span className="quick-access-event-badge">{eventCount > 99 ? '99+' : eventCount}</span>
                              )}
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="right" className="max-w-xs break-all text-xs">
                            {project.cwd || project.name}
                          </TooltipContent>
                        </Tooltip>
                        <div className="quick-access-item-actions">
                          <button
                            className="quick-access-item-action quick-access-item-action-terminal"
                            onClick={(e) => {
                              e.stopPropagation();
                              onNewSession?.(project);
                            }}
                            title={t`New session`}
                          >
                            <Terminal className="h-3.5 w-3.5" />
                          </button>
                          <button
                            className="quick-access-item-action quick-access-item-action-expand"
                            onClick={(e) => {
                              e.stopPropagation();
                              onExpandProject?.(project);
                            }}
                            title={t`View resources`}
                          >
                            <ListTree className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </TooltipProvider>
              </ul>
            )}
          </div>
        </div>

        {/* Panel 2: Resource detail view */}
        <div className="quick-access-panel">
          <div className="quick-access-detail-header">
            <div className="quick-access-detail-nav">
              <button className="quick-access-detail-back" onClick={() => onCollapseProject?.()} title={t`Back to projects`}>
                <ArrowLeft className="h-4 w-4" />
              </button>
              <button className="quick-access-detail-back" onClick={() => refetchResources()} title={t`Refresh`}>
                <RefreshCw className="h-4 w-4" />
              </button>
            </div>
            <span className="quick-access-detail-title">{expandedProject ? getShortName(expandedProject) : ''}</span>
          </div>

          <div className="quick-access-sidebar-content">
            {isLoadingResources ? (
              <div className="quick-access-sidebar-loading">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span><Trans>Loading resources...</Trans></span>
              </div>
            ) : groupedResources.length === 0 ? (
              <div className="quick-access-sidebar-empty">
                <Folder className="h-8 w-8 opacity-30" />
                <span><Trans>No resources found</Trans></span>
              </div>
            ) : (
              <div className="quick-access-detail-groups">
                {groupedResources.map((group) => {
                  const GroupIcon = group.icon;
                  return (
                    <div key={group.type} className="quick-access-group">
                      <div className="quick-access-group-header">
                        <GroupIcon className="h-3.5 w-3.5" />
                        <span className="quick-access-group-label">{group.label}</span>
                        <span className="quick-access-group-count">{group.items.length}</span>
                      </div>
                      <ul className="quick-access-group-list">
                        {group.items.map((item) => (
                          <li key={item.id}>
                            <button
                              className="quick-access-resource-item"
                              onClick={() => onResourceClick?.(item)}
                              title={item.path || item.name}
                            >
                              <span className="quick-access-resource-name">{item.name}</span>
                              {item.subtitle && <span className="quick-access-resource-subtitle">{item.subtitle}</span>}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default QuickAccessSideBar;
