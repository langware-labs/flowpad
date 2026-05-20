/**
 * Parse learning.log.md into structured `LearningLogEntry[]`.
 *
 * The file is a flat markdown document where each `## <timestamp>` block
 * is one learner attempt. We split on those headings, attach the body
 * markdown beneath each, and pull a couple of useful conventions:
 *   - `Attempt: #N`        — attempt index
 *   - `- Process: <uuid>`  — link back to the agentic_process
 *
 * Both are optional. Format is forgiving — unknown / malformed bodies
 * still render as text.
 */

import type { LearningLogArtifact, LearningLogEntry } from '../types';

const HEADING_RE = /^## (.+)$/gm;
const ATTEMPT_RE = /Attempt:\s*#?(\d+)/i;
const PROCESS_RE = /Process:\s*([0-9a-f-]{16,})/i;
const ISSUE_RE = /(?:^|\n)[-*]?\s*Issue:\s*([^\n]+)/i;
const FIX_RE = /(?:^|\n)[-*]?\s*Fix:\s*([^\n]+)/i;

export function reduceLearningLog(text: string): LearningLogArtifact {
  if (!text || !text.trim()) {
    return { content: text ?? '', entries: [] };
  }
  const entries: LearningLogEntry[] = [];
  const headings: { start: number; end: number; heading: string }[] = [];
  let m: RegExpExecArray | null;
  HEADING_RE.lastIndex = 0;
  while ((m = HEADING_RE.exec(text))) {
    headings.push({ start: m.index, end: HEADING_RE.lastIndex, heading: m[1].trim() });
  }
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    const bodyStart = h.end;
    const bodyEnd = i + 1 < headings.length ? headings[i + 1].start : text.length;
    const body = text.slice(bodyStart, bodyEnd).trim();
    const attemptMatch = body.match(ATTEMPT_RE);
    const processMatch = body.match(PROCESS_RE);
    const issueMatch = body.match(ISSUE_RE);
    const fixMatch = body.match(FIX_RE);
    entries.push({
      heading: h.heading,
      body,
      attemptNumber: attemptMatch ? Number(attemptMatch[1]) : undefined,
      processId: processMatch ? processMatch[1] : undefined,
      issue: issueMatch ? issueMatch[1].trim() : undefined,
      fix: fixMatch ? fixMatch[1].trim() : undefined,
    });
  }
  return { content: text, entries };
}
