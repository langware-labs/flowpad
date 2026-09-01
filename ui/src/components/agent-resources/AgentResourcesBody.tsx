import { useMemo, useState, type ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Plus } from 'lucide-react';
import { Markdown, Skill, type AssetDescriptor } from '@sdk';
import { NavigatorSection } from '@src/components/navigator-panel/NavigatorSection';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { lucideByName } from '@src/lib/lucide-by-name';
import { assetScope, basename, descriptorKey, displayLabelForDescriptor } from '@src/components/asset-manager';
import { DataSourceDialog } from '@src/components/data-sources/DataSourceDialog';
import { useStagedAssets } from './useStagedAssets';
import { useWirableMcpServers } from './useWirableMcpServers';
import { useEditedAgentWorker } from './useEditedAgentWorker';
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

/** Small icon affordance — a header `+` or a row `-`. Sized not to grow the
 *  line it sits on; the label and caret set that height. */
function IconButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  testId,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
      title={label}
      aria-label={label}
      data-testid={testId}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}

/** Where a skill comes from. Not the shared `AssetScopeChip` — that is
 *  `display: contents` and spans two cells of the popover's grid, so it cannot
 *  live in a flex row. `ms-auto` is logical, so it flips under RTL. */
function ScopeChip({ label, tooltip }: { label: string; tooltip?: string }) {
  return (
    <span
      className="ms-auto flex-shrink-0 rounded border border-border px-1 text-[10px] leading-4 text-muted-foreground"
      title={tooltip}
    >
      {label}
    </span>
  );
}

/** One listed resource. `action` is the trailing slot: absent for a row that
 *  cannot be removed (an MCP server, a user skill), a `-` otherwise. */
function ResourceRow({
  icon: Icon,
  label,
  hint,
  chip,
  action,
  testId,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  hint?: string;
  chip?: ReactNode;
  action?: ReactNode;
  testId: string;
}) {
  return (
    <div
      className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground"
      title={hint ? `${label} — ${hint}` : label}
      data-testid={testId}
    >
      <Icon className="h-3.5 w-3.5 flex-shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {chip}
      {action}
    </div>
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
  // Both lists are scoped to the worker the agent is set to; the editor's
  // worker field commits to `agent.md`, which is what this observes. The same
  // document is the write surface for the declared skills.
  const { workerType, isLoading: workerLoading } = useEditedAgentWorker();
  const { servers: mcpServers, isLoading: mcpLoading } = useWirableMcpServers(workerType);

  const [addSourceOpen, setAddSourceOpen] = useState(false);
  // Project home's own creation seam: `onPick(type)` opens the same name/scope
  // form. `dialogs` MUST be rendered or the trigger silently does nothing.
  const { panelProps, dialogs } = useQuickCreatePick();

  const docIcon = iconForType(Markdown.type);
  const skillIcon = iconForType(Skill.type);
  // MCP servers have no per-type registry glyph of their own.
  const mcpIcon = lucideByName('Plug');

  // Every discoverable skill, one row per (typeid, source) — the chip is what
  // tells those apart, so collapsing by typeid would hide the distinction.
  const skillRows = useMemo(
    () => skillDescriptors.map((d) => ({ key: descriptorKey(d), label: labelForAsset(d), scope: assetScope(d) })),
    [skillDescriptors],
  );


  const docRows = useMemo(
    () => docAssets.descriptors.map((d) => ({ key: descriptorKey(d), label: labelForAsset(d), scope: assetScope(d) })),
    [docAssets.descriptors],
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

      <NavigatorSection
        id="mcp-servers"
        label={t`MCP servers`}
        isLoading={mcpLoading || workerLoading}
        itemCount={mcpServers.length}
        emptyState={
          // Two different empty states, because they mean different things and
          // the fix for each differs: with no worker resolved the list is
          // unanswerable, whereas with one resolved it is a real answer — that
          // worker genuinely has none configured.
          workerType ? (
            <Empty>
              <Trans>No MCP servers found</Trans>
            </Empty>
          ) : (
            <Empty>
              <Trans>Select a worker to see the MCP servers available to it</Trans>
            </Empty>
          )
        }
      >
        {mcpServers.map((server) => (
          <ResourceRow
            key={server.id}
            icon={mcpIcon}
            label={server.name}
            hint={server.workerType}
            testId={`agent-resource-mcp-${server.name}`}
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
          <ResourceRow
            key={row.key}
            icon={skillIcon}
            label={row.label}
            chip={<ScopeChip label={row.scope.label} tooltip={row.scope.tooltip} />}
            testId={`agent-resource-skill-${row.label}`}
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
          <ResourceRow
            key={row.key}
            icon={docIcon}
            label={row.label}
            chip={<ScopeChip label={row.scope.label} tooltip={row.scope.tooltip} />}
            testId={`agent-resource-doc-${row.label}`}
          />
        ))}
      </NavigatorSection>

      {/* At the pane root, outside every section: a section can be collapsed
          while its dialog is open, and that unmount would close it mid-edit. */}
      {dialogs}
    </div>
  );
}
