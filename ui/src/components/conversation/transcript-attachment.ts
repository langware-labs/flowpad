import { ClaudeSessionRecord } from '@sdk/resource_management/fs_records/claude/claude-session';

interface LoadOptionalTranscriptOptions {
  attach: boolean;
  sessionId?: string;
  projectPath?: string;
}

/**
 * Append the active Claude session's `conversation.jsonl` to the given file
 * list, but only when the user opted in. Looks up the on-disk path via
 * ClaudeSessionRecord.discover, fetches the bytes, and wraps them as a File.
 *
 * Silent fallback: any failure (no session, no path, fetch error) returns
 * the original file list unchanged so the send is never blocked.
 */
export async function loadOptionalTranscript(
  files: File[],
  { attach, sessionId, projectPath }: LoadOptionalTranscriptOptions,
): Promise<File[]> {
  if (!attach || !sessionId) return files;
  try {
    const record = await ClaudeSessionRecord.discover(
      sessionId,
      projectPath ? { project: projectPath } : undefined,
    );
    const jsonlPath = record?.jsonl_path;
    if (!jsonlPath) return files;
    const res = await fetch(jsonlPath);
    if (!res.ok) return files;
    const blob = await res.blob();
    const transcriptFile = new File([blob], 'conversation.jsonl', { type: 'application/jsonl' });
    if (files.some((f) => f.name === transcriptFile.name && f.size === transcriptFile.size)) return files;
    return [...files, transcriptFile];
  } catch {
    return files;
  }
}
