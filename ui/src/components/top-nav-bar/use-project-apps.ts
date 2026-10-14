import { ARTIFACT_KINDS, TypeId, kindMatches, type Project, type WebApp } from '@sdk';
import { useMemo } from 'react';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { appsQuery, EDITOR_APP_KIND } from '@src/hooks/flow-hooks/useAssetApps';
import { useProjectDependencies } from '@src/hooks/use-project-dependencies';
import { projectScope } from '@src/lib/scope-filter';
import { DockPointer } from '@src/navigation/DockPointer';
import { CONSUMER_PROJECT_PARAM, PROVIDER_PROJECT_PARAM } from '@src/project-home-page/dependency-home';

/** Apps whose `kind` says they render a value inside another view, not a page of their own. */
const VIEWER_APP_KIND = 'application.web.viewer';
/** The kinds that make an app part of an ASSET (it edits or shows one) rather than of the project. */
const ASSET_APP_KINDS = [EDITOR_APP_KIND, VIEWER_APP_KIND];

/** One of a project's apps, and the project that ships it (the project itself, or a dependency). */
export interface ProjectApp {
  app: WebApp;
  providerProjectId: string;
}

const NONE: ProjectApp[] = [];

/**
 * The apps a project opens, from the app DEFINITIONS — so they are known before anything was
 * started. `projectIds` is the order: the project first, then its dependencies; within a project
 * the user apps come before the admin apps, an audience's root app first. Editors and viewers are
 * apps of an asset, not of the project, and never count.
 */
export function pickProjectApps(apps: WebApp[], projectIds: string[]): ProjectApp[] {
  const rank = (app: WebApp) => (app.audience === 'app' ? 0 : 2) + (app.isRoot ? 0 : 1);
  return projectIds.flatMap((providerProjectId) =>
    apps
      .filter((app) => app.project_id === providerProjectId)
      .filter((app) => !ASSET_APP_KINDS.some((kind) => kindMatches(kind, app.kind || ARTIFACT_KINDS.APPLICATION_WEB)))
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
      .map((app) => ({ app, providerProjectId })),
  );
}

/** The current project's apps — its own, then its dependencies'. */
export function useProjectApps(project: Project | null | undefined): ProjectApp[] {
  const { data: apps } = useEntitiesQuery<WebApp>(appsQuery);
  const { dependencies } = useProjectDependencies(project);
  const projectId = project?.id ? String(project.id) : '';
  // A string key: `dependencies` is a new array on every render.
  const providerKey = [...new Set([projectId, ...dependencies.map((dependency) => dependency.project_id ?? '')])]
    .filter(Boolean)
    .join(',');
  return useMemo(
    () => (projectId && apps?.length ? pickProjectApps(apps, providerKey.split(',')) : NONE),
    [apps, projectId, providerKey],
  );
}

/**
 * Where an app of `consumerProjectId` opens: the running app, with the consumer staying the
 * current project and the provider named so its load runs — the options a project's home app
 * opens with (`homePageDock`, `dependencyHomeDock`).
 */
export function projectAppDock(entry: ProjectApp, consumerProjectId: string): DockPointer {
  const dock = DockPointer.forAppEntity(new TypeId(`${entry.app.type}-${entry.app.id}`))
    .withScopeFilter(projectScope(consumerProjectId))
    .withOption(PROVIDER_PROJECT_PARAM, entry.providerProjectId);
  return entry.providerProjectId === consumerProjectId
    ? dock
    : dock.withOption(CONSUMER_PROJECT_PARAM, consumerProjectId);
}
