import { MarkdownEditor } from '@src/components/assets/editor/markdown/MarkdownEditor';
import { EntityExecutionPanel } from '@src/components/entity-execution-panel';
import { useEntityByPath } from '@src/hooks/use-entity-by-path';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { Agent, AgenticProcess, FSRef, ProcessKind } from '@sdk';
import { useCallback } from 'react';

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
  const onDelete = useCallback(async () => {
    if (!agent) return;
    await agent.delete();
    navigation.openDock(DockPointer.forAssetList(Agent.type));
  }, [agent, navigation]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
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
