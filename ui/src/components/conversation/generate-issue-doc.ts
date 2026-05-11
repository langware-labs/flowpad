import { AgenticProcess, ClaudeSessionRecord } from '@sdk';

const ISSUE_PROMPT = `Based on this conversation, write a concise markdown document the recipient can use to assist the sender.

Cover:
- What the sender was trying to do
- What went wrong, if anything
- What they've already tried
- The specific help they need now

Output only the markdown document. No preamble, no closing remarks.`;

interface GenerateIssueDocOptions {
  /** The sender's live AgenticProcess. Must have a session_id and workdir. */
  proc: AgenticProcess;
  /** Optional override for the project path used for transcript discovery. */
  projectPath?: string;
}

/**
 * Spawn a headless Claude fork of the sender's session, ask it to summarize
 * the issue, and return the resulting markdown wrapped as a File ready to
 * attach to a share. Returns null if the run produced no usable text.
 */
export async function generateIssueDocument({ proc, projectPath }: GenerateIssueDocOptions): Promise<File> {
  const sessionId = proc.session_id;
  if (!sessionId) {
    throw new Error('Cannot generate issue document: the active process has no session_id yet');
  }
  const workdir = projectPath ?? proc.workdir ?? undefined;
  if (!workdir) {
    throw new Error('Cannot generate issue document: no workdir available');
  }

  const { process: headless } = await AgenticProcess.spawn(
    {
      permissionMode: 'bypassPermissions',
      resumeSessionId: sessionId,
      forkSession: true,
      workdir,
    },
    {
      headless: true,
      instruction: ISSUE_PROMPT,
      sync: true,
    },
  );

  const headlessSessionId = headless.session_id;
  if (!headlessSessionId) {
    throw new Error('Headless run completed but produced no session_id');
  }

  const transcript = await ClaudeSessionRecord.fetchTranscriptRaw(headlessSessionId, { project: workdir });
  if (!transcript) {
    throw new Error('Headless run produced no readable transcript');
  }

  const lastAssistantText = extractLastAssistantText(transcript);
  if (!lastAssistantText) {
    throw new Error('Headless run did not produce any assistant text');
  }

  return new File([lastAssistantText], 'issue.md', { type: 'text/markdown' });
}

function extractLastAssistantText(jsonlText: string): string {
  const lines = jsonlText.split('\n');
  let last = '';
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj?.type !== 'assistant') continue;
      const content = obj?.message?.content;
      if (Array.isArray(content)) {
        const textBlock = content.find((b: any) => b?.type === 'text' && typeof b?.text === 'string');
        if (textBlock?.text) last = textBlock.text;
      } else if (typeof content === 'string' && content.length > 0) {
        last = content;
      }
    } catch {
      // skip malformed lines
    }
  }
  return last.trim();
}
