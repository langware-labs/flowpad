import { MarkdownEditor } from '@src/components/assets/editor/markdown/MarkdownEditor';
import { useEntityByPath } from '@src/hooks/use-entity-by-path';
import { Agent, AgenticProcess, FSRef } from '@sdk';
import { useCallback } from 'react';

interface AgentAssetEditorProps {
  /** FSRef to the agent .md file. */
  fsRef: FSRef;
}

/**
 * Agent files are edited and chatted with through the standard `MarkdownEditor`.
 * The Chat tab owns the conversation; we also hook into first-process creation
 * to embed this agent into the backing AgenticProcess so the CLI worker gets
 * the `--agents` flag.
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
  return (
    <MarkdownEditor
      fsRef={fsRef}
      chatTarget={agent ? agent.typeId.toString() : null}
      chatOnProcessCreated={embedAgent}
    />
  );
}
