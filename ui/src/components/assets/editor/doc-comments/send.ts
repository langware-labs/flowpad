import { buildChangesPrompt } from '@src/components/assets/editor/changes/useDocChangesWorker';
import { shownValue } from '@src/components/conversation/message-form';
import type { DocThread } from '@src/hooks/use-doc-comment-threads';

/** A thread an agent can act on now: a change request, or questions with answers. */
export function isReady(t: DocThread): boolean {
  if (t.status !== 'open' && t.status !== 'failed') return false;
  if (t.kind === 'change_request') return !!t.instruction;
  if (t.kind === 'questions') return !!t.form && !!t.answers;
  return false;
}

/**
 * The one turn Send puts into the session: the answers to each questions thread,
 * then the change requests in the doc Changes list's own wording, then how to
 * report back — a one-line reply in each thread, which links to this turn.
 */
export function buildCommentsPrompt(doc: string, docName: string, docFile: string, threads: readonly DocThread[]): string {
  const parts: string[] = [];
  const answered = threads.filter((x) => x.kind === 'questions' && x.form && x.answers);
  if (answered.length) {
    parts.push(
      `The person answered the questions asked in comments on the document ${docName} (the file ${docFile}). ` +
        `Act on the answers: update the document where they settle something, and do whatever else they decide.`,
    );
  }
  for (const t of answered) {
    const lines = t.form!.fields.map((f) => `- ${f.label}: ${shownValue(t.answers![f.id], 'Yes', 'No') || '—'}`);
    parts.push(`"${t.form!.title}" (${t.id}), asked at “${t.quote}”:\n${lines.join('\n')}`);
  }
  const changes = threads.filter((x) => x.kind === 'change_request' && x.instruction);
  if (changes.length) {
    parts.push(
      buildChangesPrompt(
        doc,
        docName,
        docFile,
        changes.map((c) => ({ id: c.id, quote: c.quote, from: -1, to: -1, instruction: `${c.instruction} (${c.id})` })),
      ),
    );
  }
  const ids = threads.map((t) => t.id).join(', ');
  parts.push(
    `Each of these is a comment on the document (${ids}). When you are done with each one, report in its own thread — ` +
      `a one-line reply saying what you did, then its status (done, or failed with the reason in the reply):\n` +
      `  flow record comment reply COMMENT_ID 'ONE LINE'   (single quotes, so the shell keeps $ and !)\n` +
      `  flow record comment status COMMENT_ID done`,
  );
  return parts.join('\n\n');
}
