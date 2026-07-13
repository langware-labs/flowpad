import { useCallback, useMemo } from 'react';
import { FsRef, FsRefContentState, useFSRefContent } from './use-fs-ref-content';

export interface SkillContentState extends Omit<FsRefContentState, 'content' | 'setContent'> {
  name: string;
  description: string;
  body: string;
  setName: (name: string) => void;
  setDescription: (description: string) => void;
  setBody: (body: string) => void;
}

// ── Pure frontmatter utilities ────────────────────────────────────────────────

function parseSkillMd(raw: string): { name: string; description: string; body: string } {
  let name = '';
  let description = '';
  let body = raw;

  if (raw.startsWith('---\n')) {
    const closeIdx = raw.indexOf('\n---\n', 4);
    if (closeIdx !== -1) {
      const frontmatter = raw.slice(4, closeIdx);
      // Everything after the closing ---\n, leading whitespace trimmed
      body = raw.slice(closeIdx + 5).replace(/^\n+/, '');

      for (const line of frontmatter.split('\n')) {
        const nameMatch = /^name:\s*(.+)$/.exec(line);
        if (nameMatch) {
          name = nameMatch[1].trim().replace(/^["']|["']$/g, '');
        }
        const descMatch = /^description:\s*(.+)$/.exec(line);
        if (descMatch) {
          description = descMatch[1].trim().replace(/^["']|["']$/g, '');
        }
      }
    }
  }

  return { name, description, body };
}

function serializeSkillMd(name: string, description: string, body: string): string {
  // Wrap description in single quotes if it contains double quotes, otherwise double quotes
  const descQuoted = description.includes('"') ? `'${description}'` : `"${description}"`;
  return `---\nname: ${name}\ndescription: ${descQuoted}\n---\n\n${body}`;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

/**
 * Skill-specific content hook — wraps useFSRefContent with SKILL.md
 * frontmatter parsing.
 *
 * Exposes name, description, body as individual fields.
 * Each setter re-serializes the full file and calls setContent() on the
 * inner hook, triggering debounced autosave.
 */
export function useSkillContent(
  fsRef: FsRef | null,
  options?: { autoSave?: boolean; autoSaveMs?: number; reloadKey?: string | number },
): SkillContentState {
  const { content, setContent, ...rest } = useFSRefContent(fsRef, options);

  const { name, description, body } = useMemo(() => parseSkillMd(content), [content]);

  const setName = useCallback(
    (newName: string) => {
      setContent(serializeSkillMd(newName, description, body));
    },
    [setContent, description, body],
  );

  const setDescription = useCallback(
    (newDescription: string) => {
      setContent(serializeSkillMd(name, newDescription, body));
    },
    [setContent, name, body],
  );

  const setBody = useCallback(
    (newBody: string) => {
      setContent(serializeSkillMd(name, description, newBody));
    },
    [setContent, name, description],
  );

  return { name, description, body, setName, setDescription, setBody, ...rest };
}
