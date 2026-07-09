import { describe, it, expect } from 'vitest';
import { AgenticProcess } from '@sdk';
import { subIconForEntity } from '@src/components/graph-view/icons/subIconRegistry';
import { ClaudeIcon } from '@src/components/icons/ClaudeIcon';
import { CodexIcon } from '@src/components/icons/CodexIcon';
import { CopilotIcon } from '@src/components/icons/CopilotIcon';
import {
  ClaudeRestoreIcon,
} from '@src/components/icons/ClaudeRestoreIcon';
import { CodexRestoreIcon } from '@src/components/icons/CodexRestoreIcon';
import { CopilotRestoreIcon } from '@src/components/icons/CopilotRestoreIcon';
import { Sparkles } from 'lucide-react';

const RESTORE_COMPOSITES = [ClaudeRestoreIcon, CodexRestoreIcon, CopilotRestoreIcon];

let seq = 0;
const proc = (worker_type?: string, restored = false) =>
  new AgenticProcess({
    id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
    worker_type,
    cli_config: restored ? { resume: true } : undefined,
  });

describe('subIconForEntity — AgenticProcess worker sub-icon', () => {
  it('maps each worker_type to its plain vendor glyph', () => {
    expect(subIconForEntity(proc('claude'))).toBe(ClaudeIcon);
    expect(subIconForEntity(proc('claude_code'))).toBe(ClaudeIcon);
    expect(subIconForEntity(proc(''))).toBe(ClaudeIcon); // empty defaults to claude
    expect(subIconForEntity(proc(undefined))).toBe(ClaudeIcon);
    expect(subIconForEntity(proc('codex'))).toBe(CodexIcon);
    expect(subIconForEntity(proc('copilot'))).toBe(CopilotIcon);
    expect(subIconForEntity(proc('some-future-worker'))).toBe(Sparkles); // generic
  });

  it('never returns a -restore composite (would nest a badge in a badge)', () => {
    for (const wt of ['claude', 'codex', 'copilot', 'other']) {
      const icon = subIconForEntity(proc(wt, /* restored */ true));
      expect(RESTORE_COMPOSITES).not.toContain(icon);
    }
    // The vendor is still conveyed on a restored process.
    expect(subIconForEntity(proc('codex', true))).toBe(CodexIcon);
  });

  it('returns null when there is no instance', () => {
    expect(subIconForEntity(null)).toBeNull();
    expect(subIconForEntity(undefined)).toBeNull();
  });
});
