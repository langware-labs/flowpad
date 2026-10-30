import { useCallback } from 'react';
import { useLingui } from '@lingui/react/macro';
import { Chart, Project, QueryRequest, TypeId, type FSRef } from '@sdk';
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
