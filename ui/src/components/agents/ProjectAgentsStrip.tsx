import { Agent, Project, TypeId } from '@sdk';
import { useProject } from '@sdk/react/hooks';
import { AgentAvatar } from '@src/components/agents/AgentAvatar';
import { AgentIntroCard } from '@src/components/agents/AgentIntroCard';
import { useAgentLauncher } from '@src/components/agents/use-agent-launcher';
import { labelForType } from '@src/components/graph-view/icons/iconRegistry';
import { DesktopTile, TileSection } from '@src/components/quick-create/QuickCreatePanel';
import { useProjectAgents } from '@src/hooks/use-project-agents';
import { cn } from '@src/lib/utils';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useLingui } from '@lingui/react/macro';
import { Pencil } from 'lucide-react';

/**
 * The project's agents, as tiles, on a home surface — the one place a launchable
 * Agent is reachable without first opening its profile editor. A tile click
 * starts a session AS that agent in Vibe mode; its pencil badge opens the
 * profile editor directly, and hovering explains who it is.
 *
 * Mounted on every home: the Vibe home hero, both branches of the `/` landing,
 * and Project Home's Create tab. One component at all four sites for the same
 * reason `ProjectActionsRow` is shared — so the surfaces cannot drift apart.
 *
 * Renders NOTHING when the project has no agents (the `VibeRecentSessions`
 * precedent): a fresh project should keep its bare hero, not gain an empty box.
 * Creating an agent stays quick-create's job; a second creation entry point here
 * would be a third way to do one thing.
 */
export function ProjectAgentsStrip({ projectId, className }: { projectId?: string | null; className?: string }) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  // The PROJECT, not just its id: the agent lookup needs its context roots. A
  // `projectId` pins a specific project (Project Home passes its own);
  // `undefined` resolves the active one. No memo on the TypeId — `useEntity`
  // keys on its type/id STRINGS, not object identity.
  const { project } = useProject(projectId ? new TypeId(Project.type, projectId) : null);
  const { agents } = useProjectAgents(project);
  const { launch, busyId } = useAgentLauncher();

  if (agents.length === 0) return null;

  return (
    // `text-start`: the hero surfaces are `text-center`, and a centered section
    // heading over a left-packed grid reads as a mistake.
    <div className={cn('text-start', className)} data-testid="project-agents-strip">
      <TileSection title={labelForType(Agent.type)}>
        {agents.map((agent) => {
          const useDisabled = !agent.enabled || !!busyId;
          const useAgent = () => void launch(agent, project?.id ?? null);
          const editLabel = `${t`Edit`} ${agent.displayName}`;
          return (
            <div key={agent.id} className="relative h-20 w-20">
              {/* Hover, not click: the tile itself uses the Agent. The card's
                  explicit action does the same, while the badge below owns edit. */}
              <AgentIntroCard agent={agent} trigger="hover" onUse={useAgent} useDisabled={useDisabled}>
                <DesktopTile
                  // The agent's own face, never the type glyph — a grid of
                  // identical BrainCog icons would name none of them.
                  iconSlot={<AgentAvatar agent={agent} className="h-9 w-9 text-sm" glyphClassName="h-5 w-5 text-xl" />}
                  label={agent.displayName}
                  loading={busyId === agent.id}
                  // A disabled agent is refused server-side by `_require_agent`, and
                  // a launch navigates away — so while one is starting, every tile
                  // goes inert rather than racing it.
                  disabled={useDisabled}
                  // The project the STRIP resolved, not the active one: a pinned
                  // strip lists this project's agents and must launch into it too.
                  onClick={useAgent}
                  data-testid="project-agent-tile"
                  data-agent-name={agent.name}
                />
              </AgentIntroCard>
              {/* A sibling (not a button nested in DesktopTile) positioned over
                  the avatar's lower-right edge. */}
              <button
                type="button"
                onClick={() => navigation.openDock(agent.dockPointer)}
                className="absolute left-12 top-8 z-10 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-sm hover:border-primary hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={editLabel}
                title={editLabel}
                data-testid="project-agent-edit"
              >
                <Pencil className="h-3 w-3" aria-hidden />
              </button>
            </div>
          );
        })}
      </TileSection>
    </div>
  );
}
