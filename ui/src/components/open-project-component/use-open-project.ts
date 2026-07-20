import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { canonicalPath, selectProjectContext } from '@src/components/project-selector';
import { projectScope } from '@src/lib/scope-filter';
import { useDockNavigation, useIsHomeSurface } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { agenticProcessIdForProjectEntry, dockForProjectEntry } from '@src/tabs/project-entry';
import { useIsVibe, ViewMode } from '@src/contexts/view-mode-context';
import { notify } from '@src/notifications';
import { ContextEntitiesEnum, dataContext, Project, QueryRequest } from '@sdk';
import { useCallback } from 'react';
import { useLingui } from '@lingui/react/macro';

// ---------------------------------------------------------------------------
// Shared path helpers — one source of truth for the project-open flow so the
// dialog (`OpenProjectComponent`) and any direct-open affordance (e.g. the Vibe
// home "Open project folder" button) can't drift apart. Dedup/compare keys go
// through `canonicalPath` (from project-selector); `normalizePath` keeps a
// leading slash for display.
// ---------------------------------------------------------------------------

export const normalizePath = (path: string): string => {
  const normalized = path.trim().replace(/\\/g, '/');
  if (!normalized) return '';
  if (normalized === '/') return '/';
  return normalized.replace(/\/+$/, '');
};

// ---------------------------------------------------------------------------
// useProjectOpener — the shared "open/switch to a project" flow
// ---------------------------------------------------------------------------

export interface UseProjectOpenerOptions {
  /** Called after a project is picked, before context is adopted. */
  onProjectChanged?: () => void;
  /** Gate/map continuation: when set, context is adopted here and the caller's
   *  own navigation/stamping runs in this callback (see OpenProjectComponent). */
  onPicked?: (project: Project) => void | Promise<void>;
  /** Surface a user-facing error (e.g. folder-picker failure). */
  onError?: (message: string) => void;
}

export function useProjectOpener({ onProjectChanged, onPicked, onError }: UseProjectOpenerOptions = {}) {
  const { t } = useLingui();
  const { computeNode } = useAgentContext();
  const { currentDock, navigation } = useDockNavigation();
  const isVibe = useIsVibe();
  // Surface-derived, not a prop: on ANY home surface (root `/` or /dock/home,
  // in any view mode) switching a project just changes the project and lands
  // on the fresh home; only from within a workspace/dock does it resume the
  // target's build process (Vibe) or last-active tab (Standard/Advanced).
  // Keeps the hero buttons, the modal, AND the footer Switch Project consistent.
  const isHome = useIsHomeSurface();

  const setCurrentProjectContext = useCallback(
    async (project: Project) => {
      onProjectChanged?.();
      if (onPicked) {
        // Gate/map flows don't navigate through a project loader, so adopt the
        // context here. Entity stamping (task/conversation/project_id, mapping
        // table writes, remap navigation) happens inside `onPicked` — the
        // gate's apply callback owns it (and its own navigation) so the
        // wasReplacement signal isn't clobbered by a pre-stamp here.
        await selectProjectContext(project);
        try {
          await onPicked(project);
        } catch {
          // continuation errors shouldn't break the picker
        }
      } else {
        // On a home surface, switching a project stays home — on the new
        // project — in every view mode.
        if (isVibe) {
          await selectProjectContext(project);
          if (!isHome) {
            const processId = project.id ? await agenticProcessIdForProjectEntry(project.id) : null;
            if (processId) {
              void navigation.openShellProcess(processId, { viewMode: ViewMode.Vibe });
              return;
            }
          }
          // The HOME loader has no vibe-specific clears, so the vibe home
          // adopts context imperatively (above) and resets the stale process/
          // active entity before landing on the fresh hero. The scope filter
          // makes a hard reload of the landing re-adopt the project.
          await dataContext.setActiveEntityTypeId(null);
          await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProcessTypeId, null);
          navigation.openDock(
            DockPointer.forHome(undefined, undefined, { vibeNoProcess: true })
              .withScopeFilter(projectScope(project.id))
              .withViewMode(ViewMode.Vibe),
          );
          return;
        }
        if (isHome) {
          // URL-first: the scope-carrying HOME dock's loader
          // (adoptScopeProject) is the single writer of project context.
          navigation.openDock(DockPointer.forHome().withScopeFilter(projectScope(project.id)));
          return;
        }
        // Plain switch (footer Switch Project included): navigate to the
        // project's tab — the same path as clicking that tab in the strip
        // (dockForProjectEntry → fromTabHash → openDock). Resumes the KNOWN
        // last-active tab; with no known tab, a scope-keyed current view
        // (Assets/Explorer/Desktop) re-scopes to the destination, else the
        // project landing. No context pre-write here: the destination dock's
        // loader is the single writer of project context (URL-first).
        navigation.openDock(await dockForProjectEntry(project.id, currentDock));
      }
    },
    [isVibe, isHome, onProjectChanged, onPicked, navigation, currentDock],
  );

  const ensureProjectAndSetContext = useCallback(
    async (path: string) => {
      if (!dataContext.someone) throw new Error(t`You must be logged in`);

      const normalizedPath = normalizePath(path);
      if (!normalizedPath) throw new Error(t`Please provide a valid project path`);

      const pathKey = canonicalPath(normalizedPath);
      const freshProjects = await Project.query(
        new QueryRequest({ type: Project.type, query: null, scope: [], name: 'open-project-dedup' }),
      );
      let targetProject =
        freshProjects.find((p) => canonicalPath(p.fs_storage_mount_path || p.name || '') === pathKey) || null;
      const openedExisting = !!targetProject;

      if (!targetProject) {
        targetProject = new Project({ name: normalizedPath });
        targetProject = await targetProject.save([dataContext.someone]);
      }

      await targetProject.setupForDesktop();
      await setCurrentProjectContext(targetProject);
      return { project: targetProject, openedExisting };
    },
    [setCurrentProjectContext, t],
  );

  const pickFolder = useCallback(
    async (initialDir?: string): Promise<string | null> => {
      if (!computeNode) {
        onError?.(t`No compute node available`);
        return null;
      }
      try {
        return await computeNode.openPathDialog(initialDir);
      } catch {
        onError?.(t`Failed to open folder picker`);
        return null;
      }
    },
    [computeNode, onError, t],
  );

  /** Pick a folder from disk and open (or create) the project rooted there.
   *  Never throws — cancel returns `{ opened: false }`, failures route through
   *  `onError`, so callers only manage their own busy state. */
  const openProjectFolder = useCallback(
    async (initialDir?: string): Promise<{ opened: boolean }> => {
      const selected = await pickFolder(initialDir);
      if (!selected) return { opened: false };
      try {
        const { openedExisting, project } = await ensureProjectAndSetContext(selected);
        if (openedExisting) {
          notify.success({ title: t`Opened existing project`, message: project.displayName });
        }
        return { opened: true };
      } catch (err) {
        onError?.(err instanceof Error ? err.message : t`Failed to open project`);
        return { opened: false };
      }
    },
    [pickFolder, ensureProjectAndSetContext, onError, t],
  );

  return { computeNode, ensureProjectAndSetContext, pickFolder, openProjectFolder };
}
