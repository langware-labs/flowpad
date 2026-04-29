import { MarkdownEditor } from '@src/components/assets/editor/markdown/MarkdownEditor';
import { EntityChatPanel } from '@src/components/entity-chat-panel';
import { useEntityByPath } from '@src/hooks/use-entity-by-path';
import { Agent, AgenticProcess, FSRef } from '@sdk';
import { useCallback } from 'react';

interface AgentAssetEditorProps {
  /** FSRef to the agent .md file. */
  fsRef: FSRef;
}

/**
 * Agent files render two distinct chat surfaces, keyed on different
 * `target_vfs_path` values so they own separate AgenticProcess rows:
 *
 *   - Side drawer "chat with the doc" — generic, no agent embed,
 *     keyed on `fsRef.vpath` (the file's compute-node-rooted VFS path).
 *     Same surface every other doc gets.
 *   - Bottom "talk with the agent" — keyed on the agent entity's
 *     typeId; first send calls `loadEmbeddedAgent` so subsequent turns
 *     adopt the agent persona (see compose_prompt single-agent branch).
 */
export function AgentAssetEditor({ fsRef }: AgentAssetEditorProps) {
  const { entity: agent } = useEntityByPath<Agent>(Agent.type, fsRef);
  // Prefer the entity-derived doc (built from agent.asset_ref) once the entity
  // resolves. Falls back to the URL-derived fsRef while loading. Both resolve
  // to the same file post mount-path fix, but the entity-derived ref is the
  // explicit source of truth.
  const editorRef = agent?.doc ?? fsRef;
  const sourcePath = agent?.asset_ref ?? fsRef.path;
  const embedAgent = useCallback(
    async (proc: AgenticProcess) => {
      await proc.loadEmbeddedAgent(sourcePath);
    },
    [sourcePath],
  );
  const docTarget = fsRef.vpath;
  const agentTarget = agent ? agent.typeId.toString() : null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <MarkdownEditor fsRef={editorRef} chatTarget={docTarget} />
      </div>
      {agentTarget && (
        <div className="h-[300px] flex-shrink-0 border-t" data-testid="agent-bottom-chat">
          <EntityChatPanel
            target={agentTarget}
            onProcessCreated={embedAgent}
            className="h-full"
          />
        </div>
      )}
    </div>
  );
}
