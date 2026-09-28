/**
 * Which asset types a hub project page can edit.
 *
 * Out of `HubProjectPage.tsx` so that file exports only components — a non-component export there
 * breaks React Fast Refresh.
 */
import { editorForType, type JSONSchemaProperty, type TypeInfo } from '@sdk';

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
