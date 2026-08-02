import { SubAgent, AgentKind, Project, type AssetDescriptor } from '@sdk';
import { AssetPickerPopover } from '@src/components/asset-manager/AssetPickerPopover';
import { parseTypeid } from '@src/components/asset-manager/asset-row-helpers';
import { Button } from '@src/components/ui/button';
import { useVibeAgents } from '@src/hooks/use-vibe-agents';
import { notify } from '@src/notifications';
import { Bot, Loader2, Plus, Sparkles, X } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { tagAttrs } from '@src/tags/tag-attrs';

interface VibeAgentsCardProps {
  project: Project | null | undefined;
}

/** The tag word this card answers to (`?highlight=`, click observability).
 *  Exported so the tab that hosts the card can open itself for it. */
export const VIBE_AGENTS_TAG = 'VibeAgents';

/**
 * Project "Vibe agents" — the agents layered on top of the standard vibe agent
 * on vibe process start (all `kind==vibe`, embedded in created-date order after
 * it). The standard vibe agent is pinned first and non-removable. The picker
 * marks an existing agent `kind=vibe` (via `SubAgent.setKind`); the row X unmarks
 * it (`kind=harness`). This is a live query, NOT a process's embedded-asset list.
 */
export const VibeAgentsCard: React.FC<VibeAgentsCardProps> = ({ project }) => {
  const { t } = useLingui();
  const { agents, refetch } = useVibeAgents(project?.id);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Hide agents already in the set from the add-picker.
  const alreadyVibe = useMemo(() => new Set(agents.map((a) => `agent-${a.id}`)), [agents]);
  const pickerFilter = (d: AssetDescriptor) => d.typeid.startsWith('subagent-') && !alreadyVibe.has(d.typeid);

  const addVibe = async (d: AssetDescriptor) => {
    const id = parseTypeid(d.typeid).id;
    if (!id || busyId) return;
    setBusyId(id);
    try {
      await SubAgent.setKindById(id, AgentKind.Vibe);
      await refetch();
      notify.success({ title: t`Added vibe agent` });
    } catch (err) {
      notify.error({ title: err instanceof Error ? err.message : t`Failed to add vibe agent` });
    } finally {
      setBusyId(null);
    }
  };

  const removeVibe = async (agent: SubAgent) => {
    if (busyId) return;
    setBusyId(agent.id);
    try {
      await agent.setKind(AgentKind.Harness);
      await refetch();
      notify.success({ title: t`Removed vibe agent` });
    } catch (err) {
      notify.error({ title: err instanceof Error ? err.message : t`Failed to remove vibe agent` });
    } finally {
      setBusyId(null);
    }
  };

  return (
    // Highlightable + observable purely via the tag tag — the generic
    // TagHighlightObserver applies the ring/beacon when a journey (or any
    // ?highlight=VibeAgents URL) points here. No component-local wiring.
    <div
      {...tagAttrs(VIBE_AGENTS_TAG, 'button')}
      className="relative rounded-lg border border-border p-4 transition-all duration-500"
      data-testid="vibe-agents-card"
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-medium"><Trans>Vibe agents</Trans></h3>
        </div>
        <AssetPickerPopover
          trigger={
            <Button variant="outline" size="sm" data-testid="vibe-agents-add">
              <Plus className="h-3.5 w-3.5" />
              <span className="ml-1.5"><Trans>Add</Trans></span>
            </Button>
          }
          filter={pickerFilter}
          searchPlaceholder={t`Add an agent…`}
          onPick={(d) => void addVibe(d)}
        />
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        <Trans>These agents are added on top of the standard vibe agent, in the order shown, every vibe session.</Trans>
      </p>

      <ul className="flex flex-col gap-1.5">
        {/* Standard vibe agent — always present, non-removable. */}
        <li
          className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-2.5 py-1.5"
          data-testid="vibe-agent-standard"
        >
          <Bot className="h-3.5 w-3.5 shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate text-sm">vibe</span>
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            <Trans>standard</Trans>
          </span>
        </li>

        {/* Project kind==vibe agents, created-date order. */}
        {agents.map((agent) => (
          <li
            key={agent.id}
            className="flex items-center gap-2 rounded-md border border-border/60 px-2.5 py-1.5"
            data-testid={`vibe-agent-${agent.id}`}
          >
            <Bot className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-sm">{agent.displayName || agent.name || agent.id}</span>
            <button
              type="button"
              className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
              onClick={() => void removeVibe(agent)}
              disabled={busyId === agent.id}
              title={t`Remove from vibe agents`}
              data-testid={`vibe-agent-remove-${agent.id}`}
            >
              {busyId === agent.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
};
