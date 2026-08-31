import { useMemo, useState, type ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Markdown, Skill, type DataSourceSpec } from '@sdk';
import { NavigatorSection } from '@src/components/navigator-panel/NavigatorSection';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { lucideByName } from '@src/lib/lucide-by-name';
import { cn } from '@src/lib/utils';
import { useSourceSpecs } from '@src/components/data-sources/use-source-specs';
import { useAgentSkillsWiring } from './useAgentSkillsWiring';
import type { AgentDocument } from './useAgentDocument';
import { useProjectDocs } from './useProjectDocs';
import { useWirableSkills } from './useWirableSkills';

/** Muted one-liner for a section with nothing in it. */
function Empty({ children }: { children: ReactNode }) {
  return <div className="px-3 py-2 text-xs italic text-muted-foreground">{children}</div>;
}

/**
 * One selectable resource row. The checkbox is the affordance; the label is not
 * a navigation target — this pane wires resources, it does not browse them.
 */
function ResourceRow({
  icon: Icon,
  label,
  hint,
  checked,
  disabled,
  onToggle,
  testId,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onToggle: (next: boolean) => void;
  testId: string;
}) {
  return (
    <label
      className={cn(
        'flex items-center gap-2 px-2 py-1.5 text-sm',
        disabled ? 'cursor-default text-muted-foreground/60' : 'cursor-pointer text-muted-foreground hover:bg-muted',
      )}
      title={hint ? `${label} — ${hint}` : label}
      data-testid={testId}
    >
      <input
        type="checkbox"
        className="h-3.5 w-3.5 flex-shrink-0 accent-primary"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onToggle(e.target.checked)}
      />
      <Icon className="h-3.5 w-3.5 flex-shrink-0" />
      <span className="truncate">{label}</span>
    </label>
  );
}

/**
 * The four-section body of the agent-resources navigator.
 *
 * Only Skills persists (into `agent.skills`). Data sources and Docs keep their
 * selection in local state on purpose: the `Agent` entity has no field for
 * either, and inventing one is explicitly out of scope for this change. The
 * rows are built so that giving them a real home later is a swap of the
 * checked/onToggle pair, not a rewrite.
 */
export function AgentResourcesBody({ doc }: { doc: AgentDocument }) {
  const { t } = useLingui();

  const { specs, isLoading: specsLoading } = useSourceSpecs();
  const { skills, isLoading: skillsLoading } = useWirableSkills();
  const { docs, isLoading: docsLoading } = useProjectDocs();
  const { declared, pendingId, toggle } = useAgentSkillsWiring(doc);

  // Unpersisted, deliberately (see the component docstring).
  const [pickedSources, setPickedSources] = useState<Set<string>>(new Set());
  const [pickedDocs, setPickedDocs] = useState<Set<string>>(new Set());

  const togglePick = (set: Set<string>, apply: (s: Set<string>) => void) => (key: string, next: boolean) => {
    const copy = new Set(set);
    if (next) copy.add(key);
    else copy.delete(key);
    apply(copy);
  };

  const skillIcon = iconForType(Skill.type);
  const docIcon = iconForType(Markdown.type);

  // One row per source NAME, not per spec row. `DataSourceSpec` has derived
  // (path-based) identity, so every checkout of the repo on this machine mints
  // its own row for the same nine shipped sources — a raw render shows "Slack"
  // three times. `name` is the registry key, which is why the hook's own lookup
  // map is keyed on it; this is the list form of that same collapse.
  const uniqueSpecs = useMemo(() => {
    const byName = new Map<string, DataSourceSpec>();
    for (const spec of specs) if (spec.name && !byName.has(spec.name)) byName.set(spec.name, spec);
    return [...byName.values()].sort((a, b) => (a.title || a.name || '').localeCompare(b.title || b.name || ''));
  }, [specs]);

  // One row per skill NAME, for the same multi-checkout reason as the sources.
  // Which ROW wins matters here though, because the checkbox stores a TypeId:
  // when the agent already declares one of a name's rows, that row must be the
  // one rendered, or its own selection would read back as unchecked.
  const uniqueSkills = useMemo(() => {
    const byName = new Map<string, Skill>();
    for (const skill of skills) {
      const name = skill.name ?? '';
      const existing = byName.get(name);
      if (!existing || declared.has(skill.typeId?.toString() ?? '')) byName.set(name, skill);
    }
    return [...byName.values()];
  }, [skills, declared]);

  // Values on the agent that match no listed skill. Without a row they would be
  // invisible AND silently preserved in agent.md — and the Advanced tab's
  // free-text box, which used to be the way to see them, is gone.
  const listedIds = new Set(skills.map((s) => s.typeId?.toString()).filter(Boolean));
  const orphanIds = [...declared].filter((id) => !listedIds.has(id));

  return (
    <div className="flex flex-col py-1">
      <NavigatorSection
        id="data-sources"
        label={t`Data sources`}
        isLoading={specsLoading}
        itemCount={uniqueSpecs.length}
        emptyState={
          <Empty>
            <Trans>No data sources found</Trans>
          </Empty>
        }
      >
        {uniqueSpecs.map((spec) => (
          <ResourceRow
            key={spec.name}
            // Per-provider glyph comes from the spec's `icon_name`. Never
            // `spec.icon` — that is a getter with no setter, and assigning it
            // throws during hydration and blanks the whole spec query.
            icon={lucideByName(spec.icon_name)}
            label={spec.title || spec.name || ''}
            hint={spec.description}
            checked={pickedSources.has(spec.name ?? '')}
            onToggle={(next) => togglePick(pickedSources, setPickedSources)(spec.name ?? '', next)}
            testId={`agent-resource-source-${spec.name}`}
          />
        ))}
      </NavigatorSection>

      <NavigatorSection
        id="mcp-servers"
        label={t`MCP servers`}
        itemCount={0}
        emptyState={
          <Empty>
            <Trans>No MCP servers found</Trans>
          </Empty>
        }
      />

      <NavigatorSection
        id="skills"
        label={t`Skills`}
        isLoading={skillsLoading}
        itemCount={uniqueSkills.length + orphanIds.length}
        emptyState={
          <Empty>
            <Trans>No skills found</Trans>
          </Empty>
        }
      >
        <p className="px-2 pb-1 text-[11px] text-muted-foreground">
          <Trans>Declared on the agent's card. Not yet applied to the worker.</Trans>
        </p>
        {uniqueSkills.map((skill) => {
          const id = skill.typeId?.toString() ?? '';
          return (
            <ResourceRow
              key={id || skill.name}
              icon={skillIcon}
              label={skill.name ?? id}
              hint={skill.description}
              checked={declared.has(id)}
              disabled={!doc.ready || pendingId === id}
              onToggle={(next) => void toggle(skill, next)}
              testId={`agent-resource-skill-${skill.name}`}
            />
          );
        })}
        {orphanIds.map((id) => (
          <ResourceRow
            key={id}
            icon={skillIcon}
            label={id}
            hint={t`Declared on this agent but no matching skill was found`}
            checked
            disabled
            onToggle={() => {}}
            testId={`agent-resource-skill-unresolved-${id}`}
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
            checked={pickedDocs.has(doc.id ?? '')}
            onToggle={(next) => togglePick(pickedDocs, setPickedDocs)(doc.id ?? '', next)}
            testId={`agent-resource-doc-${doc.id}`}
          />
        ))}
      </NavigatorSection>
    </div>
  );
}
