import { ContextEntitiesEnum, dataContext, Project, QueryRequest } from '@sdk';
import { useProject } from '@sdk/react/hooks';
import { ProjectSelector } from '@src/components/project-selector';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@src/components/ui/dropdown-menu';
import { useAssetTypes } from '@src/hooks/use-asset-types';
import { useClaudeProjectList } from '@src/hooks/use-claude-projects';
import type { ReactNode } from 'react';
import { useCallback, useMemo } from 'react';
import { QUICK_CREATE_REGISTRY } from './registry';

interface QuickCreateMenuProps {
  children: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (type: string) => void;
}

const normalizePath = (path: string): string => {
  const normalized = path.trim().replace(/\\/g, '/');
  if (!normalized) return '';
  if (normalized === '/') return '/';
  return normalized.replace(/\/+$/, '');
};

/**
 * Dropdown menu listing creatable entity types. The list is the intersection of
 * the UI quick-create registry and the server-reported `creatable` types (so the
 * server stays authoritative for what's actually supported).
 *
 * Top section: ProjectSelector for switching the active project before picking
 * a type to create.
 */
export function QuickCreateMenu({ children, open, onOpenChange, onPick }: QuickCreateMenuProps) {
  const { types: serverTypes } = useAssetTypes();
  const { project: currentProject } = useProject();
  const { projects: scanProjects, isLoading: isLoadingProjects } = useClaudeProjectList({ enabled: open });

  const currentProjectPath = useMemo(
    () => normalizePath(currentProject?.fs_storage_mount_path || currentProject?.name || ''),
    [currentProject],
  );

  const selectedEncodedName = useMemo(() => {
    if (!currentProject) return null;
    const byId = scanProjects.find((p) => p.id === currentProject.id);
    if (byId?.encoded_name) return byId.encoded_name;
    if (!currentProjectPath) return null;
    const byPath = scanProjects.find(
      (p) => normalizePath(p.cwd || p.name || '') === currentProjectPath,
    );
    return byPath?.encoded_name ?? null;
  }, [scanProjects, currentProject, currentProjectPath]);

  const switchToProjectByCwd = useCallback(
    async (cwd: string) => {
      if (!dataContext.someone) return;
      const targetPath = normalizePath(cwd);
      if (!targetPath || targetPath === currentProjectPath) return;

      const pathKey = targetPath.toLowerCase();
      const getPath = (p: Project) => normalizePath(p.fs_storage_mount_path || p.name || '').toLowerCase();
      const fresh = await Project.query(
        new QueryRequest({
          type: Project.type,
          query: null,
          scope: [],
          name: 'quick-create-switch-project',
        }),
      );
      let target = fresh.find((p) => getPath(p) === pathKey) ?? null;
      if (!target) {
        target = new Project({ name: targetPath });
        await target.save([dataContext.someone]);
      }
      await target.setupForDesktop();
      await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId, target.typeId);
      await dataContext.refreshProject();
      dataContext.setWorkdir(target.fs_storage_mount_path ?? null);
    },
    [currentProjectPath],
  );

  const handleProjectSelect = useCallback(
    (encodedName: string | null) => {
      if (!encodedName) return;
      const picked = scanProjects.find((p) => p.encoded_name === encodedName);
      if (!picked) return;
      onOpenChange(false);
      void switchToProjectByCwd(picked.cwd || picked.name || '');
    },
    [scanProjects, onOpenChange, switchToProjectByCwd],
  );

  const items = useMemo(() => {
    const serverCreatable = new Set(
      serverTypes.filter((t) => t.creatable).map((t) => t.type_name),
    );
    // When server list is empty (still loading / older backend), fall back to the
    // full UI registry — it's the best-effort source of truth.
    const enforce = serverCreatable.size > 0;
    return QUICK_CREATE_REGISTRY.filter((d) => !enforce || serverCreatable.has(d.type)).map((d) => {
      const label = serverTypes.find((t) => t.type_name === d.type)?.label ?? d.label;
      return { ...d, displayLabel: label };
    });
  }, [serverTypes]);

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="w-72">
        <div className="h-64 p-1">
          <ProjectSelector
            projects={scanProjects}
            selectedEncodedName={selectedEncodedName}
            onSelect={handleProjectSelect}
            isLoading={isLoadingProjects}
          />
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Create new…</DropdownMenuLabel>
        {items.map((item) => {
          const Icon = item.Icon;
          return (
            <DropdownMenuItem
              key={item.type}
              onSelect={() => {
                onOpenChange(false);
                onPick(item.type);
              }}
            >
              <Icon className="mr-2 h-4 w-4" />
              {item.displayLabel}
            </DropdownMenuItem>
          );
        })}
        {items.length === 0 && (
          <DropdownMenuItem disabled>No creatable types available</DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
