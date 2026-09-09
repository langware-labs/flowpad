import { Agent } from '@sdk';

import { AgentSignature } from '@src/components/agents/AgentSignature';
import { MarkdownView } from '@src/components/markdown-view';
import { surfaceForViewMode, useViewMode } from '@src/contexts/view-mode-context';

/**
 * The agent's `intro` for the CURRENT skin, or null. Chat surfaces (Vibe,
 * Standard) show it; the terminal surface (Advanced/Dev) fronts the raw
 * session, where a row that is not in the transcript would mislead.
 */
export function useAgentIntro(agent?: Agent | null): string | null {
  const surface = surfaceForViewMode(useViewMode());
  const intro = agent?.intro?.trim();
  return intro && surface !== 'terminal' ? intro : null;
}

/**
 * The agent's `intro`, rendered as its FIRST message — a welcome placeholder
 * so a fresh session is never an empty pane. Presentation only: not a
 * transcript row, nothing on disk, nothing the model sees.
 */
export function AgentIntroMessage({ agent }: { agent?: Agent | null }) {
  const intro = useAgentIntro(agent);
  if (!agent || !intro) return null;
  return (
    <div className="py-2.5" data-testid="agent-intro-message" data-role="assistant">
      <div className="mb-1 flex items-center gap-2">
        <AgentSignature agent={agent} />
      </div>
      <div className="min-w-0 break-words ps-7 text-[15px] leading-7 text-foreground">
        <MarkdownView value={intro} compact />
      </div>
    </div>
  );
}
