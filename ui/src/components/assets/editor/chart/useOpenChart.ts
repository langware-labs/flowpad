import { useCallback } from 'react';
import { useLingui } from '@lingui/react/macro';
import { Chart, Project, QueryRequest, TypeId, type FSRef } from '@sdk';
import apiClient from '@sdk/client';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { notify } from '@src/notifications';

/**
 * Open the chart a `ref` names (a sequence sub-flow, a C4 box that zooms in). URL-first: it
 * resolves the chart and calls navigation.openDock, nothing else.
 */
export function useOpenChart(fsRef: FSRef, projectId?: string) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  return useCallback(
    async (ref: string) => {
      try {
        const scope = projectId ? [new TypeId(Project.type, projectId)] : [];
        const found = await Chart.query(
          new QueryRequest({ type: Chart.type, query: { match: { name: ref } }, scope, name: `chart-subflow-${ref}` }),
        );
        // A name can repeat across folders: the chart beside this one wins.
        const parentOf = (p?: string) => (p ?? '').replace(/\/+$/, '').replace(/\/[^/]*$/, '');
        const here = parentOf(fsRef.path);
        const next = found.find((c) => here && parentOf(c.asset_ref) === here) ?? found[0];
        if (!next) {
          notify.error({ title: t`No chart named “${ref}” in this project` });
          return;
        }
        // The same editor pointer a Charts tree row opens, kept on the project route so the
        // project tree (the chart viewer) stays and its selection follows.
        if (!next.asset_ref) {
          navigation.openDock(next.dockPointer);
          return;
        }
        const editor = DockPointer.forAssetEditor(Chart.type, next.asset_ref);
        navigation.openDock(projectId ? DockPointer.rebaseAssetsOntoProject(editor, projectId) : editor);
      } catch (err) {
        notify.error({
          title: t`Could not open the sub-flow`,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [fsRef, navigation, projectId, t],
  );
}

/** The project a chart sits in: the folder above its `agentic-assets/` (or `docs/`). */
export function chartProjectRoot(chartPath: string): string {
  for (const mark of ['/agentic-assets/', '/docs/']) {
    const at = chartPath.lastIndexOf(mark);
    if (at > 0) return chartPath.slice(0, at);
  }
  return chartPath.replace(/\/[^/]*$/, '');
}

/**
 * Open what a chart's chips point at, URL-first: a project file (`src/x.kt:42`, `docs/a.md`), an asset
 * by TypeId, a web URL, or a data schema kind (the `data_schema` asset named by it).
 */
export function useOpenChartTarget(fsRef: FSRef, projectId?: string) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const openPointer = useCallback(
    (pointer: DockPointer) => navigation.openDock(projectId ? DockPointer.rebaseAssetsOntoProject(pointer, projectId) : pointer),
    [navigation, projectId],
  );

  const openLink = useCallback(
    (link: { href?: string; asset?: string }) => {
      try {
        if (link.asset) {
          const id = new TypeId(link.asset);
          openPointer(DockPointer.forAssetEditorByTypeId(id.type, id));
          return;
        }
        const href = link.href ?? '';
        if (/^https?:\/\//.test(href)) {
          window.open(href, '_blank', 'noopener');
          return;
        }
        const rel = href.replace(/:\d+(-\d+)?$/, '');
        const abs = rel.startsWith('/') ? rel : `${chartProjectRoot(fsRef.path || '')}/${rel}`;
        openPointer(DockPointer.forAssetEditor('', abs));
      } catch (err) {
        notify.error({ title: t`Could not open the link`, message: err instanceof Error ? err.message : String(err) });
      }
    },
    [fsRef, openPointer, t],
  );

  const openSchema = useCallback(
    async (kind: string) => {
      try {
        // Through apiClient, not dataManager: the TS SDK has no data_schema entity class, so
        // dataManager drops the rows. Unscoped: a data_schema row is not filed under the project;
        // the one inside this chart's project wins when a kind is defined in several places.
        const qs = new URLSearchParams({
          'filter[match][op]': '$EQ',
          'filter[match][operands][0]': 'name',
          'filter[match][operands][1]': kind,
        });
        const rows = ((await apiClient.get(`/graph/data_schema?${qs.toString()}`)) ?? []) as { id: string; asset_ref?: string }[];
        const root = chartProjectRoot(fsRef.path || '');
        const row = rows.find((r) => (r.asset_ref ?? '').startsWith(`${root}/`)) ?? rows[0];
        const hit = row ? { typeId: new TypeId('data_schema', row.id) } : null;
        if (!hit?.typeId) {
          notify.error({ title: t`No data schema named “${kind}” in this project` });
          return;
        }
        openPointer(DockPointer.forAssetEditorByTypeId('data_schema', hit.typeId));
      } catch (err) {
        notify.error({ title: t`Could not open the data schema`, message: err instanceof Error ? err.message : String(err) });
      }
    },
    [fsRef, openPointer, t],
  );

  return { openLink, openSchema };
}
