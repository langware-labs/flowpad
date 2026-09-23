import { useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Plus, Trash2 } from 'lucide-react';
import { Agent, config, DataSource, Markdown, Mcp, Skill, type AssetDescriptor } from '@sdk';
import apiClient from '@sdk/client';
import { NavigatorSection } from '@src/components/navigator-panel/NavigatorSection';
import {
  assetScope,
  basename,
  descriptorKey,
  displayLabelForDescriptor,
  parseTypeid,
  type AssetScope,
  type AssetScopeKind,
} from '@src/components/asset-manager';
import { showDeleteAssetModal } from '@src/components/assets/delete-asset-modal';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { DataSourceDialog } from '@src/components/data-sources/DataSourceDialog';
import { isMessageDriverSpec, sourcesQuery, useSourceSpecs } from '@src/components/data-sources/use-source-specs';
import { sourceIcon } from '@src/components/data-sources/source-icon';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { useSourceDelete } from '@src/components/data-sources/use-source-delete';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { useContext } from '@src/hooks/useContext';
import type { ChildSection } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useStagedAssets } from './useStagedAssets';
import { Empty, IconButton, ResourceRow } from './parts';
import { AgentSchedulesSection } from './AgentSchedulesSection';
import { useQuickCreatePick } from '@src/components/quick-create';

/** Stable while loading — a fresh `[]` per render would re-run the row memo. */
const NO_SOURCES: DataSource[] = [];

/** Row label. `displayLabelForDescriptor` gives up at the raw typeid here (this
 *  pane never caches Skill entities); a skill's identity IS its folder, so the
 *  basename is the answer — applied only on that give-up path. */
function labelForAsset(d: AssetDescriptor): string {
  const label = displayLabelForDescriptor(d);
  return label === d.typeid && d.posix_path ? basename(d.posix_path) : label;
}

type ScopedRow = { d: AssetDescriptor; key: string; label: string; scope: AssetScope };

/** A section lists this PROJECT's items only — its own and the agent's (which lives in it) — never
 *  the user-wide or system ones. */
const PROJECT_SCOPES: ReadonlySet<AssetScopeKind> = new Set(['agent', 'project']);

/** The project's rows of a descriptor list, labelled and scoped. */
function projectRows(descriptors: readonly AssetDescriptor[]): ScopedRow[] {
  return descriptors
    .map((d) => ({ d, key: descriptorKey(d), label: labelForAsset(d), scope: assetScope(d) }))
    .filter((row) => PROJECT_SCOPES.has(row.scope.kind));
}

/**
 * The body of the agent-resources navigator: this project's channels, data sources, schedules,
 * MCP servers, skills and docs, each a flat list with its count. A row opens the item nested in
 * the agent editor (see `DockPointer.child`); each `+` creates a new one.
 */
