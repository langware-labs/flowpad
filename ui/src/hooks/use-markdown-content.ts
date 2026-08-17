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

export function parseFrontmatter(
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

export function serializeFrontmatter(fields: Record<string, string>, body: string): string {
  // No parsed fields → the file had no readable frontmatter. Emitting a fence
  // here would inject a hollow `---\n\n---` block and strand the body's real
  // content deeper on every save, so leave the content untouched.
  if (Object.keys(fields).length === 0) return body;

  // Minimal quoting to match the backend YAML writer's on-disk form, so
  // serialize(parse(x)) === x for an unchanged asset. Quoting every scalar (the
  // old behavior) made the editor's buffer differ from disk on mount → dirty
  // with no user edit → autosave → autoversion bumps `version` every open.
  const needsQuote = (v: string) =>
    v === '' || /^(?:true|false|null|yes|no|on|off|~)$/i.test(v) || /^\s|\s$|[:#]/.test(v);
  const lines = Object.entries(fields).map(([key, value]) => {
    const quoted = needsQuote(value) ? `'${value.replace(/'/g, "''")}'` : value;
    return `${key}: ${quoted}`;
  });
  return `---\n${lines.join('\n')}\n---\n\n${body}`;
}

/**
 * Canonical form for the dirty comparison: collapses every difference a save
 * would re-normalize away, so an unedited open is never marked dirty.
 *  - frontmatter compared by parsed key/value map (immune to quote style, key
 *    spacing, fence formatting — the editor's serializer vs the backend writer's)
 *  - body compared with trailing whitespace and trailing blank lines stripped
 *    (the rich editor re-emits those on mount).
 * Compare-only — never what gets written.
 */
export function normalizeMarkdownForCompare(raw: string): string {
  const { fields, body } = parseFrontmatter(raw);
  const fm = JSON.stringify(Object.entries(fields).sort());
  const normBody = body.replace(/[ \t]+$/gm, '').replace(/\n+$/, '\n');
  return `${fm} ${normBody}`;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useMarkdownContent(
  fsRef: FsRef | null,
  options?: { autoSave?: boolean; autoSaveMs?: number; reloadKey?: string | number; reindexOnSave?: boolean },
): MarkdownContentState {
  const { content, setContent, ...rest } = useFSRefContent(fsRef, {
    ...options,
    normalize: normalizeMarkdownForCompare,
  });

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
