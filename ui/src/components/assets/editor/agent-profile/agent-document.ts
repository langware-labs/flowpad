import { isMap, parseDocument } from 'yaml';

import type { Agent } from '@sdk';

export type AgentDocumentPatch = Partial<
  Pick<
    Agent,
    | 'name'
    | 'title'
    | 'description'
    | 'avatar'
    | 'worker_type'
    | 'model'
    | 'permission_mode'
    | 'effort'
    | 'max_turns'
    | 'tools'
    | 'disallowed_tools'
    | 'skills'
    | 'mcp_servers'
    | 'subagents'
    | 'additional_dirs'
    | 'load_flowpad_assistant'
    | 'cli_options'
    | 'enabled'
    | 'system_prompt'
  >
>;

interface FrontmatterDocument {
  yaml: string;
  body: string;
}

function splitFrontmatter(source: string): FrontmatterDocument {
  const normalized = source.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return { yaml: '', body: normalized };
  }

  const close = normalized.indexOf('\n---', 4);
  if (close < 0) {
    throw new Error('Agent document has an unterminated YAML frontmatter block');
  }

  const afterFence = close + 4;
  const bodyStart = normalized[afterFence] === '\n' ? afterFence + 1 : afterFence;
  return {
    yaml: normalized.slice(4, close),
    body: normalized.slice(bodyStart),
  };
}

/** Frontmatter keys whose value is a plain list of strings. */
export type AgentDocumentListKey = 'skills' | 'mcp_servers' | 'subagents' | 'additional_dirs';

/**
 * Read one list field straight out of `agent.md`'s frontmatter.
 *
 * The read half of `patchAgentDocument`, and the reason a caller can edit these
 * lists without resolving the Agent ENTITY at all: the file is the record. That
 * matters for an agent whose row isn't indexed — the document is still there
 * and still authoritative, so it stays editable.
 *
 * Returns `[]` for a missing key, a non-list value, or unparseable frontmatter:
 * this feeds a checkbox list, where "can't tell" and "nothing selected" render
 * the same and must not throw.
 */
export function readAgentDocumentList(source: string, key: AgentDocumentListKey): string[] {
  let yaml: string;
  try {
    ({ yaml } = splitFrontmatter(source));
  } catch {
    return [];
  }
  if (!yaml) return [];
  try {
    const document = parseDocument(yaml);
    if (document.errors.length > 0 || !isMap(document.contents)) return [];
    const node = document.get(key, true) as { toJSON?: () => unknown } | undefined;
    const value = typeof node?.toJSON === 'function' ? node.toJSON() : document.get(key);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Losslessly patch the known Agent fields in agent.md.
 *
 * YAML's document model retains comments and unknown/nested values. Only keys
 * explicitly present in `patch` are touched; `undefined` removes a key while
 * `false`, `null`, and empty arrays remain real values. The Markdown body is
 * changed only when `system_prompt` is explicitly present.
 */
export function patchAgentDocument(source: string, patch: AgentDocumentPatch): string {
  const { yaml, body } = splitFrontmatter(source);
  const document = parseDocument(yaml || '{}', { keepSourceTokens: true });
  if (document.errors.length > 0) {
    throw new Error(`Agent frontmatter is invalid YAML: ${document.errors[0].message}`);
  }
  if (!isMap(document.contents)) {
    throw new Error('Agent frontmatter must be a YAML mapping');
  }

  for (const [key, value] of Object.entries(patch)) {
    if (key === 'system_prompt') continue;
    if (value === undefined) {
      document.delete(key);
    } else {
      document.set(key, value);
    }
  }

  // The body carries the identity capsule (`<!-- flowpad:capsule identity … -->`)
  // at its tail, and the prompt buffer never does — the extractor strips it.
  // A prompt edit therefore swaps the DOMAIN text and re-attaches the capsule
  // blocks, mirroring the Python owned-writer (`restore_capsule_blocks`):
  // dropping them would strip the entity's id from disk on every prompt save.
  const nextBody = Object.prototype.hasOwnProperty.call(patch, 'system_prompt')
    ? restoreCapsuleBlocks(String(patch.system_prompt ?? ''), snapshotCapsuleBlocks(body))
    : body;
  const renderedYaml = document.toString({ lineWidth: 0 }).trimEnd();
  return `---\n${renderedYaml}\n---\n\n${nextBody.replace(/^\n+/, '').replace(/\n*$/, '\n')}`;
}

/** Whole-line delimiters of a code-comment capsule block (see flow_sdk/capsules/code_comment.py). */
const CAPSULE_BLOCK = /^<!-- flowpad:capsule [a-z][a-z0-9_-]{0,63}\n[\s\S]*?^flowpad:endcapsule [a-z][a-z0-9_-]{0,63} -->$/gm;

function snapshotCapsuleBlocks(text: string): string[] {
  return text.match(CAPSULE_BLOCK) ?? [];
}

function restoreCapsuleBlocks(text: string, blocks: string[]): string {
  const base = text.replace(CAPSULE_BLOCK, '').replace(/\n*$/, '');
  if (blocks.length === 0) return base;
  return `${base}${base ? '\n\n' : ''}${blocks.join('\n\n')}\n`;
}
