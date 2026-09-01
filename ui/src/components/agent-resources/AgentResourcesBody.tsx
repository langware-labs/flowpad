import { useMemo, useState, type ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Plus } from 'lucide-react';
import { Markdown, type AssetDescriptor } from '@sdk';
import { NavigatorSection } from '@src/components/navigator-panel/NavigatorSection';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { lucideByName } from '@src/lib/lucide-by-name';
import { AssetRow, assetScope, basename, descriptorKey, displayLabelForDescriptor } from '@src/components/asset-manager';
import { DataSourceDialog } from '@src/components/data-sources/DataSourceDialog';
import { useProjectDocs } from './useProjectDocs';
import { useWirableSkills } from './useWirableSkills';
import { useWirableMcpServers } from './useWirableMcpServers';
import { useAgentDocument } from './useAgentDocument';
import { useAgentListWiring } from './useAgentListWiring';

/** Row label. `displayLabelForDescriptor` gives up at the raw typeid here (this
 *  pane never caches Skill entities); a skill's identity IS its folder, so the
 *  basename is the answer — applied only on that give-up path. */
function labelForAsset(d: AssetDescriptor): string {
  const label = displayLabelForDescriptor(d);
  return label === d.typeid && d.posix_path ? basename(d.posix_path) : label;
}

/** A `user_dir` skill is already discovered by the vendor CLI every session, so
 *  copying it in only duplicates it. Project and context-folder skills reach a
 *  worker only if something puts them where it looks. */
function isSelectableSkill(d: AssetDescriptor): boolean {
  return d.source !== 'user_dir';
}

/** Muted one-liner for a section with nothing in it. */
function Empty({ children }: { children: ReactNode }) {
  return <div className="px-3 py-2 text-xs italic text-muted-foreground">{children}</div>;
}

/** Muted one-liner under a section header, explaining where its rows come from. */
function Note({ children }: { children: ReactNode }) {
  return <p className="px-2 pb-1 text-[11px] text-muted-foreground">{children}</p>;
}

/** The `+` in a section header. Sized to sit on the header's own line without
 *  growing it — the label and the caret set that height. */
function SectionAddButton({ label, onClick, testId }: { label: string; onClick: () => void; testId: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
      title={label}
      aria-label={label}
      data-testid={testId}
    >
      <Plus className="h-3.5 w-3.5" />
    </button>
  );
}

/** Read-only row, MCP only: what a worker reaches is decided by the vendor's
 *  config files, so a control would be a box you cannot uncheck. Skills ARE
 *  per-agent intent and use `AssetRow`, whose control writes `agent.skills`. */
function ResourceRow({
  icon: Icon,
  label,
  hint,
  testId,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  hint?: string;
  testId: string;
}) {
  return (
    <div
      className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground"
      title={hint ? `${label} — ${hint}` : label}
      data-testid={testId}
    >
      <Icon className="h-3.5 w-3.5 flex-shrink-0" />
      <span className="truncate">{label}</span>
    </div>
  );
}

/**
 * The four-section body of the agent-resources navigator. An inventory with one
 * editable axis: Skills rows select into `agent.skills`, which
 * `Deployment.build` copies into every session. The rest are read-only.
 */
export function AgentResourcesBody() {
  const { t } = useLingui();

  const { descriptors: skillDescriptors, isLoading: skillsLoading } = useWirableSkills();
  // Both lists are scoped to the worker the agent is set to; the editor's
  // worker field commits to `agent.md`, which is what this observes. The same
  // document is the write surface for the declared skills.
  const doc = useAgentDocument();
  const workerType = doc.workerType;
  const workerLoading = doc.isLoading;
  const { declared: declaredSkills, pendingId: pendingSkillId, toggle: toggleSkill } = useAgentListWiring(doc, 'skills');
  const { servers: mcpServers, isLoading: mcpLoading } = useWirableMcpServers(workerType);
  const { docs, isLoading: docsLoading } = useProjectDocs();

  const [addSourceOpen, setAddSourceOpen] = useState(false);

  const docIcon = iconForType(Markdown.type);
  // MCP servers have no per-type registry glyph of their own.
  const mcpIcon = lucideByName('Plug');

  // Resolved once here, not per render — the same split `AssetManagerPopover`'s
  // list memo makes. NOT deduped by name: one row per (typeid, source) is the
  // point, and collapsing would hide the distinction the scope chip shows.
  const skillRows = useMemo(
    () =>
      skillDescriptors.map((d) => ({
        descriptor: d,
        key: descriptorKey(d),
        scope: assetScope(d),
        label: labelForAsset(d),
        selected: declaredSkills.has(d.typeid),
        selectable: isSelectableSkill(d),
      })),
    [skillDescriptors, declaredSkills],
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
          <SectionAddButton
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
        <Note>
          <Trans>Configured for the {workerType} worker — not selected per agent.</Trans>
        </Note>
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
        emptyState={
          <Empty>
            <Trans>No skills found</Trans>
          </Empty>
        }
      >
        <Note>
          <Trans>Selected skills are copied into each session this agent starts. Your global skills are always available and need no selection.</Trans>
        </Note>
        {/* Both callbacks supplied = the select control FLIPS: `+` to import,
            `X` to drop it again. `AssetRow` deliberately does not gate that
            control on the source being read-only — "read-only describes whether
            the asset FILE can be edited, not whether the user's own selection
            can be undone" — which is load-bearing here, since every row is a
            read-only global or context-folder source. */}
        {skillRows.map((row) => (
          <AssetRow
            key={row.key}
            descriptor={row.descriptor}
            scope={row.scope}
            label={row.label}
            selected={row.selected}
            improvable={false}
            busy={pendingSkillId === row.descriptor.typeid}
            // Offered only where selecting DOES something. A row that is
            // already selected keeps its un-select control regardless, so a
            // stale entry can always be cleared — withholding it there would
            // strand the value with no way to remove it.
            onPick={row.selectable ? (d) => void toggleSkill(d.typeid, true) : undefined}
            onUnpick={
              row.selectable || row.selected ? (d) => void toggleSkill(d.typeid, false) : undefined
            }
          />
        ))}
      </NavigatorSection>

      <NavigatorSection
        id="docs"
        label={t`Docs`}
        isLoading={docsLoading}
        itemCount={docs.length}
        emptyState={
          <Empty>
            <Trans>No docs found</Trans>
          </Empty>
        }
      >
        {docs.map((doc) => (
          <ResourceRow
            key={doc.id}
            icon={docIcon}
            label={doc.title || doc.name || ''}
            testId={`agent-resource-doc-${doc.id}`}
          />
        ))}
      </NavigatorSection>
    </div>
  );
}
