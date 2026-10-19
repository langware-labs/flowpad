import { describe, it, expect } from 'vitest';
import { AgenticProcess } from '@sdk';
import { flowIconComponent } from '@sdk/react/FlowIcon';
import { subIconForEntity } from '@src/components/graph-view/icons/subIconRegistry';

/**
 * The badge conveys WHICH VENDOR a process runs on, and nothing else.
 *
 * Written against tags rather than component identity because that is now what
 * the mapping produces — and it says the claim more directly: the restored and
 * fresh forms of a vendor must land on the SAME tag, since a `.restore` badge
 * inside a badge would nest one composite in another.
 *
 * `flowIconComponent` is memoized per tag, so identity comparison still works
 * and still means "the same icon".
 */
const iconFor = (tag: string) => flowIconComponent(tag);

let seq = 0;
const proc = (worker_type?: string, restored = false) =>
  new AgenticProcess({
    id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
    worker_type,
    cli_config: restored ? { resume: true } : undefined,
  });

describe('subIconForEntity — AgenticProcess worker sub-icon', () => {
  it('maps each worker_type to its plain vendor glyph', () => {
    expect(subIconForEntity(proc('claude'))).toBe(iconFor('brands.claude'));
    expect(subIconForEntity(proc('claude_code'))).toBe(iconFor('brands.claude'));
    expect(subIconForEntity(proc(''))).toBe(iconFor('brands.claude')); // empty defaults to claude
    expect(subIconForEntity(proc(undefined))).toBe(iconFor('brands.claude'));
    expect(subIconForEntity(proc('codex'))).toBe(iconFor('brands.codex'));
    expect(subIconForEntity(proc('copilot'))).toBe(iconFor('brands.copilot'));
    expect(subIconForEntity(proc('opencode'))).toBe(iconFor('brands.opencode'));
    expect(subIconForEntity(proc('some-future-worker'))).toBe(iconFor('flowpad.generic'));
  });

  it('drops the restore role — a badge inside a badge is a drawing, not an icon', () => {
    for (const wt of ['claude', 'codex', 'copilot', 'opencode', 'other']) {
      const restored = subIconForEntity(proc(wt, /* restored */ true));
      const fresh = subIconForEntity(proc(wt));
      expect(restored).toBe(fresh);
    }
    // The vendor is still conveyed on a restored process.
    expect(subIconForEntity(proc('codex', true))).toBe(iconFor('brands.codex'));
  });

  it('returns null when there is no instance', () => {
    expect(subIconForEntity(null)).toBeNull();
    expect(subIconForEntity(undefined)).toBeNull();
  });
});
