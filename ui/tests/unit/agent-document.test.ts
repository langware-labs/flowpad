import { describe, expect, it } from 'vitest';

import { patchAgentDocument } from '@src/components/assets/editor/agent-profile/agent-document';

const SOURCE = `---
name: Q
title: QA manager
enabled: true
tools:
  - Read
cli_options:
  chrome: true
unknown:
  nested: keep-me
# keep this comment
model: md
---

<!-- flowpad:capsule identity
id: ebed6648-ad32-4611-a63e-b12bb38b984b
-->

Original instructions.
`;

describe('patchAgentDocument', () => {
  it('patches known YAML keys while preserving unknown nested data and comments', () => {
    const result = patchAgentDocument(SOURCE, {
      title: 'Senior QA manager',
      enabled: false,
      tools: [],
      cli_options: { chrome: true, trace: 'on' },
    });

    expect(result).toContain('title: Senior QA manager');
    expect(result).toContain('enabled: false');
    expect(result).toMatch(/tools:\s*\[\]/);
    expect(result).toContain('trace: on');
    expect(result).toContain('unknown:\n  nested: keep-me');
    expect(result).toContain('# keep this comment');
    expect(result).toContain('flowpad:capsule identity');
    expect(result).toContain('Original instructions.');
  });

  it('changes only the Markdown body for system_prompt', () => {
    const result = patchAgentDocument(SOURCE, { system_prompt: 'Run the e2e-QA skill.\n' });

    expect(result).toContain('unknown:\n  nested: keep-me');
    expect(result).not.toContain('Original instructions.');
    expect(result).toContain('Run the e2e-QA skill.');
  });

  it('removes undefined optional keys but keeps null, false, and empty arrays', () => {
    const result = patchAgentDocument(SOURCE, {
      model: undefined,
      avatar: null,
      enabled: false,
      skills: [],
    });

    expect(result).not.toMatch(/^model:/m);
    expect(result).toMatch(/^avatar: null$/m);
    expect(result).toMatch(/^enabled: false$/m);
    expect(result).toMatch(/skills:\s*\[\]/);
  });

  it('writes the derived mcp_servers list as declared ids', () => {
    // The slot is derived, so it is written whole every time it changes. What
    // matters here is that it round-trips as a real YAML list of typeids and
    // that emptying it stays an empty list rather than vanishing — an absent
    // key and an empty one mean the same thing to the reader, but only the
    // explicit form shows the user that nothing is attached.
    const attached = patchAgentDocument(SOURCE, {
      mcp_servers: ['mcp-38a2f0c5-5637-4487-afd2-d76d757a9745', 'mcp-3f497e53-5c1a-490c-821d-6b0b2109bdb9'],
    });

    expect(attached).toContain('mcp_servers:');
    expect(attached).toContain('- mcp-38a2f0c5-5637-4487-afd2-d76d757a9745');
    expect(attached).toContain('- mcp-3f497e53-5c1a-490c-821d-6b0b2109bdb9');
    expect(attached).toContain('unknown:\n  nested: keep-me');

    expect(patchAgentDocument(attached, { mcp_servers: [] })).toMatch(/mcp_servers:\s*\[\]/);
  });

  it('rejects malformed or non-mapping frontmatter', () => {
    expect(() => patchAgentDocument('---\n[broken\n---\nbody', { title: 'x' })).toThrow(/invalid YAML/);
    expect(() => patchAgentDocument('---\n- one\n---\nbody', { title: 'x' })).toThrow(/mapping/);
  });
});
