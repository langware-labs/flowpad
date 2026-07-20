import { dataManager, FlowMessage, TypeId } from '@sdk';

/** Title-case the type slug for human-friendly type labels. */
function humanType(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1).replace(/_/g, ' ');
}

/**
 * Build the "context entities saved locally" lines for a list of TypeIds.
 *
 * Every Flowpad entity is mirrored on disk under `recordsRoot` as the folder
 * `<type>/<type>-@<id>/`; Claude can `Read` any file inside it (metadata.json,
 * data/*.json, the asset). When `recordsRoot` is unset (rare — server
 * bootstrap hasn't run yet) we fall back to the GET endpoint so the lines
 * still resolve to *something* readable.
 *
 * Format per line: `- <TypeName>: <type>/<id>, read: <folder-path>`. Caller is
 * expected to dedupe TypeIds before passing them in.
 */
export function buildContextEntityLines(typeIds: readonly TypeId[]): string[] {
  const recordsRoot = dataManager.recordsRoot;
  const out: string[] = [];
  for (const tid of typeIds) {
    if (!tid?.type || !tid?.id || tid.type === FlowMessage.type) continue;
    const label = humanType(tid.type);
    if (recordsRoot) {
      const recordPath = `${recordsRoot}/${tid.type}/${tid.id}`;
      out.push(`- ${label}: ${tid.toUrlString()}, read: ${recordPath}`);
    } else {
      out.push(`- ${label}: ${tid.toUrlString()}, fetch: GET http://localhost:9007/api/v1/graph/${tid.type}/${tid.id}`);
    }
  }
  return out;
}

/**
 * Format the conversation's context as two labelled groups — "Shared" (what
 * every participant can see on the message) and "Private" (what the local
 * user has attached for themselves under Private Context).
 *
 * Returned as a single newline-joined block; empty groups are skipped so a
 * conversation with no private items doesn't emit a dangling header.
 */
export function buildSharedAndPrivateContextSection(
  sharedTypeIds: readonly TypeId[],
  privateTypeIds: readonly TypeId[],
): string {
  const parts: string[] = [];
  const sharedLines = buildContextEntityLines(sharedTypeIds);
  if (sharedLines.length > 0) {
    parts.push('Shared context (visible to every participant in this conversation):');
    parts.push(...sharedLines);
  }
  const privateLines = buildContextEntityLines(privateTypeIds);
  if (privateLines.length > 0) {
    if (parts.length > 0) parts.push('');
    parts.push('Private context (visible only to you):');
    parts.push(...privateLines);
  }
  return parts.join('\n');
}

/**
 * Build the instruction injected when the user clicks "Use Flowpad assistance"
 * below the Private Context table. The session has no concrete task yet — it
 * just exposes the available shared/private entities so Claude can answer
 * questions from any participant.
 */
export function buildAssistancePrompt(sharedTypeIds: readonly TypeId[], privateTypeIds: readonly TypeId[]): string {
  const ctx = buildSharedAndPrivateContextSection(sharedTypeIds, privateTypeIds);
  const intro =
    'Use Flowpad Assistant to help answer questions from the user. ' +
    'Read each referenced entity folder to ground your answers in the actual entity contents.';
  return ctx ? `${intro}\n\n${ctx}` : intro;
}
