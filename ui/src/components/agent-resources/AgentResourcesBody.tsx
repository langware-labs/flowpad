import { useMemo, useState, type ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Plus } from 'lucide-react';
import { Markdown, Mcp, Skill, type AssetDescriptor } from '@sdk';
import { NavigatorSection } from '@src/components/navigator-panel/NavigatorSection';
import { AssetRow, assetScope, basename, descriptorKey, displayLabelForDescriptor } from '@src/components/asset-manager';
import { DataSourceDialog } from '@src/components/data-sources/DataSourceDialog';
import { useStagedAssets } from './useStagedAssets';
import { useQuickCreatePick } from '@src/components/quick-create';

/** Row label. `displayLabelForDescriptor` gives up at the raw typeid here (this
 *  pane never caches Skill entities); a skill's identity IS its folder, so the
 *  basename is the answer — applied only on that give-up path. */
function labelForAsset(d: AssetDescriptor): string {
  const label = displayLabelForDescriptor(d);
  return label === d.typeid && d.posix_path ? basename(d.posix_path) : label;
}

/** Muted one-liner for a section with nothing in it. */
function Empty({ children }: { children: ReactNode }) {
  return <div className="px-3 py-2 text-xs italic text-muted-foreground">{children}</div>;
}

/** A section header's `+`. Sized not to grow the line it sits on; the label and
 *  caret set that height. */
function IconButton({
  icon: Icon,
  label,
  onClick,
  testId,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
      title={label}
      aria-label={label}
      data-testid={testId}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}

/**
 * The four-section body of the agent-resources navigator. A read-only inventory
 * of what an agent run in this project can draw on; each `+` creates a new
 * asset of that kind rather than attaching anything to the agent.
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

  const [addSourceOpen, setAddSourceOpen] = useState(false);
  // Project home's own creation seam: `onPick(type)` opens the same name/scope
  // form. `dialogs` MUST be rendered or the trigger silently does nothing.
  const { panelProps, dialogs } = useQuickCreatePick();

  // Every discoverable skill, one row per (typeid, source) — the chip is what
  // tells those apart, so collapsing by typeid would hide the distinction.
  const skillRows = useMemo(
    () => skillDescriptors.map((d) => ({ d, key: descriptorKey(d), label: labelForAsset(d), scope: assetScope(d) })),
    [skillDescriptors],
  );

  const docRows = useMemo(
    () => docAssets.descriptors.map((d) => ({ d, key: descriptorKey(d), label: labelForAsset(d), scope: assetScope(d) })),
    [docAssets.descriptors],
  );

  const mcpAssetRows = useMemo(
    () => mcpAssets.descriptors.map((d) => ({ d, key: descriptorKey(d), label: labelForAsset(d), scope: assetScope(d) })),
    [mcpAssets.descriptors],
  );

  return (
    <div className="flex flex-col py-1">
      {/* Deliberately listless. What this section used to render was the
          installed `DataSourceSpec` CATALOG — the nine provider types the
          machine can connect, not anything this agent has or could be given.
          They were neither viewable (no row opened anything) nor selectable
          (the Agent has no data-sources field, and adding one is out of
          scope), so every row was decoration. The one real affordance is
          connecting a source, which is what `+` does.
          `itemCount={0}` also means the section settles collapsed — the `+`
          stays reachable in the header regardless. */}
      <NavigatorSection
        id="data-sources"
        label={t`Data sources`}
        itemCount={0}
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
      />

      {/* The project's own add-source form, reused verbatim — `editing` unset
          is its create mode. Mounted here rather than behind a navigation so
          the pane never loses the agent being edited. */}
      <DataSourceDialog open={addSourceOpen} onOpenChange={setAddSourceOpen} />

      {/* The project's OWN `mcp` assets, and nothing else. This used to also
          list the servers configured in the selected worker's vendor files
          (`capability` rows, read-only). They are gone: the agent's MCP slot
          attaches project assets by id, so a vendor row sitting in the same
          list looked attachable and never was — it describes a definition site
          we do not own and cannot hand a worker. One list, one meaning. */}
      <NavigatorSection
        id="mcp-servers"
        label={t`MCP servers`}
        isLoading={mcpAssets.isLoading}
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
          <AssetRow
            key={row.key}
            descriptor={row.d}
            scope={row.scope}
            label={row.label}
            selected={false}
            improvable={false}
            busy={false}
          />
        ))}
      </NavigatorSection>

      <NavigatorSection
        id="skills"
        label={t`Skills`}
        isLoading={skillsLoading}
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
            <Trans>No skills found</Trans>
          </Empty>
        }
      >
        {skillRows.map((row) => (
          <AssetRow
            key={row.key}
            descriptor={row.d}
            scope={row.scope}
            label={row.label}
            selected={false}
            improvable={false}
            busy={false}
          />
        ))}
      </NavigatorSection>

      <NavigatorSection
        id="docs"
        label={t`Docs`}
        isLoading={docAssets.isLoading}
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
          <AssetRow
            key={row.key}
            descriptor={row.d}
            scope={row.scope}
            label={row.label}
            selected={false}
            improvable={false}
            busy={false}
          />
        ))}
      </NavigatorSection>

      {/* At the pane root, outside every section: a section can be collapsed
          while its dialog is open, and that unmount would close it mid-edit. */}
      {dialogs}
    </div>
  );
}
