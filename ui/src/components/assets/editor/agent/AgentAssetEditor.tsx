import { MarkdownEditor } from '@src/components/assets/editor/markdown/MarkdownEditor';
import { AgenticProcess, FSRef } from '@sdk';
import { useCallback } from 'react';

interface AgentAssetEditorProps {
  /** FSRef to the agent .md file. */
  fsRef: FSRef;
}

/**
 * Agent files are edited and chatted with through the standard `MarkdownEditor`.
 * The Chat tab in its side drawer owns the conversation; we hook into first-
 * process creation to embed this agent into the backing AgenticProcess so the
 * `--agents` flag is set when the CLI worker launches.
 */
export function AgentAssetEditor({ fsRef }: AgentAssetEditorProps) {
  const sourcePath = fsRef.path;
  const embedAgent = useCallback(
    async (proc: AgenticProcess) => {
      await proc.loadEmbeddedAgent(sourcePath);
    },
    [sourcePath],
  );
  return <MarkdownEditor fsRef={fsRef} chatOnProcessCreated={embedAgent} />;
}