export function AgentResourcesBody() {
  const { t } = useLingui();

  const skillAssets = useStagedAssets(Skill.type);
  const { descriptors: skillDescriptors, isLoading: skillsLoading } = skillAssets;
  const docAssets = useStagedAssets(Markdown.type);
  // FlowPad's OWN MCP assets (`agentic-assets/mcp/<name>/mcp.json`), and the
  // only population here. Listed regardless of worker: an `mcp` is an
  // EXECUTABLE_ASSET_TYPE the process renders into every harness's config at
  // launch, so it carries no worker dimension to filter on.
  const mcpAssets = useStagedAssets(Mcp.type);

  // The connected sources, read through the ONE named query the Data sources
  // view uses, so the two can't disagree about what exists. Not
  // `useStagedAssets` like its three neighbours: a DataSource is a DB row and a
  // property of the INSTANCE (`scope: []`, see flow_sdk/builtin/data_source.py),
  // not a file the project-level path scan could find.
  const { data: sources = NO_SOURCES, isLoading: sourcesLoading, refetch: refetchSources } =
    useEntitiesQuery<DataSource>(sourcesQuery);

  // The verb and its confirm copy are owned by `use-source-delete`, shared
  // with the Data Sources screen — this panel reuses them rather than
  // re-implementing "what does deleting a source do".
  const { deleting, setDeleting, remove: removeSource, confirm: deleteConfirm } = useSourceDelete(
    () => void refetchSources(),
  );

  // The agent open in the adjacent editor pane, when there is one — read from
  // context rather than re-resolved from the URL: `load-asset.ts` (URL-first
  // navigation, see this repo's own doctrine) already writes it there before
  // this pane renders. A source created here is that agent's, the same way
  // `AttachedChannelsBar` stamps `owner` for a channel added from the agent's
  // Stream Inbox view; before this, `owner` was never set at all and every source
  // created from this panel came back unowned regardless of which agent's
  // editor it was opened from.
  const { activeEntityTypeId } = useContext();
  const editingAgentId = activeEntityTypeId?.type === Agent.type ? activeEntityTypeId : null;
  const editingAgentKey = editingAgentId?.toString() ?? null;

  const { navigation, currentDock } = useDockNavigation();

  const [addSourceOpen, setAddSourceOpen] = useState(false);
  const [addChannelOpen, setAddChannelOpen] = useState(false);
  // One rule for "a channel" everywhere: a driver that SENDS is a message channel (the stream
  // inbox's attached-channels bar and the Add channel dialog use the same predicate).
  const { specFor } = useSourceSpecs();
  // Project home's own creation seam: `onPick(type)` opens the same name/scope
  // form. `dialogs` MUST be rendered or the trigger silently does nothing.
  const { panelProps, dialogs } = useQuickCreatePick();

  const skillRows = useMemo(
    () => projectRows(skillDescriptors),
    [skillDescriptors],
  );

  const docRows = useMemo(
    () => projectRows(docAssets.descriptors),
    [docAssets.descriptors],
  );

  // Every row opens NESTED in the agent editor (see DockPointer.child): the item replaces the
  // agent's body in the same tab, the chain reads in the URL and the breadcrumbs, and this menu
  // stays. A click only navigates; which row is open is read back from the URL.
  const openChild = (section: ChildSection, typeid: string) => () =>
    currentDock && navigation.openDock(currentDock.withChild(section, typeid));
  const isOpen = (typeid: string) => currentDock?.child?.typeId === typeid;

  // Scoped to the agent this panel is open for — the same field `bind_channel`
  // and this panel's own `owner={editingAgentId}` (above) stamp. Without an
  // agent open there is no owner to match, so the list is empty rather than
  // every source on the instance: an unscoped list here contradicted the
  // section's own claim to show "what an agent here can actually read from".
  const ownedSources = useMemo(
    () => (editingAgentKey ? sources.filter((s) => s.owner === editingAgentKey) : NO_SOURCES),
    [sources, editingAgentKey],
  );

  const sourceRows = useMemo(
    () =>
      [...ownedSources]
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
        .map((source) => {
          const typeid = source.typeId.toString();
          const label = source.name || source.provider || typeid;
          const d: AssetDescriptor = {
            typeid,
            // A source lives in the remote system it syncs, which is none of
            // this process's source dirs and not writable from it.
            source: 'external',
            posix_path: null,
          };
          // Hand-built rather than `assetScope(d)`: that reads a FILE's location
          // off `source_dir`, and this row has no file. The scope axis still
          // answers "where does this live" — for a source that is the remote it
          // speaks to. `channel` is the driver-written user-facing word (gmail,
          // slack); `provider` is what shows before the first poll fills it in.
          const scope: AssetScope = {
            kind: 'external',
            label: source.channel || source.provider || 'external',
            revealPath: null,
            tooltip: [label, source.channel || source.provider, `status: ${source.status}`, `health: ${source.health}`]
              .filter(Boolean)
              .join('\n'),
          };
          return { d, key: typeid, label, scope, source };
        }),
    [ownedSources],
  );

  const { channelRows, dataSourceRows } = useMemo(() => {
    const channels: typeof sourceRows = [];
    const data: typeof sourceRows = [];
    for (const row of sourceRows) (isMessageDriverSpec(specFor(row.source.provider)) ? channels : data).push(row);
    return { channelRows: channels, dataSourceRows: data };
  }, [sourceRows, specFor]);
  const renderSourceRows = (rows: typeof sourceRows, section: ChildSection) =>
    rows.map((row) => (
      <ResourceRow
        key={row.key}
        icon={sourceIcon(specFor(row.source.provider), row.source.channel)}
        label={row.label}
        selected={isOpen(row.key)}
        onOpen={openChild(section, row.key)}
        testId={`agent-resource-row-${row.key}`}
        action={
          <IconButton
            icon={Trash2}
            label={t`Delete ${row.label}`}
            onClick={() => setDeleting(row.source)}
            testId={`agent-resource-delete-data-source-${row.source.id}`}
          />
        }
      />
    ));

  const mcpAssetRows = useMemo(
    () => projectRows(mcpAssets.descriptors),
    [mcpAssets.descriptors],
  );

  // Same generic route every other file-backed asset (agent, skill, workflow,
  // plan, markdown, …) already deletes through — see
  // `browseable-tree/adapters/assetTypeRoot.tsx` — not a bespoke MCP verb.
  // `showDeleteAssetModal` is a singleton mounted once at the app root
  // (`App.tsx`), so no dialog needs mounting here.
  const onDeleteMcp = (row: { d: AssetDescriptor; label: string }) => {
    const { type, id } = parseTypeid(row.d.typeid);
    showDeleteAssetModal({
      name: row.label,
      onConfirm: async () => {
        await apiClient.delete(`${config.API_PREFIXES.graph}/${type}/${id}`);
      },
      onAfterDelete: () => mcpAssets.refresh(),
    });
  };

  return (
    <div className="flex flex-col py-1">
      {/* The CONNECTED sources — what an agent here can actually read from —
          and never again the installed `DataDriver` catalog this section
          used to list. That catalog was the nine provider types the machine
          *can* connect: neither viewable nor selectable, so every row was
          decoration. Same shape as the three sections below it: rows are what
          is available, `+` adds one more. */}
      <NavigatorSection
        scope="agent-resources"
        id="channels"
        label={t`Channels`}
        isLoading={sourcesLoading}
        itemCount={channelRows.length}
        action={
          <IconButton
            icon={Plus}
            label={t`Add channel`}
            onClick={() => setAddChannelOpen(true)}
            testId="agent-resource-add-channel"
          />
        }
        emptyState={
          <Empty>
            <Trans>Connect a channel people can reach this agent on</Trans>
          </Empty>
        }
      >
        {renderSourceRows(channelRows, 'channel')}
      </NavigatorSection>

      <NavigatorSection
        scope="agent-resources"
        id="data-sources"
        label={t`Data sources`}
        isLoading={sourcesLoading}
        itemCount={dataSourceRows.length}
        action={
          <IconButton
            icon={Plus}
            label={t`Add data source`}
            onClick={() => setAddSourceOpen(true)}
            testId="agent-resource-add-data-source"
          />
        }
        emptyState={
          <Empty>
            <Trans>Connect a data source to make it available here</Trans>
          </Empty>
        }
      >
        {renderSourceRows(dataSourceRows, 'data_source')}
      </NavigatorSection>

      {editingAgentId && <AgentSchedulesSection agentTypeId={editingAgentId} />}

      {/* The project's own add-source form, reused verbatim — `editing` unset
          is its create mode. Mounted here rather than behind a navigation so
          the pane never loses the agent being edited. `owner` stamps the
          created source onto the agent this panel is open for, same as
          `AttachedChannelsBar`'s call one view over. */}
      <DataSourceDialog
        open={addSourceOpen}
        onOpenChange={setAddSourceOpen}
        owner={editingAgentId}
        only={(spec) => !isMessageDriverSpec(spec)}
      />
      {addChannelOpen && (
        <DataSourceDialog open onOpenChange={setAddChannelOpen} owner={editingAgentId} only={isMessageDriverSpec} />
      )}

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(next) => !next && setDeleting(null)}
        variant="destructive"
        {...deleteConfirm}
        onConfirm={() => deleting && void removeSource(deleting)}
      />

      {/* The project's OWN `mcp` assets, and nothing else. This used to also
          list the servers configured in the selected worker's vendor files
          (`capability` rows, read-only). They are gone: the agent's MCP slot
          attaches project assets by id, so a vendor row sitting in the same
          list looked attachable and never was — it describes a definition site
          we do not own and cannot hand a worker. One list, one meaning. */}
      <NavigatorSection
        scope="agent-resources"
        id="mcp-servers"
        label={t`MCP servers`}
        isLoading={mcpAssets.isLoading}
        truncated={mcpAssets.truncated}
        itemCount={mcpAssetRows.length}
        action={
          <IconButton
            icon={Plus}
            label={t`New MCP server`}
            onClick={() => panelProps.onPick(Mcp.type)}
            testId="agent-resource-new-mcp"
          />
        }
        emptyState={
          <Empty>
            <Trans>No MCP servers found</Trans>
          </Empty>
        }
      >
        {mcpAssetRows.map((row) => (
          <ResourceRow
            key={row.key}
            icon={iconForType(parseTypeid(row.d.typeid).type)}
            label={row.label}
            selected={isOpen(row.d.typeid)}
            onOpen={openChild('mcp', row.d.typeid)}
            testId={`agent-resource-row-${row.d.typeid}`}
            action={
              <IconButton
                icon={Trash2}
                label={t`Delete ${row.label}`}
                onClick={() => onDeleteMcp(row)}
                testId={`agent-resource-delete-mcp-${parseTypeid(row.d.typeid).id}`}
              />
            }
          />
        ))}
      </NavigatorSection>

      <NavigatorSection
        scope="agent-resources"
        id="skills"
        label={t`Skills`}
        isLoading={skillsLoading}
        truncated={skillAssets.truncated}
        itemCount={skillRows.length}
        action={
          <IconButton
            icon={Plus}
            label={t`New skill`}
            onClick={() => panelProps.onPick(Skill.type)}
            testId="agent-resource-new-skill"
          />
        }
        emptyState={
          <Empty>
            <Trans>No skills in this project yet</Trans>
          </Empty>
        }
      >
        {skillRows.map((row) => (
          <ResourceRow
            key={row.key}
            icon={iconForType(parseTypeid(row.d.typeid).type)}
            label={row.label}
            selected={isOpen(row.d.typeid)}
            onOpen={openChild('skill', row.d.typeid)}
            testId={`agent-resource-row-${row.d.typeid}`}
          />
        ))}
      </NavigatorSection>

      <NavigatorSection
        scope="agent-resources"
        id="docs"
        label={t`Docs`}
        isLoading={docAssets.isLoading}
        truncated={docAssets.truncated}
        itemCount={docRows.length}
        action={
          <IconButton
            icon={Plus}
            label={t`New doc`}
            onClick={() => panelProps.onPick(Markdown.type)}
            testId="agent-resource-new-doc"
          />
        }
        emptyState={
          <Empty>
            <Trans>No docs found</Trans>
          </Empty>
        }
      >
        {docRows.map((row) => (
          <ResourceRow
            key={row.key}
            icon={iconForType(parseTypeid(row.d.typeid).type)}
            label={row.label}
            selected={isOpen(row.d.typeid)}
            onOpen={openChild('doc', row.d.typeid)}
            testId={`agent-resource-row-${row.d.typeid}`}
          />
        ))}
      </NavigatorSection>

      {/* At the pane root, outside every section: a section can be collapsed
          while its dialog is open, and that unmount would close it mid-edit. */}
      {dialogs}
    </div>
  );
}
