import { useCallback, useMemo, useRef } from 'react';
import { FsRef, FsRefContentState, useFSRefContent } from './use-fs-ref-content';

export interface MarkdownContentState extends Omit<FsRefContentState, 'content' | 'setContent'> {
  fields: Record<string, string>;
  hasFields: boolean;
  body: string;
  /** 1-indexed line in the on-disk file where `body[0]` sits. 1 when no frontmatter. */
  bodyStartLine: number;
  setField: (key: string, value: string) => void;
  setBody: (body: string) => void;
}

// ── Pure frontmatter utilities ────────────────────────────────────────────────

function parseFrontmatter(
  raw: string,
): { fields: Record<string, string>; body: string; bodyStartLine: number } {
  if (!raw.startsWith('---\n')) return { fields: {}, body: raw, bodyStartLine: 1 };

  const closeIdx = raw.indexOf('\n---\n', 4);
  if (closeIdx === -1) return { fields: {}, body: raw, bodyStartLine: 1 };

  const frontmatter = raw.slice(4, closeIdx);
  const afterClose = raw.slice(closeIdx + 5);
  const leadingNewlines = afterClose.match(/^\n+/);
  const body = afterClose.replace(/^\n+/, '');
  const consumed = closeIdx + 5 + (leadingNewlines ? leadingNewlines[0].length : 0);
  const bodyStartLine = raw.slice(0, consumed).split('\n').length;

  const fields: Record<string, string> = {};
  for (const line of frontmatter.split('\n')) {
    const match = /^([\w-]+):\s*(.*)$/.exec(line);
    if (match) {
      fields[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
    }
  }

  return { fields, body, bodyStartLine };
}

function serializeFrontmatter(fields: Record<string, string>, body: string): string {
  // No parsed fields → the file had no readable frontmatter. Emitting a fence
  // here would inject a hollow `---\n\n---` block and strand the body's real
  // content deeper on every save, so leave the content untouched.
  if (Object.keys(fields).length === 0) return body;

  const lines = Object.entries(fields).map(([key, value]) => {
    const quoted = value.includes('"') ? `'${value}'` : `"${value}"`;
    return `${key}: ${quoted}`;
  });
  return `---\n${lines.join('\n')}\n---\n\n${body}`;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useMarkdownContent(
  fsRef: FsRef | null,
  options?: { autoSave?: boolean; autoSaveMs?: number },
): MarkdownContentState {
  const { content, setContent, ...rest } = useFSRefContent(fsRef, options);

  const { fields, body, bodyStartLine } = useMemo(() => parseFrontmatter(content), [content]);

  // Stable refs so setField/setBody don't change identity when fields/body change
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  const bodyRef = useRef(body);
  bodyRef.current = body;

  const setField = useCallback(
    (key: string, value: string) => {
      setContent(serializeFrontmatter({ ...fieldsRef.current, [key]: value }, bodyRef.current));
    },
    [setContent],
  );

  const setBody = useCallback(
    (newBody: string) => {
      setContent(serializeFrontmatter(fieldsRef.current, newBody));
    },
    [setContent],
  );

  return {
    fields,
    hasFields: Object.keys(fields).length > 0,
    body,
    bodyStartLine,
    setField,
    setBody,
    ...rest,
  };
}
