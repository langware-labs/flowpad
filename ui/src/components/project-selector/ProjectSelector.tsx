import { type ProjectItem } from '@sdk';
import { Check, FolderOpen, Loader2, Search } from 'lucide-react';
import { useMemo, useState } from 'react';

/**
 * Props for the ProjectSelector component
 */
export interface ProjectSelectorProps {
  /** List of projects to display */
  projects: ProjectItem[];
  /** Currently selected project's encoded_name, or null for none */
  selectedEncodedName: string | null;
  /** Callback when a project is selected (null to deselect) */
  onSelect: (encodedName: string | null) => void;
  /** Whether the projects are loading */
  isLoading?: boolean;
}

/**
 * ProjectSelector - A narrow list component for selecting projects
 *
 * Features:
 * - Filter input at top
 * - Scrollable project list sorted by session count
 * - Selected state indicator
 * - Click to select/deselect project
 */
export function ProjectSelector({ projects, selectedEncodedName, onSelect, isLoading = false }: ProjectSelectorProps) {
  const [filter, setFilter] = useState('');

  // Filter and sort projects: filter by name, sort by session_count descending
  const filteredProjects = useMemo(() => {
    return projects
      .filter((project) => project.name.toLowerCase().includes(filter.toLowerCase()))
      .sort((a, b) => b.session_count - a.session_count);
  }, [projects, filter]);

  // Handle project click - toggle selection
  const handleProjectClick = (project: ProjectItem) => {
    if (selectedEncodedName === project.encoded_name) {
      // Deselect if clicking the already selected project
      onSelect(null);
    } else {
      onSelect(project.encoded_name);
    }
  };

  return (
    <div className="flex h-full flex-col rounded-lg border border-border bg-card">
      {/* Header */}
      <div className="border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <FolderOpen className="h-4 w-4 text-muted-foreground" />
          <span className="text-xs font-medium">Projects</span>
          <span className="ml-auto rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">
            {filteredProjects.length}
          </span>
        </div>
      </div>

      {/* Filter input */}
      <div className="border-b border-border p-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Filter..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="h-7 w-full rounded border border-border bg-background pl-7 pr-2 text-xs placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      </div>

      {/* Project list */}
      <div className="flex-1 overflow-auto p-1">
        {isLoading && projects.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-4">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            <span className="text-[10px] text-muted-foreground">Loading...</span>
          </div>
        ) : filteredProjects.length === 0 ? (
          <div className="py-4 text-center text-[10px] text-muted-foreground">
            {filter ? 'No projects match filter' : 'No projects found'}
          </div>
        ) : (
          <div className="space-y-0.5">
            {/* "All Projects" option */}
            <button
              onClick={() => onSelect(null)}
              className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors ${
                selectedEncodedName === null
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              <div className="flex h-4 w-4 items-center justify-center">
                {selectedEncodedName === null && <Check className="h-3 w-3" />}
              </div>
              <span className="flex-1 text-xs font-medium">All Projects</span>
            </button>

            {/* Individual projects */}
            {filteredProjects.map((project) => {
              const isSelected = selectedEncodedName === project.encoded_name;

              return (
                <button
                  key={project.id}
                  onClick={() => handleProjectClick(project)}
                  className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors ${
                    isSelected ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-muted'
                  }`}
                  title={project.cwd || project.name}
                >
                  <div className="flex h-4 w-4 items-center justify-center">
                    {isSelected && <Check className="h-3 w-3" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-xs">{project.name}</span>
                    <span className="block text-[10px] text-muted-foreground">
                      {project.session_count} session{project.session_count !== 1 ? 's' : ''}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer with count */}
      <div className="border-t border-border px-3 py-1.5">
        <span className="text-[10px] text-muted-foreground">
          {selectedEncodedName
            ? `Selected: ${filteredProjects.find((p) => p.encoded_name === selectedEncodedName)?.name || 'Unknown'}`
            : 'Click to filter stats'}
        </span>
      </div>
    </div>
  );
}

export default ProjectSelector;
