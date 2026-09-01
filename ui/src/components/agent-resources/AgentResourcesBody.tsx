import { useMemo, useState, type ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Plus } from 'lucide-react';
import { Markdown, Skill, type AssetDescriptor } from '@sdk';
import { NavigatorSection } from '@src/components/navigator-panel/NavigatorSection';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { lucideByName } from '@src/lib/lucide-by-name';
import { AssetRow, assetScope, basename, descriptorKey, displayLabelForDescriptor } from '@src/components/asset-manager';
import { DataSourceDialog } from '@src/components/data-sources/DataSourceDialog';
import { useQuickCreatePick } from '@src/components/quick-create';
import { useProjectDocs } from './useProjectDocs';
import { useWirableSkills } from './useWirableSkills';
import { useWirableMcpServers } from './useWirableMcpServers';
import { useAgentDocument } from './useAgentDocument';
import { useAgentListWiring } from './useAgentListWiring';

/**
 * Row label, with a path fallback the shared helper cannot provide.
 *
 * `displayLabelForDescriptor` resolves a cached entity, then the descriptor's
 * own `name`, then gives up and returns the raw typeid. Both of the first two
 * miss here: `get-assets` sends `name` ONLY for an on-disk asset with no entity
 * row, and this pane never loads Skill entities into the dataManager cache (it
 * lists by location precisely so it does not have to). Every indexed skill
 * therefore rendered as a bare `skill-<uuid>`.
 *
 * The folder basename is the right answer, not a guess: a skill's on-disk
 * identity IS its folder — `resolve_skill_name` uses it unless SKILL.md
 * declares a `name`. Applied only on the give-up path, so a real cached
 * displayName (which a rename updates) always wins.
 */
function labelForAsset(d: AssetDescriptor): string {
  const label = displayLabelForDescriptor(d);
  return label === d.typeid && d.posix_path ? basename(d.posix_path) : label;
}

/**
 * Whether selecting this skill would change anything.
 *
 * A `user_dir` skill lives in `~/.claude/skills`, which the vendor CLI
 * discovers on its own for every session — copying it into the process assets
 * dir produces a second copy of a skill the worker already had. So the control
 * is withheld there rather than offering a toggle whose only effect is a
 * redundant `copytree`.
 *
 * Project and context-folder skills are the real cases: they reach a worker
 * only if something puts them where that worker looks.
 */
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

/**
 * A read-only resource row — used for MCP servers only.
 *
 * MCP carries no selection affordance because there is nothing to select: what
 * a worker can reach is decided by the vendor's own config files, so a control
 * here would be a checked box you cannot uncheck. Skills are the opposite —
 * they ARE per-agent intent — and render the shared `AssetRow`, whose select
 * control writes `agent.skills`.
 */
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
 * The four-section body of the agent-resources navigator.
 *
 * Mostly an inventory — it answers "what can this agent draw on?" for the four
 * resource families — with exactly one editable axis: the Skills rows select
 * into `agent.skills`, which `Deployment.build` then copies into every session
 * the agent starts. Data sources, MCP servers and Docs stay read-only, each for
 * its own reason (no Agent field; vendor-config-owned; project-scoped listing).
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
  // The project home's own creation seam, reused whole: `onPick(type)` opens
  // the same name/scope/path form (or the type's bespoke dialog, for types
  // whose location TypeInfo already fixes). `dialogs` MUST be rendered — the
  // hook's docstring calls out that hosting the trigger without it makes the
  // control silently do nothing.
  const { panelProps, dialogs } = useQuickCreatePick();

  const docIcon = iconForType(Markdown.type);
  // MCP servers have no per-type registry glyph of their own.
  const mcpIcon = lucideByName('Plug');

  // Resolved once here rather than per render inside each row — `assetScope`
  // and the label are cache lookups and allocations, which is the same split
  // `AssetManagerPopover`'s list memo makes.
  //
  // Deliberately NOT deduped by name: the descriptor model returns one row per
  // (typeid, source) on purpose and keys selection by typeid, so collapsing on
  // name would hide the very distinction — user-global vs project vs context
  // folder — that the scope chip exists to show.
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
        action={
          <SectionAddButton
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

      {/* Rendered at the pane root, outside every section: a section can be
          collapsed while its dialog is open, and a dialog unmounted by that
          collapse would close itself mid-edit. */}
      {dialogs}
    </div>
  );
}
