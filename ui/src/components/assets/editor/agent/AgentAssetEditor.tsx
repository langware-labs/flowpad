import { MarkdownEditor } from '@src/components/assets/editor/markdown/MarkdownEditor';
import { EntityExecutionPanel } from '@src/components/entity-execution-panel';
import { useEntityByPath } from '@src/hooks/use-entity-by-path';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { Agent, AgenticProcess, AgentKind, FSRef, ProcessKind } from '@sdk';
import { useProject } from '@sdk/react/hooks';
import { useCallback, useState } from 'react';
import { Trans } from '@lingui/react/macro';
import { Loader2, Play } from 'lucide-react';
import { Button } from '@src/components/ui/button';
import { createVibeProcessForProject } from '@src/pages/flow-page/use-start-vibe-session';
import { notify } from '@src/notifications';
import { topicTag } from '@src/topics/topic-tag';

interface AgentAssetEditorProps {
  /** FSRef to the agent .md file. */
  fsRef: FSRef;
  /**
   * Pre-resolved agent entity. Passed by `<EntityResolutionGate>` from
   * `AssetEditorRouter`. When omitted, the editor falls back to
   * `useEntityByPath` for backwards compatibility with direct-mount callers.
   */
  agent?: Agent;
}

/**
 * Agent files render two surfaces, keyed on different `target_typeid_str`
 * values so they own separate AgenticProcess rows:
 *
 *   - Side-drawer editor process — generic, no agent embed,
 *     keyed on `fsRef.vpath` (the file's compute-node-rooted VFS path).
 *     Same surface every other doc gets.
 *   - Bottom agent execution — keyed on the agent entity's typeId; first
 *     send calls `loadEmbeddedAgent` so subsequent turns adopt the agent
 *     persona (see compose_prompt single-agent branch).
 */
export function AgentAssetEditor({ fsRef, agent: providedAgent }: AgentAssetEditorProps) {
  const { entity: discoveredAgent } = useEntityByPath<Agent>(
    providedAgent ? null : Agent.type,
    providedAgent ? null : fsRef,
  );
  const agent = providedAgent ?? discoveredAgent;
  // Prefer the entity-derived doc (built from agent.asset_ref) once the entity
  // resolves. Falls back to the URL-derived fsRef while loading. Both resolve
  // to the same file post mount-path fix, but the entity-derived ref is the
  // explicit source of truth.
  const editorRef = agent?.doc ?? fsRef;
  const sourcePath = agent?.asset_ref ?? fsRef.path;
  const loadAgent = useCallback(
    async (proc: AgenticProcess) => {
      await proc.loadEmbeddedAgent(sourcePath);
    },
    [sourcePath],
  );
  // chatTarget MUST be the entity's TypeId — MarkdownEditor builds `new TypeId(chatTarget)`
  // and uses it as docTypeId. Passing a path here is what caused the "Invalid typeId" crash.
  const chatTarget = agent ? agent.typeId.toString() : null;
  const agentExecutionTarget = agent ? agent.typeId.toString() : null;
  const { navigation } = useDockNavigation();
  const { project } = useProject();
  const onDelete = useCallback(async () => {
    if (!agent) return;
    await agent.delete();
    navigation.openDock(DockPointer.forAssetList(Agent.type));
  }, [agent, navigation]);

  // "Use agent": mark it a vibe agent (the vibe layer embeds every kind==vibe
  // agent on process start) and open the vibe workspace — the agent is live in
  // a process, ready to be asked. Topic-tagged, so journeys can highlight it
  // and observe the click through the standard bus wiring.
  const [launching, setLaunching] = useState(false);
  const startUsingAgent = useCallback(async () => {
    if (!agent || !project?.id || launching) return;
    setLaunching(true);
    try {
      await agent.setKind(AgentKind.Vibe);
      await createVibeProcessForProject({ projectId: project.id, navigation });
    } catch (e) {
      notify.error({ title: e instanceof Error ? e.message : 'Failed to start the agent' });
    } finally {
      setLaunching(false);
    }
  }, [agent, project?.id, navigation, launching]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {agent && (
        <div className="flex items-center justify-end border-b border-border px-3 py-1.5">
          <Button
            type="button"
            size="sm"
            disabled={launching || !project?.id}
            onClick={() => void startUsingAgent()}
            className="h-7 gap-1.5 px-3 text-xs"
            data-testid="agent-use"
            {...topicTag('UseAgent', 'button')}
          >
            {launching ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
            <Trans>Use agent</Trans>
          </Button>
        </div>
      )}
      {/* Tagged so a journey can aim at the instructions body — highlight it, or
          fill it via `act:{kind:'fill', target:'AgentInstructions'}`. The tag
          goes on the CONTAINER; the act resolves the editable inside it, which
          the rich editor owns and may re-create. */}
      <div className="min-h-0 flex-1" {...topicTag('AgentInstructions', 'input')}>
        <MarkdownEditor
          fsRef={editorRef}
          chatTarget={chatTarget}
          onDelete={agent ? onDelete : undefined}
          deleteLabel={agent?.name ?? undefined}
        />
      </div>
      {agentExecutionTarget && (
        <div className="h-[300px] flex-shrink-0 border-t" data-testid="agent-execution">
          <EntityExecutionPanel
            target={agentExecutionTarget}
            processType={ProcessKind.Execution}
            onProcessCreated={loadAgent}
            headerLabel="Agent execution"
            className="h-full"
          />
        </div>
      )}
    </div>
  );
}
