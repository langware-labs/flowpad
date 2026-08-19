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
