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
 * Agent files use a vertical layout: the markdown body on top and an
 * `EntityChatPanel` pinned to the bottom for talking to the agent. The doc's
 * side drawer drops its Chat tab (`disableChat`) so we don't mount two
 * chats against the same target — a race on lazy `AgenticProcess` creation.
 * On first send, `loadEmbeddedAgent` registers this .md as the embedded
 * agent so the CLI worker gets the `--agents` flag.
 */
export function AgentAssetEditor({ fsRef }: AgentAssetEditorProps) {
  const { entity: agent } = useEntityByPath<Agent>(Agent.type, fsRef);
  const sourcePath = fsRef.path;
  const embedAgent = useCallback(
    async (proc: AgenticProcess) => {
      await proc.loadEmbeddedAgent(sourcePath);
    },
    [sourcePath],
  );
  const target = agent ? agent.typeId.toString() : null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <MarkdownEditor fsRef={fsRef} chatTarget={target} disableChat />
      </div>
      {target && (
        <div className="h-[300px] flex-shrink-0 border-t" data-testid="agent-bottom-chat">
          <EntityChatPanel
            target={target}
            onProcessCreated={embedAgent}
            className="h-full"
          />
        </div>
      )}
    </div>
  );
}
