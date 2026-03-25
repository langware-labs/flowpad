import { Flow, Project, timeAgo } from '@sdk';
import { useAuth } from '@sdk/react/hooks';
import { Badge } from '@src/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@src/components/ui/card';
import React from 'react';

export interface ProjectListProps {
  /** List of projects to display */
  projects: Project[] | undefined;
  /** Map of project ID to flows (optional - if not provided, flows section won't be shown) */
  projectFlowsMap?: Map<string, Flow[]>;
  /** Loading state */
  isLoading: boolean;
  /** Called when a project card is clicked */
  onProjectClick?: (project: Project) => void;
  /** Called when a flow item is clicked (only used if projectFlowsMap is provided) */
  onFlowClick?: (flow: Flow, event: React.MouseEvent) => void;
  /** Optional title for the section */
  title?: string;
  /** Whether to require authentication to show the list */
  requireAuth?: boolean;
  /** Compact mode - shows a simple list with limited items */
  compact?: boolean;
  /** Maximum number of items to show (default: all, or 5 in compact mode) */
  maxItems?: number;
}

/**
 * ProjectList - Displays a grid of project cards
 *
 * This is a presentational component that can be used in different contexts:
 * - With flows (when projectFlowsMap is provided)
 * - Without flows (just project cards)
 *
 * Navigation is handled by the parent via callbacks, making it context-agnostic.
 */
export const ProjectList: React.FC<ProjectListProps> = ({
  projects,
  projectFlowsMap,
  isLoading,
  onProjectClick,
  onFlowClick,
  title = 'Your Projects',
  requireAuth = true,
  compact = false,
  maxItems,
}) => {
  const { user } = useAuth();

  // Don't show for visitors if auth is required
  if (requireAuth && !user) {
    return null;
  }

  // Determine how many items to show
  const itemLimit = maxItems ?? (compact ? 5 : undefined);
  const displayProjects = itemLimit ? projects?.slice(0, itemLimit) : projects;

  if (isLoading) {
    if (compact) {
      return (
        <div data-testid="project-list-loading" className="space-y-2">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-8 animate-pulse rounded bg-muted"></div>
          ))}
        </div>
      );
    }
    return (
      <section data-testid="project-list-loading" className="flex w-full flex-1">
        <div className="mx-16 w-full bg-muted/70 pb-16 pt-4">
          <div className="mx-auto w-full max-w-7xl px-6">
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
              {[...Array(6)].map((_, i) => (
                <div key={i} className="animate-pulse">
                  <div className="h-48 rounded-xl bg-gray-200"></div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
    );
  }

  if (!displayProjects || displayProjects.length === 0) {
    return null;
  }

  // Compact mode: simple list
  if (compact) {
    return (
      <div data-testid="project-list-compact" className="w-64">
        {title && <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">{title}</h3>}
        <div className="space-y-1">
          {displayProjects.map((project) => (
            <div
              key={project.id}
              onClick={() => onProjectClick?.(project)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  onProjectClick?.(project);
                }
              }}
              role="button"
              tabIndex={0}
              className="cursor-pointer truncate rounded px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {project.displayName}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <section data-testid="project-list" className="flex w-full flex-1">
      <div className="mx-16 w-full bg-muted/70 pb-16 pt-4">
        <div className="mx-auto w-full max-w-7xl px-6">
          <div className="mb-8">
            <h2 className="mb-2 text-2xl font-bold">{title}</h2>
          </div>

          <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
            {displayProjects.map((project) => {
              const projectFlows = projectFlowsMap?.get(project.id || '') || [];
              const showFlows = projectFlowsMap !== undefined;

              const handleClick = () => {
                onProjectClick?.(project);
              };

              return (
                <div
                  key={project.id}
                  onClick={handleClick}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      handleClick();
                    }
                  }}
                  role="button"
                  tabIndex={0}
                  style={{ cursor: 'pointer' }}
                >
                  <Card className="pointer-events-none transition-shadow duration-200 hover:shadow-md">
                    <CardHeader>
                      <CardTitle className="flex items-center justify-between">
                        <span className="truncate">{project.displayName}</span>
                        {showFlows && (
                          <Badge variant="outline" className="ml-2">
                            {projectFlows.length} {projectFlows.length === 1 ? 'flow' : 'flows'}
                          </Badge>
                        )}
                      </CardTitle>
                    </CardHeader>

                    {showFlows && (
                      <CardContent>
                        {projectFlows.length > 0 ? (
                          <div className="space-y-3">
                            <h4 className="text-sm font-medium text-muted-foreground">Flows:</h4>
                            <div className="max-h-48 space-y-2 overflow-y-auto">
                              {projectFlows.map((flow) => (
                                <div
                                  key={flow.id}
                                  className="flex cursor-pointer items-center justify-between rounded-md bg-muted p-2 hover:bg-muted/80 hover:shadow-sm"
                                  onClick={(e) => onFlowClick?.(flow, e)}
                                >
                                  <span className="truncate text-sm font-medium">{flow.title || 'New Flow'}</span>
                                  {flow?.created_date ? (
                                    <div className="text-xs text-muted-foreground">{timeAgo(flow?.created_date)}</div>
                                  ) : null}
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : (
                          <div className="py-6 text-center">
                            <p className="text-sm text-muted-foreground">No flows in this project</p>
                          </div>
                        )}
                      </CardContent>
                    )}
                  </Card>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
};
