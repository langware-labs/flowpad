import {
  APIEntity,
  dataContext,
  dataManager,
  editorForType,
  Project,
  QueryRequest,
  TypeId,
  type JSONSchemaProperty,
  type TypeInfo,
} from '@sdk';
import { useQueries } from '@tanstack/react-query';
import { AssetEditorRouter } from '@src/components/assets/editor/AssetEditorRouter';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { hubProjectAssetDock } from '@src/lib/hub-page-url';
import { ProjectHome } from '@src/components/project-home/ProjectHome';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Trans } from '@lingui/react/macro';
import { useMemo } from 'react';

type HubAssetRow = APIEntity<never> & { id: string; type: string; displayName: string; typeId: TypeId };

type LegacyAssetSchema = JSONSchemaProperty & {
  properties?: Record<string, JSONSchemaProperty> & {
    type?: JSONSchemaProperty & { const?: string };
    asset_ref?: JSONSchemaProperty;
  };
};

/** Registry-owned editable Git assets, plus the old Hub schema compatibility shape. */
export function hubEditableAssetTypes(
  typeInfos: Array<Pick<TypeInfo, 'type_name' | 'cloud_file_transport'>>,
  schemas: JSONSchemaProperty[] = [],
): string[] {
  const types = new Set(
    typeInfos
      .filter((info) => info.cloud_file_transport === 'git' && !!editorForType(info.type_name))
      .map((info) => info.type_name),
  );

  for (const schema of schemas as LegacyAssetSchema[]) {
    const type = schema.properties?.type?.const;
    // Legacy Hub schemas predate TypeInfo transport metadata and are deltas:
    // Git-backed Agent/Skill omit asset_ref entirely. The editor registry is
    // the compatibility capability gate; Project scope then selects only the
    // entities actually shared under this project.
    if (type && editorForType(type)) types.add(type);
  }
  return [...types].sort();
}

function HubProjectAssets({ projectId }: { projectId: string }) {
  const { navigation } = useDockNavigation();
  const projectTypeId = useMemo(() => new TypeId(Project.type, projectId), [projectId]);
  const assetTypes = useMemo(
    () => hubEditableAssetTypes(dataManager.getAllTypeInfos(), dataContext.bootstrapInfo?.schemas ?? []),
    [],
  );
  const queries = useQueries({
    queries: assetTypes.map((type) => ({
      queryKey: ['hub-project-assets', projectId, type],
      queryFn: () =>
        dataManager.query<HubAssetRow>(
          new QueryRequest({ type, scope: [projectTypeId], name: `hub-project-assets:${projectId}:${type}` }),
        ),
    })),
  });
  const assets = queries
    .flatMap((query) => query.data ?? [])
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  const isLoading = queries.some((query) => query.isLoading);

  if (isLoading)
    return (
      <p className="text-sm text-muted-foreground">
        <Trans>Loading…</Trans>
      </p>
    );
  if (!assetTypes.length || !assets.length) {
    return (
      <p className="text-sm text-muted-foreground">
        <Trans>No published assets yet.</Trans>
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="hub-project-assets">
      <h2 className="text-sm font-medium text-muted-foreground">
        <Trans>Assets</Trans>
      </h2>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {assets.map((asset) => {
          const AssetIcon = iconForType(asset.type);
          return (
            <button
              key={asset.typeId.toString()}
              type="button"
              onClick={() => navigation.openDock(hubProjectAssetDock(projectId, asset.typeId))}
              className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-start transition-colors hover:bg-accent"
              data-testid={`hub-project-asset-${asset.typeId.toString()}`}
            >
              <AssetIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-sm">{asset.displayName}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Hub Project Home and its TypeId-addressed Git/VFS editor sub-routes. */
export function HubProjectPage() {
  const { currentDock } = useDockNavigation();
  const { projectId, assetSubPointer } = DockPointer.splitProjectPointer(currentDock?.pointer);

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Trans>Project not found.</Trans>
      </div>
    );
  }
  if (assetSubPointer) {
    return <AssetEditorRouter pointer={assetSubPointer} hubReflect />;
  }
  return <ProjectHome spawnProjectId={projectId} cloudContent={<HubProjectAssets projectId={projectId} />} />;
}

export default HubProjectPage;
