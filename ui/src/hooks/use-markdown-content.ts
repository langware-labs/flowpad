import { useCallback, useMemo, useRef } from 'react';
import { FsRef, FsRefContentState, useFSRefContent } from './use-fs-ref-content';

export interface MarkdownContentState extends Omit<FsRefContentState, 'content' | 'setContent'> {
  fields: Record<string, string>;
  hasFields: boolean;
  body: string;
  setField: (key: string, value: string) => void;
  setBody: (body: string) => void;
}

// ── Pure frontmatter utilities ────────────────────────────────────────────────

function parseFrontmatter(raw: string): { fields: Record<string, string>; body: string } {
  if (!raw.startsWith('---\n')) return { fields: {}, body: raw };

  const closeIdx = raw.indexOf('\n---\n', 4);
  if (closeIdx === -1) return { fields: {}, body: raw };

  const frontmatter = raw.slice(4, closeIdx);
  const body = raw.slice(closeIdx + 5).replace(/^\n+/, '');
  const fields: Record<string, string> = {};

  for (const line of frontmatter.split('\n')) {
    const match = /^([\w-]+):\s*(.*)$/.exec(line);
    if (match) {
      fields[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
    }
  }

  return { fields, body };
}

function serializeFrontmatter(fields: Record<string, string>, body: string): string {
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

  const { fields, body } = useMemo(() => parseFrontmatter(content), [content]);

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
    setField,
    setBody,
    ...rest,
  };
}
